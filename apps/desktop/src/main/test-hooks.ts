/**
 * Development/CI test hooks, active only via environment variables.
 * OPENLOOM_TEST_RECORD_SECONDS=<n>: after boot, start a screen-only recording
 * of the first display, stop after n seconds, log the resulting video id.
 * Detects macOS Screen Recording (TCC) denial and reports one actionable
 * line instead of failing obscurely (SPEC section 7, macOS TCC note).
 */
import { app, desktopCapturer } from 'electron';
import { getPermissions } from './permissions';
import { getSettings } from './settings';
import { startRecording, stopRecording } from './recorder-ipc';
import { log } from './logger';

export async function runTestHooks(): Promise<void> {
  const seconds = Number(process.env['OPENLOOM_TEST_RECORD_SECONDS'] ?? 0);
  if (!seconds) return;

  log.info(`test-hook: attempting a ${seconds}s screen-only recording`);
  const perms = getPermissions();
  if (process.platform === 'darwin' && perms.screen !== 'granted') {
    log.error(
      `test-hook: BLOCKED-BY-TCC screen permission is '${perms.screen}'. Grant Screen Recording to this binary in System Settings > Privacy & Security > Screen Recording, then rerun.`
    );
    app.exit(3);
    return;
  }
  if (!perms.ffmpeg) {
    log.error('test-hook: ffmpeg missing; cannot post-process. Install ffmpeg first.');
    app.exit(4);
    return;
  }

  try {
    const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const first = screens[0];
    if (!first) throw new Error('no screens found');
    const settings = getSettings();
    await startRecording({
      mode: 'screen',
      sourceId: first.id,
      sourceIsDisplay: true,
      cameraOn: false,
      micOn: false,
      systemAudio: false,
      quality: settings.recording.quality,
      fps: 30,
    });
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const { videoId } = await stopRecording();
    log.info(`test-hook: RECORDING-OK videoId=${videoId}`);
    app.exit(0);
  } catch (err) {
    log.error(`test-hook: RECORDING-FAILED ${err instanceof Error ? err.message : String(err)}`);
    app.exit(5);
  }
}
