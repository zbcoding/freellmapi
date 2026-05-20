import './env.js';
import { createApp } from './app.js';
import { initDb, getDb } from './db/index.js';
import { startHealthChecker } from './services/health.js';
import { encrypt, decrypt } from './lib/crypto.js';

const PORT = process.env.PORT ?? 3001;

// Maps Coolify env var names to freellmapi platform identifiers.
// Set e.g. FREELLMAPI_GROQ_KEY=gsk_... in Coolify and it will be
// inserted into the DB on first boot (skipped on subsequent boots).
const ENV_KEY_MAP: Array<{ envVar: string; platform: string }> = [
  { envVar: 'FREELLMAPI_GOOGLE_KEY',      platform: 'google' },
  { envVar: 'FREELLMAPI_GROQ_KEY',        platform: 'groq' },
  { envVar: 'FREELLMAPI_CEREBRAS_KEY',    platform: 'cerebras' },
  { envVar: 'FREELLMAPI_SAMBANOVA_KEY',   platform: 'sambanova' },
  { envVar: 'FREELLMAPI_MISTRAL_KEY',     platform: 'mistral' },
  { envVar: 'FREELLMAPI_OPENROUTER_KEY',  platform: 'openrouter' },
  { envVar: 'FREELLMAPI_GITHUB_KEY',      platform: 'github' },
  { envVar: 'FREELLMAPI_COHERE_KEY',      platform: 'cohere' },
  { envVar: 'FREELLMAPI_CLOUDFLARE_KEY',  platform: 'cloudflare' },
  { envVar: 'FREELLMAPI_ZHIPU_KEY',       platform: 'zhipu' },
  { envVar: 'FREELLMAPI_OLLAMA_KEY',      platform: 'ollama' },
];

function seedKeysFromEnv(): void {
  const db = getDb();
  const existingRows = db.prepare('SELECT platform, encrypted_key, iv, auth_tag FROM api_keys').all() as Array<{
    platform: string; encrypted_key: string; iv: string; auth_tag: string;
  }>;

  // Decrypt existing keys so we can skip exact duplicates on restart.
  const existingKeys = new Set<string>();
  for (const row of existingRows) {
    try {
      existingKeys.add(`${row.platform}:${decrypt(row.encrypted_key, row.iv, row.auth_tag)}`);
    } catch {
      // Corrupted row — ignore, don't block startup.
    }
  }

  const insert = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `);

  for (const { envVar, platform } of ENV_KEY_MAP) {
    const key = process.env[envVar];
    if (!key) continue;

    if (existingKeys.has(`${platform}:${key}`)) {
      console.log(`[env-seed] ${platform}: already present, skipping`);
      continue;
    }

    const { encrypted, iv, authTag } = encrypt(key);
    insert.run(platform, 'env-seeded', encrypted, iv, authTag);
    console.log(`[env-seed] ${platform}: inserted from ${envVar}`);
  }
}

async function main() {
  initDb();
  seedKeysFromEnv();
  const app = createApp();

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Proxy endpoint: http://0.0.0.0:${PORT}/v1/chat/completions`);
    startHealthChecker();
  });
}

main().catch(console.error);
