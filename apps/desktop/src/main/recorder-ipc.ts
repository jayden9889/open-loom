/**
 * Recording orchestration (SPEC section 5, "Recording orchestration").
 * Main-process state machine: coordinates the engine window (capture +
 * MediaRecorder), HUD, bubble, countdown and draw overlays, receives chunk
 * buffers over IPC into a crash-safe temp file, and post-processes the
 * result into the library on stop.
 */
import { app, clipboard, ipcMain, type Display } from 'electron';
import { nanoid } from 'nanoid';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CameraLayout,
  RecordingMode,
  RecordingOptions,
  RecordingState,
  RecoverableRecording,
  VideoMeta,
} from '@shared/types';
import { QUALITY_BITRATES } from '@shared/types';
import { getSettings } from './settings';
import { log } from './logger';
import {
  broadcast,
  destroyBubble,
  destroyCountdown,
  destroyDrawOverlay,
  destroyHud,
  destroyLauncher,
  displayForSource,
  getDrawWindow,
  getOrCreateEngineWindow,
  positionBubbleCircle,
  raiseHud,
  resizeBubbleKeepAnchor,
  setBubbleFullScreen,
  setBubbleLayout,
  setBubbleVisible,
  setDrawInteractive,
  showBubble,
  showCountdown,
  showDrawOverlay,
  showHud,
  showLauncher,
} from './windows';
import { setPendingCapture, clearPendingCapture, displayIdForSource } from './capture';
import * as ffmpeg from './ffmpeg';
import { shareVideo } from './share';
import { library } from './library';
import { maybeAutoTranscribe } from './transcribe';
import { generatePreviews } from './preview-core';

interface ActiveRecording {
  tempId: string;
  dir: string;
  chunkFile: string;
  stream: fs.WriteStream;
  opts: RecordingOptions;
  startedAt: number;
  /** Milliseconds recorded before the current segment (pauses excluded). */
  recordedMsBase: number;
  segmentStartedAt: number | null;
  status: 'countdown' | 'recording' | 'paused' | 'processing';
  mimeType: string;
  display: Display;
  cameraOn: boolean;
  /** Live camera layout for Screen+Camera recordings. */
  cameraLayout: CameraLayout;
  /** Last non-off layout, so camera on/off restores the previous look. */
  lastCamLayout: Exclude<CameraLayout, 'off'>;
  micOn: boolean;
  drawOn: boolean;
  cancelled: boolean;
  stoppedResolvers: { resolve: (r: { videoId: string }) => void; reject: (e: Error) => void }[];
}

let active: ActiveRecording | null = null;
let tickTimer: NodeJS.Timeout | null = null;
let lastState: RecordingState = { status: 'idle', elapsedSec: 0 };

function tmpRoot(): string {
  return path.join(app.getPath('userData'), 'recordings-tmp');
}

function elapsedSec(rec: ActiveRecording): number {
  const segment = rec.segmentStartedAt ? Date.now() - rec.segmentStartedAt : 0;
  return Math.floor((rec.recordedMsBase + segment) / 1000);
}

function emitState(partial?: Partial<RecordingState>): void {
  const wasIdle = lastState.status === 'idle';
  if (active) {
    lastState = {
      status: active.status,
      elapsedSec: elapsedSec(active),
      mode: active.opts.mode,
      cameraOn: active.cameraOn,
      cameraLayout: active.cameraLayout,
      micOn: active.micOn,
      drawOn: active.drawOn,
      drawAvailable: active.opts.mode !== 'cam' && !!active.opts.sourceIsDisplay,
      ...partial,
    };
  } else {
    lastState = { status: 'idle', elapsedSec: 0, ...partial };
  }
  broadcast('ol:recording-state', lastState);
  // The launcher follows the session: it disappears while a recording runs
  // (destroyed, so its camera preview is released) and returns when idle.
  if (wasIdle && lastState.status !== 'idle') destroyLauncher();
  else if (!wasIdle && lastState.status === 'idle') showLauncher({ inactive: true });
}

export function currentState(): RecordingState {
  return lastState;
}

