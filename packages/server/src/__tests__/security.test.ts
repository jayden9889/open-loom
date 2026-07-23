/**
 * Regression tests for the anonymous-viewer abuse surfaces: oversized bodies,
 * comment/reaction/beacon flooding, unbounded view minting, unlock brute force,
 * cookie hardening and the create-path password invariant. These run the real
 * Hono app in-process (app.request) so each app gets its own fresh rate-limiter
 * state and no TLS is needed to exercise the HTTPS cookie logic.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { createServerApp, type ServerApp } from '../app.js';

const API_KEY = 'sec-test-key-0123456789';
const spawned: { srv: ServerApp; dataDir: string }[] = [];

function makeApp(baseUrl = 'http://localhost:3000'): ServerApp {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-sec-'));
  const cfg = loadConfig({ DATA_DIR: dataDir, API_KEY, BASE_URL: baseUrl, PORT: '3000' } as NodeJS.ProcessEnv);
  const srv = createServerApp(cfg);
  spawned.push({ srv, dataDir });
  return srv;
}

const authJson = { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' };

async function createVideo(srv: ServerApp, body: Record<string, unknown> = {}): Promise<string> {
  const res = await srv.app.request('/api/videos', {
    method: 'POST',
    headers: authJson,
    body: JSON.stringify(body),
  });
  return ((await res.json()) as { id: string }).id;
}

function post(srv: ServerApp, pathname: string, body: unknown): Promise<Response> {
  return srv.app.request(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  for (const { srv, dataDir } of spawned.splice(0)) {
    srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('viewer abuse hardening', () => {
  it('rejects an oversized beacon body with 413 before parsing', async () => {
    const srv = makeApp();
    const id = await createVideo(srv, { id: 'oversize123' });
    const res = await post(srv, `/v/${id}/beacon`, {
      viewId: 'aaaaaa',
      sessionId: 'bbbbbb',
      pad: 'x'.repeat(70 * 1024),
    });
    expect(res.status).toBe(413);
  });

  it('caps distinct view rows a single IP can mint for one video', async () => {
    const srv = makeApp();
    const id = await createVideo(srv, { id: 'viewmint123' });
    for (let i = 0; i < 45; i++) {
      const n = String(i).padStart(6, '0');
      const res = await post(srv, `/v/${id}/beacon`, { viewId: `view${n}`, sessionId: `sess${n}` });
      expect(res.status).toBe(204);
    }
    const activity = (await (
      await srv.app.request(`/api/videos/${id}/activity`, { headers: { authorization: `Bearer ${API_KEY}` } })
    ).json()) as { views: number };
    // viewMint limiter allows 40 fresh views per IP+video; the rest are dropped.
    expect(activity.views).toBe(40);
  });

  it('rate-limits comment floods with 429', async () => {
    const srv = makeApp();
    const id = await createVideo(srv, { id: 'commentddos' });
    let created = 0;
    let blocked = false;
    for (let i = 0; i < 25; i++) {
      const res = await post(srv, `/v/${id}/comments`, { text: `spam ${i}` });
      if (res.status === 201) created++;
      if (res.status === 429) blocked = true;
    }
    expect(created).toBe(20);
    expect(blocked).toBe(true);
  });

  it('rate-limits reaction floods with 429', async () => {
    const srv = makeApp();
    const id = await createVideo(srv, { id: 'reactddos12' });
    let blocked = false;
    for (let i = 0; i < 45; i++) {
      const n = String(i).padStart(6, '0');
      const res = await post(srv, `/v/${id}/reactions`, { emoji: '\u{1F44D}', sessionId: `sess${n}` });
      if (res.status === 429) blocked = true;
    }
    expect(blocked).toBe(true);
  });

  it('locks out unlock brute force per IP+video and still unlocks a fresh video (async compare)', async () => {
    const srv = makeApp();
    const id = await createVideo(srv, { id: 'brutevid123' });
    await srv.app.request(`/api/videos/${id}`, {
      method: 'PATCH',
      headers: authJson,
      body: JSON.stringify({ privacy: 'password', password: 'sesame42' }),
    });

    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      statuses.push((await post(srv, `/v/${id}/unlock`, { password: 'wrong' })).status);
    }
    // 8 wrong guesses answer 403, the 9th trips the lockout.
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(403));
    expect(statuses[8]).toBe(429);

    // A different video is a separate bucket: the correct password still unlocks
    // it, proving the async bcrypt.compare path works.
    const id2 = await createVideo(srv, { id: 'brutevid456' });
    await srv.app.request(`/api/videos/${id2}`, {
      method: 'PATCH',
      headers: authJson,
      body: JSON.stringify({ privacy: 'password', password: 'hunter2!' }),
    });
    const good = await post(srv, `/v/${id2}/unlock`, { password: 'hunter2!' });
    expect(good.status).toBe(200);
  });

  it('a spoofed X-Forwarded-For cannot bypass the unlock lockout when trustProxy is off (default)', async () => {
    const srv = makeApp();
    const id = await createVideo(srv, { id: 'spoofvid123' });
    await srv.app.request(`/api/videos/${id}`, {
      method: 'PATCH',
      headers: authJson,
      body: JSON.stringify({ privacy: 'password', password: 'sesame42' }),
    });

    // Every guess forges a fresh client IP. With trustProxy off the header is
    // ignored, so all attempts share the socket bucket and the lockout still trips.
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      const res = await srv.app.request(`/v/${id}/unlock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i}` },
        body: JSON.stringify({ password: 'wrong' }),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(403));
    expect(statuses[8]).toBe(429);
  });
});

describe('unlock cookie hardening', () => {
  it('marks the cookie Secure + SameSite=Lax over HTTPS (same-origin)', async () => {
    const srv = makeApp('https://videos.example.test');
    const id = await createVideo(srv, { id: 'cookiehttps' });
    await srv.app.request(`/api/videos/${id}`, {
      method: 'PATCH',
      headers: authJson,
      body: JSON.stringify({ privacy: 'password', password: 'sesame42' }),
    });
    const res = await post(srv, `/v/${id}/unlock`, { password: 'sesame42' });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('SameSite=None');
  });

  it('uses SameSite=None; Secure for an embedded unlock over HTTPS', async () => {
    const srv = makeApp('https://videos.example.test');
    const id = await createVideo(srv, { id: 'cookieembed' });
    await srv.app.request(`/api/videos/${id}`, {
      method: 'PATCH',
      headers: authJson,
      body: JSON.stringify({ privacy: 'password', password: 'sesame42' }),
    });
    const res = await post(srv, `/v/${id}/unlock?embed=1`, { password: 'sesame42' });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Secure');
  });

  it('never marks the cookie Secure over plain HTTP', async () => {
    const srv = makeApp('http://localhost:3000');
    const id = await createVideo(srv, { id: 'cookiehttp1' });
    await srv.app.request(`/api/videos/${id}`, {
      method: 'PATCH',
      headers: authJson,
      body: JSON.stringify({ privacy: 'password', password: 'sesame42' }),
    });
    const res = await post(srv, `/v/${id}/unlock`, { password: 'sesame42' });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });
});

describe('create-path password invariant', () => {
  it('forces privacy back to link when privacy=password arrives with no password', async () => {
    const srv = makeApp();
    const id = await createVideo(srv, { id: 'noreadpass1', title: 'Q3 numbers', privacy: 'password' });
    const video = (await (
      await srv.app.request(`/api/videos/${id}`, { headers: { authorization: `Bearer ${API_KEY}` } })
    ).json()) as { privacy: string };
    expect(video.privacy).toBe('link');
    // The unlock endpoint agrees the video is not protected (no false confidentiality).
    const unlock = (await post(srv, `/v/${id}/unlock`, { password: 'x' })).status;
    expect(unlock).toBe(200);
  });

  it('honours privacy=password when a password is supplied at create', async () => {
    const srv = makeApp();
    const id = await createVideo(srv, { id: 'realpass123', privacy: 'password', password: 'sesame42' });
    const video = (await (
      await srv.app.request(`/api/videos/${id}`, { headers: { authorization: `Bearer ${API_KEY}` } })
    ).json()) as { privacy: string };
    expect(video.privacy).toBe('password');
    // Locked to link holders: the watch page 403s until unlocked.
    expect((await srv.app.request(`/v/${id}`)).status).toBe(403);
  });
});
