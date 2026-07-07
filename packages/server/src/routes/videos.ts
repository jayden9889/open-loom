/**
 * Creator API (Bearer API_KEY): mint videos, patch share settings, delete,
 * moderate comments. Upload endpoints live in upload.ts, activity in
 * analytics.ts.
 */
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { AppCtx } from '../context.js';
import { getVideo, type VideoRow } from '../db.js';
import { ID_RE, nowIso, timingSafeEqualStr } from '../util.js';

export function creatorAuth(ctx: AppCtx) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const header = c.req.header('authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token || !timingSafeEqualStr(token, ctx.cfg.apiKey)) {
      return c.json({ error: 'Unauthorized. Send the server API key as a Bearer token.' }, 401);
    }
    await next();
  };
}

export function videoDir(ctx: AppCtx, id: string): string {
  return path.join(ctx.cfg.dataDir, 'videos', id);
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asBoolInt(v: unknown, fallback: 0 | 1): 0 | 1 {
  return typeof v === 'boolean' ? (v ? 1 : 0) : fallback;
}

interface ChapterInput {
  t: number;
  title: string;
}

function sanitizeChapters(v: unknown): ChapterInput[] | null {
  if (!Array.isArray(v)) return null;
  const out: ChapterInput[] = [];
  for (const item of v) {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as ChapterInput).t === 'number' &&
      typeof (item as ChapterInput).title === 'string'
    ) {
      out.push({ t: (item as ChapterInput).t, title: (item as ChapterInput).title.slice(0, 200) });
    }
  }
  return out;
}

