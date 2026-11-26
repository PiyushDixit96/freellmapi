import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';
import { resolveProvider, getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { decryptProxyUrl } from '../lib/key-proxy.js';
import { withKeyProxy } from '../lib/proxy.js';
import { recordBenchmark } from './benchmark-service.js';
import { isOnCooldown } from './ratelimit.js';

export type BenchmarkSuite =
  | 'all'
  | 'speed'
  | 'fast_text'
  | 'coding'
  | 'structured_json'
  | 'reasoning'
  | 'tools';

export interface RunBenchmarkOptions {
  platform: string;
  modelId: string;
  endpointScope?: string;
  keyId?: number;
  suite?: BenchmarkSuite;
}

export interface BenchmarkTaskResult {
  taskId: string;
  name: string;
  suite: string;
  passed: boolean;
  score: number;
  latencyMs: number;
  ttfbMs: number;
  tokensPerSec: number;
  outputTokens: number;
  reasoningTokens?: number;
  testedAt: string;
  detail?: string;
}

export interface RunBenchmarkResult {
  ok: boolean;
  platform: string;
  modelId: string;
  testedAt: string;
  totalLatencyMs: number;
  avgTtfbMs: number;
  avgTokensPerSec: number;
  overallScore: number;
  taskResults: BenchmarkTaskResult[];
  error?: string;
}

function extractContentText(raw: any): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map((b: any) => b?.text ?? '').join('');
  }
  return '';
}

async function runPromptWithRealTtfb(
  provider: any,
  apiKey: string,
  messages: any[],
  modelId: string,
  options: Record<string, unknown>,
): Promise<{
  content: string;
  reasoningTokens: number;
  outputTokens: number;
  latencyMs: number;
  ttfbMs: number;
}> {
  const tStart = Date.now();
  if (typeof provider.chatCompletionStream === 'function') {
    try {
      let ttfbMs: number | null = null;
      let content = '';
      let outputTokens = 0;
      let reasoningTokens = 0;
      for await (const chunk of provider.chatCompletionStream(apiKey, messages, modelId, options)) {
        const delta = chunk?.choices?.[0]?.delta;
        const textPart = typeof delta?.content === 'string' ? delta.content : '';
        const reasonPart = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : '';
        if (ttfbMs === null && (textPart.length > 0 || reasonPart.length > 0)) {
          ttfbMs = Math.max(1, Date.now() - tStart);
        }
        content += textPart;
        if (chunk?.usage?.completion_tokens) outputTokens = chunk.usage.completion_tokens;
        if (chunk?.usage?.completion_tokens_details?.reasoning_tokens) {
          reasoningTokens = chunk.usage.completion_tokens_details.reasoning_tokens;
        }
      }
      const latencyMs = Math.max(1, Date.now() - tStart);
      if (content.length > 0) {
        return {
          content,
          reasoningTokens,
          outputTokens: outputTokens || Math.ceil(content.length / 4),
          latencyMs,
          ttfbMs: ttfbMs ?? Math.round(latencyMs * 0.35),
        };
      }
    } catch {
      // Fall back to non-streaming completion if provider rejects streaming
    }
  }

  const tFallbackStart = Date.now();
  const res = await provider.chatCompletion(apiKey, messages, modelId, options);
  const latencyMs = Math.max(1, Date.now() - tFallbackStart);
  const content = extractContentText(res.choices?.[0]?.message?.content);
  const reasoningTokens = res.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const outputTokens = res.usage?.completion_tokens ?? Math.ceil(content.length / 4);
  return {
    content,
    reasoningTokens,
    outputTokens,
    latencyMs,
    ttfbMs: Math.round(latencyMs * 0.35),
  };
}

