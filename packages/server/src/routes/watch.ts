/**
 * Anonymous viewer routes: the watch page itself, the range-capable video
 * stream, page assets, password unlock and the processing status poll.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { AppCtx } from '../context.js';
import { getVideo, type VideoRow } from '../db.js';
import {
  CONTENT_TYPES,
  isUploadFile,
  parseRange,
  timingSafeEqualStr,
  unlockToken,
  type UploadFileName,
} from '../util.js';
import {
  renderNotFoundPage,
  renderPasswordPage,
  renderProcessingPage,
  renderWatchPage,
  type PageChapter,
} from '../pages/watch-page.js';
import { videoDir } from './videos.js';
import { reactionCounts } from './reactions.js';
import { isEmbed } from './embed.js';
import { clientIp, type Limiters } from '../rate-limit.js';

function cookieName(videoId: string): string {
  return `olv_${videoId}`;
}

/**
 * Build the unlock Set-Cookie header. Over HTTPS the cookie is marked Secure;
 * an embedded (cross-origin iframe) unlock over HTTPS additionally needs
 * SameSite=None so the browser sends it on the third-party /stream subresource.
 * Same-origin (non-embed) stays SameSite=Lax; plain HTTP keeps Lax (SameSite=None
 * without Secure is rejected by browsers, and Secure over HTTP would be dropped).
 */
function unlockCookie(videoId: string, token: string, baseUrl: string, embed: boolean): string {
  const https = baseUrl.startsWith('https://');
  const attrs = [
    `${cookieName(videoId)}=${token}`,
    `Path=/v/${videoId}`,
    'Max-Age=2592000',
    'HttpOnly',
  ];
  if (https && embed) {
    attrs.push('SameSite=None', 'Secure');
  } else if (https) {
    attrs.push('SameSite=Lax', 'Secure');
  } else {
    attrs.push('SameSite=Lax');
  }
  return attrs.join('; ');
}

function readCookie(c: Context, name: string): string | null {
  const header = c.req.header('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** True when the request may see a video's content (link privacy or valid unlock cookie). */
export function makeIsUnlocked(): (c: Context, video: VideoRow) => boolean {
  return (c, video) => {
    if (video.privacy !== 'password' || !video.password_hash) return true;
    const cookie = readCookie(c, cookieName(video.id));
    if (!cookie) return false;
    return timingSafeEqualStr(cookie, unlockToken(video.id, video.password_hash));
  };
}

function chaptersOf(video: VideoRow): PageChapter[] {
  if (!video.chapters_json) return [];
  try {
    const parsed = JSON.parse(video.chapters_json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (ch): ch is PageChapter =>
          typeof ch === 'object' &&
          ch !== null &&
          typeof (ch as PageChapter).t === 'number' &&
          typeof (ch as PageChapter).title === 'string'
      )
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

function fileIfExists(ctx: AppCtx, video: VideoRow, name: UploadFileName): string | null {
  const p = path.join(videoDir(ctx, video.id), name);
  try {
    return fs.statSync(p).size > 0 ? p : null;
  } catch {
    return null;
  }
}

function streamFile(c: Context, filePath: string, contentType: string, download?: string): Response {
  const size = fs.statSync(filePath).size;
  const range = parseRange(c.req.header('range'), size);
  const headers: Record<string, string> = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0',
  };
  if (download) {
    headers['content-disposition'] = `attachment; filename="${download.replace(/[^\w .-]+/g, '_')}"`;
  }
  if (range) {
    const stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
        'content-length': String(range.end - range.start + 1),
      },
    });
  }
  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers: { ...headers, 'content-length': String(size) },
  });
}

export function watchRoutes(
  ctx: AppCtx,
  isUnlocked: (c: Context, video: VideoRow) => boolean,
  limiters: Limiters
): Hono {
  const app = new Hono();

  app.get('/:id', (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    const embed = isEmbed(c);
    if (!video) return c.html(renderNotFoundPage(), 404);
    if (!isUnlocked(c, video)) return c.html(renderPasswordPage(video.id, embed), 403);
    if (video.status !== 'ready' || !fileIfExists(ctx, video, 'video.mp4')) {
      return c.html(renderProcessingPage(video.title, video.id, embed), 200);
    }
    const { counts } = reactionCounts(ctx, video.id);
    return c.html(
      renderWatchPage({
        id: video.id,
        title: video.title,
        creator: video.creator,
        createdAt: video.created_at,
        durationSec: video.duration_sec,
        allowComments: video.allow_comments === 1,
        allowReactions: video.allow_reactions === 1,
        allowDownload: video.allow_download === 1,
        cta: video.cta_label && video.cta_url ? { label: video.cta_label, url: video.cta_url } : null,
        chapters: chaptersOf(video),
        hasCaptions: fileIfExists(ctx, video, 'captions.vtt') !== null,
        hasThumb: fileIfExists(ctx, video, 'thumb.jpg') !== null,
        reactions: counts,
        embed,
      })
    );
  });

  app.get('/:id/status', (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    const ready = video.status === 'ready' && fileIfExists(ctx, video, 'video.mp4') !== null;
    return c.json({ status: ready ? 'ready' : 'processing' });
  });

  app.post('/:id/unlock', async (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    if (video.privacy !== 'password' || !video.password_hash) {
      return c.json({ ok: true, note: 'This video is not password protected.' });
    }
    // Throttle guesses per IP+video; the window doubles as a lockout.
    if (!limiters.unlock.allow(`${clientIp(c, ctx.cfg.trustProxy)}:${video.id}`)) {
      return c.json({ error: 'Too many attempts. Try again later.' }, 429);
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Send the password as JSON.' }, 400);
    }
    const password = typeof body.password === 'string' ? body.password : '';
    // Async compare so a cost-10 bcrypt hash never blocks the single event loop.
    if (!password || !(await bcrypt.compare(password, video.password_hash))) {
      return c.json({ error: 'That password is not right.' }, 403);
    }
    const token = unlockToken(video.id, video.password_hash);
    c.header('set-cookie', unlockCookie(video.id, token, ctx.cfg.baseUrl, isEmbed(c)));
    return c.json({ ok: true });
  });

  app.get('/:id/stream', (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    if (!isUnlocked(c, video)) return c.json({ error: 'This video is password protected.' }, 403);
    const file = fileIfExists(ctx, video, 'video.mp4');
    if (!file) return c.json({ error: 'The video file has not finished uploading.' }, 404);
    return streamFile(c, file, 'video/mp4');
  });

  app.get('/:id/download', (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    if (!isUnlocked(c, video)) return c.json({ error: 'This video is password protected.' }, 403);
    if (video.allow_download !== 1) {
      return c.json({ error: 'Downloads are turned off for this video.' }, 403);
    }
    const file = fileIfExists(ctx, video, 'video.mp4');
    if (!file) return c.json({ error: 'The video file has not finished uploading.' }, 404);
    return streamFile(c, file, 'video/mp4', `${video.title || video.id}.mp4`);
  });

  // Page assets: thumb.jpg, preview.gif, captions.vtt (unlock-gated like the video).
  app.get('/:id/:file{(thumb\\.jpg|preview\\.gif|captions\\.vtt)}', (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    if (!isUnlocked(c, video)) return c.json({ error: 'This video is password protected.' }, 403);
    const name = c.req.param('file');
    if (!isUploadFile(name)) return c.json({ error: 'Unknown file.' }, 404);
    const file = fileIfExists(ctx, video, name);
    if (!file) return c.json({ error: 'This file has not been uploaded.' }, 404);
    return streamFile(c, file, CONTENT_TYPES[name]);
  });

  return app;
}
