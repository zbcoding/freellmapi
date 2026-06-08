import type Database from 'better-sqlite3';
import { resolveProvider } from '../providers/index.js';
import { encrypt, maskKey } from '../lib/crypto.js';

// Platforms accepted from the environment. Mirrors the PLATFORMS list in
// routes/keys.ts (which is itself tied to providers/index.ts + shared Platform).
const PLATFORMS = [
  'google', 'groq', 'cerebras', 'sambanova', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'huggingface', 'opencode', 'custom',
] as const;
type Platform = (typeof PLATFORMS)[number];

// Env var convention: FREELLMAPI_<PLATFORM>_KEY (e.g. FREELLMAPI_GROQ_KEY).
// 'custom' additionally reads FREELLMAPI_CUSTOM_BASE_URL and
// FREELLMAPI_CUSTOM_MODEL.
const envKeyVar = (platform: Platform) => `FREELLMAPI_${platform.toUpperCase()}_KEY`;

/**
 * Seed provider keys from environment variables on startup (add-only).
 *
 * For each platform, if FREELLMAPI_<PLATFORM>_KEY is set and no key row already
 * exists for that platform, encrypt and insert one (label "from-env"). This is
 * the env-driven equivalent of POST /api/keys, so keys are still encrypted at
 * rest under the same ENCRYPTION_KEY.
 *
 * Add-only by design: existing rows (GUI- or previously env-seeded) are left
 * untouched, so this is idempotent across restarts and never clobbers keys a
 * user edited in the dashboard. To replace a key, delete it in the GUI first.
 */
export function seedKeysFromEnv(db: Database.Database): void {
  let inserted = 0;

  const hasKeyForPlatform = db.prepare('SELECT 1 FROM api_keys WHERE platform = ? LIMIT 1');
  const insertKey = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1, ?)
  `);

  const seed = db.transaction(() => {
    for (const platform of PLATFORMS) {
      // Custom is handled separately — it needs a base URL + model, not just a key.
      if (platform === 'custom') continue;

      const raw = process.env[envKeyVar(platform)]?.trim();
      if (!raw) continue;

      // Add-only: skip if any row already exists for this platform.
      if (hasKeyForPlatform.get(platform)) continue;

      const { encrypted, iv, authTag } = encrypt(raw);
      insertKey.run(platform, 'from-env', encrypted, iv, authTag, null);
      console.log(`[env-keys] Imported ${platform} key from ${envKeyVar(platform)} (${maskKey(raw)})`);
      inserted++;
    }

    if (seedCustomFromEnv(db)) inserted++;
  });
  seed();

  if (inserted > 0) {
    console.log(`[env-keys] Seeded ${inserted} provider key(s) from the environment`);
  }
}

/**
 * Custom OpenAI-compatible endpoint from env. Requires FREELLMAPI_CUSTOM_BASE_URL
 * and FREELLMAPI_CUSTOM_MODEL; the API key is optional (local servers often need
 * none — a "no-key" sentinel is stored so there's always a bearer). Mirrors the
 * upsert in POST /api/keys/custom: one shared 'custom' key row holds the URL, and
 * the model is registered + appended to the fallback chain.
 *
 * Add-only: skips entirely if a 'custom' key row already exists. Returns true if
 * it inserted a new custom endpoint.
 */
function seedCustomFromEnv(db: Database.Database): boolean {
  const baseUrlRaw = process.env.FREELLMAPI_CUSTOM_BASE_URL?.trim();
  const modelRaw = process.env.FREELLMAPI_CUSTOM_MODEL?.trim();
  if (!baseUrlRaw || !modelRaw) {
    if (baseUrlRaw || modelRaw) {
      console.warn('[env-keys] Custom provider needs both FREELLMAPI_CUSTOM_BASE_URL and FREELLMAPI_CUSTOM_MODEL — skipping');
    }
    return false;
  }

  const existing = db.prepare("SELECT 1 FROM api_keys WHERE platform = 'custom' LIMIT 1").get();
  if (existing) return false;

  const baseUrl = baseUrlRaw.replace(/\/+$/, '');
  // Validate the URL the same way the route's zod schema does.
  try {
    new URL(baseUrl);
  } catch {
    console.warn(`[env-keys] FREELLMAPI_CUSTOM_BASE_URL is not a valid URL ("${baseUrl}") — skipping custom provider`);
    return false;
  }
  if (!resolveProvider('custom', baseUrl)) {
    console.warn('[env-keys] Could not resolve custom provider — skipping');
    return false;
  }

  const modelId = modelRaw;
  const displayName = (process.env.FREELLMAPI_CUSTOM_NAME?.trim() || modelId);
  const rawKey = process.env.FREELLMAPI_CUSTOM_KEY?.trim() || 'no-key';

  const { encrypted, iv, authTag } = encrypt(rawKey);
  const r = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', 'from-env', ?, ?, ?, 'unknown', 1, ?)
  `).run(encrypted, iv, authTag, baseUrl);

  db.prepare(`
    INSERT OR IGNORE INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
       rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled)
    VALUES ('custom', ?, ?, 50, 50, 'Custom', NULL, NULL, NULL, NULL, '', NULL, 1)
  `).run(modelId, displayName);

  const modelRow = db.prepare("SELECT id FROM models WHERE platform = 'custom' AND model_id = ?").get(modelId) as { id: number };
  const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelRow.id);
  if (!inChain) {
    const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelRow.id, max.m + 1);
  }

  console.log(`[env-keys] Imported custom provider ${baseUrl} model ${modelId} (key ${maskKey(rawKey)}, row ${r.lastInsertRowid})`);
  return true;
}
