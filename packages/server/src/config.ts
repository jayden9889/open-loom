/**
 * Environment configuration. Everything has a sensible default so
 * `npx openloom-server` starts with zero flags; the API key is generated on
 * first boot and persisted inside DATA_DIR when not provided.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ServerConfig {
  port: number;
  dataDir: string;
  apiKey: string;
  /** True when the key was generated this boot (so index.ts can print it). */
  apiKeyGenerated: boolean;
  baseUrl: string;
  maxUploadBytes: number;
  /** Optional display name shown as the creator on watch pages. */
  creatorName: string;
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = intEnv(env.PORT, 3000);
  const dataDir = path.resolve(env.DATA_DIR || './openloom-data');
  fs.mkdirSync(path.join(dataDir, 'videos'), { recursive: true });

  let apiKey = (env.API_KEY || '').trim();
  let apiKeyGenerated = false;
  if (!apiKey) {
    const keyFile = path.join(dataDir, 'api-key.txt');
    if (fs.existsSync(keyFile)) {
      apiKey = fs.readFileSync(keyFile, 'utf8').trim();
    }
    if (!apiKey) {
      apiKey = crypto.randomBytes(24).toString('base64url');
      fs.writeFileSync(keyFile, apiKey + '\n', { mode: 0o600 });
      apiKeyGenerated = true;
    }
  }

  const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const maxUploadBytes = intEnv(env.MAX_UPLOAD_MB, 2048) * 1024 * 1024;
  const creatorName = (env.CREATOR_NAME || '').trim();

  return { port, dataDir, apiKey, apiKeyGenerated, baseUrl, maxUploadBytes, creatorName };
}
