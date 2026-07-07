/**
 * Test helper: build (once) and spawn a real openloom-server child process on
 * a temp data dir + random port. Used by the server flow tests and the
 * desktop server-provider tests.
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const DIST_ENTRY = path.join(SERVER_DIR, 'dist', 'index.js');
const LOCK_DIR = path.join(SERVER_DIR, '.build-lock');

function distFresh(): boolean {
  if (!fs.existsSync(DIST_ENTRY)) return false;
  const distMtime = fs.statSync(DIST_ENTRY).mtimeMs;
  const srcDir = path.join(SERVER_DIR, 'src');
  const stack = [srcDir];
  while (stack.length) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.endsWith('.ts') && fs.statSync(p).mtimeMs > distMtime) return false;
    }
  }
  return true;
}

/** Build dist/ if stale. Safe under parallel vitest workers via a dir lock. */
export function ensureServerBuilt(): void {
  if (distFresh()) return;
  try {
    fs.mkdirSync(LOCK_DIR);
  } catch {
    // Another worker is building; wait for it.
    const deadline = Date.now() + 120_000;
    while (fs.existsSync(LOCK_DIR) && Date.now() < deadline) {
      execSync('sleep 0.5');
    }
    if (!fs.existsSync(DIST_ENTRY)) throw new Error('openloom-server build did not produce dist/index.js');
    return;
  }
  try {
    execSync('npm run build -w packages/server', { cwd: REPO_ROOT, stdio: 'pipe' });
  } finally {
    fs.rmdirSync(LOCK_DIR);
  }
}

export interface SpawnedServer {
  port: number;
  baseUrl: string;
  apiKey: string;
  dataDir: string;
  child: ChildProcess;
  stop(): Promise<void>;
}

export async function spawnServer(): Promise<SpawnedServer> {
  ensureServerBuilt();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-server-test-'));
  const apiKey = 'test-api-key-0123456789';
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [DIST_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      API_KEY: apiKey,
      BASE_URL: baseUrl,
      MAX_UPLOAD_MB: '64',
      CREATOR_NAME: 'Test Creator',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (d: Buffer) => (logs += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (logs += d.toString()));

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) throw new Error(`openloom-server exited early:\n${logs}`);
    if (Date.now() > deadline) throw new Error(`openloom-server did not come up in time:\n${logs}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    port,
    baseUrl,
    apiKey,
    dataDir,
    child,
    async stop() {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3_000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
