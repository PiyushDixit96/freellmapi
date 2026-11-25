import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  recordBenchmark,
  seedExternalBenchmarks,
  getBenchmarkSummary,
  getModelBenchmarkDetail,
  getBenchmarkScoreMap,
  getBenchmarkScoreForModel,
} from '../../services/benchmark-service.js';
import { getRoutingStrategy, setRoutingStrategy, getRoutingScores } from '../../services/router.js';
import { getBenchmarkAutopilotStatus } from '../../services/benchmark-autopilot.js';

describe('Benchmark Service', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.DEV_MODE = 'true';
    initDb(':memory:');
  });

  it('seeds external benchmarks for catalog models', () => {
    const db = getDb();
    const { seeded } = seedExternalBenchmarks(db);
    expect(typeof seeded).toBe('number');

    const count = (db.prepare("SELECT COUNT(*) AS c FROM model_benchmarks WHERE source = 'external'").get() as { c: number }).c;
    expect(count).toBeGreaterThan(0);
  });

  it('records a new benchmark result', () => {
    const db = getDb();
    recordBenchmark(db, {
      platform: 'google',
      model_id: 'gemini-2.5-pro',
      source: 'micro_probe',
      benchmark_suite: 'speed',
      metric_name: 'tokens_per_sec',
      metric_value: 85.5,
      unit: 'tok/s',
    });

    const row = db.prepare(`
      SELECT * FROM model_benchmarks 
      WHERE platform = 'google' AND model_id = 'gemini-2.5-pro' AND metric_name = 'tokens_per_sec'
    `).get() as any;

    expect(row).toBeDefined();
    expect(row.metric_value).toBe(85.5);
    expect(row.unit).toBe('tok/s');
    expect(row.source).toBe('micro_probe');
  });

  it('retrieves benchmark summaries for all models', () => {
    const db = getDb();
    const summaries = getBenchmarkSummary(db);

    expect(summaries.length).toBeGreaterThan(0);
    const first = summaries[0];
    expect(first.platform).toBeDefined();
    expect(first.modelId).toBeDefined();
    expect(first.qualityScore).toBeGreaterThanOrEqual(10);
    expect(first.speedScore).toBeGreaterThanOrEqual(10);
    expect(first.ttfbMs).toBeGreaterThan(0);
    expect(first.tokensPerSec).toBeGreaterThan(0);
  });

  it('filters benchmark summaries by search query and sorting', () => {
    const db = getDb();
    const filtered = getBenchmarkSummary(db, { search: 'gemini', sort: 'speed' });

    expect(filtered.length).toBeGreaterThan(0);
    for (const item of filtered) {
      expect(
        item.modelId.toLowerCase().includes('gemini') || 
        item.displayName.toLowerCase().includes('gemini')
      ).toBe(true);
    }
  });

  it('retrieves detailed benchmark profile for a single model', () => {
    const db = getDb();
    const detail = getModelBenchmarkDetail(db, 'gemini-2.5-pro');

    expect(detail).not.toBeNull();
    if (detail) {
      expect(detail.modelId).toContain('gemini-2.5-pro');
      expect(detail.qualityScore).toBeGreaterThan(0);
      expect(detail.livePerformance).toBeDefined();
      expect(detail.providerComparisons).toBeDefined();
      expect(Array.isArray(detail.recentProbes)).toBe(true);
    }
  });

  it('retrieves fast benchmark score map for scoring router', () => {
    const db = getDb();
    const map = getBenchmarkScoreMap(db);
    expect(map.size).toBeGreaterThan(0);

    const score = getBenchmarkScoreForModel('google', 'gemini-2.5-flash', db);
    expect(score).not.toBeNull();
    expect(score?.qualityScore).toBeGreaterThan(0);
  });

  it('supports benchmark-driven routing strategy and calculates scores', () => {
    const prevStrategy = getRoutingStrategy();
    try {
      setRoutingStrategy('benchmark');
      expect(getRoutingStrategy()).toBe('benchmark');

      const scores = getRoutingScores();
      expect(scores.strategy).toBe('benchmark');
      expect(scores.weights).toEqual({ reliability: 0.30, speed: 0.25, intelligence: 0.45 });
      expect(scores.scores.length).toBeGreaterThan(0);
    } finally {
      setRoutingStrategy(prevStrategy);
    }
  });

  it('provides autopilot status', () => {
    const status = getBenchmarkAutopilotStatus();
    expect(typeof status.enabled).toBe('boolean');
    expect(typeof status.intervalMs).toBe('number');
    expect(typeof status.runsTotal).toBe('number');
  });

  it('tracks use-case metrics, lastBenchmarkedAt datetime, and rate-limit status', () => {
    const db = getDb();
    recordBenchmark(db, {
      platform: 'google',
      model_id: 'gemini-2.5-flash',
      source: 'micro_probe',
      benchmark_suite: 'fast_text',
      metric_name: 'fast_text_ms',
      metric_value: 280,
      unit: 'ms',
    });
    recordBenchmark(db, {
      platform: 'google',
      model_id: 'gemini-2.5-flash',
      source: 'micro_probe',
      benchmark_suite: 'coding',
      metric_name: 'coding_accuracy',
      metric_value: 100,
      unit: '%',
    });
    recordBenchmark(db, {
      platform: 'google',
      model_id: 'gemini-2.5-flash',
      source: 'micro_probe',
      benchmark_suite: 'structured_json',
      metric_name: 'json_accuracy',
      metric_value: 100,
      unit: '%',
    });

    const summaries = getBenchmarkSummary(db, { search: 'gemini-2.5-flash', sort: 'fast_text' });
    const target = summaries.find(s => s.platform === 'google' && s.modelId === 'gemini-2.5-flash');
    expect(target).toBeDefined();
    expect(target?.fastTextMs).toBe(280);
    expect(target?.lastBenchmarkedAt).toBeTruthy();
    expect(target?.lastTestedAt).toBeTruthy();
    expect(target?.useCases.coding).toBe(100);
    expect(target?.useCases.structuredJson).toBe(100);
    expect(target?.rateLimitInfo).toBeDefined();
    expect(['ready', 'no_key', 'rate_limited', 'quota_reached', 'error']).toContain(target?.rateLimitInfo.status);
  });
});