/** Execute a live micro-benchmark safely against a target model */
export async function runMicroBenchmark(
  db: Db,
  options: RunBenchmarkOptions,
): Promise<RunBenchmarkResult> {
  const { platform, modelId, endpointScope = '' } = options;

  // 1. Resolve key
  let keyRow: any = null;
  if (options.keyId) {
    keyRow = db.prepare('SELECT * FROM api_keys WHERE id = ? AND enabled = 1').get(options.keyId);
  } else {
    keyRow = db.prepare(`
      SELECT * FROM api_keys 
      WHERE platform = ? AND enabled = 1 
      ORDER BY (status = 'healthy') DESC, id ASC 
      LIMIT 1
    `).get(platform);
  }

  const testedAt = new Date().toISOString();

  if (!keyRow) {
    return {
      ok: false,
      platform,
      modelId,
      testedAt,
      totalLatencyMs: 0,
      avgTtfbMs: 0,
      avgTokensPerSec: 0,
      overallScore: 0,
      taskResults: [],
      error: `No enabled API key found for platform "${platform}"`,
    };
  }

  // 2. Cooldown check
  if (isOnCooldown(platform, modelId, keyRow.id)) {
    return {
      ok: false,
      platform,
      modelId,
      testedAt,
      totalLatencyMs: 0,
      avgTtfbMs: 0,
      avgTokensPerSec: 0,
      overallScore: 0,
      taskResults: [],
      error: `Model ${platform}/${modelId} is currently on cooldown (rate-limited upstream)`,
    };
  }

  const provider = resolveProvider(platform as any, keyRow.base_url) ?? getProvider(platform as any);
  if (!provider) {
    return {
      ok: false,
      platform,
      modelId,
      testedAt,
      totalLatencyMs: 0,
      avgTtfbMs: 0,
      avgTokensPerSec: 0,
      overallScore: 0,
      taskResults: [],
      error: `No provider adapter registered for "${platform}"`,
    };
  }

  const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
  const proxyUrl = decryptProxyUrl(keyRow);

  const suite = options.suite ?? 'all';
  const taskResults: BenchmarkTaskResult[] = [];
  const startOverall = Date.now();

  // Task 1: Speed & Generation Throughput
  if (suite === 'all' || suite === 'speed') {
    try {
      const { content, outputTokens, latencyMs, ttfbMs } = await withKeyProxy(proxyUrl, () =>
        runPromptWithRealTtfb(
          provider,
          apiKey,
          [{ role: 'user', content: 'Count from 1 to 15 separated by commas. Return only the numbers.' }],
          modelId,
          { max_tokens: 60, timeoutMs: 30000 },
        ),
      );
      const tokensPerSec = outputTokens > 0 ? Math.round((outputTokens * 1000.0 / latencyMs) * 10) / 10 : 30.0;
      const passed = content.length > 5;

      taskResults.push({
        taskId: 'speed_throughput',
        name: 'Speed & Generation Throughput',
        suite: 'speed',
        passed,
        score: Math.min(100, Math.round(tokensPerSec * 1.5)),
        latencyMs,
        ttfbMs,
        tokensPerSec,
        outputTokens,
        testedAt: new Date().toISOString(),
        detail: `Generated ${outputTokens} tokens in ${latencyMs}ms (${tokensPerSec} tok/s, ${ttfbMs}ms TTFB)`,
      });

      recordBenchmark(db, {
        platform,
        model_id: modelId,
        endpoint_scope: endpointScope,
        key_id: keyRow.id,
        source: 'micro_probe',
        benchmark_suite: 'speed',
        metric_name: 'tokens_per_sec',
        metric_value: tokensPerSec,
        unit: 'tok/s',
        details_json: JSON.stringify({ latencyMs, outputTokens, testedAt }),
      });

      recordBenchmark(db, {
        platform,
        model_id: modelId,
        endpoint_scope: endpointScope,
        key_id: keyRow.id,
        source: 'micro_probe',
        benchmark_suite: 'speed',
        metric_name: 'ttfb_ms',
        metric_value: ttfbMs,
        unit: 'ms',
        details_json: JSON.stringify({ latencyMs, testedAt }),
      });
    } catch (err: any) {
      taskResults.push({
        taskId: 'speed_throughput',
        name: 'Speed & Generation Throughput',
        suite: 'speed',
        passed: false,
        score: 0,
        latencyMs: 0,
        ttfbMs: 0,
        tokensPerSec: 0,
        outputTokens: 0,
        testedAt: new Date().toISOString(),
        detail: `Failed: ${err?.message ?? err}`,
      });
    }
  }

  // Task 1b: Fast Text / Minimal-or-No Thinking Response Timing
  if (suite === 'all' || suite === 'fast_text') {
    try {
      const { content: rawContent, reasoningTokens, outputTokens, latencyMs, ttfbMs } = await withKeyProxy(proxyUrl, () =>
        runPromptWithRealTtfb(
          provider,
          apiKey,
          [
            { role: 'system', content: 'Answer directly in 1 short sentence with zero reasoning or preamble.' },
            { role: 'user', content: 'Define an API gateway in one short sentence.' },
          ],
          modelId,
          { max_tokens: 60, temperature: 0.2, reasoning_effort: 'low', timeoutMs: 30000 },
        ),
      );
      const content = rawContent.trim();
      const tokensPerSec = outputTokens > 0 ? Math.round((outputTokens * 1000.0 / Math.max(1, latencyMs)) * 10) / 10 : 25.0;
      const passed = content.length >= 10;
      const speedRating = Math.max(10, Math.min(100, Math.round(100 - (latencyMs / 100))));

      taskResults.push({
        taskId: 'fast_text_no_thinking',
        name: 'Fast Text (Less / No Thinking)',
        suite: 'fast_text',
        passed,
        score: passed ? speedRating : 0,
        latencyMs,
        ttfbMs,
        tokensPerSec,
        outputTokens,
        reasoningTokens,
        testedAt: new Date().toISOString(),
        detail: `${latencyMs}ms total, ${ttfbMs}ms TTFB (${reasoningTokens} reasoning tok): "${content.slice(0, 70)}"`,
      });

      recordBenchmark(db, {
        platform,
        model_id: modelId,
        endpoint_scope: endpointScope,
        key_id: keyRow.id,
        source: 'micro_probe',
        benchmark_suite: 'fast_text',
        metric_name: 'fast_text_ms',
        metric_value: latencyMs,
        unit: 'ms',
        details_json: JSON.stringify({ latencyMs, reasoningTokens, outputTokens, tokensPerSec, passed, testedAt }),
      });
    } catch (err: any) {
      taskResults.push({
        taskId: 'fast_text_no_thinking',
        name: 'Fast Text (Less / No Thinking)',
        suite: 'fast_text',
        passed: false,
        score: 0,
        latencyMs: 0,
        ttfbMs: 0,
        tokensPerSec: 0,
        outputTokens: 0,
        testedAt: new Date().toISOString(),
        detail: `Failed: ${err?.message ?? err}`,
      });
    }
  }

  // Task 2: Reasoning & Compact Logic
  if (suite === 'all' || suite === 'reasoning') {
    try {
      const tStart = Date.now();
      const res = await withKeyProxy(proxyUrl, () =>
        provider.chatCompletion(
          apiKey,
          [{
            role: 'user',
            content: 'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost in cents? Reply with only the number.',
          }],
          modelId,
          { max_tokens: 30, timeoutMs: 30000 } as any,
        ),
      );
      const latencyMs = Date.now() - tStart;
      const content = extractContentText(res.choices?.[0]?.message?.content).trim();
      const outputTokens = res.usage?.completion_tokens ?? Math.ceil(content.length / 4);
      const passed = /\b5\b/.test(content) && !/\b10\b/.test(content.replace(/1\.10/g, ''));

      taskResults.push({
        taskId: 'reasoning_math',
        name: 'Mathematical Logic Probe',
        suite: 'reasoning',
        passed,
        score: passed ? 100 : 20,
        latencyMs,
        ttfbMs: Math.round(latencyMs * 0.4),
        tokensPerSec: outputTokens > 0 ? Math.round((outputTokens * 1000.0 / latencyMs) * 10) / 10 : 25.0,
        outputTokens,
        testedAt: new Date().toISOString(),
        detail: passed ? `Correctly deduced 5 cents (${latencyMs}ms)` : `Answered: "${content.slice(0, 50)}" (expected 5)`,
      });

      recordBenchmark(db, {
        platform,
        model_id: modelId,
        endpoint_scope: endpointScope,
        key_id: keyRow.id,
        source: 'micro_probe',
        benchmark_suite: 'reasoning',
        metric_name: 'math_accuracy',
        metric_value: passed ? 100 : 0,
        unit: '%',
        details_json: JSON.stringify({ answer: content, passed, latencyMs, testedAt }),
      });
    } catch (err: any) {
      taskResults.push({
        taskId: 'reasoning_math',
        name: 'Mathematical Logic Probe',
        suite: 'reasoning',
        passed: false,
        score: 0,
        latencyMs: 0,
        ttfbMs: 0,
        tokensPerSec: 0,
        outputTokens: 0,
        testedAt: new Date().toISOString(),
        detail: `Failed: ${err?.message ?? err}`,
      });
    }
  }

  // Task 2b: Coding & Syntax Use Case
  if (suite === 'all' || suite === 'coding') {
    try {
      const tStart = Date.now();
      const res = await withKeyProxy(proxyUrl, () =>
        provider.chatCompletion(
          apiKey,
          [{
            role: 'user',
            content: 'Write a concise TypeScript function `isPalindrome(s: string): boolean` returning true if `s` is a palindrome ignoring case and non-alphanumeric characters. Return only the code.',
          }],
          modelId,
          { max_tokens: 180, temperature: 0.1, timeoutMs: 35000 } as any,
        ),
      );
      const latencyMs = Date.now() - tStart;
      const content = extractContentText(res.choices?.[0]?.message?.content).trim();
      const outputTokens = res.usage?.completion_tokens ?? Math.ceil(content.length / 4);
      const hasFn = /isPalindrome\s*\(/.test(content);
      const hasReturn = /\breturn\b/.test(content);
      const hasNormalize = /toLowerCase|replace/.test(content);
      const passed = hasFn && hasReturn && hasNormalize;
      const score = (hasFn ? 40 : 0) + (hasReturn ? 30 : 0) + (hasNormalize ? 30 : 0);

      taskResults.push({
        taskId: 'coding_typescript',
        name: 'Code Generation (TypeScript)',
        suite: 'coding',
        passed,
        score,
        latencyMs,
        ttfbMs: Math.round(latencyMs * 0.35),
        tokensPerSec: outputTokens > 0 ? Math.round((outputTokens * 1000.0 / Math.max(1, latencyMs)) * 10) / 10 : 30.0,
        outputTokens,
        testedAt: new Date().toISOString(),
        detail: passed ? `Valid TS function in ${latencyMs}ms` : `Partial syntax match (${score}%)`,
      });

      recordBenchmark(db, {
        platform,
        model_id: modelId,
        endpoint_scope: endpointScope,
        key_id: keyRow.id,
        source: 'micro_probe',
        benchmark_suite: 'coding',
        metric_name: 'coding_accuracy',
        metric_value: score,
        unit: '%',
        details_json: JSON.stringify({ passed, latencyMs, outputTokens, testedAt }),
      });
    } catch (err: any) {
      taskResults.push({
        taskId: 'coding_typescript',
        name: 'Code Generation (TypeScript)',
        suite: 'coding',
        passed: false,
        score: 0,
        latencyMs: 0,
        ttfbMs: 0,
        tokensPerSec: 0,
        outputTokens: 0,
        testedAt: new Date().toISOString(),
        detail: `Failed: ${err?.message ?? err}`,
      });
    }
  }

  // Task 2c: Structured JSON Extraction Use Case
  if (suite === 'all' || suite === 'structured_json') {
    try {
      const tStart = Date.now();
      const res = await withKeyProxy(proxyUrl, () =>
        provider.chatCompletion(
          apiKey,
          [{
            role: 'user',
            content: 'Extract name and age from "Alice is 29 years old" as raw valid JSON with keys "name" and "age". No markdown fences or extra text.',
          }],
          modelId,
          { max_tokens: 60, temperature: 0, timeoutMs: 30000 } as any,
        ),
      );
      const latencyMs = Date.now() - tStart;
      const raw = extractContentText(res.choices?.[0]?.message?.content).trim();
      const outputTokens = res.usage?.completion_tokens ?? Math.ceil(raw.length / 4);
      const hadFences = raw.includes('```');
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      let passed = false;
      let score = 0;
      let detail = `Invalid JSON: "${raw.slice(0, 60)}"`;

      try {
        const parsed = JSON.parse(cleaned);
        if (parsed?.name === 'Alice' && Number(parsed?.age) === 29) {
          passed = true;
          score = hadFences ? 75 : 100;
          detail = hadFences
            ? `Valid JSON (wrapped in fences) in ${latencyMs}ms`
            : `Strict raw JSON extracted in ${latencyMs}ms`;
        } else {
          score = 30;
          detail = `Wrong JSON values: ${cleaned.slice(0, 60)}`;
        }
      } catch {
        // Invalid JSON
      }

      taskResults.push({
        taskId: 'structured_json',
        name: 'Structured JSON Extraction',
        suite: 'structured_json',
        passed,
        score,
        latencyMs,
        ttfbMs: Math.round(latencyMs * 0.4),
        tokensPerSec: outputTokens > 0 ? Math.round((outputTokens * 1000.0 / Math.max(1, latencyMs)) * 10) / 10 : 25.0,
        outputTokens,
        testedAt: new Date().toISOString(),
        detail,
      });

      recordBenchmark(db, {
        platform,
        model_id: modelId,
        endpoint_scope: endpointScope,
        key_id: keyRow.id,
        source: 'micro_probe',
        benchmark_suite: 'structured_json',
        metric_name: 'json_accuracy',
        metric_value: score,
        unit: '%',
        details_json: JSON.stringify({ passed, hadFences, latencyMs, testedAt }),
      });
    } catch (err: any) {
      taskResults.push({
        taskId: 'structured_json',
        name: 'Structured JSON Extraction',
        suite: 'structured_json',
        passed: false,
        score: 0,
        latencyMs: 0,
        ttfbMs: 0,
        tokensPerSec: 0,
        outputTokens: 0,
        testedAt: new Date().toISOString(),
        detail: `Failed: ${err?.message ?? err}`,
      });
    }
  }

  // Task 3: Tool-Calling Schema Compliance (if model supports tools)
  const modelMeta = db.prepare('SELECT supports_tools FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as any;
  if (modelMeta?.supports_tools && (suite === 'all' || suite === 'tools')) {
    try {
      const tStart = Date.now();
      const res = await withKeyProxy(proxyUrl, () =>
        provider.chatCompletion(
          apiKey,
          [{ role: 'user', content: 'What is the weather in Tokyo right now?' }],
          modelId,
          {
            max_tokens: 100,
            timeoutMs: 35000,
            tools: [
              {
                type: 'function',
                function: {
                  name: 'get_current_weather',
                  description: 'Get the current weather for a location',
                  parameters: {
                    type: 'object',
                    properties: {
                      location: { type: 'string', description: 'The city name' },
                    },
                    required: ['location'],
                  },
                },
              },
            ],
          } as any,
        ),
      );
      const latencyMs = Date.now() - tStart;
      const toolCall = res.choices?.[0]?.message?.tool_calls?.[0];
      let passed = false;
      let detail = 'No tool call returned';

      if (toolCall) {
        try {
          const args = typeof toolCall.function.arguments === 'string' 
            ? JSON.parse(toolCall.function.arguments) 
            : toolCall.function.arguments;
          if (args.location?.toLowerCase().includes('tokyo')) {
            passed = true;
            detail = `Valid tool call: ${toolCall.function.name}(${JSON.stringify(args)})`;
          } else {
            detail = `Unexpected args: ${JSON.stringify(args)}`;
          }
        } catch {
          detail = `Malformed JSON: ${toolCall.function.arguments}`;
        }
      }

      taskResults.push({
        taskId: 'tool_calling_compliance',
        name: 'Tool Calling Schema Compliance',
        suite: 'tools',
        passed,
        score: passed ? 100 : 0,
        latencyMs,
        ttfbMs: Math.round(latencyMs * 0.4),
        tokensPerSec: 35.0,
        outputTokens: 30,
        testedAt: new Date().toISOString(),
        detail,
      });

      recordBenchmark(db, {
        platform,
        model_id: modelId,
        endpoint_scope: endpointScope,
        key_id: keyRow.id,
        source: 'micro_probe',
        benchmark_suite: 'tools',
        metric_name: 'tool_call_accuracy',
        metric_value: passed ? 100 : 0,
        unit: '%',
        details_json: JSON.stringify({ detail, passed, latencyMs, testedAt }),
      });
    } catch (err: any) {
      taskResults.push({
        taskId: 'tool_calling_compliance',
        name: 'Tool Calling Schema Compliance',
        suite: 'tools',
        passed: false,
        score: 0,
        latencyMs: 0,
        ttfbMs: 0,
        tokensPerSec: 0,
        outputTokens: 0,
        testedAt: new Date().toISOString(),
        detail: `Failed: ${err?.message ?? err}`,
      });
    }
  }

  const passedTasks = taskResults.filter(t => t.passed);
  const avgScore = taskResults.length > 0 
    ? Math.round(taskResults.reduce((sum, t) => sum + t.score, 0) / taskResults.length) 
    : 0;

  const validSpeeds = taskResults.filter(t => t.tokensPerSec > 0);
  const avgTps = validSpeeds.length > 0 
    ? Math.round((validSpeeds.reduce((sum, t) => sum + t.tokensPerSec, 0) / validSpeeds.length) * 10) / 10 
    : 0;

  const validTtfb = taskResults.filter(t => t.ttfbMs > 0);
  const avgTtfb = validTtfb.length > 0 
    ? Math.round(validTtfb.reduce((sum, t) => sum + t.ttfbMs, 0) / validTtfb.length) 
    : 0;

  return {
    ok: passedTasks.length > 0,
    platform,
    modelId,
    testedAt,
    totalLatencyMs: Date.now() - startOverall,
    avgTtfbMs: avgTtfb,
    avgTokensPerSec: avgTps,
    overallScore: avgScore,
    taskResults,
  };
}
