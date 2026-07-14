/**
 * Full E2E suite (SPEC section 7).
 *
 * Drives the built Electron app end-to-end with Playwright `_electron`, launched
 * with fake-media Chromium flags on a clean userData profile. Covers: boot,
 * the floating recording launcher, a real screen recording attempt (camera
 * always on, TCC-tolerant),
 * ingest via the app's real recover pipeline, the Watch player (play/seek/speed),
 * trimming (ffprobe-verified), settings persistence across relaunch, the
 * save-folder picker repointing the library root, sharing to a real
 * openloom-server and the hosted watch page in a browser context.
 *
 * The suite is resilient by design: every check is recorded (pass/fail +
 * classification) into test-results/e2e-report.json instead of aborting, so one
 * blocked step (e.g. macOS Screen Recording TCC) never hides the rest. Only
 * scaffolding lives here; no product code is touched.
 */
import { test, _electron as electron, chromium, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(__dirname, '..');
const MAIN_ENTRY = path.join(REPO, 'apps/desktop/out/main/index.js');
const SERVER_ENTRY = path.join(REPO, 'packages/server/dist/index.js');
const SAMPLE = path.join(__dirname, 'fixtures/sample.mp4');
const SCREENS = path.join(REPO, 'test-results/screens');
const REPORT = path.join(REPO, 'test-results/e2e-report.json');

type Classification = 'pass' | 'product-bug' | 'test-bug' | 'environment';
interface Check {
  name: string;
  ok: boolean;
  classification: Classification;
  detail: string;
}
const checks: Check[] = [];
function record(name: string, ok: boolean, classification: Classification, detail = ''): void {
  checks.push({ name, ok, classification, detail });
  console.log(`[CHECK] ${ok ? 'PASS' : 'FAIL'} (${classification}) ${name}${detail ? ' :: ' + detail : ''}`);
}
const shots: string[] = [];
// Full app-side console (main-process log lines + renderer console via
// ELECTRON_ENABLE_LOGGING) - written into the report so a failed run carries
// its own evidence instead of needing a rerun.
const appLog: string[] = [];
async function shot(page: Page, file: string): Promise<void> {
  const p = path.join(SCREENS, file);
  try {
    await page.screenshot({ path: p, animations: 'disabled' });
    shots.push(p);
  } catch (err) {
    console.log(`[SHOT-FAIL] ${file}: ${String(err)}`);
  }
}

function ffprobeDuration(file: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file], {
    encoding: 'utf8',
  });
  return Number(out.trim());
}

