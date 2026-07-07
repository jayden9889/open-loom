/**
 * Full-flow integration tests against a real spawned openloom-server:
 * create -> chunked upload (with a deliberate interruption + resume) ->
 * complete -> watch page -> range stream -> password -> comments ->
 * reactions -> beacons -> activity -> download gate -> delete.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnServer, type SpawnedServer } from './spawn-server';

let server: SpawnedServer;
const VIDEO_BYTES = crypto.randomBytes(300_000);
const VIDEO_ID = 'itest12345';

function auth(json = false): Record<string, string> {
  const h: Record<string, string> = { authorization: `Bearer ${server.apiKey}` };
  if (json) h['content-type'] = 'application/json';
  return h;
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeAll(async () => {
  server = await spawnServer();
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

describe('openloom-server full flow', () => {
  it('rejects the creator API without the key', async () => {
    const res = await fetch(`${server.baseUrl}/api/videos`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('creates a video and mints the share URL', async () => {
    const res = await fetch(`${server.baseUrl}/api/videos`, {
      method: 'POST',
      headers: auth(true),
      body: JSON.stringify({
        id: VIDEO_ID,
        title: 'Integration <test> & video',
        durationSec: 10,
        width: 1280,
        height: 720,
        createdAt: '2026-07-07T09:00:00.000Z',
        chapters: [
          { t: 0, title: 'Intro' },
          { t: 5, title: 'The middle bit' },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const data = await jsonOf(res);
    expect(data.id).toBe(VIDEO_ID);
    expect(data.shareUrl).toBe(`${server.baseUrl}/v/${VIDEO_ID}`);
  });

  it('shows the processing page before the file arrives', async () => {
    const page = await (await fetch(`${server.baseUrl}/v/${VIDEO_ID}`)).text();
    expect(page).toContain('still uploading');
    const status = await jsonOf(await fetch(`${server.baseUrl}/v/${VIDEO_ID}/status`));
    expect(status.status).toBe('processing');
  });

  it('uploads in chunks, surviving an interruption via offset resume', async () => {
    const first = VIDEO_BYTES.subarray(0, 120_000);
    const res1 = await fetch(`${server.baseUrl}/api/videos/${VIDEO_ID}/files/video.mp4?offset=0`, {
      method: 'PUT',
      headers: auth(),
      body: new Uint8Array(first),
    });
    expect(res1.status).toBe(200);

    // Deliberate interruption: the client thinks it sent more than it did and
    // resumes from the wrong offset. The server answers 409 + where it stopped.
    const wrong = await fetch(`${server.baseUrl}/api/videos/${VIDEO_ID}/files/video.mp4?offset=200000`, {
      method: 'PUT',
      headers: auth(),
      body: new Uint8Array(VIDEO_BYTES.subarray(200_000)),
    });
    expect(wrong.status).toBe(409);
    expect((await jsonOf(wrong)).offset).toBe(120_000);

    // Ask the server where to resume, then finish the upload from there.
    const head = await fetch(`${server.baseUrl}/api/videos/${VIDEO_ID}/files/video.mp4`, {
      method: 'HEAD',
      headers: auth(),
    });
    const offset = Number(head.headers.get('upload-offset'));
    expect(offset).toBe(120_000);
    const res2 = await fetch(`${server.baseUrl}/api/videos/${VIDEO_ID}/files/video.mp4?offset=${offset}`, {
      method: 'PUT',
      headers: auth(),
      body: new Uint8Array(VIDEO_BYTES.subarray(offset)),
    });
    expect(res2.status).toBe(200);

    // Captions land too, then complete flips the status.
    const vtt = 'WEBVTT\n\n00:00.000 --> 00:02.000\nHello from the test\n';
    await fetch(`${server.baseUrl}/api/videos/${VIDEO_ID}/files/captions.vtt?offset=0`, {
      method: 'PUT',
      headers: auth(),
      body: vtt,
    });
    const complete = await fetch(`${server.baseUrl}/api/videos/${VIDEO_ID}/complete`, {
      method: 'POST',
      headers: auth(),
    });
    expect(complete.status).toBe(200);
    expect((await jsonOf(complete)).status).toBe('ready');

    const stored = fs.readFileSync(path.join(server.dataDir, 'videos', VIDEO_ID, 'video.mp4'));
    expect(stored.equals(VIDEO_BYTES)).toBe(true);
  });

  it('serves the watch page with the escaped title, chapters and captions', async () => {
    const res = await fetch(`${server.baseUrl}/v/${VIDEO_ID}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Integration &lt;test&gt; &amp; video');
    expect(html).toContain('The middle bit');
    expect(html).toContain(`/v/${VIDEO_ID}/captions.vtt`);
    expect(html).toContain('Test Creator');
    expect(html).not.toContain('<test>');
  });

  it('renders the chromeless embed variant', async () => {
    const html = await (await fetch(`${server.baseUrl}/v/${VIDEO_ID}?embed=1`)).text();
    expect(html).toContain('class="embed"');
    // Chromeless: no comments or reactions section markup. (The shared player
    // script still defines helpers like renderComments, so assert on the section
    // markup rather than the bare word, which also appears in JS identifiers.)
    expect(html).not.toContain('class="comments"');
    expect(html).not.toContain('class="reactions"');
  });

  it('honours Range requests on the stream', async () => {
    const res = await fetch(`${server.baseUrl}/v/${VIDEO_ID}/stream`, {
      headers: { range: 'bytes=100-199' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/300000');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(100);
    expect(body.equals(VIDEO_BYTES.subarray(100, 200))).toBe(true);
  });

  it('accepts threaded, unicode comments and flattens deep nesting to one level', async () => {
    const top = await fetch(`${server.baseUrl}/v/${VIDEO_ID}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'Zoë 观众', text: 'Great walkthrough 🎬 привет мир', atSec: 4.2 }),
    });
    expect(top.status).toBe(201);
    const topJson = await jsonOf(top);

    const reply = await fetch(`${server.baseUrl}/v/${VIDEO_ID}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'Reply Guy', text: 'Agreed 👍', parentId: topJson.id }),
    });
    expect(reply.status).toBe(201);
    const replyJson = await jsonOf(reply);
    expect(replyJson.parentId).toBe(topJson.id);

    // Replying to a reply must attach to the top-level parent (one level deep).
    const nested = await fetch(`${server.baseUrl}/v/${VIDEO_ID}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'Nester', text: 'Reply to a reply', parentId: replyJson.id }),
    });
    expect((await jsonOf(nested)).parentId).toBe(topJson.id);

    const list = await jsonOf(await fetch(`${server.baseUrl}/v/${VIDEO_ID}/comments`));
    const comments = list.comments as { author: string; text: string; atSec: number | null }[];
    expect(comments).toHaveLength(3);
    expect(comments[0]?.text).toBe('Great walkthrough 🎬 привет мир');
    expect(comments[0]?.atSec).toBe(4.2);
  });

  it('dedupes reactions per session and counts across sessions', async () => {
    const react = (sessionId: string, remove = false) =>
      fetch(`${server.baseUrl}/v/${VIDEO_ID}/reactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ emoji: '👍', sessionId, remove }),
      });
    await react('session-aaaaaa');
    const dup = await jsonOf(await react('session-aaaaaa'));
    expect((dup.counts as Record<string, number>)['👍']).toBe(1); // UNIQUE dedupe
    const second = await jsonOf(await react('session-bbbbbb'));
    expect((second.counts as Record<string, number>)['👍']).toBe(2);
    const removed = await jsonOf(await react('session-bbbbbb', true));
    expect((removed.counts as Record<string, number>)['👍']).toBe(1);
    const rejected = await fetch(`${server.baseUrl}/v/${VIDEO_ID}/reactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emoji: '🦄', sessionId: 'session-aaaaaa' }),
    });
    expect(rejected.status).toBe(400);
  });

  it('aggregates beacons into activity with completion and coverage', async () => {
    const beacon = (viewId: string, sessionId: string, body: Record<string, unknown>) =>
      fetch(`${server.baseUrl}/v/${VIDEO_ID}/beacon`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewId, sessionId, ...body }),
      });
    // Alice watches the first half across two beacons of one view.
    await beacon('view-alice-1', 'session-alice', {
      name: 'Alice',
      positionSec: 2,
      coverage: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    });
    await beacon('view-alice-1', 'session-alice', {
      positionSec: 5,
      coverage: Array.from({ length: 40 }, (_, i) => i + 10),
    });
    // Anonymous second session watches the first tenth, twice (two views).
    await beacon('view-anon-1', 'session-anon', { positionSec: 1, coverage: [0, 1, 2, 3, 4] });
    await beacon('view-anon-2', 'session-anon', { positionSec: 1, coverage: [0, 1, 2, 3, 4] });

    const res = await fetch(`${server.baseUrl}/api/videos/${VIDEO_ID}/activity`, { headers: auth() });
    expect(res.status).toBe(200);
    const activity = (await res.json()) as {
      views: number;
      uniqueViewers: number;
      completionRate: number;
      viewers: { name: string; sessions: number; maxPositionSec: number }[];
      comments: unknown[];
      reactions: Record<string, number>;
      viewsByDay: { day: string; views: number }[];
      coverage: number[];
    };
    expect(activity.views).toBe(3);
    expect(activity.uniqueViewers).toBe(2);
    // Alice covered 50 buckets, anon covered 5: mean of 0.5 and 0.05.
    expect(activity.completionRate).toBeCloseTo(0.275, 3);
    expect(activity.coverage).toHaveLength(100);
    expect(activity.coverage[0]).toBe(1); // both sessions saw the opening
    expect(activity.coverage[20]).toBe(0.5); // only Alice got here
    expect(activity.coverage[99]).toBe(0);
    const alice = activity.viewers.find((v) => v.name === 'Alice');
    expect(alice?.maxPositionSec).toBe(5);
    const anon = activity.viewers.find((v) => v.name === 'Anonymous');
    expect(anon?.sessions).toBe(2);
    expect(activity.comments).toHaveLength(3);
    expect(activity.reactions['👍']).toBe(1);
    expect(activity.viewsByDay.reduce((n, d) => n + d.views, 0)).toBe(3);
  });

  it('lets the creator delete a comment and its replies', async () => {
    const list = await jsonOf(await fetch(`${server.baseUrl}/v/${VIDEO_ID}/comments`));
    const top = (list.comments as { id: string; parentId: string | null }[]).find((c) => !c.parentId);
    const res = await fetch(`${server.baseUrl}/api/videos/${VIDEO_ID}/comments/${top?.id}`, {
      method: 'DELETE',
      headers: auth(),
    });
    expect(res.status).toBe(200);
    const after = await jsonOf(await fetch(`${server.baseUrl}/v/${VIDEO_ID}/comments`));
    expect(after.comments).toHaveLength(0);
  });

  it('locks the video behind a password and unlocks with a cookie', async () => {
    const patch = await fetch(`${server.baseUrl}/api/videos/${VIDEO_ID}`, {
      method: 'PATCH',
      headers: auth(true),
      body: JSON.stringify({ privacy: 'password', password: 'sesame42' }),
    });
    expect(patch.status).toBe(200);

    const lockedPage = await fetch(`${server.baseUrl}/v/${VIDEO_ID}`);
    expect(lockedPage.status).toBe(403);
    expect(await lockedPage.text()).toContain('password protected');
    expect((await fetch(`${server.baseUrl}/v/${VIDEO_ID}/stream`)).status).toBe(403);
    expect((await fetch(`${server.baseUrl}/v/${VIDEO_ID}/comments`)).status).toBe(403);

    const bad = await fetch(`${server.baseUrl}/v/${VIDEO_ID}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    expect(bad.status).toBe(403);

    const good = await fetch(`${server.baseUrl}/v/${VIDEO_ID}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'sesame42' }),
    });
    expect(good.status).toBe(200);
    const cookie = (good.headers.get('set-cookie') ?? '').split(';')[0] as string;
    expect(cookie).toContain(`olv_${VIDEO_ID}=`);

    const unlockedPage = await fetch(`${server.baseUrl}/v/${VIDEO_ID}`, { headers: { cookie } });
    expect(unlockedPage.status).toBe(200);
    expect((await fetch(`${server.baseUrl}/v/${VIDEO_ID}/stream`, { headers: { cookie } })).status).toBe(200);

    // Clearing the password reopens the link.
    await fetch(`${server.baseUrl}/api/videos/${VIDEO_ID}`, {
      method: 'PATCH',
      headers: auth(true),
      body: JSON.stringify({ password: '' }),
    });
    expect((await fetch(`${server.baseUrl}/v/${VIDEO_ID}`)).status).toBe(200);
  });

  it('enforces allow_download and allow_comments server-side', async () => {
    await fetch(`${server.baseUrl}/api/videos/${VIDEO_ID}`, {
      method: 'PATCH',
      headers: auth(true),
      body: JSON.stringify({ allowDownload: false, allowComments: false }),
    });
    expect((await fetch(`${server.baseUrl}/v/${VIDEO_ID}/download`)).status).toBe(403);
    const comment = await fetch(`${server.baseUrl}/v/${VIDEO_ID}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'X', text: 'should bounce' }),
    });
    expect(comment.status).toBe(403);

    await fetch(`${server.baseUrl}/api/videos/${VIDEO_ID}`, {
      method: 'PATCH',
      headers: auth(true),
      body: JSON.stringify({ allowDownload: true }),
    });
    const download = await fetch(`${server.baseUrl}/v/${VIDEO_ID}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('attachment');
  });

  it('deletes the video, its rows and its files', async () => {
    const res = await fetch(`${server.baseUrl}/api/videos/${VIDEO_ID}`, {
      method: 'DELETE',
      headers: auth(),
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(server.dataDir, 'videos', VIDEO_ID))).toBe(false);
    expect((await fetch(`${server.baseUrl}/v/${VIDEO_ID}`)).status).toBe(404);
    expect((await fetch(`${server.baseUrl}/v/${VIDEO_ID}/status`)).status).toBe(404);
  });
});
