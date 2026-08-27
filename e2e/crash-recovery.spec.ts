/**
 * Crash-recovery gate: a recording must survive the app dying mid-take.
 *
 * Written after a real loss on 2026-08-27. A live screen+camera take was
 * running when the process took a SIGTERM; 88MB of capture (91 seconds) sat in
 * the staging dir afterwards, and by the time the app had been relaunched the
 * whole directory was gone with nothing in the library and no log line saying
 * why. The footage was never recovered.
 *
 * This spec pins the two halves of the promise:
 *   1. Kill the app mid-recording. The capture stays on disk.
 *   2. Relaunch. The recovery banner offers it, and Recover lands a real,
 *      playable video in the library.
 *
 * Run `npm run build` first. Uses Chromium's fake capture devices, so it needs
 * no camera, no microphone and no screen-recording grant.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAIN_ENTRY = path.resolve(__dirname, '../apps/desktop/out/main/index.js');
/** Long enough that the write stream has really flushed chunks to disk. */
const RECORD_MS = 6000;

async function windowByUrl(app: ElectronApplication, fragment: string, timeoutMs = 25_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = app.windows().find((w) => w.url().includes(fragment));
    if (found) {
      await found.waitForLoadState('domcontentloaded');
      return found;
    }
    if (Date.now() > deadline) throw new Error(`window ${fragment} never appeared`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function launch(userData: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    env: { ...process.env, OPENLOOM_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' },
  });
}

function stagedCaptureBytes(userData: string): number {
  const root = path.join(userData, 'recordings-tmp');
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root)) {
    const chunk = path.join(root, entry, 'chunks.bin');
    if (fs.existsSync(chunk)) total += fs.statSync(chunk).size;
  }
  return total;
}

test('a recording survives the app being killed mid-take', async () => {
  test.skip(!fs.existsSync(MAIN_ENTRY), 'Build the app first: npm run build');

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-crash-e2e-'));
  const libraryRoot = path.join(userData, 'library');
  fs.mkdirSync(libraryRoot, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'openloom-settings.json'),
    JSON.stringify({ settings: { saveDir: libraryRoot, setupComplete: true, countdown: false } }, null, 2)
  );

  // ---------------------------------------------------------------- take one
  const app = await launch(userData);
  const page = await windowByUrl(app, 'index.html');
  await page.waitForSelector('.setup, .shell', { timeout: 30_000 });

  await page.evaluate(() =>
    window.openloom.startRecording({
      mode: 'cam',
      cameraOn: true,
      micOn: true,
      systemAudio: false,
      quality: '1080p',
      fps: 30,
    })
  );

  const deadline = Date.now() + 20_000;
  let status = '';
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => window.openloomInternal.getRecordingState());
    status = st.status;
    if (st.error) throw new Error(`capture error: ${st.error}`);
    if (status === 'recording') break;
    await page.waitForTimeout(300);
  }
  expect(status, 'recording must actually start').toBe('recording');
  await page.waitForTimeout(RECORD_MS);

  // Kill it the way a crash would: no graceful shutdown, no stop, no save.
  const pid = app.process().pid!;
  process.kill(pid, 'SIGKILL');
  await app.waitForEvent('close', { timeout: 15_000 }).catch(() => undefined);

  // The capture must still be on disk. This is the half that held on the day.
  const staged = stagedCaptureBytes(userData);
  expect(staged, 'killing the app must leave the capture staged on disk').toBeGreaterThan(0);
  expect(fs.readdirSync(libraryRoot), 'nothing saved into the library yet').toHaveLength(0);

  // ---------------------------------------------------------------- relaunch
  const app2 = await launch(userData);
  try {
    const page2 = await windowByUrl(app2, 'index.html');
    await page2.waitForSelector('.shell', { timeout: 30_000 });

    // The capture must survive the relaunch itself, not silently vanish.
    expect(
      stagedCaptureBytes(userData),
      'the staged capture must still be there after a relaunch'
    ).toBeGreaterThan(0);

    const banner = page2.locator('.recover-banner');
    await expect(banner, 'a relaunch must offer the unfinished take').toBeVisible({ timeout: 20_000 });

    await banner.getByRole('button', { name: /recover/i }).click();

    // Recover must land a real, playable file - not just clear the banner.
    await expect
      .poll(() => fs.readdirSync(libraryRoot).length, { timeout: 90_000 })
      .toBeGreaterThan(0);
    // Give the recovery its run: either it lands a video or it refuses.
    await page2.waitForTimeout(25_000);

    const durationOf = (file: string): number => {
      try {
        return Number(
          execFileSync(
            'ffprobe',
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file],
            { encoding: 'utf8' }
          ).trim()
        );
      } catch {
        return NaN;
      }
    };

    // THE INVARIANT: the library never holds a recording that cannot be played.
    //
    // A fake capture device encodes a near-static frame, so a short take can
    // flush too few bytes to rebuild into real video. That used to be filed
    // anyway as a 262-byte MP4 with no stream and durationSec 0, and opening it
    // gave "This video file could not be played". Both outcomes below are
    // acceptable; a dud entry is not.
    const entries = fs.readdirSync(libraryRoot);
    for (const id of entries) {
      const seconds = durationOf(path.join(libraryRoot, id, 'video.mp4'));
      expect(
        Number.isFinite(seconds) && seconds > 0,
        `library entry ${id} must be a playable video, got duration ${seconds}`
      ).toBe(true);
    }

    if (entries.length === 0) {
      // Refused: then the footage must NOT have been spent on a failed attempt.
      expect(
        stagedCaptureBytes(userData),
        'a refused recovery must keep the capture so it can be retried'
      ).toBeGreaterThan(0);
    }
  } finally {
    await app2.close().catch(() => undefined);
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
