/**
 * Recording orchestration (SPEC section 5, "Recording orchestration").
 * Main-process state machine: coordinates the engine window (capture +
 * MediaRecorder), HUD, bubble, countdown and draw overlays, receives chunk
 * buffers over IPC into a crash-safe temp file, and post-processes the
 * result into the library on stop.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, type Display } from 'electron';
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
import type { Settings } from '@shared/types';
import { getSettings, setSettings } from './settings';
import { log } from './logger';
import {
  broadcast,
  createMainWindow,
  destroyBubble,
  destroyCountdown,
  destroyDrawOverlay,
  destroyEngineWindow,
  destroyHud,
  destroyLauncher,
  destroyNotesOverlay,
  destroySwitcher,
  displayForSource,
  getMainWindow,
  fadeBubbleToLayout,
  getBubbleWindow,
  getDrawWindow,
  getOrCreateEngineWindow,
  positionBubbleCircle,
  positionBubbleFull,
  resizeBubbleKeepAnchor,
  setBubbleLayout,
  sendDrawClear,
  sendDrawColor,
  setBubbleVisible,
  setHudExpanded,
  setHudPanel,
  setNotesOverlayVisible,
  setDrawInteractive,
  showBubble,
  showCountdown,
  showDrawOverlay,
  showHud,
  showLauncher,
  showNotesOverlay,
  showSwitcher,
} from './windows';
import { setPendingCapture, clearPendingCapture, displayIdForSource } from './capture';
import {
  chunkWatchdogTripped,
  freeSpaceVerdict,
  keepChunksOnCancel,
  micSilenceTripped,
  MIC_SILENCE_RMS,
  needsDestroyConfirm,
  CONFIRM_EXPIRY_MS,
  redoCutAt,
  redoKeepRanges,
  totalRedoCutMs,
  startBlockMessage,
  stopIntent,
  type RedoCut,
} from './recording-guards';
import { trimVideoFile } from './editor-core';
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
  /** Last time an engine:chunk landed; feeds the dead-engine watchdog. */
  lastChunkAt: number;
  /** One low-disk warning per session, not one per tick. */
  lowDiskWarned: boolean;
  /** One camera-loss warning per session. */
  cameraLostNotified: boolean;
  /** Stretches marked by "re-say the last bit", removed at finalise. */
  redoCuts: RedoCut[];
  /** A redo waiting on its resume countdown; the cut commits when it hits 0. */
  pendingRedo: { cut: RedoCut; timer: NodeJS.Timeout; secondsLeft: number } | null;
  /** A destructive action (delete/restart) waiting on the HUD confirm panel. */
  confirmKind: 'cancel' | 'restart' | null;
  confirmExpiry: NodeJS.Timeout | null;
  /** Last time the mic level was above digital silence; feeds the silence watchdog. */
  lastAudibleAt: number;
  /** One dead-mic warning per silent stretch, not one per tick. */
  micSilenceNotified: boolean;
  /** Talking notes exist for this take (the HUD shows the toggle only then). */
  notesAvailable: boolean;
  /** The notes overlay is currently shown. */
  notesOn: boolean;
  stoppedResolvers: { resolve: (r: { videoId: string }) => void; reject: (e: Error) => void }[];
}

let active: ActiveRecording | null = null;
let tickTimer: NodeJS.Timeout | null = null;
let lastState: RecordingState = { status: 'idle', elapsedSec: 0 };

/** Healthy takes land within ~25ms; sample-drop drift lands in the 100s of ms. */
const AV_SYNC_TOLERANCE_SEC = 0.3;

function tmpRoot(): string {
  return path.join(app.getPath('userData'), 'recordings-tmp');
}

/**
 * Put a recording failure somewhere the user will actually see it. The toast
 * broadcast only reaches open windows, and the intended workflow (filming from
 * the launcher with the library closed) has none - so anything important also
 * goes out as a system notification, and anything data-loss-shaped opens the
 * library window so the recovery banner has somewhere to land.
 */
function notifyUser(kind: 'info' | 'error', text: string, opts?: { openLibrary?: boolean }): void {
  const recording = active !== null;
  const anyVisible = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible());
  broadcast('ol:toast', { kind, text });
  // During a recording the only visible windows are overlays that render no
  // toasts, so the system notification is the surface that reaches the user.
  if ((kind === 'error' || recording || !anyVisible) && Notification.isSupported()) {
    try {
      new Notification({ title: 'Open Loom', body: text }).show();
    } catch (err) {
      log.warn(`notification failed: ${String(err)}`);
    }
  }
  if (opts?.openLibrary) createMainWindow();
}

/** Tell open windows the recoverable set changed so banners refresh now, not at next launch. */
function broadcastRecoverablesChanged(): void {
  broadcast('ol:recoverable-added', null);
}

/**
 * End a chunk stream without ever hanging: `end`'s callback rides on 'finish',
 * which never fires once the stream has errored (full disk), so resolve on
 * either outcome.
 */
function endStreamSafe(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.writableFinished) {
      resolve();
      return;
    }
    stream.once('error', () => resolve());
    stream.end(() => resolve());
  });
}

