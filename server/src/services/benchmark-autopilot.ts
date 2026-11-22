import type { Scheduler } from '../lib/scheduler.js';
import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';
import { isOnCooldown } from './ratelimit.js';
import { runMicroBenchmark, type RunBenchmarkResult } from './benchmark-runner.js';
import { providerLog } from '../lib/server-logs.js';

export interface BenchmarkAutopilotStatus {
  enabled: boolean;
  intervalMs: number;
  lastRunAt: string | null;
  lastProbedModel: string | null;
  lastResult: {
    ok: boolean;
    avgTokensPerSec?: number;
    avgTtfbMs?: number;
    error?: string;
  } | null;
  runsTotal: number;
}

// 30 minute default interval
export const AUTOPILOT_DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
// Stagger the first run by 45s after boot so it doesn't slow down startup
const FIRST_RUN_STAGGER_MS = 45 * 1000;

interface CandidateModel {
  platform: string;
  modelId: string;
  displayName: string;
  keyId: number;
}

class BenchmarkAutopilotManager {
  private enabled: boolean;
  private intervalMs: number;
  private lastRunAt: string | null = null;
  private lastProbedModel: string | null = null;
  private lastResult: BenchmarkAutopilotStatus['lastResult'] = null;
  private runsTotal = 0;
  private isRunning = false;

  constructor() {
    this.enabled = process.env.BENCHMARK_AUTOPILOT_DISABLED !== '1';
    const envInterval = Number(process.env.BENCHMARK_AUTOPILOT_INTERVAL_MS);
    this.intervalMs = Number.isInteger(envInterval) && envInterval > 10_000
      ? envInterval
      : AUTOPILOT_DEFAULT_INTERVAL_MS;
  }

  public getStatus(): BenchmarkAutopilotStatus {
    return {
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      lastRunAt: this.lastRunAt,
      lastProbedModel: this.lastProbedModel,
      lastResult: this.lastResult,
      runsTotal: this.runsTotal,
    };
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public start(scheduler: Scheduler): void {
    if (!this.enabled) {
      providerLog('info', '[benchmark-autopilot] Autopilot benchmark runner is disabled via environment');
      return;
    }

    console.log(`[benchmark-autopilot] Autopilot service started (interval: ${Math.round(this.intervalMs / 60000)}m)`);

    // First run with stagger
    scheduler.after(FIRST_RUN_STAGGER_MS, () => {
      void this.runPass();
    });

    // Recurring schedule
    scheduler.every(this.intervalMs, () => {
      void this.runPass();
    }, { name: 'benchmark-autopilot' });
  }

  public async runPass(): Promise<{ ok: boolean; model?: string; result?: RunBenchmarkResult; error?: string }> {
    if (this.isRunning) {
      return { ok: false, error: 'Autopilot pass already in progress' };
    }

    this.isRunning = true;
    try {
      const candidate = this.selectNextCandidate();
      if (!candidate) {
        return { ok: false, error: 'No probeable active models found' };
      }

      console.log(`[benchmark-autopilot] Running scheduled micro-benchmark for ${candidate.platform}:${candidate.modelId}`);
      const result = await runMicroBenchmark(getDb(), {
        platform: candidate.platform,
        modelId: candidate.modelId,
        suite: 'all',
      });

      this.lastRunAt = new Date().toISOString();
      this.lastProbedModel = `${candidate.platform}:${candidate.modelId}`;
      this.runsTotal++;
      this.lastResult = {
        ok: result.ok,
        avgTokensPerSec: result.avgTokensPerSec,
        avgTtfbMs: result.avgTtfbMs,
        error: result.error,
      };

      if (result.ok) {
        console.log(
          `[benchmark-autopilot] Benchmark completed for ${candidate.modelId}: ${result.avgTokensPerSec} tok/s, ${result.avgTtfbMs}ms TTFB`
        );
      } else {
        console.warn(`[benchmark-autopilot] Benchmark probe failed for ${candidate.modelId}: ${result.error}`);
      }

      return {
        ok: result.ok,
        model: `${candidate.platform}:${candidate.modelId}`,
        result,
        error: result.error,
      };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.warn(`[benchmark-autopilot] Pass error: ${msg}`);
      this.lastResult = { ok: false, error: msg };
      return { ok: false, error: msg };
    } finally {
      this.isRunning = false;
    }
  }

  private selectNextCandidate(): CandidateModel | null {
    const db = getDb();

    // Query active models with enabled keys
    const candidates = db.prepare(`
      SELECT DISTINCT
        m.platform,
        m.model_id as modelId,
        m.display_name as displayName,
        k.id as keyId
      FROM models m
      JOIN api_keys k ON k.platform = m.platform AND k.enabled = 1
      WHERE m.enabled = 1
      ORDER BY m.id ASC
    `).all() as CandidateModel[];

    if (!candidates || candidates.length === 0) {
      return null;
    }

    // Filter out models currently in cooldown
    const eligible = candidates.filter(c => !isOnCooldown(c.platform, c.modelId, c.keyId));
    if (eligible.length === 0) {
      return null;
    }

    // Check which eligible model was least recently benchmarked in model_benchmarks
    const runRecords = db.prepare(`
      SELECT platform, model_id, MAX(recorded_at) as last_probed
      FROM model_benchmarks
      WHERE source = 'micro_probe'
      GROUP BY platform, model_id
    `).all() as Array<{ platform: string; model_id: string; last_probed: string }>;

    const lastProbedMap = new Map<string, number>();
    for (const r of runRecords) {
      lastProbedMap.set(`${r.platform}:${r.model_id}`, new Date(r.last_probed).getTime());
    }

    // Sort eligible models: unmeasured first (lastProbed === 0), then oldest probed
    eligible.sort((a, b) => {
      const aTime = lastProbedMap.get(`${a.platform}:${a.modelId}`) ?? 0;
      const bTime = lastProbedMap.get(`${b.platform}:${b.modelId}`) ?? 0;
      return aTime - bTime;
    });

    return eligible[0] ?? null;
  }
}

export const benchmarkAutopilot = new BenchmarkAutopilotManager();

export function startBenchmarkAutopilot(scheduler: Scheduler): void {
  benchmarkAutopilot.start(scheduler);
}

export function getBenchmarkAutopilotStatus(): BenchmarkAutopilotStatus {
  return benchmarkAutopilot.getStatus();
}

export async function triggerBenchmarkAutopilotPass() {
  return benchmarkAutopilot.runPass();
}