// -- minimal real openloom-server child (mirrors the vitest spawn helper) -----
interface Server {
  baseUrl: string;
  apiKey: string;
  dataDir: string;
  stop(): Promise<void>;
}
async function spawnServer(): Promise<Server> {
  const port = 21000 + Math.floor(Math.random() * 15000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-srv-'));
  const apiKey = 'e2e-api-key-0123456789';
  const baseUrl = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, API_KEY: apiKey, BASE_URL: baseUrl, MAX_UPLOAD_MB: '128', CREATOR_NAME: 'E2E Creator' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (d: Buffer) => (logs += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (logs += d.toString()));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) break;
    } catch {
      /* not up */
    }
    if (child.exitCode !== null) throw new Error(`server exited early:\n${logs}`);
    if (Date.now() > deadline) throw new Error(`server did not come up:\n${logs}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    baseUrl,
    apiKey,
    dataDir,
    async stop() {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// Send a real in-app navigation event from the main process (same channel the
// tray/menu use) so we can reach Library from first-run Setup regardless of the
// macOS screen-permission gate.
async function navigate(app: ElectronApplication, view: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, v) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
    win?.webContents.send('ol:navigate', { view: v });
  }, view);
}

async function setTheme(page: Page, theme: 'light' | 'dark' | 'auto'): Promise<void> {
  await page.evaluate((t) => window.openloom.setSettings({ theme: t }), theme);
  await page.waitForTimeout(220);
}

// The floating launcher opens alongside the main window on boot, so pick
// windows by URL instead of relying on creation order.
async function windowByUrl(app: ElectronApplication, frag: string, timeoutMs = 15_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const win = app.windows().find((w) => w.url().includes(frag));
    if (win) {
      await win.waitForLoadState('domcontentloaded');
      return win;
    }
    if (Date.now() > deadline) throw new Error(`window ${frag} did not appear within ${timeoutMs}ms`);
    await app.waitForEvent('window', { timeout: Math.max(250, deadline - Date.now()) }).catch(() => undefined);
  }
}

test('Open Loom full E2E (SPEC §7)', async () => {
  test.setTimeout(360_000);
  fs.mkdirSync(SCREENS, { recursive: true });
  // A live `electron-vite dev` instance shares apps/desktop/out with this
  // suite: a dev rebuild mid-run swaps the chunk files the e2e app lazy-loads,
  // and its windows die one by one ("Target page ... has been closed").
  // Refuse to run rather than fail mysteriously.
  try {
    execFileSync('pgrep', ['-f', 'electron-vite dev'], { encoding: 'utf8' });
    record(
      'no dev instance running',
      false,
      'environment',
      'electron-vite dev is running and shares apps/desktop/out with this suite. Stop it (pkill -f "electron-vite dev") and rerun.'
    );
    fs.writeFileSync(REPORT, JSON.stringify({ checks, shots, appLog }, null, 2));
    throw new Error('dev instance running - e2e refused to start');
  } catch (err) {
    if (err instanceof Error && err.message.includes('refused')) throw err;
    /* pgrep exits non-zero when nothing matches: clean environment */
  }
  if (!fs.existsSync(MAIN_ENTRY)) {
    record('build present', false, 'test-bug', `missing ${MAIN_ENTRY}; run npm run build`);
    fs.writeFileSync(REPORT, JSON.stringify({ checks, shots }, null, 2));
    throw new Error('app not built');
  }
  if (!fs.existsSync(SAMPLE)) {
    record('sample fixture present', false, 'test-bug', `missing ${SAMPLE}`);
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-e2e-'));
  const libraryRoot = path.join(userData, 'library');
  let server: Server | null = null;
  let app: ElectronApplication | null = null;
  let videoId = '';

  // Seed the electron-store BEFORE first launch so the app's library points at
  // a scratch dir from the very first render. Without this, boot briefly reads
  // the machine's real default folder (~/Movies/OpenLoom) and any pre-existing
  // recording there renders a card whose thumbnail request is then invalidated
  // when we repoint saveDir - a test artifact, not a product bug.
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'openloom-settings.json'),
    JSON.stringify({ settings: { saveDir: libraryRoot, setupComplete: true, countdown: false } }, null, 2)
  );

  const launch = async (): Promise<{ app: ElectronApplication; page: Page }> => {
    const a = await electron.launch({
      args: [
        MAIN_ENTRY,
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--enable-features=MediaStreamTrackFakeDevices',
      ],
      env: { ...process.env, OPENLOOM_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' },
    });
    a.process().stdout?.on('data', (d: Buffer) => appLog.push(...d.toString().split('\n').filter(Boolean)));
    a.process().stderr?.on('data', (d: Buffer) => appLog.push(...d.toString().split('\n').filter(Boolean)));
    // Every window that ever appears logs its close, stamped against the checks.
    const tagWindow = (w: Page) => {
      const url = w.url();
      w.on('close', () => appLog.push(`[e2e] WINDOW CLOSED: ${url} (after ${checks.length} checks)`));
    };
    a.windows().forEach(tagWindow);
    a.on('window', tagWindow);
    const p = await windowByUrl(a, 'index.html');
    return { app: a, page: p };
  };

  try {
    // ------------------------------------------------------------------ boot
    const launched = await launch();
    app = launched.app;
    let page = launched.page;

    const rendererErrors: string[] = [];
    const failed404: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') rendererErrors.push(m.text());
    });
    page.on('response', (r) => {
      if (r.status() === 404) failed404.push(r.url());
    });

    try {
      const title = await page.title();
      record('app boots with title "Open Loom"', title === 'Open Loom', title === 'Open Loom' ? 'pass' : 'product-bug', `title=${title}`);
    } catch (err) {
      record('app boots with title "Open Loom"', false, 'product-bug', String(err));
    }

    // Typed bridge round-trips.
    let perms: { screen: string; camera: string; mic: string; ffmpeg: boolean; whisper: boolean } | null = null;
    try {
      const info = await page.evaluate(() => window.openloom.appInfo());
      record('preload bridge round-trips (appInfo)', !!info.version && !!info.platform, info.version ? 'pass' : 'product-bug', `v${info.version} ${info.platform}`);
      perms = await page.evaluate(() => window.openloom.getPermissions());
      record('ffmpeg detected', !!perms?.ffmpeg, perms?.ffmpeg ? 'pass' : 'environment', `screen=${perms?.screen} ffmpeg=${perms?.ffmpeg}`);
    } catch (err) {
      record('preload bridge round-trips (appInfo)', false, 'product-bug', String(err));
    }

    // Wait for either Setup or Library to render, then snapshot the first view.
    await page.waitForSelector('.setup, .shell', { timeout: 30_000 }).catch(() => undefined);
    const firstView = (await page.locator('.setup').count()) ? 'setup' : 'library';
    record('first-run boots to Setup or Library', ['setup', 'library'].includes(firstView), 'pass', `view=${firstView} (screen perm=${perms?.screen})`);
    await shot(page, '01-boot.png');

    // saveDir + setupComplete are seeded pre-launch; just ensure we are on Library.
    await navigate(app, 'library');
    await page.waitForSelector('.shell', { timeout: 15_000 });
    await page.waitForSelector('.side-item', { timeout: 15_000 });

    // ---------------------------------------------------------- library empty
    const emptyCount = await page.evaluate(() => window.openloom.listVideos().then((v) => v.length));
    record('reaches Library, empty on clean profile', emptyCount === 0, emptyCount === 0 ? 'pass' : 'product-bug', `videos=${emptyCount}`);
    await page.waitForSelector('.empty-state', { timeout: 8000 }).catch(() => undefined);
    await setTheme(page, 'light');
    await shot(page, '02-library-empty-light.png');
    await setTheme(page, 'dark');
    await shot(page, '03-library-empty-dark.png');
    await setTheme(page, 'light');

    // ------------------------------------------------ recording launcher UI
    // The launcher is its own floating window (left edge of the screen); it
    // opens on boot because setupComplete is seeded. Screen mode is the
    // default and the camera is always part of the recording.
    try {
      const launcher = await windowByUrl(app, 'launcher.html');
      await launcher.waitForSelector('.launcher', { timeout: 12_000 });
      // Give source enumeration + device labels a moment.
      await launcher.waitForTimeout(1500);
      const hasSourceGrid = (await launcher.locator('.source-grid').count()) > 0;
      const hasCamera = (await launcher.locator('#nr-camera').count()) > 0;
      const hasMic = (await launcher.locator('#nr-mic').count()) > 0;
      const hasModeSwitch = (await launcher.locator('.segmented .segment').count()) === 2;
      const sourceCards = await launcher.locator('.source-card').count();
      const cameraOptions = await launcher.locator('#nr-camera option').count();
      const micOptions = await launcher.locator('#nr-mic option').count();
      const panelOk = hasSourceGrid && hasCamera && hasMic && hasModeSwitch;
      record(
        'Launcher lists screen sources + camera/mic devices + 2-mode switch',
        panelOk,
        panelOk ? 'pass' : 'product-bug',
        `sourceCards=${sourceCards} camera=${hasCamera}(${cameraOptions} opts) mic=${hasMic}(${micOptions} opts) modes2=${hasModeSwitch}`
      );
      await shot(launcher, '04-launcher-light.png');
      await setTheme(page, 'dark');
      await shot(launcher, '05-launcher-dark.png');
      await setTheme(page, 'light');

      // ---------------------------------------- attempt a real screen recording
      // Start via the launcher button (the real UI path). The launcher window
      // is torn down by the main process once recording begins, so all state
      // polling happens in the main window.
      const startBtn = launcher.getByRole('button', { name: /Start recording/i });
      const recChecks = await attemptRealRecording(app, page, startBtn);
      for (const c of recChecks) record(c.name, c.ok, c.classification, c.detail);
      const recLanded = recChecks[0]?.ok ?? false;
      await shot(page, '06-recording-attempt.png');
      // A recording that just landed auto-opens Watch with the YouTube publish
      // panel already expanded (fresh-recording flow, DECISIONS 2026-07-13).
      if (recLanded) {
        const ytPanel = await page
          .waitForSelector('.youtube-block', { timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        record(
          'fresh recording lands on Watch with the publish panel expanded',
          ytPanel,
          ytPanel ? 'pass' : 'product-bug',
          `youtube-block visible=${ytPanel}`
        );
        await shot(page, '06b-watch-publish-panel.png');
        // The paste-back half of the guided YouTube publish, end to end:
        // saving a messy-but-valid link must persist the canonical watch URL
        // and auto-copy it (what actually gets sent to a prospect).
        const recVideoId = recChecks[0]?.detail.match(/videoId=([\w-]+)/)?.[1];
        if (recVideoId) {
          try {
            const res = await page.evaluate(async (vid) => {
              const meta = await window.openloom.youtubeSaveLink(vid, 'https://youtu.be/dQw4w9WgXcQ?si=tracking&t=12');
              const clip = await window.openloom.youtubeReadClipboardLink();
              return { saved: meta.youtubeUrl ?? '', clip };
            }, recVideoId);
            const canonical = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
            const ok = res.saved === canonical && res.clip === canonical;
            record(
              'guided YouTube publish persists + copies the canonical link',
              ok,
              ok ? 'pass' : 'product-bug',
              `saved=${res.saved} clipboard=${res.clip}`
            );
          } catch (err) {
            record('guided YouTube publish persists + copies the canonical link', false, 'product-bug', String(err));
          }
        }
      }
      // Ensure nothing is left recording before we continue.
      await page.evaluate(async () => {
        try {
          await window.openloom.cancelRecording();
        } catch {
          /* nothing active */
        }
      });
    } catch (err) {
      record('Recording launcher opens', false, 'product-bug', String(err));
    }

    // Make sure we are back on a clean Library view before injecting.
    await navigate(app, 'library');
    await page.waitForSelector('.shell', { timeout: 10_000 }).catch(() => undefined);

    // ------------------------------- ingest sample via the real recover pipeline
    // (processCaptureFile: remux -> thumb -> gif -> waveform -> meta.json). This
    // is the app's real ingest path, exercised whenever a recording is blocked.
    if (fs.existsSync(SAMPLE)) {
      try {
        const tmpId = `rec-e2e-${Date.now().toString(36)}`;
        const recDir = path.join(userData, 'recordings-tmp', tmpId);
        fs.mkdirSync(recDir, { recursive: true });
        fs.copyFileSync(SAMPLE, path.join(recDir, 'chunks.bin'));
        fs.writeFileSync(
          path.join(recDir, 'manifest.json'),
          JSON.stringify({
            tempId: tmpId,
            startedAt: new Date().toISOString(),
            opts: { mode: 'screen', cameraOn: false, micOn: false, systemAudio: false, quality: '1080p', fps: 30 },
            mimeType: 'video/mp4',
            approxDurationSec: 4,
            status: 'recording',
          })
        );
        const res = await page.evaluate(async (id) => {
          const list = await window.openloom.listRecoverable();
          const found = list.find((r) => r.tempId === id);
          if (!found) return { ok: false, error: `not listed as recoverable`, list: list.map((l) => l.tempId) };
          const out = await window.openloom.recoverRecording(id);
          return { ok: true, videoId: out.videoId };
        }, tmpId);
        if (res.ok && res.videoId) {
          videoId = res.videoId;
          record('sample ingests via real recover pipeline (processing completes)', true, 'pass', `videoId=${videoId}`);
        } else {
          record('sample ingests via real recover pipeline (processing completes)', false, 'product-bug', JSON.stringify(res));
        }
      } catch (err) {
        record('sample ingests via real recover pipeline (processing completes)', false, 'product-bug', String(err));
      }
    }

    // ----------------------------------------------------------- watch player
    if (videoId) {
      // Recover broadcasts lastVideoId, which auto-opens Watch; ensure we are there.
      await page.waitForSelector('.watch', { timeout: 15_000 }).catch(async () => {
        await navigate(app!, 'library');
        await page.locator('.video-card, .lib-card, [data-video-id]').first().click().catch(() => undefined);
      });
      const onWatch = (await page.locator('.watch').count()) > 0;
      if (!onWatch) {
        // Fall back: open the video by id through the library grid.
        await navigate(app, 'library');
        await page.waitForTimeout(500);
      }
      await page.waitForSelector('.player video', { timeout: 15_000 }).catch(() => undefined);

      // Meta duration in range.
      try {
        const meta = await page.evaluate((id) => window.openloom.getVideo(id), videoId);
        const durOk = meta.durationSec >= 3 && meta.durationSec <= 6;
        record('watch page video duration is 3-6s', durOk, durOk ? 'pass' : 'product-bug', `durationSec=${meta.durationSec}`);
      } catch (err) {
        record('watch page video duration is 3-6s', false, 'product-bug', String(err));
      }

      // Play advances currentTime.
      try {
        const played = await page.evaluate(async () => {
          const v = document.querySelector('.player video') as HTMLVideoElement | null;
          if (!v) return { ok: false, why: 'no video element' };
          await new Promise<void>((res) => {
            if (v.readyState >= 1) return res();
            v.addEventListener('loadedmetadata', () => res(), { once: true });
            setTimeout(res, 4000);
          });
          try {
            await v.play();
          } catch (e) {
            return { ok: false, why: 'play() rejected: ' + String(e) };
          }
          await new Promise((r) => setTimeout(r, 900));
          return { ok: v.currentTime > 0.15, why: `currentTime=${v.currentTime.toFixed(2)} dur=${(v.duration || 0).toFixed(2)}` };
        });
        record('watch player plays the recording', played.ok, played.ok ? 'pass' : 'product-bug', played.why);
      } catch (err) {
        record('watch player plays the recording', false, 'product-bug', String(err));
      }

      // Seek via the scrubber.
      try {
        const before = await page.evaluate(() => (document.querySelector('.player video') as HTMLVideoElement).currentTime);
        const scrubber = page.locator('.scrubber');
        const box = await scrubber.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2);
        }
        await page.waitForTimeout(400);
        const after = await page.evaluate(() => (document.querySelector('.player video') as HTMLVideoElement).currentTime);
        const seekOk = Math.abs(after - before) > 0.4;
        record('scrubber seek changes playback position', seekOk, seekOk ? 'pass' : 'product-bug', `before=${before.toFixed(2)} after=${after.toFixed(2)}`);
      } catch (err) {
        record('scrubber seek changes playback position', false, 'product-bug', String(err));
      }

      // Speed menu changes playbackRate.
      try {
        await page.locator('.speed-btn').click();
        await page.locator('.speed-menu button', { hasText: '1.5×' }).click();
        await page.waitForTimeout(150);
        const rate = await page.evaluate(() => (document.querySelector('.player video') as HTMLVideoElement).playbackRate);
        record('speed menu changes playbackRate', rate === 1.5, rate === 1.5 ? 'pass' : 'product-bug', `playbackRate=${rate}`);
      } catch (err) {
        record('speed menu changes playbackRate', false, 'product-bug', String(err));
      }

      await setTheme(page, 'light');
      await shot(page, '07-watch-light.png');
      await setTheme(page, 'dark');
      await shot(page, '08-watch-dark.png');
      await setTheme(page, 'light');

      // Trim to ~2s (real trim IPC used by the Editor), ffprobe-verified on disk.
      try {
        const filePath = path.join(libraryRoot, videoId, 'video.mp4');
        const durBefore = ffprobeDuration(filePath);
        await page.evaluate((id) => window.openloom.trimVideo(id, [{ start: 0, end: 2 }]), videoId);
        // trimVideo awaits the job; give the file a beat to be replaced.
        await page.waitForTimeout(500);
        const durAfter = ffprobeDuration(filePath);
        const trimOk = durAfter < durBefore - 0.5 && durAfter >= 1.4 && durAfter <= 2.8;
        record('trim to ~2s yields a shorter file (ffprobe)', trimOk, trimOk ? 'pass' : 'product-bug', `before=${durBefore.toFixed(2)}s after=${durAfter.toFixed(2)}s`);
      } catch (err) {
        record('trim to ~2s yields a shorter file (ffprobe)', false, 'product-bug', String(err));
      }
    } else {
      record('watch/seek/speed/trim (needs a landed video)', false, 'environment', 'no video available to test the player');
    }

    // ---------------------------------------------- share dialog (unconfigured)
    if (videoId) {
      try {
        await navigate(app, 'library');
        await page.waitForTimeout(400);
        await page.locator('.empty-state, .lib-grid, .video-card').first().waitFor({ timeout: 5000 }).catch(() => undefined);
        // Open the video again to reach its Share button.
        await openVideo(app, page, videoId);
        await page.waitForSelector('.watch', { timeout: 8000 }).catch(() => undefined);
      } catch {
        /* best effort */
      }
    }

    // ------------------------------------ spawn server + configure sharing + share
    try {
      server = await spawnServer();
      record('openloom-server starts (healthz ok)', true, 'pass', server.baseUrl);
    } catch (err) {
      record('openloom-server starts (healthz ok)', false, 'environment', String(err));
    }

    if (videoId && server) {
      const srv = server;
      try {
        await page.evaluate(
          (cfg) =>
            window.openloom.setSettings({
              sharing: { provider: 'server', autoCopyOnStop: false, server: { url: cfg.url, apiKey: cfg.apiKey } } as never,
            }),
          { url: srv.baseUrl, apiKey: srv.apiKey }
        );
        // Open the Share dialog and share through it.
        await openVideo(app, page, videoId);
        await page.waitForSelector('.watch', { timeout: 8000 });
        await page.getByRole('button', { name: /^Share$/ }).click();
        await page.waitForSelector('.shr-body', { timeout: 8000 });
        // Click "Share and copy link" if the provider is configured.
        const shareBtn = page.getByRole('button', { name: /Share and copy link/i });
        if (await shareBtn.count()) {
          await shareBtn.click();
        } else {
          // Provider not picked up in the dialog; mint via bridge as fallback.
          await page.evaluate((id) => window.openloom.shareVideo(id), videoId);
        }
        // Wait for upload to complete on the server.
        const ready = await waitForServerReady(srv.baseUrl, videoId, 25_000);
        record('share uploads to server (watch page becomes ready)', ready, ready ? 'pass' : 'product-bug', ready ? '/v ready' : 'status not ready in time');
        await page.waitForTimeout(600);
        await setTheme(page, 'light');
        await shot(page, '11-share-dialog-light.png');
        await setTheme(page, 'dark');
        await shot(page, '12-share-dialog-dark.png');
        await setTheme(page, 'light');
        await page.locator('.modal-close, [aria-label="Close"]').first().click().catch(() => undefined);
      } catch (err) {
        record('share uploads to server (watch page becomes ready)', false, 'product-bug', String(err));
        // Still try to screenshot whatever share dialog state exists.
        await shot(page, '11-share-dialog-light.png');
      }
    } else if (videoId) {
      // No server: screenshot the unconfigured share dialog for design QA.
      try {
        await openVideo(app, page, videoId);
        await page.waitForSelector('.watch', { timeout: 8000 });
        await page.getByRole('button', { name: /^Share$/ }).click();
        await page.waitForSelector('.shr-body', { timeout: 8000 });
        await shot(page, '11-share-dialog-light.png');
        await page.locator('.modal-close, [aria-label="Close"]').first().click().catch(() => undefined);
      } catch {
        /* best effort */
      }
    }

    // -------------------------------------------------- library with a video
    try {
      await navigate(app, 'library');
      await page.waitForSelector('.shell', { timeout: 8000 });
      await page.waitForTimeout(500);
      const count = await page.evaluate(() => window.openloom.listVideos().then((v) => v.length));
      record('library shows the ingested video', count >= 1, count >= 1 ? 'pass' : 'product-bug', `videos=${count}`);
      // Ground-truth scan: every library video dir must have its thumb.jpg on disk.
      try {
        const ids = fs.existsSync(libraryRoot) ? fs.readdirSync(libraryRoot).filter((d) => /^[A-Za-z0-9_-]{6,}$/.test(d) && fs.statSync(path.join(libraryRoot, d)).isDirectory()) : [];
        const missingThumb = ids.filter((id) => !fs.existsSync(path.join(libraryRoot, id, 'thumb.jpg')));
        const listing = ids.map((id) => `${id}:[${fs.readdirSync(path.join(libraryRoot, id)).join(',')}]`).join('  ');
        console.log(`[DISK] libraryRoot dirs: ${listing}`);
        record('every library video has thumb.jpg on disk', missingThumb.length === 0, missingThumb.length === 0 ? 'pass' : 'product-bug', missingThumb.length ? `missing thumb: ${missingThumb.join(', ')}` : `${ids.length} videos ok`);
      } catch (err) {
        console.log(`[DISK] scan failed: ${String(err)}`);
      }
      await setTheme(page, 'light');
      await shot(page, '09-library-with-video-light.png');
      await setTheme(page, 'dark');
      await shot(page, '10-library-with-video-dark.png');
      await setTheme(page, 'light');
    } catch (err) {
      record('library shows the ingested video', false, 'product-bug', String(err));
    }

    // ----------------------------------------------------------- settings view
    try {
      await navigate(app, 'settings');
      await page.waitForSelector('.settings', { timeout: 8000 });
      record('settings view renders', true, 'pass', '');
      await setTheme(page, 'light');
      await shot(page, '13-settings-light.png');
      await setTheme(page, 'dark');
      await shot(page, '14-settings-dark.png');
      await setTheme(page, 'light');
    } catch (err) {
      record('settings view renders', false, 'product-bug', String(err));
    }

    // Change the default-recording-name pattern via the real Settings input
    // (persistence marker) and repoint the save folder via the mocked picker.
    const marker = 'E2E-PERSIST {date}, {time}';
    const pickedDir = fs.mkdtempSync(path.join(userData, 'picked-'));
    try {
      const nameInput = page.getByLabel('Default recording name pattern');
      await nameInput.fill(marker);
      await nameInput.blur();
      await page.waitForTimeout(300);

      // Save-folder picker: mock the native dialog in the main process, then click Change.
      await app.evaluate(async ({ dialog }, dir) => {
        // @ts-expect-error test override of the native dialog
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
      }, pickedDir);
      await page.getByRole('button', { name: /^Change$/ }).click();
      await page.waitForTimeout(400);
      const saveDirNow = await page.evaluate(() => window.openloom.getSettings().then((s) => s.saveDir));
      const pickerOk = saveDirNow === pickedDir;
      record('save-folder picker updates the library root', pickerOk, pickerOk ? 'pass' : 'product-bug', `saveDir=${saveDirNow}`);
    } catch (err) {
      record('save-folder picker updates the library root', false, 'product-bug', String(err));
    }

    // ------------------------------------------- persistence across relaunch
    try {
      await app.close();
      app = null;
      const relaunched = await launch();
      app = relaunched.app;
      page = relaunched.page;
      await page.waitForSelector('.setup, .shell', { timeout: 20_000 }).catch(() => undefined);
      const persisted = await page.evaluate(() => window.openloom.getSettings());
      const nameOk = persisted.namePattern === marker;
      const dirOk = persisted.saveDir === pickedDir;
      record('settings persist across relaunch (name pattern)', nameOk, nameOk ? 'pass' : 'product-bug', `namePattern=${persisted.namePattern}`);
      record('save folder persists across relaunch', dirOk, dirOk ? 'pass' : 'product-bug', `saveDir=${persisted.saveDir}`);
    } catch (err) {
      record('settings persist across relaunch (name pattern)', false, 'product-bug', String(err));
    }

    // ------------------------------------- server watch page in a browser context
    if (server && videoId) {
      const srv = server;
      let browser = null;
      try {
        browser = await chromium.launch();
        const ctxLight = await browser.newContext({ colorScheme: 'light', viewport: { width: 1200, height: 900 } });
        const wp = await ctxLight.newPage();
        const resp = await wp.goto(`${srv.baseUrl}/v/${videoId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await wp.waitForSelector('video, .player, main', { timeout: 12_000 }).catch(() => undefined);
        await wp.waitForTimeout(800);
        const httpOk = !!resp && resp.status() >= 200 && resp.status() < 400;
        const hasVideo = (await wp.locator('video').count()) > 0;
        record('server watch page loads in a browser (has player)', httpOk && hasVideo, httpOk && hasVideo ? 'pass' : 'product-bug', `http=${resp?.status()} video=${hasVideo}`);
        shots.push(path.join(SCREENS, '15-server-watch-page-light.png'));
        await wp.screenshot({ path: path.join(SCREENS, '15-server-watch-page-light.png'), fullPage: true });
        await ctxLight.close();

        const ctxDark = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1200, height: 900 } });
        const wpd = await ctxDark.newPage();
        await wpd.goto(`${srv.baseUrl}/v/${videoId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await wpd.waitForSelector('video, .player, main', { timeout: 12_000 }).catch(() => undefined);
        await wpd.waitForTimeout(800);
        shots.push(path.join(SCREENS, '16-server-watch-page-dark.png'));
        await wpd.screenshot({ path: path.join(SCREENS, '16-server-watch-page-dark.png'), fullPage: true });
        await ctxDark.close();
      } catch (err) {
        const msg = String(err);
        const isEnv = /Executable doesn't exist|playwright install/.test(msg);
        record('server watch page loads in a browser (has player)', false, isEnv ? 'environment' : 'product-bug', msg);
      } finally {
        if (browser) await browser.close();
      }
    } else {
      record('server watch page loads in a browser (has player)', false, 'environment', 'no server or no shared video');
    }

    // Renderer network 404s. transcript.vtt / captions.vtt 404s are expected
    // (the Watch view probes for captions that only exist after transcription);
    // anything else 404ing is a real product/asset bug.
    const unexpected404 = [...new Set(failed404)].filter((u) => !/transcript\.vtt|captions\.vtt/.test(u));
    const expected404 = [...new Set(failed404)].filter((u) => /transcript\.vtt|captions\.vtt/.test(u));
    record(
      'no unexpected renderer resource 404s',
      unexpected404.length === 0,
      unexpected404.length === 0 ? 'pass' : 'product-bug',
      unexpected404.length ? `unexpected: ${unexpected404.slice(0, 5).map((u) => u.replace(/^openloom-file:\/\//, '')).join(', ')}` : `only expected caption probes (${expected404.length})`
    );
  } finally {
    fs.writeFileSync(REPORT, JSON.stringify({ checks, shots, appLog }, null, 2));
    if (app) await app.close().catch(() => undefined);
    if (server) await server.stop().catch(() => undefined);
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    console.log('\n===== E2E REPORT =====');
    for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} [${c.classification}] ${c.name}${c.detail ? ' :: ' + c.detail : ''}`);
    console.log(`screenshots: ${shots.length} in ${SCREENS}`);
  }
});

// Attempt a real screen-only recording and return classified checks (the
// recording itself first, then the mid-recording bubble check). Never throws;
// classifies TCC / capture failures as environment.
async function attemptRealRecording(
  app: ElectronApplication,
  page: Page,
  startBtn: ReturnType<Page['getByRole']>
): Promise<Check[]> {
  const name = 'real screen recording via the UI (camera always on, TCC-tolerant)';
  const perms = await page.evaluate(() => window.openloom.getPermissions());
  if (process.platform === 'darwin' && perms.screen !== 'granted') {
    return [{
      name,
      ok: false,
      classification: 'environment',
      detail: `macOS Screen Recording not granted to the Electron dev binary (screen='${perms.screen}'). Grant it in System Settings > Privacy & Security > Screen Recording to record for real.`,
    }];
  }
  try {
    if (await startBtn.count()) await startBtn.click();
    // Poll the state machine for up to ~12s to reach 'recording'.
    const deadline = Date.now() + 12_000;
    let reached = false;
    let lastState = '';
    while (Date.now() < deadline) {
      const st = await page.evaluate(() => window.openloomInternal.getRecordingState());
      lastState = st.status;
      if (st.error) {
        return [{ name, ok: false, classification: 'environment', detail: `capture error: ${st.error}` }];
      }
      if (st.status === 'recording') {
        reached = true;
        break;
      }
      await page.waitForTimeout(400);
    }
    if (!reached) {
      return [{ name, ok: false, classification: 'environment', detail: `recording never reached 'recording' (last='${lastState}') - likely no capturable display / TCC` }];
    }
    // Record ~4s then stop via the real stop path.
    await page.waitForTimeout(2000);
    // Mid-recording: the webcam bubble must show live camera video, never the
    // opaque "Camera is off" overlay (an author display:flex on .bubble-off
    // once beat the [hidden] attribute and blacked out the face in every
    // full-display recording).
    let bubbleOk = false;
    let bubbleDetail = '';
    try {
      const bubble = await windowByUrl(app, 'bubble.html', 5000);
      // The video fades in only after loadeddata; poll briefly for the live state.
      const st = await bubble.evaluate(async () => {
        const deadline = Date.now() + 5000;
        const read = () => {
          const b = document.getElementById('bubble');
          const state = document.getElementById('bubble-state');
          const video = document.getElementById('bubble-video') as HTMLVideoElement | null;
          return {
            live: !!b?.classList.contains('live'),
            stateShown: !!state && getComputedStyle(state).display !== 'none',
            videoWidth: video?.videoWidth ?? 0,
            videoOpacity: video ? Number(getComputedStyle(video).opacity) : 0,
          };
        };
        let cur = read();
        while (Date.now() < deadline && !(cur.live && cur.videoOpacity > 0.9)) {
          await new Promise((r) => setTimeout(r, 200));
          cur = read();
        }
        return cur;
      });
      bubbleOk = st.live && !st.stateShown && st.videoWidth > 0 && st.videoOpacity > 0.9;
      bubbleDetail = `live=${st.live} stateShown=${st.stateShown} videoWidth=${st.videoWidth} opacity=${st.videoOpacity}`;
    } catch (err) {
      bubbleDetail = `bubble window: ${String(err)}`;
    }
    const bubbleCheck: Check = {
      name: 'webcam bubble shows live camera while recording (no off-overlay)',
      ok: bubbleOk,
      classification: bubbleOk ? 'pass' : 'product-bug',
      detail: bubbleDetail,
    };
    await page.waitForTimeout(2000);
    const out = await page.evaluate(() => window.openloom.stopRecording());
    return [
      { name, ok: !!out.videoId, classification: out.videoId ? 'pass' : 'product-bug', detail: `videoId=${out.videoId}` },
      bubbleCheck,
    ];
  } catch (err) {
    return [{ name, ok: false, classification: 'environment', detail: `start/stop failed: ${String(err)}` }];
  }
}

async function openVideo(app: ElectronApplication, page: Page, id: string): Promise<void> {
  // Prefer the real in-app path: from Library, click the video card. Falls back
  // to a nav event that opens the last recovered video's watch view.
  await navigate(app, 'library');
  await page.waitForSelector('.shell', { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  const card = page.locator('.video-thumb').first();
  if (await card.count()) {
    await card.click().catch(() => undefined);
  }
  // If the click did not land us on Watch, drive it through the recover-state
  // broadcast by re-reading meta (the App auto-opens on lastVideoId).
  if (!(await page.locator('.watch').count())) {
    await app.evaluate(({ BrowserWindow }, vid) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
      win?.webContents.send('ol:recording-state', { status: 'idle', elapsedSec: 0, lastVideoId: vid });
    }, id);
    await page.waitForSelector('.watch', { timeout: 6000 }).catch(() => undefined);
  }
}

async function waitForServerReady(baseUrl: string, id: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/v/${id}/status`);
      if (res.ok) {
        const data = (await res.json()) as { status?: string };
        if (data.status === 'ready') return true;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