/**
 * An unhandled 'error' on the chunk stream is an uncaught exception that takes
 * the whole app down mid-take (full disk, unplugged volume). Handle it: keep
 * what was written, reset the session and tell the user what happened.
 */
function armChunkStream(rec: ActiveRecording): void {
  rec.stream.on('error', (err) => {
    log.error(`chunk stream error for ${rec.tempId}: ${String(err)}`);
    if (active !== rec) return; // late error after the session already moved on
    failActiveRecording(
      'Recording stopped: the video could not be written to disk (it may be full). What was captured so far is saved - recover it from the library.'
    );
  });
}

/**
 * A recording died under the user (engine crash, dead disk, stalled encoder).
 * Keep the chunks recoverable, reset the session and surface the failure
 * loudly - this is the path a person filming a client proposal depends on.
 */
function failActiveRecording(message: string): void {
  const rec = active;
  active = null;
  stopTick();
  closeSessionWindows();
  clearPendingCapture();
  if (rec) {
    clearTransientPanels(rec);
    void endStreamSafe(rec.stream);
    writeManifest(rec, 'recording');
    broadcastRecoverablesChanged();
  }
  emitState({ status: 'idle', elapsedSec: 0, error: message });
  notifyUser('error', message, { openLibrary: true });
}

/** Free bytes on the volume holding `dir`; null when the platform cannot say. */
function freeBytesAt(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function elapsedSec(rec: ActiveRecording): number {
  const segment = rec.segmentStartedAt ? Date.now() - rec.segmentStartedAt : 0;
  // The timer shows what the final video will run, so committed redo cuts
  // come off - the visible jump back is the feedback that the redo landed.
  return Math.max(0, Math.floor((rec.recordedMsBase + segment - totalRedoCutMs(rec.redoCuts)) / 1000));
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
      // Full-face layout has no screen to draw on; cam-only never does.
      drawAvailable:
        active.opts.mode !== 'cam' && !!active.opts.sourceIsDisplay && active.cameraLayout !== 'full',
      ...(active.confirmKind ? { confirm: active.confirmKind } : {}),
      ...(active.pendingRedo ? { redoCountdown: active.pendingRedo.secondsLeft } : {}),
      notesAvailable: active.notesAvailable,
      notesOn: active.notesOn,
      ...partial,
    };
  } else {
    lastState = { status: 'idle', elapsedSec: 0, ...partial };
  }
  broadcast('ol:recording-state', lastState);
  // The launcher follows the session: it disappears while a recording runs
  // (destroyed, so its camera preview is released) and returns when idle.
  if (wasIdle && lastState.status !== 'idle') destroyLauncher(`state ${lastState.status}`);
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

/** Sample the disk this often during a recording (in 1s ticks). */
const DISK_SAMPLE_TICKS = 10;
let tickCount = 0;

