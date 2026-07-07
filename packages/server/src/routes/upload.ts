/**
 * Resumable chunked uploads (creator API).
 *   PUT  /api/videos/:id/files/:name?offset=N   append bytes at N
 *   HEAD /api/videos/:id/files/:name            Upload-Offset header = bytes stored
 *   POST /api/videos/:id/complete               flip status to ready
 * The offset must equal the bytes already stored; a mismatch returns 409 with
 * the current offset so the client can resume exactly where it stopped.
 */
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { AppCtx } from '../context.js';
import { getVideo } from '../db.js';
import { isUploadFile } from '../util.js';
import { videoDir } from './videos.js';

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function uploadRoutes(ctx: AppCtx): Hono {
  const app = new Hono();

  // Resume probe: how many bytes are already stored. Registered on GET (not
  // only HEAD) because @hono/node-server serves HEAD by routing it to the GET
  // handler and stripping the body; a HEAD-only route never matches and 404s.
  app.on(['GET', 'HEAD'], '/videos/:id/files/:name', (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    const name = c.req.param('name');
    if (!video || !isUploadFile(name)) return c.body(null, 404);
    const size = fileSize(path.join(videoDir(ctx, video.id), name));
    c.header('Upload-Offset', String(size));
    return c.body(null, 200);
  });

  app.put('/videos/:id/files/:name', async (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found. Create it with POST /api/videos first.' }, 404);
    const name = c.req.param('name');
    if (!isUploadFile(name)) {
      return c.json({ error: 'Unknown file name. Allowed: video.mp4, thumb.jpg, preview.gif, captions.vtt.' }, 400);
    }

    const offsetRaw = c.req.query('offset') ?? '0';
    const offset = Number(offsetRaw);
    if (!Number.isInteger(offset) || offset < 0) {
      return c.json({ error: 'offset must be a non-negative integer.' }, 400);
    }

    const dir = videoDir(ctx, video.id);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, name);
    const current = fileSize(filePath);

    if (offset === 0 && current > 0) {
      // Explicit restart from the top.
      fs.truncateSync(filePath, 0);
    } else if (offset !== current) {
      c.header('Upload-Offset', String(current));
      return c.json({ error: `Offset mismatch: ${current} bytes are stored.`, offset: current }, 409);
    }

    // Read the chunk fully. Each PUT carries one resumable chunk, so buffering it
    // is bounded by the client's chunk size. Streaming via Readable.fromWeb proved
    // unreliable across the node-server adapter (it yielded an empty stream, so
    // every upload silently stored zero bytes).
    const body = Buffer.from(await c.req.arrayBuffer());
    if (offset + body.length > ctx.cfg.maxUploadBytes) {
      return c.json(
        { error: `Upload exceeds the ${Math.round(ctx.cfg.maxUploadBytes / (1024 * 1024))} MB limit (MAX_UPLOAD_MB).` },
        413
      );
    }

    if (body.length > 0) {
      const fd = fs.openSync(filePath, offset === 0 ? 'w' : 'r+');
      try {
        fs.writeSync(fd, body, 0, body.length, offset);
      } finally {
        fs.closeSync(fd);
      }
    } else if (offset === 0) {
      // A zero-length PUT at the top still creates (or clears) the file.
      fs.closeSync(fs.openSync(filePath, 'w'));
    }

    const size = fileSize(filePath);
    c.header('Upload-Offset', String(size));
    return c.json({ ok: true, received: body.length, size });
  });

  app.post('/videos/:id/complete', (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    const dir = videoDir(ctx, video.id);
    const videoSize = fileSize(path.join(dir, 'video.mp4'));
    if (videoSize <= 0) {
      return c.json({ error: 'video.mp4 has not been uploaded yet; complete is rejected.' }, 409);
    }
    const hasCaptions = fileSize(path.join(dir, 'captions.vtt')) > 0;
    ctx.db
      .prepare('UPDATE videos SET status = ?, size_bytes = ?, transcript_vtt_path = ? WHERE id = ?')
      .run('ready', videoSize, hasCaptions ? path.join(dir, 'captions.vtt') : null, video.id);
    return c.json({ ok: true, status: 'ready', sizeBytes: videoSize });
  });

  return app;
}