function writeManifest(rec: ActiveRecording, status: 'recording' | 'completed'): void {
  const manifest = {
    tempId: rec.tempId,
    startedAt: new Date(rec.startedAt).toISOString(),
    opts: rec.opts,
    mimeType: rec.mimeType,
    approxDurationSec: elapsedSec(rec),
    status,
  };
  try {
    fs.writeFileSync(path.join(rec.dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  } catch (err) {
    log.warn(`manifest write failed: ${String(err)}`);
  }
}

function startTick(): void {
  stopTick();
  tickTimer = setInterval(() => {
    if (!active) return;
    emitState();
    if (active.status === 'recording') {
      writeManifest(active, 'recording');
      const maxMin = getSettings().recording.maxDurationMin;
      if (maxMin > 0 && elapsedSec(active) >= maxMin * 60) {
        log.info(`max duration of ${maxMin} min reached; stopping`);
        void stopRecording().catch((err) => log.error(`auto-stop failed: ${String(err)}`));
      }
    }
  }, 1000);
}

function stopTick(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

function closeSessionWindows(): void {
  destroyHud();
  destroyBubble();
  destroyCountdown();
  destroyDrawOverlay();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startRecording(opts: RecordingOptions): Promise<void> {
  if (active) throw new Error('A recording is already in progress.');
  if (!ffmpeg.ffmpegAvailable()) {
    throw new Error('ffmpeg is required to save recordings. Install it from the Setup screen first.');
  }
  if (opts.mode !== 'cam' && !opts.sourceId) {
    throw new Error('Pick a screen or window to record first.');
  }
  // The face never leaves a screen recording: camera is always on (proposal
  // videos are the product; the bubble/full layout switch stays available).
  if (opts.mode === 'screen-cam') opts = { ...opts, cameraOn: true };

  const settings = getSettings();
  const tempId = `rec-${Date.now().toString(36)}-${nanoid(6)}`;
  const dir = path.join(tmpRoot(), tempId);
  fs.mkdirSync(dir, { recursive: true });
  const chunkFile = path.join(dir, 'chunks.bin');
  const stream = fs.createWriteStream(chunkFile, { flags: 'a' });

  let display: Display;
  if (opts.mode !== 'cam' && opts.sourceIsDisplay && opts.sourceId) {
    display = displayForSource(await displayIdForSource(opts.sourceId));
  } else {
    display = displayForSource(undefined);
  }

  active = {
    tempId,
    dir,
    chunkFile,
    stream,
    opts,
    startedAt: Date.now(),
    recordedMsBase: 0,
    segmentStartedAt: null,
    status: 'countdown',
    mimeType: '',
    display,
    cameraOn: opts.cameraOn,
    cameraLayout: opts.mode === 'screen-cam' && opts.cameraOn ? 'bubble' : 'off',
    lastCamLayout: 'bubble',
    micOn: opts.micOn,
    drawOn: false,
    cancelled: false,
    stoppedResolvers: [],
  };

  try {
    if (opts.mode !== 'cam' && opts.sourceId) {
      setPendingCapture(opts.sourceId, opts.systemAudio);
    }

    const engine = getOrCreateEngineWindow();
    await whenEngineReady(engine.webContents.id);

    if (settings.countdown) {
      emitState();
      showCountdown(display);
      await waitForCountdown();
      destroyCountdown();
      if (!active || active.cancelled) return;
    }

    await beginEngineCapture();
  } catch (err) {
    // Carry the failure on the state broadcast too: the launcher window that
    // initiated the start is destroyed with the session, so the invoke
    // rejection alone can land in a dead renderer.
    await hardResetSession(err instanceof Error ? err.message : String(err));
    throw err instanceof Error ? err : new Error(String(err));
  }
}

const engineReadyWaiters = new Map<number, (() => void)[]>();
const readyEngines = new Set<number>();

function whenEngineReady(webContentsId: number): Promise<void> {
  if (readyEngines.has(webContentsId)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The recorder engine did not start. Try again.')), 15_000);
    const list = engineReadyWaiters.get(webContentsId) ?? [];
    list.push(() => {
      clearTimeout(timer);
      resolve();
    });
    engineReadyWaiters.set(webContentsId, list);
  });
}

let countdownWaiter: (() => void) | null = null;

function waitForCountdown(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      countdownWaiter = null;
      resolve();
    }, 4500);
    countdownWaiter = () => {
      clearTimeout(timer);
      countdownWaiter = null;
      resolve();
    };
  });
}