function startTick(): void {
  stopTick();
  tickCount = 0;
  tickTimer = setInterval(() => {
    if (!active) return;
    emitState();
    if (active.status === 'recording') {
      writeManifest(active, 'recording');

      // Dead-engine watchdog: the HUD must never count over a take that is no
      // longer being captured. Chunks arrive every second; a silent engine is
      // crashed or wedged either way, and the user needs to know NOW.
      if (chunkWatchdogTripped(active.status, active.lastChunkAt, Date.now())) {
        log.error(`no chunks for ${Date.now() - active.lastChunkAt}ms; treating the take as broken`);
        failActiveRecording(
          'Recording stopped: the capture engine stopped responding. Everything captured up to now is saved - recover it from the library.'
        );
        return;
      }

      // Sustained write backpressure: the disk cannot keep up and buffered
      // chunks are piling up in memory. Warn once; the low-disk stop below
      // covers the usual cause (a nearly full disk).
      if (!active.lowDiskWarned && active.stream.writableLength > 64 * 1024 * 1024) {
        active.lowDiskWarned = true;
        notifyUser('error', 'Your disk is not keeping up with the recording. Consider stopping soon to make sure the take saves.');
      }

      tickCount += 1;
      if (tickCount % DISK_SAMPLE_TICKS === 0) {
        const free = freeBytesAt(active.dir);
        if (free !== null) {
          const verdict = freeSpaceVerdict(free);
          if (verdict === 'critical') {
            log.warn(`free space critical (${free} bytes); auto-stopping to save the take`);
            notifyUser('error', 'Your disk is almost full - stopping and saving the recording now.');
            void stopRecording().catch((err) => log.error(`low-disk auto-stop failed: ${String(err)}`));
            return;
          }
          if (verdict === 'low' && !active.lowDiskWarned) {
            active.lowDiskWarned = true;
            notifyUser('error', 'Your disk is running low on space. The recording will stop and save itself before the disk fills.');
          }
        }
      }

      // Mic silence watchdog: a dead or wrongly-picked mic records a silent
      // client video. Warn while re-recording still costs a minute.
      if (
        !active.micSilenceNotified &&
        micSilenceTripped(active.status, active.micOn, active.lastAudibleAt, Date.now())
      ) {
        active.micSilenceNotified = true;
        notifyUser(
          'error',
          'The microphone has not picked up any sound for a while. If you are speaking, check the mic - the recording is still running.'
        );
      }

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
  destroyNotesOverlay();
  destroySwitcher();
}

/** Stop the confirm and redo timers so a finished session cannot fire them late. */
function clearTransientPanels(rec: ActiveRecording): void {
  if (rec.pendingRedo) {
    clearInterval(rec.pendingRedo.timer);
    rec.pendingRedo = null;
  }
  if (rec.confirmExpiry) {
    clearTimeout(rec.confirmExpiry);
    rec.confirmExpiry = null;
  }
  rec.confirmKind = null;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startRecording(opts: RecordingOptions): Promise<void> {
  if (active) throw new Error('A recording is already in progress.');
  // ffmpeg is fetched automatically (prefetched at launch; awaited here as the
  // backstop) - never a user-facing wall. Throws only if the download fails.
  await ffmpeg.ensureFfmpeg('record');
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
  // Pre-flight: refuse to start a take the disk cannot hold. Running out
  // mid-recording used to be a hard crash (see armChunkStream).
  const free = freeBytesAt(dir);
  if (free !== null) {
    const block = startBlockMessage(free, opts.quality);
    if (block) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      notifyUser('error', block);
      throw new Error(block);
    }
  }
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
    lastChunkAt: 0,
    lowDiskWarned: false,
    cameraLostNotified: false,
    redoCuts: [],
    pendingRedo: null,
    confirmKind: null,
    confirmExpiry: null,
    lastAudibleAt: 0,
    micSilenceNotified: false,
    notesAvailable: false,
    notesOn: false,
    stoppedResolvers: [],
  };
  const rec = active;
  armChunkStream(rec);
  // Remember the picked source so the launcher can offer it first next time.
  if (opts.sourceId && settings.recording.lastSourceId !== opts.sourceId) {
    setSettings({ recording: { lastSourceId: opts.sourceId } } as Partial<Settings>);
  }

  try {
    if (opts.mode !== 'cam' && opts.sourceId) {
      setPendingCapture(opts.sourceId, opts.systemAudio);
    }

    // Release the launcher's camera BEFORE warming the bubble so the two
    // renderers never fight over the device during startup.
    destroyLauncher('recording starting');

    // Warm the face bubble NOW: the window and its camera stream spin up in
    // parallel with the engine + countdown, so the circle is live from the
    // first recorded frame instead of appearing ~2s into the video.
    if (opts.mode === 'screen-cam') showBubble(display, settings.bubble.size);

    const engine = getOrCreateEngineWindow();
    await whenEngineReady(engine.webContents.id);

    if (settings.countdown) {
      emitState();
      showCountdown(display);
      await waitForCountdown();
      destroyCountdown();
      // The session may no longer be ours: a stop or cancel during the 3-2-1
      // must never walk on into a capture over a finalised session.
      if (active !== rec || rec.cancelled || rec.status !== 'countdown') return;
    }

    await beginEngineCapture(rec);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Carry the failure on the state broadcast too: the launcher window that
    // initiated the start is destroyed with the session, so the invoke
    // rejection alone can land in a dead renderer.
    await hardResetSession(rec, message);
    notifyUser('error', `Recording did not start: ${message}`);
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

async function beginEngineCapture(rec: ActiveRecording): Promise<void> {
  // The session must still be ours and still pre-capture: a stop or cancel
  // that raced the countdown means this begin belongs to a dead session.
  if (active !== rec || rec.cancelled || rec.status !== 'countdown') return;
  const settings = getSettings();
  const engine = getOrCreateEngineWindow();
  armEngineCrashWatch(engine);

  const started = new Promise<void>((resolve, reject) => {
    const waiter: EngineStartWaiter = {
      rec,
      settle: (err) => {
        clearTimeout(timer);
        if (engineStartWaiter === waiter) engineStartWaiter = null;
        if (err) reject(new Error(err));
        else resolve();
      },
    };
    const timer = setTimeout(() => {
      // Only time out the CURRENT session. A stale timer from an abandoned
      // start must never reject (and thereby reset) the take that replaced it.
      if (engineStartWaiter === waiter) {
        waiter.settle('Recording did not start. Check screen permissions in Setup and try again.');
      } else {
        resolve();
      }
    }, 20_000);
    engineStartWaiter = waiter;
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
  rec.lastChunkAt = Date.now();
  // Baseline for the silence watchdog: a mic that never delivers a single
  // audible sample should trip it too, not sit below its "ever audible" gate.
  rec.lastAudibleAt = Date.now();
  writeManifest(rec, 'recording');

  showHud(rec.display);
  const notes = settings.recording.notes.trim();
  rec.notesAvailable = notes.length > 0;
  rec.notesOn = rec.notesAvailable;
  if (notes) showNotesOverlay(rec.display, notes);
  if (rec.opts.mode === 'screen-cam' && rec.cameraOn) {
    showBubble(rec.display, settings.bubble.size);
    showSwitcher(rec.display);
  }
  if (rec.opts.mode !== 'cam' && rec.opts.sourceIsDisplay) {
    showDrawOverlay(rec.display);
  }
  startTick();
  emitState();
  log.info(`recording started (${rec.opts.mode}, ${rec.opts.quality}@${rec.opts.fps}, mime=${rec.mimeType})`);
}

/** Tied to the session that armed it, so stale settles can be recognised and ignored. */
interface EngineStartWaiter {
  rec: ActiveRecording;
  settle: (err?: string) => void;
}
let engineStartWaiter: EngineStartWaiter | null = null;
let engineStopWaiter: (() => void) | null = null;

/**
 * The engine renderer can die outright (a 4K compositor is a realistic OOM
 * candidate) and IPC-based liveness never notices: nothing arrives, and the
 * HUD keeps counting over a take that is no longer captured. Watch the
 * process itself; the chunk watchdog in the tick covers wedged-but-alive.
 */
const crashWatchedEngines = new WeakSet<Electron.WebContents>();

function armEngineCrashWatch(engine: BrowserWindow): void {
  if (crashWatchedEngines.has(engine.webContents)) return;
  crashWatchedEngines.add(engine.webContents);
  engine.webContents.on('render-process-gone', (_event, details) => {
    log.error(`engine renderer gone (${details.reason})`);
    destroyEngineWindow();
    const waiter = engineStartWaiter;
    if (waiter) {
      waiter.settle('The recorder engine crashed before the recording started. Try again.');
      return;
    }
    if (active) {
      failActiveRecording(
        'Recording stopped: the capture engine crashed. Everything captured up to now is saved - recover it from the library.'
      );
    }
  });
}

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
  // A redo countdown owns the paused state; its commit or escape hatch is the
  // only way back to recording, or the engine would resume twice.
  if (rec.pendingRedo) return;
  getOrCreateEngineWindow().webContents.send('engine:resume', null);
  rec.segmentStartedAt = Date.now();
  // Fresh watchdog window: a paused recorder emits no chunks by design.
  rec.lastChunkAt = Date.now();
  rec.status = 'recording';
  emitState();
}

/**
 * Ceiling on finalisation: the ffmpeg queue is serial and shared with editor
 * and transcription jobs, so a stop can otherwise sit in "Processing" forever
 * with no escape. On timeout the capture stays recoverable; if the transcode
 * still lands later it simply replaces the recoverable with the real video.
 */
const FINALIZE_CEILING_MS = 10 * 60_000;

export async function stopRecording(): Promise<{ videoId: string }> {
  const rec = active;
  if (!rec) throw new Error('Nothing is recording.');
  const intent = stopIntent(rec.status);
  if (intent === 'cancel') {
    // Stop during the 3-2-1: nothing has been captured, so this is a cancel.
    // Routing it into the stop path could resurrect a finalised session and
    // write into a closed file.
    await cancelRecording();
    throw new Error('The recording had not started yet, so it was cancelled.');
  }
  if (intent === 'queue') {
    return new Promise((resolve, reject) => rec.stoppedResolvers.push({ resolve, reject }));
  }
  if (rec.segmentStartedAt) {
    rec.recordedMsBase += Date.now() - rec.segmentStartedAt;
    rec.segmentStartedAt = null;
  }
  // A stop during the redo countdown keeps the footage: the uncommitted cut is
  // dropped rather than applied, because keeping too much is the safe failure.
  clearTransientPanels(rec);
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

  await endStreamSafe(rec.stream);
  clearPendingCapture();

  return new Promise<{ videoId: string }>((resolve, reject) => {
    rec.stoppedResolvers.push({ resolve, reject });
    let settled = false;
    const ceiling = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.error(`finalize exceeded ${FINALIZE_CEILING_MS}ms; releasing the session, capture stays recoverable`);
      if (active === rec) active = null;
      const msg =
        'Processing is taking too long, so the app has stopped waiting. Your capture is safe - recover it from the library.';
      emitState({ status: 'idle', elapsedSec: 0, error: msg });
      broadcastRecoverablesChanged();
      notifyUser('error', msg, { openLibrary: true });
      for (const r of rec.stoppedResolvers) r.reject(new Error(msg));
    }, FINALIZE_CEILING_MS);
    void finalizeRecording(rec)
      .then((videoId) => {
        clearTimeout(ceiling);
        const late = settled;
        settled = true;
        if (active === rec) active = null;
        emitState({ status: 'idle', elapsedSec: 0, lastVideoId: videoId });
        if (late) {
          // The transcode landed after the ceiling gave up on it: the video is
          // real, the recoverable it replaced is gone - refresh the banners.
          log.info(`late finalize landed as ${videoId}`);
          broadcastRecoverablesChanged();
        }
        maybeOpenWatchOnStop(videoId);
        maybeAutoShareOnStop(videoId);
        for (const r of rec.stoppedResolvers) r.resolve({ videoId });
      })
      .catch((err: unknown) => {
        clearTimeout(ceiling);
        if (settled) return;
        settled = true;
        log.error(`finalize failed: ${String(err)}`);
        if (active === rec) active = null;
        const msg = humanProcessingError(err);
        emitState({ status: 'idle', elapsedSec: 0, error: msg });
        // The raw capture was kept - make sure the user can find it NOW, not
        // at the next launch, even with every window closed.
        broadcastRecoverablesChanged();
        notifyUser('error', msg, { openLibrary: true });
        for (const r of rec.stoppedResolvers) r.reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/**
 * A take that finished with the library window closed used to end on a bare
 * launcher with no sign the video exists. Open the library on the Watch view
 * so "your recording is ready" actually reads that way; the id is handed to
 * the fresh window via takePendingWatch since the state broadcast fires
 * before its renderer subscribes.
 */
let pendingWatchVideoId: string | null = null;

export function takePendingWatch(): string | null {
  const id = pendingWatchVideoId;
  pendingWatchVideoId = null;
  return id;
}

function maybeOpenWatchOnStop(videoId: string): void {
  if (getMainWindow()) return; // the open window navigates off the state broadcast
  pendingWatchVideoId = videoId;
  createMainWindow();
}

function humanProcessingError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `We could not finish processing this recording: ${msg} The raw capture is kept - recover it from the library.`;
}

/**
 * SPEC R14 / G6: when a share provider is configured and "copy link on stop"
 * is on, mint the share URL the moment the recording lands, copy it to the
 * clipboard, and let the upload run in the background. Failures surface as a
 * toast and never break the finished recording, which stays in the library.
 */
function maybeAutoShareOnStop(videoId: string): void {
  const settings = getSettings();
  const sharing = settings.sharing;
  if (sharing.provider === 'none' || !sharing.autoCopyOnStop) return;
  // A provider that was switched on but never configured must not raise an
  // error toast and a warn line on every single recording; name the gap once.
  if (sharing.provider === 'server' && !sharing.server.url.trim()) {
    log.info(`auto-share skipped for ${videoId}: provider is 'server' but no server URL is set`);
    return;
  }
  if (sharing.provider === 's3' && !sharing.s3.bucket.trim()) {
    log.info(`auto-share skipped for ${videoId}: provider is 's3' but no bucket is set`);
    return;
  }
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

export async function cancelRecording(opts?: { quiet?: boolean }): Promise<void> {
  const rec = active;
  if (!rec) return;
  clearTransientPanels(rec);
  rec.cancelled = true;
  if (countdownWaiter) countdownWaiter();
  // Release a start still in flight quietly: its begin path re-checks session
  // ownership after the await, and its 20s timer must not fire a false
  // "did not start" long after the user cancelled.
  if (engineStartWaiter && engineStartWaiter.rec === rec) engineStartWaiter.settle();
  getOrCreateEngineWindow().webContents.send('engine:cancel', null);
  // Cancel rides on a global hotkey one mis-press away from pause: a take
  // with real content in it is parked as recoverable instead of deleted, so
  // a slip never destroys minutes of capture with no undo.
  const keep =
    (rec.status === 'recording' || rec.status === 'paused') && keepChunksOnCancel(elapsedSec(rec));
  if (keep) {
    active = null;
    stopTick();
    closeSessionWindows();
    clearPendingCapture();
    await endStreamSafe(rec.stream);
    writeManifest(rec, 'recording');
    broadcastRecoverablesChanged();
    emitState({ status: 'idle', elapsedSec: 0 });
    if (!opts?.quiet) {
      notifyUser('info', 'Recording discarded. It is kept for now in case that was a slip - recover or delete it from the library.');
    }
  } else {
    await hardResetSession(rec);
  }
  log.info(`recording cancelled${keep ? ' (kept recoverable)' : ''}`);
}

export async function restartRecording(): Promise<void> {
  const rec = active;
  if (!rec) return;
  const opts = rec.opts;
  await cancelRecording({ quiet: true });
  // Restart skips the countdown: the user is already set up (Loom behaviour).
  try {
    await startRecordingWithoutCountdown(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitState({ status: 'idle', error: message });
    notifyUser('error', `Restart failed: ${message}`);
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
    lastChunkAt: 0,
    lowDiskWarned: false,
    cameraLostNotified: false,
    redoCuts: [],
    pendingRedo: null,
    confirmKind: null,
    confirmExpiry: null,
    lastAudibleAt: 0,
    micSilenceNotified: false,
    notesAvailable: false,
    notesOn: false,
    stoppedResolvers: [],
  };
  const rec = active;
  armChunkStream(rec);
  if (opts.mode !== 'cam' && opts.sourceId) setPendingCapture(opts.sourceId, opts.systemAudio);
  destroyLauncher('recording restarting');
  // Same early warm-up as the countdown path: the camera connects while the
  // engine rebuilds its capture, so restart also starts with a live circle.
  if (opts.mode === 'screen-cam') showBubble(display, getSettings().bubble.size);
  const engine = getOrCreateEngineWindow();
  await whenEngineReady(engine.webContents.id);
  await beginEngineCapture(rec);
}

/**
 * Reset ONE session. Scoped on purpose: a stale failure (an abandoned start's
 * 20s timer, a late stream error) must only ever clean up its own temp files,
 * never tear down - let alone delete - a live session that replaced it.
 */
async function hardResetSession(rec: ActiveRecording | null, error?: string): Promise<void> {
  const owns = rec !== null && active === rec;
  if (rec) clearTransientPanels(rec);
  if (owns) {
    active = null;
    stopTick();
    closeSessionWindows();
    clearPendingCapture();
  }
  if (rec) {
    await endStreamSafe(rec.stream);
    try {
      fs.rmSync(rec.dir, { recursive: true, force: true });
    } catch (err) {
      log.warn(`temp cleanup failed: ${String(err)}`);
    }
  }
  if (owns || active === null) {
    emitState({ status: 'idle', elapsedSec: 0, ...(error ? { error } : {}) });
  }
}

// ---------------------------------------------------------------------------
// Destructive-action confirm (HUD panel; shared by buttons and global hotkeys)
// ---------------------------------------------------------------------------

function openConfirm(rec: ActiveRecording, kind: 'cancel' | 'restart'): void {
  // A redo countdown in flight is abandoned harmlessly: the take resumes and
  // the confirm panel takes over.
  if (rec.pendingRedo) cancelPendingRedo();
  if (rec.confirmExpiry) clearTimeout(rec.confirmExpiry);
  rec.confirmKind = kind;
  rec.confirmExpiry = setTimeout(() => closeConfirm(rec), CONFIRM_EXPIRY_MS);
  setHudPanel('confirm');
  emitState();
}

function closeConfirm(rec: ActiveRecording): void {
  if (rec.confirmExpiry) clearTimeout(rec.confirmExpiry);
  rec.confirmExpiry = null;
  rec.confirmKind = null;
  if (active === rec) {
    setHudPanel('normal');
    emitState();
  }
}

/** Cancel, behind a confirm once the take is long enough to be worth one. */
export function requestCancelRecording(): void {
  const rec = active;
  if (!rec) return;
  if (needsDestroyConfirm(rec.status, elapsedSec(rec))) openConfirm(rec, 'cancel');
  else void cancelRecording();
}

/** Restart, behind the same confirm gate as cancel. */
export function requestRestartRecording(): void {
  const rec = active;
  if (!rec) return;
  if (needsDestroyConfirm(rec.status, elapsedSec(rec))) openConfirm(rec, 'restart');
  else void restartRecording().catch((err) => log.error(`restart failed: ${String(err)}`));
}

/** Answer the HUD confirm. `confirmed` false keeps recording. */
export function resolveRecordingConfirm(confirmed: boolean): void {
  const rec = active;
  if (!rec || !rec.confirmKind) return;
  const kind = rec.confirmKind;
  closeConfirm(rec);
  if (!confirmed) return;
  if (kind === 'cancel') void cancelRecording();
  else void restartRecording().catch((err) => log.error(`restart failed: ${String(err)}`));
}

// ---------------------------------------------------------------------------
// Re-say the last bit (redo cuts)
// ---------------------------------------------------------------------------

/** Breathing room before the take resumes after a redo. */
const REDO_RESUME_COUNTDOWN_SEC = 3;

/**
 * Go back ten seconds and say it again: pause the take, count down on the
 * HUD, then resume with the fluffed stretch marked for removal at finalise.
 */
export function redoLastTen(): void {
  const rec = active;
  if (!rec || rec.status !== 'recording' || rec.pendingRedo || rec.confirmKind) return;
  const recordedMs = rec.recordedMsBase + (rec.segmentStartedAt ? Date.now() - rec.segmentStartedAt : 0);
  getOrCreateEngineWindow().webContents.send('engine:pause', null);
  if (rec.segmentStartedAt) {
    rec.recordedMsBase += Date.now() - rec.segmentStartedAt;
    rec.segmentStartedAt = null;
  }
  rec.status = 'paused';
  const timer = setInterval(() => {
    const p = rec.pendingRedo;
    if (!p || active !== rec) {
      clearInterval(timer);
      return;
    }
    p.secondsLeft -= 1;
    if (p.secondsLeft <= 0) commitPendingRedo(rec);
    else emitState();
  }, 1000);
  rec.pendingRedo = { cut: redoCutAt(recordedMs), timer, secondsLeft: REDO_RESUME_COUNTDOWN_SEC };
  setHudPanel('redo');
  emitState();
  log.info(`redo armed: will cut ${JSON.stringify(rec.pendingRedo.cut)} on resume`);
}

function resumeAfterRedo(rec: ActiveRecording): void {
  getOrCreateEngineWindow().webContents.send('engine:resume', null);
  rec.segmentStartedAt = Date.now();
  rec.lastChunkAt = Date.now();
  rec.lastAudibleAt = Date.now();
  rec.status = 'recording';
  setHudPanel('normal');
  emitState();
}

function commitPendingRedo(rec: ActiveRecording): void {
  const p = rec.pendingRedo;
  if (!p) return;
  clearInterval(p.timer);
  rec.redoCuts.push(p.cut);
  rec.pendingRedo = null;
  resumeAfterRedo(rec);
}

/** Escape hatch while the redo countdown runs: keep the take as it was. */
export function cancelPendingRedo(): void {
  const rec = active;
  const p = rec?.pendingRedo;
  if (!rec || !p) return;
  clearInterval(p.timer);
  rec.pendingRedo = null;
  resumeAfterRedo(rec);
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

/**
 * Switch the live camera layout from the bottom-screen slider (Screen+Camera
 * recordings only): 'bubble' = face + screen, 'full' = full face.
 */
export function setCameraLayout(layout: CameraLayout): void {
  const rec = active;
  if (!rec || (rec.status !== 'recording' && rec.status !== 'paused')) return;
  applyLayout(rec, layout);
}

/**
 * Apply a camera layout across both capture paths:
 * - Window-composite: the engine canvas compositor crossfades between layouts.
 * - Full-display: the bubble is a real OS window the display capture sees; a
 *   bubble <-> full flip fades out, swaps bounds and fades back in.
 */
function applyLayout(rec: ActiveRecording, layout: CameraLayout): void {
  // Only Screen+Camera recordings have a switchable camera. Screen-only has no
  // camera; cam-only is already full face.
  if (rec.opts.mode !== 'screen-cam') return;
  if (rec.cameraLayout === layout) return;
  const prev = rec.cameraLayout;
  rec.cameraLayout = layout;
  rec.cameraOn = layout !== 'off';
  if (layout !== 'off') rec.lastCamLayout = layout;

  // Full face leaves nothing to draw on: an active pen session ends here
  // (the overlay fades its ink out on disable).
  if (layout === 'full' && rec.drawOn) {
    rec.drawOn = false;
    setDrawInteractive(false);
    setHudExpanded(false);
  }

  getOrCreateEngineWindow().webContents.send('engine:set-layout', layout);

  if (rec.opts.sourceIsDisplay) {
    applyFullDisplayBubble(rec, layout, prev);
  } else {
    // Window-composite: the floating bubble window is only a preview; the
    // compositor burns the camera in. Mirror visibility, leave shape alone.
    setBubbleVisible(layout !== 'off');
  }
  emitState();
}

function applyFullDisplayBubble(rec: ActiveRecording, layout: CameraLayout, prev: CameraLayout): void {
  if (layout === 'off') {
    setBubbleVisible(false);
    return;
  }
  const size = getSettings().bubble.size;
  const flip = (prev === 'bubble' && layout === 'full') || (prev === 'full' && layout === 'bubble');
  if (flip && getBubbleWindow()) {
    // Live bubble <-> full flip: fade handles bounds + shape while invisible.
    // showBubble would snap the window back to a circle first, so skip it.
    fadeBubbleToLayout(rec.display, size, layout);
    return;
  }
  showBubble(rec.display, size);
  if (layout === 'full') positionBubbleFull(rec.display);
  else positionBubbleCircle(rec.display, size);
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
  if (on && rec.cameraLayout === 'full') return; // full face on screen: nothing to draw on
  rec.drawOn = on;
  // Leaving draw mode is the signal that the annotation is over: the
  // overlay fades its ink out the moment it is disabled (see draw.ts).
  setDrawInteractive(on);
  setHudExpanded(on);
  emitState();
}

/** Hide/show the talking-notes overlay; it keeps its dragged position. */
export function toggleNotes(): void {
  const rec = active;
  if (!rec || !rec.notesAvailable) return;
  rec.notesOn = !rec.notesOn;
  setNotesOverlayVisible(rec.notesOn);
  emitState();
}

export function setDrawColor(color: string): void {
  const rec = active;
  if (!rec || !rec.drawOn) return;
  sendDrawColor(color);
}

export function clearDraw(): void {
  sendDrawClear();
}

export function setBubbleSize(size: 'S' | 'M' | 'L'): void {
  const { bubble } = getSettings();
  resizeBubbleKeepAnchor(size);
  getOrCreateEngineWindow().webContents.send('engine:set-bubble', { size, mirror: bubble.mirror });
}

export function sendClickRipple(x: number, y: number): void {
  const rec = active;
  if (!rec || rec.status !== 'recording') return;
  // The draw overlay sits above the full-face cover; ripples over the face
  // would record as floating rings, so they pause while the layout is 'full'.
  if (rec.cameraLayout === 'full') return;
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
    const waiter = engineStartWaiter;
    if (!waiter) return;
    waiter.rec.mimeType = info.mimeType;
    waiter.settle();
  });

  ipcMain.on('engine:error', (_event, message: string) => {
    log.error(`engine error: ${message}`);
    const waiter = engineStartWaiter;
    if (waiter) {
      waiter.settle(message);
      void hardResetSession(waiter.rec, message);
      return;
    }
    // Mid-recording failure: keep the chunks (recovery), reset the session
    // and make sure a person filming with every window closed still hears it.
    if (active) {
      failActiveRecording(`${message} Everything captured up to now is saved - recover it from the library.`);
    }
  });

  ipcMain.on('engine:chunk', (_event, chunk: Uint8Array) => {
    const rec = active;
    // A chunk can arrive after stop ended the stream (a slow engine flush, or
    // a session the stop timeout gave up on): writing then would raise the
    // stream error path for a take that already saved cleanly.
    if (!rec || rec.stream.writableEnded || rec.stream.destroyed) return;
    rec.lastChunkAt = Date.now();
    rec.stream.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  });

  // The camera died mid-recording (unplugged webcam, USB hub glitch). The
  // take keeps going - losing the face must never lose the screen - but the
  // user gets told instead of discovering a frozen face after delivery.
  ipcMain.on('ol:camera-lost', () => {
    const rec = active;
    if (!rec || rec.opts.mode !== 'screen-cam') return;
    // Full-display capture records the bubble window itself: hide it so a
    // frozen frame or an error card is not burned into the client video.
    if (rec.opts.sourceIsDisplay) setBubbleVisible(false);
    if (rec.cameraLostNotified) return;
    rec.cameraLostNotified = true;
    notifyUser(
      'error',
      'Your camera stopped working, so the recording is continuing without your face. Reconnect the camera and switch the layout to bring it back.'
    );
  });

  // Engine-side mic RMS sample: relayed to the HUD meter and fed to the
  // silence watchdog. A level above digital silence also re-arms the warning.
  ipcMain.on('engine:mic-level', (_event, level: number) => {
    const rec = active;
    if (!rec || typeof level !== 'number' || !Number.isFinite(level)) return;
    broadcast('ol:mic-level', level);
    if (level > MIC_SILENCE_RMS) {
      rec.lastAudibleAt = Date.now();
      rec.micSilenceNotified = false;
    }
  });

  ipcMain.on('ol:redoLastTen', () => redoLastTen());
  ipcMain.on('ol:toggleNotes', () => toggleNotes());
  ipcMain.on('ol:cancelPendingRedo', () => cancelPendingRedo());
  ipcMain.on('ol:resolveRecordingConfirm', (_event, confirmed: boolean) =>
    resolveRecordingConfirm(confirmed === true)
  );

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
    redoCuts: rec.redoCuts,
  });
  // Mark the manifest done BEFORE cleanup: if the rm fails, the leftover dir
  // must not be offered as a recoverable for a take that saved fine.
  writeManifest(rec, 'completed');
  try {
    fs.rmSync(rec.dir, { recursive: true, force: true });
  } catch (err) {
    log.warn(`temp cleanup failed: ${String(err)}`);
  }
  log.info(`recording ${videoId} landed in library`);
  return videoId;
}

/**
 * Shared by normal stop and crash recovery. `redoCuts` (recorded time, pauses
 * excluded) are trimmed out of the finished file; crash recovery never passes
 * them, because keeping the full take is the safe failure.
 */
export async function processCaptureFile(input: {
  chunkFile: string;
  mimeType: string;
  mode: RecordingMode;
  approxDurationSec: number;
  createdAt: Date;
  redoCuts?: RedoCut[];
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

  // Apply the "re-say the last bit" cuts now, before previews, so the thumb,
  // gif and waveform never show the fluffed stretches. Best-effort: a failed
  // trim keeps the full take, never fails the recording.
  if (input.redoCuts && input.redoCuts.length > 0) {
    try {
      const probed = await ffmpeg.probe(bins, finalPath).catch(() => null);
      const keep = redoKeepRanges(input.redoCuts, probed?.durationSec ?? expectedDuration);
      if (keep) {
        emitState({ status: 'processing', processingNote: 'Removing the re-said parts' });
        const tmpOut = path.join(videoDir, '.redo-tmp.mp4');
        try {
          await ffmpeg.enqueueJob(videoId, 'trim', async (report, signal) => {
            await trimVideoFile(bins, finalPath, tmpOut, keep, (pct) => report(pct, 'Removing the re-said parts'), signal);
          });
          fs.renameSync(tmpOut, finalPath);
          log.info(`${videoId}: removed ${input.redoCuts.length} re-said stretch(es)`);
        } finally {
          fs.rmSync(tmpOut, { force: true });
        }
      }
    } catch (err) {
      log.warn(`${videoId}: redo cuts could not be applied, keeping the full take: ${String(err)}`);
    }
  }

  // video.mp4 exists and is valid from here on. Probing it for exact dimensions
  // is best-effort too: fall back to what we know rather than losing the video.
  const info = await ffmpeg.probe(bins, finalPath).catch(() => null);

  // Sync guard: a healthy take muxes audio and video to within a few ms. A
  // materially shorter audio track means the capture dropped samples and the
  // take WILL play out of lip-sync - tell the user now, while re-recording
  // costs a minute, not after the link is with a client.
  if (info?.audioDurationSec != null && info.durationSec > 0) {
    const driftSec = info.durationSec - info.audioDurationSec;
    if (Math.abs(driftSec) > AV_SYNC_TOLERANCE_SEC) {
      log.warn(`${videoId}: audio/video duration mismatch ${driftSec.toFixed(2)}s - take is likely out of sync`);
      broadcast('ol:toast', {
        kind: 'error',
        text: `Audio and video drifted ${Math.abs(driftSec).toFixed(1)}s apart in this take - it will play out of sync. Best to re-record.`,
      });
    }
  }
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

/**
 * Quitting from the tray mid-recording used to be silent: the take survived
 * only as a crash-recoverable, minus whatever the write stream had buffered.
 * Ask first.
 */
export function installQuitGuard(): void {
  app.on('before-quit', (event) => {
    if (!isRecordingActive()) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Stop and save', 'Discard recording', 'Keep recording'],
      defaultId: 0,
      cancelId: 2,
      message: 'A recording is still running.',
      detail: 'Save it before quitting, discard it, or go back to recording.',
    });
    if (choice === 0) {
      void stopRecording()
        .catch((err) => log.error(`stop on quit failed: ${String(err)}`))
        .finally(() => app.quit());
    } else if (choice === 1) {
      void cancelRecording().finally(() => app.quit());
    }
  });
}

export function isPaused(): boolean {
  return active?.status === 'paused';
}
