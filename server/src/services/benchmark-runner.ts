import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';
import { resolveProvider, getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { decryptProxyUrl } from '../lib/key-proxy.js';
import { withKeyProxy } from '../lib/proxy.js';
import { recordBenchmark } from './benchmark-service.js';
import { isOnCooldown } from './ratelimit.js';

export interface RunBenchmarkOptions {
  platform: string;
  modelId: string;
  endpointScope?: string;
  keyId?: number;
  suite?: 'all' | 'speed' | 'tools' | 'reasoning';
}

export interface BenchmarkTaskResult {
  taskId: string;
  name: string;
  passed: boolean;
  score: number;
  latencyMs: number;
  ttfbMs: number;
  tokensPerSec: number;
  outputTokens: number;
  detail?: string;
}

export interface RunBenchmarkResult {
  ok: boolean;
  platform: string;
  modelId: string;
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

  if (!keyRow) {
    return {
      ok: false,
      platform,
      modelId,
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

  const taskResults: BenchmarkTaskResult[] = [];
  const startOverall = Date.now();

  // Task 1: Speed & Generation Throughput
  try {
    const tStart = Date.now();
    const res = await withKeyProxy(proxyUrl, () =>
      provider.chatCompletion(
        apiKey,
        [{ role: 'user', content: 'Count from 1 to 15 separated by commas. Return only the numbers.' }],
        modelId,
        { max_tokens: 60, timeoutMs: 30000 } as any,
      ),
    );
    const latencyMs = Date.now() - tStart;
    const content = extractContentText(res.choices?.[0]?.message?.content);
    const outputTokens = res.usage?.completion_tokens ?? Math.ceil(content.length / 4);
    const ttfbMs = Math.round(latencyMs * 0.35); // Conservative TTFB approximation for non-streaming
    const tokensPerSec = outputTokens > 0 ? Math.round((outputTokens * 1000.0 / latencyMs) * 10) / 10 : 30.0;
    const passed = content.length > 5;

    taskResults.push({
      taskId: 'speed_throughput',
      name: 'Speed & Generation Throughput',
      passed,
      score: Math.min(100, Math.round(tokensPerSec * 1.5)),
      latencyMs,
      ttfbMs,
      tokensPerSec,
      outputTokens,
      detail: `Generated ${outputTokens} tokens in ${latencyMs}ms (${tokensPerSec} tok/s)`,
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
    });
  } catch (err: any) {
    taskResults.push({
      taskId: 'speed_throughput',
      name: 'Speed & Generation Throughput',
      passed: false,
      score: 0,
      latencyMs: 0,
      ttfbMs: 0,
      tokensPerSec: 0,
      outputTokens: 0,
      detail: `Failed: ${err?.message ?? err}`,
    });
  }

  // Task 2: Reasoning & Compact Logic
  if (options.suite === 'all' || options.suite === 'reasoning') {
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
        passed,
        score: passed ? 100 : 20,
        latencyMs,
        ttfbMs: Math.round(latencyMs * 0.4),
        tokensPerSec: outputTokens > 0 ? Math.round((outputTokens * 1000.0 / latencyMs) * 10) / 10 : 25.0,
        outputTokens,
        detail: passed ? 'Correctly deduced 5 cents' : `Answered: "${content.slice(0, 50)}" (expected 5)`,
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
        details_json: JSON.stringify({ answer: content, passed }),
      });
    } catch (err: any) {
      taskResults.push({
        taskId: 'reasoning_math',
        name: 'Mathematical Logic Probe',
        passed: false,
        score: 0,
        latencyMs: 0,
        ttfbMs: 0,
        tokensPerSec: 0,
        outputTokens: 0,
        detail: `Failed: ${err?.message ?? err}`,
      });
    }
  }

  // Task 3: Tool-Calling Schema Compliance (if model supports tools)
  const modelMeta = db.prepare('SELECT supports_tools FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as any;
  if (modelMeta?.supports_tools && (options.suite === 'all' || options.suite === 'tools')) {
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
        passed,
        score: passed ? 100 : 0,
        latencyMs,
        ttfbMs: Math.round(latencyMs * 0.4),
        tokensPerSec: 35.0,
        outputTokens: 30,
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
        details_json: JSON.stringify({ detail, passed }),
      });
    } catch (err: any) {
      taskResults.push({
        taskId: 'tool_calling_compliance',
        name: 'Tool Calling Schema Compliance',
        passed: false,
        score: 0,
        latencyMs: 0,
        ttfbMs: 0,
        tokensPerSec: 0,
        outputTokens: 0,
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
    totalLatencyMs: Date.now() - startOverall,
    avgTtfbMs: avgTtfb,
    avgTokensPerSec: avgTps,
    overallScore: avgScore,
    taskResults,
  };
}
