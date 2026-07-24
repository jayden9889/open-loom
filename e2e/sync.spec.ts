/**
 * A/V sync regression gate (the "repeatable as Loom" guarantee).
 *
 * Records a real camera-mode take through the full production pipeline
 * (getUserMedia -> WebAudio-clocked mic -> MediaRecorder -> chunk IPC ->
 * ffmpeg finalise) using Chromium's fake capture devices, then ffprobes the
 * landed video.mp4 and asserts the audio and video stream durations match.
 *
 * Guards the drift class found 2026-07-24: a raw mic track fed straight to
 * MediaRecorder compacts around dropped capture samples, so the audio track
 * ends up shorter than the video and every lip drifts progressively out of
 * sync. Run `npm run build` first.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAIN_ENTRY = path.resolve(__dirname, '../apps/desktop/out/main/index.js');

/** Matches AV_SYNC_TOLERANCE_SEC in recorder-ipc.ts: healthy takes land ~25ms apart. */
const MAX_DRIFT_SEC = 0.3;
const RECORD_MS = 8000;

function streamDurations(file: string): { video: number; audio: number | null } {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    { encoding: 'utf8' }
  );
  const data = JSON.parse(out) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; duration?: string }[];
  };
  const video = data.streams?.find((s) => s.codec_type === 'video');
  const audio = data.streams?.find((s) => s.codec_type === 'audio');
  return {
    video: Number(video?.duration) || Number(data.format?.duration) || 0,
    audio: audio ? Number(audio.duration) || 0 : null,
  };
}

async function windowByUrl(app: ElectronApplication, fragment: string, timeoutMs = 20_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = app.windows().find((w) => w.url().includes(fragment));
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`window ${fragment} never appeared`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test('camera-mode recording lands with audio and video in sync', async () => {
  test.skip(!fs.existsSync(MAIN_ENTRY), 'Build the app first: npm run build');

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-sync-'));
  const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-sync-lib-'));
  fs.writeFileSync(
    path.join(userData, 'openloom-settings.json'),
    JSON.stringify({ settings: { saveDir: libraryRoot, setupComplete: true, countdown: false } }, null, 2)
  );

  const app = await electron.launch({
    args: [
      MAIN_ENTRY,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
    env: { ...process.env, OPENLOOM_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' },
  });

  try {
    const page = await windowByUrl(app, 'index.html');
    await page.waitForSelector('.setup, .shell', { timeout: 30_000 });

    // Start a camera-only recording through the real bridge (no TCC needed:
    // fake devices satisfy getUserMedia without touching hardware).
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

    const deadline = Date.now() + 15_000;
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
    const { videoId } = await page.evaluate(() => window.openloom.stopRecording());
    expect(videoId, 'stop must land a library video').toBeTruthy();

    const finalPath = path.join(libraryRoot, videoId, 'video.mp4');
    expect(fs.existsSync(finalPath), `expected ${finalPath}`).toBe(true);

    const d = streamDurations(finalPath);
    expect(d.audio, 'take must contain an audio stream').not.toBeNull();
    expect(d.video, 'video must cover the recorded time').toBeGreaterThan((RECORD_MS / 1000) * 0.75);
    const drift = Math.abs(d.video - (d.audio ?? 0));
    expect(drift, `audio/video drift ${drift.toFixed(3)}s (video=${d.video}s audio=${d.audio}s)`).toBeLessThan(MAX_DRIFT_SEC);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  }
});
