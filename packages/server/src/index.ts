/**
 * openloom-server entry point.
 * Env: PORT, DATA_DIR, API_KEY, BASE_URL, MAX_UPLOAD_MB, CREATOR_NAME.
 * `npx openloom-server` or `docker compose up -d` and you are live.
 */
import crypto from 'node:crypto';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createServerApp } from './app.js';

const cfg = loadConfig();
const server = createServerApp(cfg);

serve({ fetch: server.app.fetch, port: cfg.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`[openloom-server] listening on http://localhost:${info.port}`);
  console.log(`[openloom-server] base URL      ${cfg.baseUrl}`);
  console.log(`[openloom-server] data dir      ${cfg.dataDir}`);
  console.log(`[openloom-server] max upload    ${Math.round(cfg.maxUploadBytes / (1024 * 1024))} MB`);
  if (cfg.apiKeyGenerated) {
    // First boot only: this is the one time the key is printed in full. On a
    // Docker install stdout lands in `docker logs` (and whatever log shipper the
    // host runs) forever, so routine boots must never repeat the secret.
    console.log('[openloom-server] no API_KEY was set, so one was generated and saved to');
    console.log(`[openloom-server]   ${cfg.dataDir}/api-key.txt`);
    console.log(`[openloom-server] API key: ${cfg.apiKey}`);
    console.log('[openloom-server] paste it into OpenLoom Settings then Sharing.');
  } else {
    const fingerprint = crypto.createHash('sha256').update(cfg.apiKey).digest('hex').slice(0, 12);
    console.log(`[openloom-server] API key loaded (sha256:${fingerprint}…).`);
    console.log(`[openloom-server] find it in your API_KEY env, or in ${cfg.dataDir}/api-key.txt if it was generated.`);
  }

  // A bare IP or localhost makes for a shady-looking share link; nudge towards a
  // real domain + HTTPS, which the watch pages and unlock cookies are built for.
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/i.test(cfg.baseUrl)) {
    console.warn(
      '[openloom-server] BASE_URL is a bare host. Set BASE_URL to a real domain over HTTPS ' +
        '(e.g. https://videos.example.com) for credible, shareable links.'
    );
  }
});

function shutdown(signal: string): void {
  console.log(`[openloom-server] ${signal} received, shutting down.`);
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
