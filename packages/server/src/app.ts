/**
 * Application assembly: creator API behind Bearer auth, anonymous viewer
 * routes, health check. index.ts binds this to a listening socket.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { openDb } from './db.js';
import type { ServerConfig } from './config.js';
import type { AppCtx } from './context.js';
import { creatorAuth, videosRoutes } from './routes/videos.js';
import { uploadRoutes } from './routes/upload.js';
import { activityRoutes, beaconRoutes } from './routes/analytics.js';
import { watchRoutes, makeIsUnlocked } from './routes/watch.js';
import { commentsRoutes } from './routes/comments.js';
import { reactionsRoutes } from './routes/reactions.js';
import { createLimiters } from './rate-limit.js';
import path from 'node:path';

/** Viewer POST bodies (comment/reaction/beacon/unlock) are tiny; cap hard. */
const VIEWER_BODY_LIMIT = 64 * 1024;

export interface ServerApp {
  app: Hono;
  ctx: AppCtx;
  close(): void;
}

export function createServerApp(cfg: ServerConfig): ServerApp {
  const db = openDb(path.join(cfg.dataDir, 'openloom.db'));
  const ctx: AppCtx = { db, cfg };
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true, name: 'openloom-server' }));
  app.get('/', (c) => c.redirect('/healthz'));

  const api = new Hono();
  api.use('*', creatorAuth(ctx));
  api.route('/', videosRoutes(ctx));
  api.route('/', uploadRoutes(ctx));
  api.route('/', activityRoutes(ctx));
  app.route('/api', api);

  const isUnlocked = makeIsUnlocked();
  const limiters = createLimiters();
  const viewer = new Hono();
  // Reject oversized viewer bodies with 413 BEFORE any handler parses them.
  viewer.use(
    '*',
    bodyLimit({
      maxSize: VIEWER_BODY_LIMIT,
      onError: (c) => c.json({ error: 'That request body is too large.' }, 413),
    })
  );
  viewer.route('/', commentsRoutes(ctx, isUnlocked, limiters));
  viewer.route('/', reactionsRoutes(ctx, isUnlocked, limiters));
  viewer.route('/', beaconRoutes(ctx, isUnlocked, limiters));
  viewer.route('/', watchRoutes(ctx, isUnlocked, limiters));
  app.route('/v', viewer);

  app.notFound((c) => c.json({ error: 'Not found.' }, 404));
  app.onError((err, c) => {
    console.error(`[openloom-server] ${c.req.method} ${c.req.path} failed:`, err);
    return c.json({ error: 'The server hit an unexpected error. Check its logs.' }, 500);
  });

  return {
    app,
    ctx,
    close() {
      db.close();
    },
  };
}
