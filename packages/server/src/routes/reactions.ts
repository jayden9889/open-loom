/**
 * Emoji reactions: one per emoji per viewer session, enforced by the
 * UNIQUE(video_id, emoji, session_id) constraint. POST toggles when
 * `remove` is true; the response always carries fresh counts.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppCtx } from '../context.js';
import { getVideo, type VideoRow } from '../db.js';
import { REACTION_EMOJI, SESSION_RE, nowIso } from '../util.js';
import { clientIp, type Limiters } from '../rate-limit.js';

export function reactionCounts(ctx: AppCtx, videoId: string, sessionId?: string): {
  counts: Record<string, number>;
  mine: string[];
} {
  const rows = ctx.db
    .prepare('SELECT emoji, COUNT(*) AS n FROM reactions WHERE video_id = ? GROUP BY emoji')
    .all(videoId) as { emoji: string; n: number }[];
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.emoji] = row.n;
  let mine: string[] = [];
  if (sessionId) {
    const mineRows = ctx.db
      .prepare('SELECT emoji FROM reactions WHERE video_id = ? AND session_id = ?')
      .all(videoId, sessionId) as { emoji: string }[];
    mine = mineRows.map((r) => r.emoji);
  }
  return { counts, mine };
}

export function reactionsRoutes(
  ctx: AppCtx,
  isUnlocked: (c: Context, video: VideoRow) => boolean,
  limiters: Limiters
): Hono {
  const app = new Hono();

  app.get('/:id/reactions', (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    if (!isUnlocked(c, video)) return c.json({ error: 'This video is password protected.' }, 403);
    const sessionId = c.req.query('sessionId');
    return c.json(reactionCounts(ctx, video.id, sessionId && SESSION_RE.test(sessionId) ? sessionId : undefined));
  });

  app.post('/:id/reactions', async (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    if (!isUnlocked(c, video)) return c.json({ error: 'This video is password protected.' }, 403);
    if (video.allow_reactions !== 1) return c.json({ error: 'Reactions are turned off for this video.' }, 403);
    if (!limiters.reactions.allow(`${clientIp(c)}:${video.id}`)) {
      return c.json({ error: 'You are reacting too fast. Wait a moment and try again.' }, 429);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Reaction body must be JSON.' }, 400);
    }
    const emoji = typeof body.emoji === 'string' ? body.emoji : '';
    if (!(REACTION_EMOJI as readonly string[]).includes(emoji)) {
      return c.json({ error: 'That emoji is not in the reaction bar.' }, 400);
    }
    const sessionId = typeof body.sessionId === 'string' && SESSION_RE.test(body.sessionId) ? body.sessionId : null;
    if (!sessionId) return c.json({ error: 'sessionId is required.' }, 400);

    if (body.remove === true) {
      ctx.db
        .prepare('DELETE FROM reactions WHERE video_id = ? AND emoji = ? AND session_id = ?')
        .run(video.id, emoji, sessionId);
    } else {
      // UNIQUE(video_id, emoji, session_id) dedupes repeat posts.
      ctx.db
        .prepare(
          'INSERT OR IGNORE INTO reactions (video_id, emoji, session_id, created_at) VALUES (?, ?, ?, ?)'
        )
        .run(video.id, emoji, sessionId, nowIso());
    }
    return c.json(reactionCounts(ctx, video.id, sessionId));
  });

  return app;
}