async function beginEngineCapture(): Promise<void> {
  const rec = active;
  if (!rec) return;
  const settings = getSettings();
  const engine = getOrCreateEngineWindow();

  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Recording did not start. Check screen permissions in Setup and try again.')),
      20_000
    );
    engineStartWaiter = (err) => {
      clearTimeout(timer);
      engineStartWaiter = null;
      if (err) reject(new Error(err));
      else resolve();
    };
  });

  engine.webContents.send('engine:begin', {
    opts: rec.opts,
    videoBitsPerSecond: QUALITY_BITRATES[rec.opts.quality],
    bubble: { size: settings.bubble.size, mirror: settings.bubble.mirror },
    captureSize:
      rec.opts.mode !== 'cam'
        ? {
            width: Math.round(rec.display.size.width * rec.display.scaleFactor),
            height: Math.round(rec.display.size.height * rec.display.scaleFactor),
          }
        : null,
  });

  await started;
  if (!active || active !== rec || rec.cancelled) return;

  rec.status = 'recording';
  rec.segmentStartedAt = Date.now();
  writeManifest(rec, 'recording');

  showHud(rec.display);
  if (rec.opts.mode === 'screen-cam' && rec.cameraOn) {
    showBubble(rec.display, settings.bubble.size);
  }
  if (rec.opts.mode !== 'cam' && rec.opts.sourceIsDisplay) {
    showDrawOverlay(rec.display);
  }
  startTick();
  emitState();
  log.info(`recording started (${rec.opts.mode}, ${rec.opts.quality}@${rec.opts.fps}, mime=${rec.mimeType})`);
}

let engineStartWaiter: ((err?: string) => void) | null = null;
let engineStopWaiter: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Pause / resume / stop / cancel / restart
// ---------------------------------------------------------------------------

export async function pauseRecording(): Promise<void> {
  const rec = active;
  if (!rec || rec.status !== 'recording') return;
  getOrCreateEngineWindow().webContents.send('engine:pause', null);
  if (rec.segmentStartedAt) {
    rec.recordedMsBase += Date.now() - rec.segmentStartedAt;
    rec.segmentStartedAt = null;
  }
  rec.status = 'paused';
  emitState();
}

export async function resumeRecording(): Promise<void> {
  const rec = active;
  if (!rec || rec.status !== 'paused') return;
  getOrCreateEngineWindow().webContents.send('engine:resume', null);
  rec.segmentStartedAt = Date.now();
  rec.status = 'recording';
  emitState();
}

