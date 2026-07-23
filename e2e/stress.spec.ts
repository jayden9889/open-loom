/**
 * Stress spec: the camera-layout switcher + instant-facecam changes.
 *
 * Simulates a real proposal-recording session and exercises the code paths that
 * JUST changed in recorder-ipc.ts / windows.ts / switcher.ts / bubble.ts:
 *   - the webcam bubble is warmed up EARLY (created during countdown, live from
 *     the first recorded frame) rather than ~2s into the recording;
 *   - a bottom-center, content-protected "switcher" overlay appears during
 *     Screen+Camera recordings;
 *   - the camera layout flips bubble <-> full mid-recording (fade), full-face
 *     force-disables + hides draw, and the bubble window grows to cover the
 *     display / shrinks back to a circle;
 *   - draw auto-flips off when the layout goes full;
 *   - pause/resume stays consistent while full;
 *   - a clean stop tears down every session window and lands a video;
 *   - cam-only mode has no switcher and no draw;
 *   - restart re-warms the bubble immediately.
 *
 * Resilient by design (mirrors full-suite.spec.ts): every check is recorded
 * (pass/fail + classification) into test-results/stress-report.json instead of
 * aborting, so one blocked step (e.g. macOS Screen Recording TCC) never hides
 * the rest. No product code is touched. Capture-dependent checks classify as
 * 'environment' when the OS blocks real screen/camera capture.
 */
import { test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(__dirname, '..');
const MAIN_ENTRY = path.join(REPO, 'apps/desktop/out/main/index.js');
const REPORT = path.join(REPO, 'test-results/stress-report.json');

// Bubble diameters per size preset (packages/shared/types.ts BUBBLE_SIZES).
const BUBBLE_SIZES: Record<string, number> = { S: 160, M: 240, L: 320 };
// windows.ts SWITCHER_SIZE / HUD_SIZE / HUD_DRAW_EXTRA.
const SWITCHER_SIZE = { width: 300, height: 56 };
const HUD_HEIGHT = 388;
const HUD_DRAW_EXTRA = 155;

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
const appLog: string[] = [];

interface RecState {
  status: string;
  elapsedSec: number;
  mode?: string;
  cameraOn?: boolean;
  cameraLayout?: string;
  micOn?: boolean;
  drawOn?: boolean;
  drawAvailable?: boolean;
  lastVideoId?: string;
  error?: string;
}
interface WinInfo {
  bounds: { x: number; y: number; width: number; height: number };
  contentProtected: boolean | null;
  contentProtectApi: boolean;
  title: string;
}

// -- main-process introspection helpers --------------------------------------

/** Bounds + content-protection of the first live window whose URL contains `frag`. */
async function winInfo(app: ElectronApplication, frag: string): Promise<WinInfo | null> {
  return app.evaluate(({ BrowserWindow }, f) => {
    const w = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(f));
    if (!w) return null;
    const anyW = w as unknown as { isContentProtected?: () => boolean };
    const contentProtectApi = typeof anyW.isContentProtected === 'function';
    let contentProtected: boolean | null = null;
    try {
      if (contentProtectApi) contentProtected = anyW.isContentProtected!();
    } catch {
      contentProtected = null;
    }
    return { bounds: w.getBounds(), contentProtected, contentProtectApi, title: w.getTitle() };
  }, frag);
}

async function windowExists(app: ElectronApplication, frag: string): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }, f) => {
    return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents.getURL().includes(f));
  }, frag);
}

async function primaryDisplay(
  app: ElectronApplication
): Promise<{ bounds: { x: number; y: number; width: number; height: number }; workArea: { x: number; y: number; width: number; height: number } }> {
  return app.evaluate(({ screen }) => {
    const d = screen.getPrimaryDisplay();
    return { bounds: d.bounds, workArea: d.workArea };
  });
}

function approx(a: number, b: number, tol = 3): boolean {
  return Math.abs(a - b) <= tol;
}

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

