import type { Db } from '../types.js';

// model_benchmarks — benchmark and operational performance metrics table.
// Stores external benchmark indices (Artificial Analysis, Arena Elo, SWE-bench),
// passive traffic analytics (TTFB, throughput, latency percentiles),
// and active micro-probe results (tool-calling accuracy, reasoning, vision).

export function up(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS model_benchmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    model_id TEXT NOT NULL,
    endpoint_scope TEXT NOT NULL DEFAULT '',
    key_id INTEGER,
    modality TEXT NOT NULL DEFAULT 'text',
    source TEXT NOT NULL,                          -- 'external' | 'passive' | 'micro_probe'
    benchmark_suite TEXT NOT NULL,                 -- 'academic' | 'speed' | 'tools' | 'reasoning' | 'vision' | 'quality'
    metric_name TEXT NOT NULL,                     -- 'arena_elo' | 'aa_intelligence' | 'ttfb_ms' | 'tokens_per_sec' | 'tool_call_accuracy' | 'swe_bench'
    metric_value REAL NOT NULL,                    -- score or metric measurement
    unit TEXT,                                     -- 'elo' | 'index' | 'ms' | 'tok/s' | '%'
    sample_size INTEGER NOT NULL DEFAULT 1,
    details_json TEXT,                             -- diagnostic or breakdown JSON
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (key_id) REFERENCES api_keys(id) ON DELETE SET NULL
  )`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_benchmarks_lookup 
    ON model_benchmarks(platform, model_id, modality)`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_benchmarks_metric 
    ON model_benchmarks(metric_name, recorded_at)`);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS model_benchmarks');
}
