/**
 * Viewer beacons + creator activity aggregation (SPEC V3).
 * A view = one page load (client-minted view id) tied to a persistent
 * session id; progress beacons update max position and 100-bucket coverage.
 */
import { Hono } from 'hono';
import type { AppCtx } from '../context.js';
import { getVideo, type CommentRow, type ViewRow, type VideoRow } from '../db.js';
import { COVERAGE_BUCKETS, SESSION_RE, nowIso } from '../util.js';
import { clientIp, type Limiters } from '../rate-limit.js';

function parseCoverage(json: string): boolean[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return new Array<boolean>(COVERAGE_BUCKETS).fill(false);
    const out = new Array<boolean>(COVERAGE_BUCKETS).fill(false);
    for (let i = 0; i < COVERAGE_BUCKETS; i++) out[i] = arr[i] === 1 || arr[i] === true;
    return out;
  } catch {
    return new Array<boolean>(COVERAGE_BUCKETS).fill(false);
  }
}

function serializeCoverage(cov: boolean[]): string {
  return JSON.stringify(cov.map((b) => (b ? 1 : 0)));
}

/** Viewer side: POST /v/:id/beacon */
export function beaconRoutes(
  ctx: AppCtx,
  isUnlocked: (c: import('hono').Context, video: VideoRow) => boolean,
  limiters: Limiters
): Hono {
  const app = new Hono();

  app.post('/:id/beacon', async (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    if (!isUnlocked(c, video)) return c.json({ error: 'This video is password protected.' }, 403);
    const ip = clientIp(c, ctx.cfg.trustProxy);
    if (!limiters.beacon.allow(`${ip}:${video.id}`)) {
      return c.json({ error: 'Too many beacons. Slow down.' }, 429);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Beacon body must be JSON.' }, 400);
    }
    const viewId = typeof body.viewId === 'string' && SESSION_RE.test(body.viewId) ? body.viewId : null;
    const sessionId = typeof body.sessionId === 'string' && SESSION_RE.test(body.sessionId) ? body.sessionId : null;
    if (!viewId || !sessionId) return c.json({ error: 'viewId and sessionId are required.' }, 400);

    const name =
      typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : null;
    const positionSec =
      typeof body.positionSec === 'number' && Number.isFinite(body.positionSec) && body.positionSec >= 0
        ? body.positionSec
        : 0;
    // Only COVERAGE_BUCKETS distinct indices can ever matter; clamp the array so
    // a giant coverage payload can never blow up the loop below.
    const bucketsIn = Array.isArray(body.coverage)
      ? (body.coverage as unknown[]).slice(0, COVERAGE_BUCKETS)
      : [];

    const existing = ctx.db
      .prepare('SELECT * FROM views WHERE id = ? AND video_id = ?')
      .get(viewId, video.id) as ViewRow | undefined;
    const now = nowIso();

    const coverage = existing ? parseCoverage(existing.coverage_json) : new Array<boolean>(COVERAGE_BUCKETS).fill(false);
    for (const b of bucketsIn) {
      if (typeof b === 'number' && Number.isInteger(b) && b >= 0 && b < COVERAGE_BUCKETS) coverage[b] = true;
    }

    if (existing) {
      ctx.db
        .prepare(
          `UPDATE views SET last_beacon_at = ?, max_position_sec = ?, coverage_json = ?,
             viewer_name = COALESCE(?, viewer_name)
           WHERE id = ?`
        )
        .run(now, Math.max(existing.max_position_sec, positionSec), serializeCoverage(coverage), name, viewId);
    } else {
      // Minting a brand-new view row is the unbounded-growth vector: a fresh
      // viewId per request would spawn a row each time. Cap distinct new views
      // per IP+video per window; over the cap we ack without inserting so a real
      // viewer's later beacons (which UPDATE an existing row) keep working.
      if (!limiters.viewMint.allow(`${ip}:${video.id}`)) return c.body(null, 204);
      ctx.db
        .prepare(
          `INSERT INTO views (id, video_id, session_id, viewer_name, started_at, last_beacon_at, max_position_sec, coverage_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(viewId, video.id, sessionId, name, now, now, positionSec, serializeCoverage(coverage));
    }
    return c.body(null, 204);
  });

  return app;
}

export interface ActivityJson {
  views: number;
  uniqueViewers: number;
  completionRate: number;
  viewers: { name: string; sessions: number; maxPositionSec: number; lastSeenAt: string }[];
  comments: { id: string; parentId: string | null; author: string; text: string; atSec: number | null; createdAt: string }[];
  reactions: Record<string, number>;
  viewsByDay: { day: string; views: number }[];
  coverage: number[];
}

export function aggregateActivity(ctx: AppCtx, video: VideoRow): ActivityJson {
  const viewRows = ctx.db
    .prepare('SELECT * FROM views WHERE video_id = ? ORDER BY started_at ASC')
    .all(video.id) as ViewRow[];

  // Merge coverage per session, then average across sessions.
  const bySession = new Map<string, { name: string | null; rows: ViewRow[]; coverage: boolean[] }>();
  for (const row of viewRows) {
    let entry = bySession.get(row.session_id);
    if (!entry) {
      entry = { name: null, rows: [], coverage: new Array<boolean>(COVERAGE_BUCKETS).fill(false) };
      bySession.set(row.session_id, entry);
    }
    entry.rows.push(row);
    if (row.viewer_name) entry.name = row.viewer_name;
    const cov = parseCoverage(row.coverage_json);
    for (let i = 0; i < COVERAGE_BUCKETS; i++) {
      if (cov[i]) entry.coverage[i] = true;
    }
  }

  const sessions = [...bySession.values()];
  const coverage = new Array<number>(COVERAGE_BUCKETS).fill(0);
  let completionSum = 0;
  for (const s of sessions) {
    let covered = 0;
    for (let i = 0; i < COVERAGE_BUCKETS; i++) {
      if (s.coverage[i]) {
        covered++;
        coverage[i] = (coverage[i] ?? 0) + 1;
      }
    }
    completionSum += covered / COVERAGE_BUCKETS;
  }
  const coverageAvg = coverage.map((n) => (sessions.length ? n / sessions.length : 0));

  const viewers = sessions
    .map((s) => ({
      name: s.name ?? 'Anonymous',
      sessions: s.rows.length,
      maxPositionSec: Math.max(0, ...s.rows.map((r) => r.max_position_sec)),
      lastSeenAt: s.rows.reduce((max, r) => (r.last_beacon_at > max ? r.last_beacon_at : max), ''),
    }))
    .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));

  const byDay = new Map<string, number>();
  for (const row of viewRows) {
    const day = row.started_at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const viewsByDay = [...byDay.entries()]
    .map(([day, views]) => ({ day, views }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  const commentRows = ctx.db
    .prepare('SELECT * FROM comments WHERE video_id = ? ORDER BY created_at ASC')
    .all(video.id) as CommentRow[];
  const reactionRows = ctx.db
    .prepare('SELECT emoji, COUNT(*) AS n FROM reactions WHERE video_id = ? GROUP BY emoji')
    .all(video.id) as { emoji: string; n: number }[];
  const reactions: Record<string, number> = {};
  for (const r of reactionRows) reactions[r.emoji] = r.n;

  return {
    views: viewRows.length,
    uniqueViewers: sessions.length,
    completionRate: sessions.length ? completionSum / sessions.length : 0,
    viewers,
    comments: commentRows.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      author: row.author,
      text: row.text,
      atSec: row.at_sec,
      createdAt: row.created_at,
    })),
    reactions,
    viewsByDay,
    coverage: coverageAvg,
  };
}

/** Creator side: GET /api/videos/:id/activity */
export function activityRoutes(ctx: AppCtx): Hono {
  const app = new Hono();
  app.get('/videos/:id/activity', (c) => {
    const video = getVideo(ctx.db, c.req.param('id'));
    if (!video) return c.json({ error: 'Video not found.' }, 404);
    return c.json(aggregateActivity(ctx, video));
  });
  return app;
}