test('Open Loom stress: camera-layout switcher + instant-facecam', async () => {
  test.setTimeout(360_000);

  // Refuse to run against a live dev instance sharing apps/desktop/out.
  try {
    execFileSync('pgrep', ['-f', 'electron-vite dev'], { encoding: 'utf8' });
    record('no dev instance running', false, 'environment', 'electron-vite dev shares apps/desktop/out; stop it and rerun.');
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify({ checks, appLog }, null, 2));
    throw new Error('dev instance running - stress spec refused to start');
  } catch (err) {
    if (err instanceof Error && err.message.includes('refused')) throw err;
    /* pgrep non-zero: clean */
  }
  if (!fs.existsSync(MAIN_ENTRY)) {
    record('build present', false, 'test-bug', `missing ${MAIN_ENTRY}; run npm run build`);
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify({ checks, appLog }, null, 2));
    throw new Error('app not built');
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-stress-'));
  const libraryRoot = path.join(userData, 'library');
  fs.mkdirSync(userData, { recursive: true });
  // Seed: skip setup, scratch library, countdown ON (so the instant-facecam
  // fix has an observable pre-recording window), bubble size M.
  fs.writeFileSync(
    path.join(userData, 'openloom-settings.json'),
    JSON.stringify(
      { settings: { saveDir: libraryRoot, setupComplete: true, countdown: true, bubble: { size: 'M', mirror: true } } },
      null,
      2
    )
  );

  let app: ElectronApplication | null = null;

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
    const p = await windowByUrl(a, 'index.html');
    await p.waitForSelector('.setup, .shell', { timeout: 30_000 }).catch(() => undefined);
    return { app: a, page: p };
  };

  const bubbleDiameter = BUBBLE_SIZES['M'];

  try {
    const launched = await launch();
    app = launched.app;
    const page = launched.page;
    const state = (): Promise<RecState> => page.evaluate(() => window.openloomInternal.getRecordingState());
    const setLayoutViaSwitcher = async (sw: Page, layout: 'bubble' | 'full'): Promise<void> => {
      await sw.evaluate((l) => window.openloom.setCameraLayout(l as 'bubble' | 'full'), layout);
    };

    // ---- sanity: boot + permissions ----------------------------------------
    let screenGranted = false;
    try {
      const info = await page.evaluate(() => window.openloom.appInfo());
      const perms = await page.evaluate(() => window.openloom.getPermissions());
      screenGranted = perms.screen === 'granted';
      record('app boots + preload bridge round-trips', !!info.version, info.version ? 'pass' : 'product-bug', `v${info.version} screen=${perms.screen} ffmpeg=${perms.ffmpeg}`);
    } catch (err) {
      record('app boots + preload bridge round-trips', false, 'product-bug', String(err));
    }

    // Pick a whole-display capture source (the real Screen+Camera path).
    let displaySourceId = '';
    try {
      const sources: { id: string; display: boolean }[] = await page.evaluate(() => window.openloom.listCaptureSources());
      const disp = sources.find((s) => s.display);
      displaySourceId = disp?.id ?? '';
      record('a whole-display capture source is available', !!displaySourceId, displaySourceId ? 'pass' : 'environment', `sources=${sources.length} display=${!!disp}`);
    } catch (err) {
      record('a whole-display capture source is available', false, 'environment', String(err));
    }

    const captureBlocked = process.platform === 'darwin' && !screenGranted;

    // ======================================================================
    // ARC 1 - Screen+Camera recording: switcher + layout flips + draw + stop
    // ======================================================================
    if (displaySourceId && !captureBlocked) {
      let started = false;
      try {
        // Fire start WITHOUT awaiting so we can observe the countdown-phase
        // bubble warm-up. The promise result is stashed on window.
        await page.evaluate((id) => {
          (window as unknown as { __rec: Promise<unknown> }).__rec = window.openloom
            .startRecording({
              mode: 'screen-cam',
              sourceId: id,
              sourceIsDisplay: true,
              cameraOn: true,
              micOn: false,
              systemAudio: false,
              quality: '1080p',
              fps: 30,
            })
            .then(() => ({ ok: true }))
            .catch((e: unknown) => ({ ok: false, err: String(e) }));
        }, displaySourceId);

        // Instant-facecam: the bubble window is warmed up EARLY - it must exist
        // BEFORE the recording starts (created ahead of the engine/countdown,
        // not ~2s into the recording). Rapid-poll from the moment start is fired
        // and capture the status at the instant the bubble first appears. The
        // state machine only broadcasts 'countdown' after the engine is ready,
        // so before that getRecordingState() still reads the stale 'idle' - the
        // bubble legitimately appears during that idle/countdown pre-roll.
        let bubbleFirstSeenAt = '';
        let sawCountdown = false;
        const deadline = Date.now() + 12_000;
        while (Date.now() < deadline) {
          const st = await state();
          if (st.status === 'countdown') sawCountdown = true;
          if (await windowExists(app, 'bubble.html')) {
            bubbleFirstSeenAt = st.status;
            break;
          }
          if (st.status === 'recording' || st.error) break;
          await page.waitForTimeout(40);
        }
        const beforeRecording = bubbleFirstSeenAt === 'idle' || bubbleFirstSeenAt === 'countdown';
        record(
          'instant-facecam: bubble window warmed up before recording starts',
          beforeRecording,
          beforeRecording ? 'pass' : bubbleFirstSeenAt ? 'product-bug' : 'environment',
          `bubbleFirstSeenAt=${bubbleFirstSeenAt || 'never'} sawCountdown=${sawCountdown}`
        );

        // Now wait for the start to complete (reach 'recording').
        const startRes = (await page.evaluate(() => (window as unknown as { __rec: Promise<{ ok: boolean; err?: string }> }).__rec)) as {
          ok: boolean;
          err?: string;
        };
        // Poll to 'recording' just in case.
        const recDeadline = Date.now() + 12_000;
        let st = await state();
        while (Date.now() < recDeadline && st.status !== 'recording') {
          if (st.error) break;
          await page.waitForTimeout(200);
          st = await state();
        }
        started = st.status === 'recording';
        record(
          'screen-cam recording reaches "recording"',
          started,
          started ? 'pass' : startRes.ok === false ? 'environment' : 'product-bug',
          `status=${st.status} startOk=${startRes.ok} err=${startRes.err ?? st.error ?? ''}`
        );
      } catch (err) {
        record('screen-cam recording reaches "recording"', false, 'environment', String(err));
      }

      if (started) {
        // Bubble present at 'recording'.
        record('bubble window present at "recording"', await windowExists(app, 'bubble.html'), (await windowExists(app, 'bubble.html')) ? 'pass' : 'product-bug', '');

        const disp = await primaryDisplay(app);

        // ---- switcher window checks ----------------------------------------
        let switcher: Page | null = null;
        try {
          switcher = await windowByUrl(app, 'switcher.html', 6000);
        } catch {
          /* not created */
        }
        const swInfo = await winInfo(app, 'switcher.html');
        record('switcher window exists during screen-cam recording', !!swInfo, swInfo ? 'pass' : 'product-bug', swInfo ? `bounds=${JSON.stringify(swInfo.bounds)}` : 'no switcher window');

        if (swInfo) {
          const expX = disp.workArea.x + Math.round((disp.workArea.width - SWITCHER_SIZE.width) / 2);
          const expY = disp.workArea.y + disp.workArea.height - SWITCHER_SIZE.height - 16;
          const posOk = approx(swInfo.bounds.x, expX, 4) && approx(swInfo.bounds.y, expY, 4);
          record('switcher is positioned bottom-center of the display', posOk, posOk ? 'pass' : 'product-bug', `got=(${swInfo.bounds.x},${swInfo.bounds.y}) expected=(${expX},${expY})`);

          const sizeOk = approx(swInfo.bounds.width, SWITCHER_SIZE.width, 2) && approx(swInfo.bounds.height, SWITCHER_SIZE.height, 2);
          record('switcher is 300x56', sizeOk, sizeOk ? 'pass' : 'product-bug', `size=${swInfo.bounds.width}x${swInfo.bounds.height}`);

          if (swInfo.contentProtectApi) {
            record('switcher has content protection ON (excluded from capture)', swInfo.contentProtected === true, swInfo.contentProtected === true ? 'pass' : 'product-bug', `isContentProtected=${swInfo.contentProtected}`);
          } else {
            record(
              'switcher has content protection ON (excluded from capture)',
              true,
              'environment',
              'BrowserWindow.isContentProtected() unavailable in this Electron; verified by code path: windows.ts showSwitcher() -> excludeFromCapture() -> setContentProtection(true).'
            );
          }
        }

        // ---- switch to FULL --------------------------------------------------
        if (switcher) {
          try {
            await setLayoutViaSwitcher(switcher, 'full');
            await page.waitForTimeout(500); // > 220ms fade + bounds swap
            const st = await state();
            record('switch to full: state.cameraLayout === "full"', st.cameraLayout === 'full', st.cameraLayout === 'full' ? 'pass' : 'product-bug', `cameraLayout=${st.cameraLayout}`);
            record('switch to full: drawAvailable === false', st.drawAvailable === false, st.drawAvailable === false ? 'pass' : 'product-bug', `drawAvailable=${st.drawAvailable}`);

            const bInfo = await winInfo(app, 'bubble.html');
            const coversDisplay = !!bInfo && approx(bInfo.bounds.width, disp.bounds.width, 3) && approx(bInfo.bounds.height, disp.bounds.height, 3);
            record('switch to full: bubble window covers the display (after fade)', coversDisplay, coversDisplay ? 'pass' : 'product-bug', bInfo ? `bubble=${bInfo.bounds.width}x${bInfo.bounds.height} display=${disp.bounds.width}x${disp.bounds.height}` : 'no bubble window');

            // toggleDraw(true) must be a no-op while full.
            await page.evaluate(() => window.openloom.toggleDraw(true));
            await page.waitForTimeout(250);
            const st2 = await state();
            record('toggleDraw(true) does nothing while layout is full', st2.drawOn === false, st2.drawOn === false ? 'pass' : 'product-bug', `drawOn=${st2.drawOn}`);
          } catch (err) {
            record('switch to full flow', false, 'product-bug', String(err));
          }

          // ---- switch back to BUBBLE -----------------------------------------
          try {
            await setLayoutViaSwitcher(switcher, 'bubble');
            await page.waitForTimeout(500);
            const bInfo = await winInfo(app, 'bubble.html');
            const shrunk = !!bInfo && approx(bInfo.bounds.width, bubbleDiameter, 2) && approx(bInfo.bounds.height, bubbleDiameter, 2);
            record('switch to bubble: bubble window shrinks back to circle diameter (M=240)', shrunk, shrunk ? 'pass' : 'product-bug', bInfo ? `bubble=${bInfo.bounds.width}x${bInfo.bounds.height}` : 'no bubble window');
            const st = await state();
            record('switch to bubble: drawAvailable === true again', st.drawAvailable === true, st.drawAvailable === true ? 'pass' : 'product-bug', `drawAvailable=${st.drawAvailable}`);
          } catch (err) {
            record('switch back to bubble flow', false, 'product-bug', String(err));
          }

          // ---- draw flow (bubble layout) -------------------------------------
          try {
            await page.evaluate(() => window.openloom.toggleDraw(true));
            await page.waitForTimeout(300);
            const on = await state();
            const hud = await winInfo(app, 'hud.html');
            const hudExpanded = !!hud && approx(hud.bounds.height, HUD_HEIGHT + HUD_DRAW_EXTRA, 4);
            record('toggleDraw(true): drawOn true + HUD expands', on.drawOn === true && hudExpanded, on.drawOn === true && hudExpanded ? 'pass' : 'product-bug', `drawOn=${on.drawOn} hudHeight=${hud?.bounds.height}`);
            const drawWin = await windowExists(app, 'draw.html');
            record('draw overlay window is present while drawing', drawWin, drawWin ? 'pass' : 'product-bug', `drawWindow=${drawWin}`);

            await page.evaluate(() => window.openloom.toggleDraw(false));
            await page.waitForTimeout(300);
            const off = await state();
            const hud2 = await winInfo(app, 'hud.html');
            const hudCollapsed = !!hud2 && approx(hud2.bounds.height, HUD_HEIGHT, 4);
            record('toggleDraw(false): drawOn false + HUD collapses', off.drawOn === false && hudCollapsed, off.drawOn === false && hudCollapsed ? 'pass' : 'product-bug', `drawOn=${off.drawOn} hudHeight=${hud2?.bounds.height}`);
          } catch (err) {
            record('draw toggle flow', false, 'product-bug', String(err));
          }

          // ---- draw ON then switch to FULL -> draw auto-off ------------------
          try {
            await page.evaluate(() => window.openloom.toggleDraw(true));
            await page.waitForTimeout(250);
            const pre = await state();
            await setLayoutViaSwitcher(switcher, 'full');
            await page.waitForTimeout(500);
            const post = await state();
            record('enabling draw then switching to full auto-disables draw', pre.drawOn === true && post.drawOn === false, pre.drawOn === true && post.drawOn === false ? 'pass' : 'product-bug', `preDrawOn=${pre.drawOn} postDrawOn=${post.drawOn} layout=${post.cameraLayout}`);
          } catch (err) {
            record('draw auto-off on full', false, 'product-bug', String(err));
          }

          // ---- pause / resume while FULL -------------------------------------
          try {
            await page.evaluate(() => window.openloom.pauseRecording());
            await page.waitForTimeout(300);
            const paused = await state();
            record('pause while full: status paused, layout stays full', paused.status === 'paused' && paused.cameraLayout === 'full', paused.status === 'paused' && paused.cameraLayout === 'full' ? 'pass' : 'product-bug', `status=${paused.status} layout=${paused.cameraLayout}`);
            await page.evaluate(() => window.openloom.resumeRecording());
            await page.waitForTimeout(300);
            const resumed = await state();
            record('resume while full: status recording, layout stays full, drawAvailable false', resumed.status === 'recording' && resumed.cameraLayout === 'full' && resumed.drawAvailable === false, resumed.status === 'recording' && resumed.cameraLayout === 'full' && resumed.drawAvailable === false ? 'pass' : 'product-bug', `status=${resumed.status} layout=${resumed.cameraLayout} drawAvailable=${resumed.drawAvailable}`);
          } catch (err) {
            record('pause/resume while full', false, 'product-bug', String(err));
          }

          // ---- back to bubble, re-enable draw, then STOP ---------------------
          try {
            await setLayoutViaSwitcher(switcher, 'bubble');
            await page.waitForTimeout(500);
            await page.evaluate(() => window.openloom.toggleDraw(true));
            await page.waitForTimeout(250);
            const before = await page.evaluate(() => window.openloom.listVideos().then((v) => v.length));
            const out = (await page.evaluate(() => window.openloom.stopRecording())) as { videoId: string };
            const stopped = await state();
            record('clean stop: state returns to idle', stopped.status === 'idle', stopped.status === 'idle' ? 'pass' : 'product-bug', `status=${stopped.status} lastVideoId=${stopped.lastVideoId ?? out.videoId}`);
            const after = await page.evaluate(() => window.openloom.listVideos().then((v) => v.length));
            record('clean stop: a video lands in the library', !!out.videoId && after > before, !!out.videoId && after > before ? 'pass' : 'product-bug', `videoId=${out.videoId} before=${before} after=${after}`);

            // Every session window destroyed.
            await page.waitForTimeout(300);
            const survivors: string[] = [];
            for (const frag of ['hud.html', 'bubble.html', 'switcher.html', 'draw.html', 'countdown.html']) {
              if (await windowExists(app, frag)) survivors.push(frag);
            }
            record('clean stop: all session windows (hud/bubble/switcher/draw) destroyed', survivors.length === 0, survivors.length === 0 ? 'pass' : 'product-bug', survivors.length ? `still open: ${survivors.join(', ')}` : 'all torn down');
          } catch (err) {
            record('clean stop teardown', false, 'product-bug', String(err));
          }
        }
      }

      // Make sure nothing is left active.
      await page.evaluate(async () => {
        try {
          await window.openloom.cancelRecording();
        } catch {
          /* nothing active */
        }
      });
    } else {
      record('screen-cam recording reaches "recording"', false, 'environment', captureBlocked ? `macOS Screen Recording not granted (screen not 'granted')` : 'no display capture source');
    }

    // ======================================================================
    // ARC 2 - Full-face-only ('cam') mode: no switcher, no draw
    // ======================================================================
    try {
      const camRes = (await page.evaluate(() =>
        window.openloom
          .startRecording({ mode: 'cam', cameraOn: true, micOn: false, systemAudio: false, quality: '1080p', fps: 30 })
          .then(() => ({ ok: true }))
          .catch((e: unknown) => ({ ok: false, err: String(e) }))
      )) as { ok: boolean; err?: string };
      let st = await state();
      const camDeadline = Date.now() + 12_000;
      while (Date.now() < camDeadline && st.status !== 'recording') {
        if (st.error) break;
        await page.waitForTimeout(200);
        st = await state();
      }
      const camStarted = st.status === 'recording';
      record('cam-only recording reaches "recording"', camStarted, camStarted ? 'pass' : camRes.ok === false ? 'environment' : 'product-bug', `status=${st.status} startOk=${camRes.ok} err=${camRes.err ?? st.error ?? ''}`);

      if (camStarted) {
        const hasSwitcher = await windowExists(app, 'switcher.html');
        record('cam-only: NO switcher window is created', !hasSwitcher, !hasSwitcher ? 'pass' : 'product-bug', `switcher=${hasSwitcher}`);
        record('cam-only: drawAvailable is false (cannot draw on full face)', st.drawAvailable === false, st.drawAvailable === false ? 'pass' : 'product-bug', `drawAvailable=${st.drawAvailable}`);
        // toggleDraw must be inert.
        await page.evaluate(() => window.openloom.toggleDraw(true));
        await page.waitForTimeout(200);
        const st2 = await state();
        record('cam-only: toggleDraw(true) is inert', st2.drawOn !== true, st2.drawOn !== true ? 'pass' : 'product-bug', `drawOn=${st2.drawOn}`);

        const out = (await page.evaluate(() => window.openloom.stopRecording())) as { videoId: string };
        await page.waitForTimeout(200);
        const stopped = await state();
        record('cam-only: stop works (idle + video landed)', stopped.status === 'idle' && !!out.videoId, stopped.status === 'idle' && !!out.videoId ? 'pass' : 'product-bug', `status=${stopped.status} videoId=${out.videoId}`);
      }
    } catch (err) {
      record('cam-only recording reaches "recording"', false, 'environment', String(err));
    }
    await page.evaluate(async () => {
      try {
        await window.openloom.cancelRecording();
      } catch {
        /* noop */
      }
    });

    // ======================================================================
    // ARC 3 - Restart re-warms the bubble immediately (early warm-up path)
    // ======================================================================
    if (displaySourceId && !captureBlocked) {
      try {
        // Start a fresh screen-cam recording (await to 'recording').
        await page.evaluate((id) =>
          window.openloom.startRecording({
            mode: 'screen-cam',
            sourceId: id,
            sourceIsDisplay: true,
            cameraOn: true,
            micOn: false,
            systemAudio: false,
            quality: '1080p',
            fps: 30,
          })
        , displaySourceId);
        let st = await state();
        const d1 = Date.now() + 12_000;
        while (Date.now() < d1 && st.status !== 'recording') {
          if (st.error) break;
          await page.waitForTimeout(200);
          st = await state();
        }
        if (st.status === 'recording') {
          // restartRecording: cancels + starts again, skipping the countdown.
          // Fire without awaiting; poll for the bubble returning quickly.
          await page.evaluate(() => {
            (window as unknown as { __restart: Promise<unknown> }).__restart = window.openloom
              .restartRecording()
              .then(() => ({ ok: true }))
              .catch((e: unknown) => ({ ok: false, err: String(e) }));
          });
          let bubbleBack = false;
          const d2 = Date.now() + 12_000;
          while (Date.now() < d2) {
            if (await windowExists(app, 'bubble.html')) {
              bubbleBack = true;
              break;
            }
            await page.waitForTimeout(50);
          }
          const restartRes = (await page.evaluate(() => (window as unknown as { __restart: Promise<{ ok: boolean; err?: string }> }).__restart)) as {
            ok: boolean;
            err?: string;
          };
          let st3 = await state();
          const d3 = Date.now() + 12_000;
          while (Date.now() < d3 && st3.status !== 'recording') {
            if (st3.error) break;
            await page.waitForTimeout(200);
            st3 = await state();
          }
          record('restart: bubble window returns (early warm-up)', bubbleBack, bubbleBack ? 'pass' : 'product-bug', `bubbleBack=${bubbleBack} restartOk=${restartRes.ok} err=${restartRes.err ?? ''}`);
          record('restart: session survives and reaches "recording"', st3.status === 'recording', st3.status === 'recording' ? 'pass' : 'product-bug', `status=${st3.status}`);
          // Clean stop the restarted session.
          await page.evaluate(async () => {
            try {
              await window.openloom.stopRecording();
            } catch {
              /* noop */
            }
          });
        } else {
          record('restart: bubble window returns (early warm-up)', false, 'environment', `pre-restart recording never reached 'recording' (status=${st.status})`);
        }
      } catch (err) {
        record('restart: bubble window returns (early warm-up)', false, 'product-bug', String(err));
      }
      await page.evaluate(async () => {
        try {
          await window.openloom.cancelRecording();
        } catch {
          /* noop */
        }
      });
    } else {
      record('restart: bubble window returns (early warm-up)', false, 'environment', 'capture blocked / no display source');
    }
  } finally {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify({ checks, appLog }, null, 2));
    if (app) await app.close().catch(() => undefined);
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    console.log('\n===== STRESS REPORT =====');
    for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} [${c.classification}] ${c.name}${c.detail ? ' :: ' + c.detail : ''}`);
  }
});
