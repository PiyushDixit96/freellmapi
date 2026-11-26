import type { Platform } from '@freellmapi/shared/types.js';
import type { Db } from '../db/types.js';
import type { Scheduler } from '../lib/scheduler.js';
import { isCatalogModelTombstoned } from './model-state.js';
import { customModelSeed } from './custom-model-seed.js';
import { ensureModelInProfiles } from './profile-models.js';

export const FREE_MODEL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_STAGGER_MS = 60 * 1000;

export interface FreeModelSyncResult {
  checkedPlatforms: string[];
  addedCount: number;
  added: Array<{ platform: string; modelId: string; id: number }>;
  errors: Array<{ platform: string; error: string }>;
}

const FREE_CATALOG_SOURCES: Array<{
  platform: Platform;
  url: string;
  filter: (id: string) => boolean;
}> = [
  {
    platform: 'kilo',
    url: 'https://api.kilo.ai/api/gateway/models',
    filter: (id) => id.includes(':free') || id.includes('/free'),
  },
  {
    platform: 'ovh',
    url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models',
    filter: (id) => !/(tts|asr|whisper|embed|bge|rerank|diffusion|translate|summarise)/i.test(id),
  },
  {
    platform: 'gonkabroker',
    url: 'https://proxy.gonkabroker.com/v1/models',
    filter: (id) => !/(embed|bge|rerank)/i.test(id),
  },
  {
    platform: 'cheapllm',
    url: 'https://cheapllm.shop/v1/models',
    filter: (id) => !/(embed|bge|rerank)/i.test(id),
  },
];

/** Fetch newly published free/keyless models from live provider catalogs. */
export async function syncFreeModels(db: Db): Promise<FreeModelSyncResult> {
  const enabledPlatforms = new Set(
    (db.prepare('SELECT DISTINCT platform FROM api_keys WHERE enabled = 1').all() as { platform: string }[])
      .map(r => r.platform),
  );

  const added: Array<{ platform: string; modelId: string; id: number }> = [];
  const checkedPlatforms: string[] = [];
  const errors: Array<{ platform: string; error: string }> = [];
  const seed = customModelSeed(db);

  for (const src of FREE_CATALOG_SOURCES) {
    if (!enabledPlatforms.has(src.platform)) continue;
    checkedPlatforms.push(src.platform);
    try {
      const resp = await fetch(src.url, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) {
        errors.push({ platform: src.platform, error: `HTTP ${resp.status}` });
        continue;
      }
      const json = await resp.json() as {
        data?: Array<{ id?: string; name?: string; context_length?: number; supported_parameters?: string[] }>;
      };
      const rows = Array.isArray(json?.data) ? json.data : [];
      for (const item of rows) {
        const modelId = item?.id?.trim();
        if (!modelId || !src.filter(modelId)) continue;

        const exists = db.prepare(
          "SELECT 1 FROM models WHERE platform = ? AND model_id = ? AND endpoint_scope = ''",
        ).get(src.platform, modelId);
        if (exists || isCatalogModelTombstoned(db, 'chat', src.platform, modelId)) continue;

        const supportsTools = Array.isArray(item.supported_parameters)
          ? (item.supported_parameters.includes('tools') ? 1 : 0)
          : 1;
        const contextWindow = typeof item.context_length === 'number' && item.context_length > 0
          ? item.context_length
          : 131072;
        const displayName = item.name?.trim() || modelId;

        const insertedId = db.transaction(() => {
          const info = db.prepare(`
            INSERT INTO models (
              platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
              context_window, enabled, supports_vision, supports_tools, source, endpoint_scope
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 'discovered', '')
          `).run(
            src.platform,
            modelId,
            displayName,
            seed.intelligenceRank,
            seed.speedRank,
            seed.sizeLabel,
            contextWindow,
            supportsTools,
          );
          const modelDbId = Number(info.lastInsertRowid);
          const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
          db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, max.m + 1);
          ensureModelInProfiles(db, modelDbId);
          return modelDbId;
        })();

        added.push({ platform: src.platform, modelId, id: insertedId });
      }
    } catch (err: any) {
      errors.push({ platform: src.platform, error: err?.message ?? String(err) });
    }
  }

  return { checkedPlatforms, addedCount: added.length, added, errors };
}

/** Schedule a daily background pass to discover new free/keyless models. */
export function startFreeModelSync(db: Db, scheduler: Scheduler): void {
  if (process.env.FREE_MODEL_SYNC_DISABLED === '1') return;

  const runPass = async () => {
    try {
      const res = await syncFreeModels(db);
      if (res.addedCount > 0) {
        console.log(`[free-model-sync] discovered ${res.addedCount} new free model(s): ${res.added.map(a => a.modelId).join(', ')}`);
      }
    } catch (err: any) {
      console.warn(`[free-model-sync] scheduled sync error: ${err?.message ?? err}`);
    }
  };

  scheduler.after(FIRST_RUN_STAGGER_MS, () => {
    void runPass();
  });
  scheduler.every(FREE_MODEL_SYNC_INTERVAL_MS, () => {
    void runPass();
  }, { name: 'free-model-sync' });
}
