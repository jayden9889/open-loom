/**
 * Anonymous viewer comments: threaded one level, optional video timestamp.
 * Creator moderation (delete) lives in videos.ts behind the API key.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { nanoid } from 'nanoid';
import type { AppCtx } from '../context.js';
import { getVideo, type CommentRow, type VideoRow } from '../db.js';
import { nowIso } from '../util.js';

export function commentsRoutes(ctx: AppCtx, isUnlocked: (c: Context, video: VideoRow) => boolean): Hono {
  const app = new Hono();

  app.get('/:id/comments', (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    if (!isUnlocked(c, video)) return c.json({ error: 'This video is password protected.' }, 403);
    if (video.allow_comments !== 1) return c.json({ error: 'Comments are turned off for this video.' }, 403);
    const rows = ctx.db
      .prepare('SELECT * FROM comments WHERE video_id = ? ORDER BY created_at ASC')
      .all(video.id) as CommentRow[];
    return c.json({
      comments: rows.map((row) => ({
        id: row.id,
        parentId: row.parent_id,
        author: row.author,
        text: row.text,
        atSec: row.at_sec,
        createdAt: row.created_at,
      })),
    });
  });

  app.post('/:id/comments', async (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    if (!isUnlocked(c, video)) return c.json({ error: 'This video is password protected.' }, 403);
    if (video.allow_comments !== 1) return c.json({ error: 'Comments are turned off for this video.' }, 403);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Comment body must be JSON.' }, 400);
    }

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return c.json({ error: 'Write something before posting.' }, 400);
    if (text.length > 5000) return c.json({ error: 'Comments are capped at 5000 characters.' }, 400);

    const author =
      typeof body.author === 'string' && body.author.trim() ? body.author.trim().slice(0, 80) : 'Anonymous';
    const atSec =
      typeof body.atSec === 'number' && Number.isFinite(body.atSec) && body.atSec >= 0
        ? Math.round(body.atSec * 10) / 10
        : null;

    let parentId: string | null = null;
    if (typeof body.parentId === 'string' && body.parentId) {
      const parent = ctx.db
        .prepare('SELECT * FROM comments WHERE id = ? AND video_id = ?')
        .get(body.parentId, video.id) as CommentRow | undefined;
      if (!parent) return c.json({ error: 'The comment you are replying to no longer exists.' }, 400);
      // Threads are one level deep: replying to a reply attaches to its parent.
      parentId = parent.parent_id ?? parent.id;
    }

    const comment: CommentRow = {
      id: nanoid(12),
      video_id: video.id,
      parent_id: parentId,
      author,
      text,
      at_sec: atSec,
      created_at: nowIso(),
    };
    ctx.db
      .prepare(
        `INSERT INTO comments (id, video_id, parent_id, author, text, at_sec, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(comment.id, comment.video_id, comment.parent_id, comment.author, comment.text, comment.at_sec, comment.created_at);

    return c.json(
      {
        id: comment.id,
        parentId: comment.parent_id,
        author: comment.author,
        text: comment.text,
        atSec: comment.at_sec,
        createdAt: comment.created_at,
      },
      201
    );
  });

  return app;
}
