/**
 * Editor live-path E2E: cutting and quiet-part removal through the real app.
 *
 * Seeds the library with a generated tone-silence-tone video, opens the
 * Editor via the UI (card -> Watch -> More -> Edit) and verifies:
 *  - clicking the timeline places the playhead where you clicked (the bug
 *    class this guards: segment overlays swallowing the click and snapping
 *    the playhead to the segment start, which made Split-at-playhead unusable)
 *  - split + remove + undo work as segment state
 *  - Remove quiet parts detects the silent middle and marks it removed
 *  - Save applies the edit, ffprobe-verified shorter on disk
 *
 * Run `npm run build` first. Needs ffmpeg/ffprobe on PATH.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The app opens auxiliary windows (launcher/HUD) at boot; target the main one. */
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

const MAIN_ENTRY = path.resolve(__dirname, '../apps/desktop/out/main/index.js');
const VIDEO_ID = 'e2eeditor1';

function ffprobeDuration(file: string): number {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' }
  );
  return Number(out.trim());
}

/** 6s test video: 2s tone, 2s silence, 2s tone, so the quiet middle is known. */
function makeGappedSample(file: string): void {
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6',
    '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=2,apad=pad_dur=2 [a1]; sine=frequency=440:duration=2 [a2]; [a1][a2] concat=n=2:v=0:a=1',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ]);
}

test('editor: scrub, split, remove, undo, cut quiet parts, save', async () => {
  test.skip(!fs.existsSync(MAIN_ENTRY), 'Build the app first: npm run build');

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-editor-e2e-'));
  const libraryRoot = path.join(userData, 'library');
  const videoDir = path.join(libraryRoot, VIDEO_ID);
  fs.mkdirSync(videoDir, { recursive: true });

  const videoFile = path.join(videoDir, 'video.mp4');
  makeGappedSample(videoFile);
  fs.writeFileSync(
    path.join(videoDir, 'meta.json'),
    JSON.stringify({
      id: VIDEO_ID,
      title: 'Editor E2E sample',
      createdAt: new Date().toISOString(),
      durationSec: 6,
      width: 640,
      height: 360,
      fps: 30,
      sizeBytes: fs.statSync(videoFile).size,
      mode: 'screen',
    })
  );
  fs.writeFileSync(
    path.join(userData, 'openloom-settings.json'),
    JSON.stringify({ settings: { saveDir: libraryRoot, setupComplete: true, countdown: false } })
  );

  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, OPENLOOM_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' },
  });
  try {
    const page = await windowByUrl(app, 'index.html');
    await expect(page).toHaveTitle('Open Loom');

    // A machine without screen permission boots to Setup; the editor cannot
    // be reached through the UI there, which is an environment gap, not a bug.
    const setup = page.locator('h1, h2', { hasText: 'Welcome to Open Loom' });
    test.skip(await setup.isVisible().catch(() => false), 'Setup gate (permissions) blocks the library on this machine');

    // Library -> Watch -> More actions -> Edit.
    await page.locator('.video-thumb').first().click();
    await page.locator('button[aria-label="More actions"]').click();
    await page.locator('.menu .menu-item', { hasText: 'Edit' }).first().click();

    const timeline = page.locator('.timeline');
    await expect(timeline).toBeVisible();
    // The preview <video> must have metadata before currentTime means anything.
    await page.waitForFunction(() => {
      const v = document.querySelector('.editor-player video') as HTMLVideoElement | null;
      return !!v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
    });

    const box = (await timeline.boundingBox())!;
    const playheadTime = () =>
      page.evaluate(() => (document.querySelector('.editor-player video') as HTMLVideoElement).currentTime);

    // 1. Clicking the middle of the timeline puts the playhead there (~3s of 6s).
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
    const atHalf = await playheadTime();
    expect(atHalf).toBeGreaterThan(2.4);
    expect(atHalf).toBeLessThan(3.6);

    // 2. Split there, then select and remove the second half.
    await page.keyboard.press('s');
    await expect(page.locator('.tl-cut')).toHaveCount(1);
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
    await expect(page.locator('.tl-seg.selected')).toHaveCount(1);
    await page.locator('button', { hasText: 'Remove section' }).click();
    await expect(page.locator('.tl-seg.removed')).toHaveCount(1);

    // 3. Undo brings it back.
    await page.locator('button[aria-label="Undo the last edit step"]').click();
    await expect(page.locator('.tl-seg.removed')).toHaveCount(0);

    // 4. Cut quiet parts finds the silent middle (~2s..4s) and marks it removed.
    await page.locator('button', { hasText: 'Remove quiet parts' }).click();
    await expect(page.locator('.tl-seg.removed')).toHaveCount(1, { timeout: 30_000 });

    // 5. Save applies the edit; the file on disk really gets shorter.
    const durBefore = ffprobeDuration(videoFile);
    await page.locator('button', { hasText: 'Save edit' }).click();
    await expect(page.locator('.edit-banner')).toBeVisible({ timeout: 60_000 });
    const durAfter = ffprobeDuration(videoFile);
    // ~1.6s of padded silence removed from 6s; allow codec/keyframe slack.
    expect(durAfter).toBeLessThan(durBefore - 1);
    expect(durAfter).toBeGreaterThan(3.5);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
