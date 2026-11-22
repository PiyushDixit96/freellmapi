import { Router } from 'express';
import { getDb } from '../db/index.js';
import {
  getBenchmarkSummary,
  getModelBenchmarkDetail,
  seedExternalBenchmarks,
} from '../services/benchmark-service.js';
import { runMicroBenchmark } from '../services/benchmark-runner.js';
import {
  getBenchmarkAutopilotStatus,
  triggerBenchmarkAutopilotPass,
} from '../services/benchmark-autopilot.js';

export const benchmarksRouter = Router();

// GET /api/benchmarks — all models summary leaderboard
benchmarksRouter.get('/', (req, res) => {
  try {
    const { platform, search, sort, modality } = req.query;
    const db = getDb();
    const summaries = getBenchmarkSummary(db, {
      platform: typeof platform === 'string' ? platform : undefined,
      search: typeof search === 'string' ? search : undefined,
      sort: typeof sort === 'string' ? (sort as any) : 'quality',
      modality: typeof modality === 'string' ? modality : undefined,
    });
    res.json({ models: summaries, count: summaries.length });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Failed to fetch benchmark summaries' });
  }
});

// POST /api/benchmarks/seed — re-seed baseline external benchmarks
benchmarksRouter.post('/seed', (_req, res) => {
  try {
    const db = getDb();
    const result = seedExternalBenchmarks(db);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Failed to seed benchmarks' });
  }
});

// GET /api/benchmarks/model/:id — in-depth single model benchmark profile
benchmarksRouter.get('/model/:id', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();
    const detail = getModelBenchmarkDetail(db, decodeURIComponent(id));
    if (!detail) {
      return res.status(404).json({ error: `Model "${id}" not found` });
    }
    res.json(detail);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Failed to fetch model benchmark details' });
  }
});

// POST /api/benchmarks/run — trigger live micro-benchmark probe
benchmarksRouter.post('/run', async (req, res) => {
  try {
    const { platform, modelId, endpointScope, keyId, suite } = req.body;
    if (!platform || !modelId) {
      return res.status(400).json({ error: 'Missing required parameters: platform and modelId' });
    }
    const db = getDb();
    const result = await runMicroBenchmark(db, {
      platform,
      modelId,
      endpointScope,
      keyId,
      suite: suite ?? 'all',
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Micro-benchmark failed to execute' });
  }
});

// GET /api/benchmarks/autopilot/status — autopilot status
benchmarksRouter.get('/autopilot/status', (_req, res) => {
  res.json(getBenchmarkAutopilotStatus());
});

// POST /api/benchmarks/autopilot/trigger — manually trigger an autopilot pass
benchmarksRouter.post('/autopilot/trigger', async (_req, res) => {
  try {
    const result = await triggerBenchmarkAutopilotPass();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Autopilot pass failed' });
  }
});