export function videosRoutes(ctx: AppCtx): Hono {
  const app = new Hono();

  // Connection test for the desktop app's "Test" button.
  app.get('/ping', (c) => c.json({ ok: true, name: 'openloom-server' }));

  app.post('/videos', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Body must be JSON video metadata.' }, 400);
    }
    let id = typeof body.id === 'string' && ID_RE.test(body.id) ? body.id : nanoid(10);
    if (getVideo(ctx.db, id)) id = nanoid(10);

    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 300) : 'Untitled recording';
    const dir = videoDir(ctx, id);
    fs.mkdirSync(dir, { recursive: true });

    const creator =
      typeof body.creator === 'string' && body.creator.trim()
        ? body.creator.trim().slice(0, 120)
        : ctx.cfg.creatorName || null;

    ctx.db
      .prepare(
        `INSERT INTO videos (id, title, description, creator, created_at, duration_sec, width, height,
           size_bytes, status, privacy, allow_comments, allow_reactions, allow_download, chapters_json, files_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        title,
        typeof body.description === 'string' ? body.description.slice(0, 5000) : null,
        creator,
        typeof body.createdAt === 'string' ? body.createdAt : nowIso(),
        asNumber(body.durationSec),
        asNumber(body.width),
        asNumber(body.height),
        asNumber(body.sizeBytes),
        body.privacy === 'password' ? 'password' : 'link',
        asBoolInt(body.allowComments, 1),
        asBoolInt(body.allowReactions, 1),
        asBoolInt(body.allowDownload, 1),
        sanitizeChapters(body.chapters) ? JSON.stringify(sanitizeChapters(body.chapters)) : null,
        dir
      );

    return c.json(
      {
        id,
        shareUrl: `${ctx.cfg.baseUrl}/v/${id}`,
        uploadUrl: `${ctx.cfg.baseUrl}/api/videos/${id}/files`,
      },
      201
    );
  });

  app.get('/videos/:id', (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    return c.json(publicVideoJson(ctx, video));
  });

  app.patch('/videos/:id', async (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Body must be a JSON patch.' }, 400);
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, value: unknown): void => {
      sets.push(`${col} = ?`);
      params.push(value);
    };

    if (typeof body.title === 'string' && body.title.trim()) set('title', body.title.trim().slice(0, 300));
    if (typeof body.description === 'string') set('description', body.description.slice(0, 5000) || null);
    if (typeof body.creator === 'string') set('creator', body.creator.trim().slice(0, 120) || null);
    if (typeof body.durationSec === 'number' && Number.isFinite(body.durationSec)) {
      set('duration_sec', body.durationSec);
    }
    if (typeof body.allowComments === 'boolean') set('allow_comments', body.allowComments ? 1 : 0);
    if (typeof body.allowReactions === 'boolean') set('allow_reactions', body.allowReactions ? 1 : 0);
    if (typeof body.allowDownload === 'boolean') set('allow_download', body.allowDownload ? 1 : 0);

    if ('cta' in body) {
      const cta = body.cta as { label?: unknown; url?: unknown } | null;
      if (
        cta &&
        typeof cta.label === 'string' &&
        cta.label.trim() &&
        typeof cta.url === 'string' &&
        /^https?:\/\//.test(cta.url)
      ) {
        set('cta_label', cta.label.trim().slice(0, 80));
        set('cta_url', cta.url.slice(0, 2000));
      } else {
        set('cta_label', null);
        set('cta_url', null);
      }
    }

    if ('chapters' in body) {
      const chapters = sanitizeChapters(body.chapters);
      set('chapters_json', chapters && chapters.length ? JSON.stringify(chapters) : null);
    }

    // Password handling: a non-empty string sets it, ''/null clears it.
    let passwordHash: string | null | undefined;
    if ('password' in body) {
      if (typeof body.password === 'string' && body.password.length > 0) {
        if (body.password.length < 4) {
          return c.json({ error: 'Password must be at least 4 characters.' }, 400);
        }
        passwordHash = bcrypt.hashSync(body.password, 10);
      } else {
        passwordHash = null;
      }
      set('password_hash', passwordHash);
    }

    if ('privacy' in body) {
      if (body.privacy !== 'link' && body.privacy !== 'password') {
        return c.json({ error: "privacy must be 'link' or 'password'." }, 400);
      }
      const effectiveHash = passwordHash === undefined ? video.password_hash : passwordHash;
      if (body.privacy === 'password' && !effectiveHash) {
        return c.json({ error: 'Set a password in the same request when switching privacy to password.' }, 400);
      }
      set('privacy', body.privacy);
    } else if (passwordHash === null && video.privacy === 'password') {
      // Clearing the password on a password-locked video falls back to link privacy.
      set('privacy', 'link');
    }

    if (sets.length === 0) return c.json({ ok: true, unchanged: true });
    params.push(video.id);
    ctx.db.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    const updated = getVideo(ctx.db, video.id);
    return c.json(publicVideoJson(ctx, updated as VideoRow));
  });

  app.delete('/videos/:id', (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    fs.rmSync(videoDir(ctx, video.id), { recursive: true, force: true });
    ctx.db.prepare('DELETE FROM comments WHERE video_id = ?').run(video.id);
    ctx.db.prepare('DELETE FROM reactions WHERE video_id = ?').run(video.id);
    ctx.db.prepare('DELETE FROM views WHERE video_id = ?').run(video.id);
    ctx.db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);
    return c.json({ ok: true });
  });

  // Creator moderation: delete a comment (and its replies).
  app.delete('/videos/:id/comments/:commentId', (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    const commentId = c.req.param('commentId');
    const result = ctx.db
      .prepare('DELETE FROM comments WHERE video_id = ? AND (id = ? OR parent_id = ?)')
      .run(video.id, commentId, commentId);
    if (result.changes === 0) return c.json({ error: 'Comment not found.' }, 404);
    return c.json({ ok: true, deleted: result.changes });
  });

  return app;
}

export function publicVideoJson(ctx: AppCtx, video: VideoRow): Record<string, unknown> {
  return {
    id: video.id,
    title: video.title,
    description: video.description,
    creator: video.creator,
    createdAt: video.created_at,
    durationSec: video.duration_sec,
    width: video.width,
    height: video.height,
    sizeBytes: video.size_bytes,
    status: video.status,
    privacy: video.privacy,
    allowComments: video.allow_comments === 1,
    allowReactions: video.allow_reactions === 1,
    allowDownload: video.allow_download === 1,
    cta: video.cta_label && video.cta_url ? { label: video.cta_label, url: video.cta_url } : null,
    chapters: video.chapters_json ? (JSON.parse(video.chapters_json) as unknown) : null,
    shareUrl: `${ctx.cfg.baseUrl}/v/${video.id}`,
  };
}
