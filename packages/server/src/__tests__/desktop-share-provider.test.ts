/**
 * End-to-end proof of the desktop share path (SPEC S2 + section 7 "provider
 * adapters ... server against real server instance"): the real
 * ServerShareProvider from the desktop app, pointed at a real spawned
 * openloom-server, ingesting a real ffmpeg-produced sample video through
 * prepareShare -> chunked upload -> complete. Then it fetches the resulting
 * /v/:id watch page (title must appear) and asserts the stream honours a
 * Range request with 206. No mocks: real HTTP, real MP4, real upload protocol.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VideoMeta } from '@shared/types';
import { ServerShareProvider } from '../../../../apps/desktop/src/main/share/server';
import { spawnServer, type SpawnedServer } from './spawn-server';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const TITLE = 'Open Loom End To End Share Proof';

let server: SpawnedServer;
let filesDir: string;
let meta: VideoMeta;

beforeAll(async () => {
  server = await spawnServer();

  // Real sample video via the project's own script (H.264/AAC MP4).
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-share-proof-'));
  const videoPath = path.join(filesDir, 'video.mp4');
  execFileSync('bash', [path.join(REPO_ROOT, 'scripts', 'make-sample-video.sh'), videoPath], {
    stdio: 'pipe',
  });
  // A thumbnail + captions so the upload exercises the multi-file plan.
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath, '-frames:v', '1', path.join(filesDir, 'thumb.jpg')], {
    stdio: 'pipe',
  });
  fs.writeFileSync(path.join(filesDir, 'transcript.vtt'), 'WEBVTT\n\n00:00.000 --> 00:02.000\nProof of the share pipeline\n');

  const size = fs.statSync(videoPath).size;
  meta = {
    id: 'proof12345',
    title: TITLE,
    createdAt: '2026-07-07T09:00:00.000Z',
    durationSec: 5,
    width: 1920,
    height: 1080,
    fps: 30,
    sizeBytes: size,
    mode: 'screen',
    folderId: null,
  };
}, 120_000);

afterAll(async () => {
  if (server) await server.stop();
  if (filesDir) fs.rmSync(filesDir, { recursive: true, force: true });
});

describe('desktop ServerShareProvider against a real server', () => {
  const provider = (): ServerShareProvider =>
    new ServerShareProvider({ url: server.baseUrl, apiKey: server.apiKey });

  it('reaches the server via test()', async () => {
    expect(await provider().test()).toEqual({ ok: true });
  });

  it('rejects a bad API key via test()', async () => {
    const bad = new ServerShareProvider({ url: server.baseUrl, apiKey: 'wrong-key' });
    const r = await bad.test();
    expect(r.ok).toBe(false);
  });

  it('mints a share URL and uploads the video + assets end to end', async () => {
    const p = provider();
    const { shareUrl, uploadPlan } = await p.prepareShare(meta);
    expect(shareUrl).toBe(`${server.baseUrl}/v/${meta.id}`);

    const progress: number[] = [];
    await p.upload(uploadPlan, filesDir, (info) => progress.push(info.pct));
    expect(progress.at(-1)).toBe(100);

    // The uploaded bytes match the local file exactly.
    const stored = fs.readFileSync(path.join(server.dataDir, 'videos', meta.id, 'video.mp4'));
    expect(stored.equals(fs.readFileSync(path.join(filesDir, 'video.mp4')))).toBe(true);

    const status = await (await fetch(`${server.baseUrl}/v/${meta.id}/status`)).json();
    expect(status.status).toBe('ready');
  });

  it('serves the watch page with the video title', async () => {
    const res = await fetch(`${server.baseUrl}/v/${meta.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(TITLE);
  });

  it('honours a Range request on the stream with 206', async () => {
    const res = await fetch(`${server.baseUrl}/v/${meta.id}/stream`, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-99\//);
    expect(Number(res.headers.get('content-length'))).toBe(100);
    await res.arrayBuffer();
  });

  it('reports activity and removes the remote copy', async () => {
    const p = provider();
    const activity = await p.fetchActivity(meta.id);
    expect(typeof activity.views).toBe('number');
    expect(Array.isArray(activity.comments)).toBe(true);

    await p.remove(meta.id);
    expect((await fetch(`${server.baseUrl}/v/${meta.id}/status`)).status).toBe(404);
  });
});