export async function stopRecording(): Promise<{ videoId: string }> {
  const rec = active;
  if (!rec) throw new Error('Nothing is recording.');
  if (rec.status === 'processing') {
    return new Promise((resolve, reject) => rec.stoppedResolvers.push({ resolve, reject }));
  }
  if (rec.segmentStartedAt) {
    rec.recordedMsBase += Date.now() - rec.segmentStartedAt;
    rec.segmentStartedAt = null;
  }
  rec.status = 'processing';
  stopTick();
  // HUD + bubble close instantly on stop (SPEC R14).
  closeSessionWindows();
  emitState({ processingNote: 'Finishing up' });

  const engineStopped = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      engineStopWaiter = null;
      resolve();
    }, 15_000);
    engineStopWaiter = () => {
      clearTimeout(timer);
      engineStopWaiter = null;
      resolve();
    };
  });
  getOrCreateEngineWindow().webContents.send('engine:stop', null);
  await engineStopped;

  await new Promise<void>((resolve) => rec.stream.end(resolve));
  clearPendingCapture();

  return new Promise<{ videoId: string }>((resolve, reject) => {
    rec.stoppedResolvers.push({ resolve, reject });
    void finalizeRecording(rec)
      .then((videoId) => {
        if (active === rec) active = null;
        emitState({ status: 'idle', elapsedSec: 0, lastVideoId: videoId });
        maybeAutoShareOnStop(videoId);
        for (const r of rec.stoppedResolvers) r.resolve({ videoId });
      })
      .catch((err: unknown) => {
        log.error(`finalize failed: ${String(err)}`);
        if (active === rec) active = null;
        emitState({ status: 'idle', elapsedSec: 0, error: humanProcessingError(err) });
        for (const r of rec.stoppedResolvers) r.reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

function humanProcessingError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `We could not finish processing this recording: ${msg} The raw capture is kept and offered for recovery next launch.`;
}

/**
 * SPEC R14 / G6: when a share provider is configured and "copy link on stop"
 * is on, mint the share URL the moment the recording lands, copy it to the
 * clipboard, and let the upload run in the background. Failures surface as a
 * toast and never break the finished recording, which stays in the library.
 */
function maybeAutoShareOnStop(videoId: string): void {
  const settings = getSettings();
  if (settings.sharing.provider === 'none' || !settings.sharing.autoCopyOnStop) return;
  void shareVideo(videoId)
    .then(({ url }) => {
      clipboard.writeText(url);
      broadcast('ol:toast', { kind: 'success', text: 'Link copied - uploading in the background' });
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`auto-share on stop failed for ${videoId}: ${msg}`);
      broadcast('ol:toast', {
        kind: 'error',
        text: `Saved to your library, but sharing did not start: ${msg}`,
      });
    });
}

export async function cancelRecording(): Promise<void> {
  const rec = active;
  if (!rec) return;
  rec.cancelled = true;
  if (countdownWaiter) countdownWaiter();
  getOrCreateEngineWindow().webContents.send('engine:cancel', null);
  await hardResetSession();
  log.info('recording cancelled');
}

export async function restartRecording(): Promise<void> {
  const rec = active;
  if (!rec) return;
  const opts = rec.opts;
  await cancelRecording();
  // Restart skips the countdown: the user is already set up (Loom behaviour).
  try {
    await startRecordingWithoutCountdown(opts);
  } catch (err) {
    emitState({ status: 'idle', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

async function startRecordingWithoutCountdown(opts: RecordingOptions): Promise<void> {
  if (active) throw new Error('A recording is already in progress.');
  const tempId = `rec-${Date.now().toString(36)}-${nanoid(6)}`;
  const dir = path.join(tmpRoot(), tempId);
  fs.mkdirSync(dir, { recursive: true });
  const chunkFile = path.join(dir, 'chunks.bin');
  let display: Display;
  if (opts.mode !== 'cam' && opts.sourceIsDisplay && opts.sourceId) {
    display = displayForSource(await displayIdForSource(opts.sourceId));
  } else {
    display = displayForSource(undefined);
  }
  active = {
    tempId,
    dir,
    chunkFile,
    stream: fs.createWriteStream(chunkFile, { flags: 'a' }),
    opts,
    startedAt: Date.now(),
    recordedMsBase: 0,
    segmentStartedAt: null,
    status: 'countdown',
    mimeType: '',
    display,
    cameraOn: opts.cameraOn,
    cameraLayout: opts.mode === 'screen-cam' && opts.cameraOn ? 'bubble' : 'off',
    lastCamLayout: 'bubble',
    micOn: opts.micOn,
    drawOn: false,
    cancelled: false,
    stoppedResolvers: [],
  };
  if (opts.mode !== 'cam' && opts.sourceId) setPendingCapture(opts.sourceId, opts.systemAudio);
  const engine = getOrCreateEngineWindow();
  await whenEngineReady(engine.webContents.id);
  await beginEngineCapture();
}

async function hardResetSession(error?: string): Promise<void> {
  const rec = active;
  active = null;
  stopTick();
  closeSessionWindows();
  clearPendingCapture();
  if (rec) {
    await new Promise<void>((resolve) => rec.stream.end(resolve));
    try {
      fs.rmSync(rec.dir, { recursive: true, force: true });
    } catch (err) {
      log.warn(`temp cleanup failed: ${String(err)}`);
    }
  }
  emitState({ status: 'idle', elapsedSec: 0, ...(error ? { error } : {}) });
}

// ---------------------------------------------------------------------------
// Mid-recording toggles
// ---------------------------------------------------------------------------

export function toggleCamera(on: boolean): void {
  const rec = active;
  if (!rec) return;
  // Camera on/off maps onto the layout: off = 'Screen only', on = restore the
  // last camera layout (bubble or full).
  applyLayout(rec, on ? rec.lastCamLayout : 'off');
}

/** Switch the live camera layout mid-recording (Screen+Camera recordings only). */
export function setLayout(layout: CameraLayout): void {
  const rec = active;
  if (!rec) return;
  applyLayout(rec, layout);
}

/**
 * Apply a camera layout across both capture paths:
 * - Window-composite: the engine canvas compositor redraws (bubble/full/off).
 * - Full-display: the bubble is a real OS window the display capture sees, so
 *   we resize it (circle bottom-left / full-screen cover / hidden).
 */
function applyLayout(rec: ActiveRecording, layout: CameraLayout): void {
  // Only Screen+Camera recordings have a switchable camera. Screen-only has no
  // camera; cam-only is already full face.
  if (rec.opts.mode !== 'screen-cam') return;
  rec.cameraLayout = layout;
  rec.cameraOn = layout !== 'off';
  if (layout !== 'off') rec.lastCamLayout = layout;

  getOrCreateEngineWindow().webContents.send('engine:set-layout', layout);

  if (rec.opts.sourceIsDisplay) {
    applyFullDisplayBubble(rec, layout);
  } else {
    // Window-composite: the floating bubble window is only a preview; the
    // compositor burns the camera in. Mirror visibility, leave shape alone.
    setBubbleVisible(layout !== 'off');
  }
  emitState();
}

function applyFullDisplayBubble(rec: ActiveRecording, layout: CameraLayout): void {
  if (layout === 'off') {
    setBubbleVisible(false);
    return;
  }
  const size = getSettings().bubble.size;
  showBubble(rec.display, size);
  if (layout === 'full') {
    setBubbleFullScreen(rec.display);
    // Keep the (capture-excluded) HUD above the full-frame camera so the user
    // can always switch back.
    raiseHud();
  } else {
    positionBubbleCircle(rec.display, size);
  }
  setBubbleLayout(layout);
}

export function toggleMic(on: boolean): void {
  const rec = active;
  if (!rec) return;
  rec.micOn = on;
  getOrCreateEngineWindow().webContents.send('engine:set-mic', on);
  emitState();
}

export function toggleDraw(on: boolean): void {
  const rec = active;
  if (!rec) return;
  if (!rec.opts.sourceIsDisplay || rec.opts.mode === 'cam') return; // window/cam capture: draw not available
  rec.drawOn = on;
  setDrawInteractive(on);
  emitState();
}

export function setBubbleSize(size: 'S' | 'M' | 'L'): void {
  const { bubble } = getSettings();
  resizeBubbleKeepAnchor(size);
  getOrCreateEngineWindow().webContents.send('engine:set-bubble', { size, mirror: bubble.mirror });
}

export function sendClickRipple(x: number, y: number): void {
  const rec = active;
  if (!rec || rec.status !== 'recording') return;
  const draw = getDrawWindow();
  if (!draw) return;
  const bounds = draw.getBounds();
  draw.webContents.send('draw:ripple', { x: x - bounds.x, y: y - bounds.y });
}

// ---------------------------------------------------------------------------
// Engine IPC wiring
// ---------------------------------------------------------------------------

export function registerEngineIpc(): void {
  ipcMain.on('engine:ready', (event) => {
    readyEngines.add(event.sender.id);
    for (const waiter of engineReadyWaiters.get(event.sender.id) ?? []) waiter();
    engineReadyWaiters.delete(event.sender.id);
    event.sender.once('destroyed', () => readyEngines.delete(event.sender.id));
  });

  ipcMain.on('engine:started', (_event, info: { mimeType: string }) => {
    if (active) active.mimeType = info.mimeType;
    engineStartWaiter?.();
  });

  ipcMain.on('engine:error', (_event, message: string) => {
    log.error(`engine error: ${message}`);
    if (engineStartWaiter) {
      engineStartWaiter(message);
      void hardResetSession();
      return;
    }
    // Mid-recording failure: keep the chunks (recovery) and reset the session.
    const rec = active;
    active = null;
    stopTick();
    closeSessionWindows();
    clearPendingCapture();
    if (rec) {
      rec.stream.end();
      writeManifest(rec, 'recording');
    }
    emitState({ status: 'idle', elapsedSec: 0, error: message });
  });

  ipcMain.on('engine:chunk', (_event, chunk: Uint8Array) => {
    const rec = active;
    if (!rec) return;
    rec.stream.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  });

  ipcMain.on('engine:stopped', () => {
    engineStopWaiter?.();
  });

  ipcMain.on('countdown:done', () => {
    countdownWaiter?.();
  });

  ipcMain.on('countdown:cancel', () => {
    void cancelRecording();
  });
}

// ---------------------------------------------------------------------------
// Finalize: temp chunks -> seekable mp4 + thumb + gif + waveform + meta.json
// ---------------------------------------------------------------------------

function formatTitle(pattern: string, when: Date, mode: RecordingMode): string {
  const date = when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const title = pattern.replaceAll('{date}', date).replaceAll('{time}', time).replaceAll('{mode}', mode);
  return title.trim() || `Recording - ${date}, ${time}`;
}

async function finalizeRecording(rec: ActiveRecording): Promise<string> {
  const durationSec = Math.max(1, Math.round((rec.recordedMsBase / 1000) * 10) / 10);
  const videoId = await processCaptureFile({
    chunkFile: rec.chunkFile,
    mimeType: rec.mimeType,
    mode: rec.opts.mode,
    approxDurationSec: durationSec,
    createdAt: new Date(rec.startedAt),
  });
  try {
    fs.rmSync(rec.dir, { recursive: true, force: true });
  } catch (err) {
    log.warn(`temp cleanup failed: ${String(err)}`);
  }
  log.info(`recording ${videoId} landed in library`);
  return videoId;
}

/** Shared by normal stop and crash recovery. */
export async function processCaptureFile(input: {
  chunkFile: string;
  mimeType: string;
  mode: RecordingMode;
  approxDurationSec: number;
  createdAt: Date;
}): Promise<string> {
  const bins = ffmpeg.requireBinaries();
  const store = library();
  const videoId = nanoid(10);
  const videoDir = store.videoDir(videoId);
  fs.mkdirSync(videoDir, { recursive: true });
  const finalPath = path.join(videoDir, 'video.mp4');

  // Producing a valid video.mp4 is the only fatal step. If the transcode/remux
  // fails we clean up the half-built dir and rethrow (a genuine capture/encode
  // failure). Everything after this block is best-effort: a preview or probe
  // hiccup must never delete an already-valid recording.
  let expectedDuration = input.approxDurationSec;
  try {
    emitState({ status: 'processing', processingNote: 'Preparing video' });
    const probeIn = await ffmpeg.probe(bins, input.chunkFile).catch(() => null);
    expectedDuration = probeIn?.durationSec || input.approxDurationSec;

    await ffmpeg.enqueueJob(videoId, probeIn && ffmpeg.canRemux(probeIn) ? 'remux' : 'transcode', async (report) => {
      if (probeIn && ffmpeg.canRemux(probeIn)) {
        report(10, 'Remuxing');
        await ffmpeg.remux(bins, input.chunkFile, finalPath);
      } else {
        await ffmpeg.transcodeH264(bins, input.chunkFile, finalPath, {
          expectedDurationSec: expectedDuration,
          onProgress: (pct) => report(pct, 'Converting to MP4'),
        });
      }
    });
  } catch (err) {
    // Transcode failed: no valid video was produced, so leave no half-built
    // library entry behind.
    try {
      fs.rmSync(videoDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }

  // video.mp4 exists and is valid from here on. Probing it for exact dimensions
  // is best-effort too: fall back to what we know rather than losing the video.
  const info = await ffmpeg.probe(bins, finalPath).catch(() => null);
  emitState({ status: 'processing', processingNote: 'Creating preview' });

  const previewDuration = info?.durationSec ?? expectedDuration;
  await generatePreviews({
    thumbnail: () =>
      ffmpeg.enqueueJob(videoId, 'thumbnail', () =>
        ffmpeg.thumbnail(bins, finalPath, path.join(videoDir, 'thumb.jpg'), previewDuration * 0.25)
      ),
    gif: () => ffmpeg.enqueueJob(videoId, 'gif', () => ffmpeg.gifPreview(bins, finalPath, path.join(videoDir, 'preview.gif'))),
    waveform: () =>
      ffmpeg.enqueueJob(videoId, 'waveform', async () => {
        await ffmpeg.waveformPeaks(bins, finalPath, path.join(videoDir, 'waveform.json'));
      }),
    warn: (msg) => log.warn(`${videoId}: ${msg}`),
  });

  let sizeBytes = info?.sizeBytes ?? 0;
  if (!sizeBytes) {
    try {
      sizeBytes = fs.statSync(finalPath).size;
    } catch {
      /* keep 0 */
    }
  }

  const settings = getSettings();
  const meta: VideoMeta = {
    id: videoId,
    title: formatTitle(settings.namePattern, input.createdAt, input.mode),
    createdAt: input.createdAt.toISOString(),
    durationSec: info?.durationSec ?? Math.max(1, Math.round(expectedDuration)),
    width: info?.width ?? 0,
    height: info?.height ?? 0,
    fps: info?.fps ?? 0,
    sizeBytes,
    mode: input.mode,
    folderId: null,
  };
  store.put(meta);
  // Auto-transcribe after processing when an engine is configured (SPEC T1);
  // runs in the background and never blocks the Watch view opening.
  maybeAutoTranscribe(videoId);
  return videoId;
}

// ---------------------------------------------------------------------------
// Crash recovery (SPEC R8)
// ---------------------------------------------------------------------------

export function listRecoverable(): RecoverableRecording[] {
  const root = tmpRoot();
  if (!fs.existsSync(root)) return [];
  const out: RecoverableRecording[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (active && active.tempId === entry.name) continue;
    const dir = path.join(root, entry.name);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
        tempId: string;
        startedAt: string;
        opts: RecordingOptions;
        mimeType: string;
        approxDurationSec: number;
        status: string;
      };
      const chunkFile = path.join(dir, 'chunks.bin');
      if (manifest.status === 'completed' || !fs.existsSync(chunkFile)) continue;
      const size = fs.statSync(chunkFile).size;
      if (size === 0) continue;
      out.push({
        tempId: manifest.tempId,
        startedAt: manifest.startedAt,
        mode: manifest.opts.mode,
        mimeType: manifest.mimeType,
        approxDurationSec: manifest.approxDurationSec,
        sizeBytes: size,
      });
    } catch {
      // Unreadable manifest: not recoverable; leave for discard-all cleanup.
    }
  }
  return out;
}

export async function recoverRecording(tempId: string): Promise<{ videoId: string }> {
  const rec = listRecoverable().find((r) => r.tempId === tempId);
  if (!rec) throw new Error('That recording is no longer recoverable.');
  const dir = path.join(tmpRoot(), tempId);
  const videoId = await processCaptureFile({
    chunkFile: path.join(dir, 'chunks.bin'),
    mimeType: rec.mimeType,
    mode: rec.mode,
    approxDurationSec: rec.approxDurationSec,
    createdAt: new Date(rec.startedAt),
  });
  fs.rmSync(dir, { recursive: true, force: true });
  emitState({ status: 'idle', elapsedSec: 0, lastVideoId: videoId });
  return { videoId };
}

export async function discardRecoverable(tempId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(tempId)) throw new Error('Invalid recording id.');
  fs.rmSync(path.join(tmpRoot(), tempId), { recursive: true, force: true });
}

export function isRecordingActive(): boolean {
  return active !== null && active.status !== 'processing';
}

export function isPaused(): boolean {
  return active?.status === 'paused';
}
