/**
 * Editor stress E2E: hammer the editing surface the way an impatient user
 * does, against the real built app, and fail on any renderer console error.
 *
 * Covers: scrub spam, split spam (including double-splitting one spot),
 * removing sections down to the "at least one section must remain" guard,
 * undo spam past the bottom of the history, running Remove quiet parts twice
 * (second run must be a clean no-op), dragging a trim handle across an
 * interior cut and back, then Save + Revert with ffprobe checks both ways.
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
const VIDEO_ID = 'e2estress01';

function ffprobeDuration(file: string): number {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' }
  );
  return Number(out.trim());
}

/** 10s: tone 0-3, silence 3-5, tone 5-8, silence 8-10 (trailing). */
function makeSample(file: string): void {
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=10',
    '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=3,apad=pad_dur=2 [a1]; sine=frequency=440:duration=3,apad=pad_dur=2 [a2]; [a1][a2] concat=n=2:v=0:a=1',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ]);
}

test('editor survives a hostile user session', async () => {
  test.skip(!fs.existsSync(MAIN_ENTRY), 'Build the app first: npm run build');
  test.setTimeout(180_000);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-stress-e2e-'));
  const libraryRoot = path.join(userData, 'library');
  const videoDir = path.join(libraryRoot, VIDEO_ID);
  fs.mkdirSync(videoDir, { recursive: true });
  const videoFile = path.join(videoDir, 'video.mp4');
  makeSample(videoFile);
  fs.writeFileSync(
    path.join(videoDir, 'meta.json'),
    JSON.stringify({
      id: VIDEO_ID,
      title: 'Stress sample',
      createdAt: new Date().toISOString(),
      durationSec: 10,
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
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      // The seeded video has no thumb/preview/waveform sidecars, so their 404s
      // are an artefact of seeding, not a product error.
      if (msg.type() === 'error' && !/Failed to load resource.*404/.test(msg.text())) {
        consoleErrors.push(msg.text());
      }
    });

    const setup = page.locator('h1, h2', { hasText: 'Welcome to Open Loom' });
    test.skip(await setup.isVisible().catch(() => false), 'Setup gate (permissions) blocks the library on this machine');

    await page.locator('.video-thumb').first().click();
    await page.locator('button[aria-label="More actions"]').click();
    await page.locator('.menu .menu-item', { hasText: 'Edit' }).first().click();

    const timeline = page.locator('.timeline');
    await expect(timeline).toBeVisible();
    await page.waitForFunction(() => {
      const v = document.querySelector('.editor-player video') as HTMLVideoElement | null;
      return !!v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
    });
    const box = (await timeline.boundingBox())!;
    const midY = box.y + box.height / 2;
    const xAt = (frac: number) => box.x + box.width * frac;
    const playheadTime = () =>
      page.evaluate(() => (document.querySelector('.editor-player video') as HTMLVideoElement).currentTime);

    // 1. Scrub spam: 20 rapid clicks all over, then a long drag. No errors,
    // and the playhead ends where the pointer ended.
    for (let i = 0; i < 20; i++) {
      await page.mouse.click(xAt(0.05 + 0.9 * ((i * 7) % 10) / 10), midY, { delay: 5 });
    }
    await page.mouse.move(xAt(0.1), midY);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) await page.mouse.move(xAt(0.1 + (0.7 * i) / 15), midY);
    await page.mouse.up();
    const afterDrag = await playheadTime();
    expect(afterDrag).toBeGreaterThan(7); // 80% of 10s
    expect(afterDrag).toBeLessThan(9);

    // 2. Split spam: split at several spots, press S twice at one spot (the
    // second press must be a clean no-op, not a zero-width segment).
    for (const frac of [0.2, 0.4, 0.6, 0.6, 0.8]) {
      await page.mouse.click(xAt(frac), midY);
      await page.keyboard.press('s');
    }
    await expect(page.locator('.tl-cut')).toHaveCount(4);

    // 3. Remove sections until the guard stops the last one.
    for (const frac of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      await page.mouse.click(xAt(frac), midY);
      const remove = page.locator('button', { hasText: 'Remove section' });
      if (await remove.isEnabled()) await remove.click();
    }
    // The guard must have kept at least one section.
    expect(await page.locator('.tl-seg:not(.removed)').count()).toBeGreaterThan(0);
    await expect(page.locator('.toast, [role="status"]').filter({ hasText: 'At least one section' }).first()).toBeVisible();

    // 4. Undo spam: 30 presses walks history to the bottom and stops cleanly.
    for (let i = 0; i < 30; i++) await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await expect(page.locator('.tl-seg.removed')).toHaveCount(0);
    await expect(page.locator('.tl-cut')).toHaveCount(0);
    await expect(page.locator('button[aria-label="Undo the last edit step"]')).toBeDisabled();

    // 5. Remove quiet parts twice: first run cuts the two silent stretches,
    // the second run must find nothing new and change nothing.
    await page.locator('button', { hasText: 'Remove quiet parts' }).click();
    await expect(page.locator('.tl-seg.removed')).not.toHaveCount(0, { timeout: 30_000 });
    const removedAfterFirst = await page.locator('.tl-seg.removed').count();
    await page.locator('button', { hasText: 'Remove quiet parts' }).click();
    await expect(page.locator('.toast, [role="status"]').filter({ hasText: 'No quiet parts found' }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.tl-seg.removed')).toHaveCount(removedAfterFirst);

    // 6a. Drag the in-handle up to (but not past) the first silence cut and
    // back to the start: interior cuts survive (restore-then-cut behaviour).
    const dragIn = async (fracs: number[]) => {
      const handleBox = (await page.locator('.tl-handle.in').boundingBox())!;
      await page.mouse.move(handleBox.x + handleBox.width / 2, midY);
      await page.mouse.down();
      for (const f of fracs) await page.mouse.move(xAt(f), midY, { steps: 5 });
      await page.mouse.up();
    };
    await dragIn([0.25, 0.001]); // first silence cut starts ~3.18s (31.8%)
    await expect(page.locator('.tl-seg.removed')).toHaveCount(removedAfterFirst);

    // 6b. Drag THROUGH the cut and back: the head swallows the merged cut
    // (documented trim-model behaviour) and one undo brings it back.
    await dragIn([0.6, 0.001]);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await expect(page.locator('.tl-seg.removed')).toHaveCount(removedAfterFirst);

    // 7. Save, ffprobe the shorter file, then Revert and ffprobe the restore.
    const durBefore = ffprobeDuration(videoFile);
    await page.locator('button', { hasText: 'Save edit' }).click();
    await expect(page.locator('.edit-banner')).toBeVisible({ timeout: 60_000 });
    const durAfter = ffprobeDuration(videoFile);
    expect(durAfter).toBeLessThan(durBefore - 2); // two ~2s silences, padded
    expect(durAfter).toBeGreaterThan(4);

    await page.locator('.edit-banner button', { hasText: 'Revert' }).click();
    await expect(page.locator('.edit-banner')).toBeHidden({ timeout: 60_000 });
    const durRestored = ffprobeDuration(videoFile);
    expect(Math.abs(durRestored - durBefore)).toBeLessThan(0.2);

    expect(consoleErrors, `renderer console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
