/**
 * Recorder engine (hidden window). Owns getDisplayMedia/getUserMedia,
 * WebAudio mixing of mic + system audio, canvas compositing for
 * window+camera mode, codec selection and MediaRecorder with a 1000ms
 * timeslice. Chunks stream to the main process over IPC and land in a
 * crash-safe temp file.
 */
import type { CameraLayout, EngineBeginPayload } from '@shared/types';
import { BUBBLE_SIZES } from '@shared/types';
import { cameraDrawPlan, coverFit } from './layout';
import { attachHealthyCameraStream, getUserMediaResilient } from '../media';

const internal = window.openloomInternal;

interface EngineSession {
  recorder: MediaRecorder;
  allStreams: MediaStream[];
  audioCtx: AudioContext | null;
  micGain: GainNode | null;
  micTrack: MediaStreamTrack | null;
  compositor: Compositor | null;
  chunkChain: Promise<void>;
  stopping: boolean;
}

let session: EngineSession | null = null;

// Monotonic token claimed by each begin. A cancel/restart bumps it, so a begin
// still awaiting getDisplayMedia/getUserMedia inside buildSession can detect
// that it was cancelled during setup and abort instead of starting a recorder
// (and leaving the camera/screen live) after the user already cancelled.
let beginToken = 0;

// ---------------------------------------------------------------------------
// Codec selection (SPEC locked decision: mp4 h264 preferred, then vp9, vp8)
// ---------------------------------------------------------------------------

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function pickMimeType(): string {
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Window+camera compositor (SPEC locked decision: canvas burn-in bottom-left)
// ---------------------------------------------------------------------------

interface Compositor {
  stream: MediaStream;
  setCameraOn(on: boolean): void;
  setCameraLayout(layout: CameraLayout): void;
  setBubble(size: 'S' | 'M' | 'L', mirror: boolean): void;
  stop(): void;
}

function createCompositor(
  windowVideo: HTMLVideoElement,
  camVideo: HTMLVideoElement | null,
  fps: number,
  initial: { size: 'S' | 'M' | 'L'; mirror: boolean; cameraOn: boolean }
): Compositor {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, windowVideo.videoWidth);
  canvas.height = Math.max(2, windowVideo.videoHeight);
  const ctx = canvas.getContext('2d')!;
  let layout: CameraLayout = initial.cameraOn ? 'bubble' : 'off';
  // What sits under the full-face cover while it fades: the last bubble/off state.
  let baseLayout: Exclude<CameraLayout, 'full'> = initial.cameraOn ? 'bubble' : 'off';
  // 0 = screen (+bubble), 1 = full-face cover; steps toward the target each
  // frame so layout flips crossfade instead of hard-cutting in the recording.
  let fullAlpha = 0;
  const FULL_FADE_MS = 250;
  let lastFrameAt = performance.now();
  let bubbleSize = initial.size;
  let mirror = initial.mirror;
  let running = true;

  const frameMs = 1000 / fps;

  function drawCameraFull(cam: HTMLVideoElement, alpha: number): void {
    const rect = coverFit(cam.videoWidth, cam.videoHeight, 0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (mirror) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(cam, rect.dx, rect.dy, rect.dw, rect.dh);
    ctx.restore();
  }

  function drawFrame(): void {
    if (!running) return;
    // The canvas always tracks the source dimensions so the output size is stable
    // across layout switches, even when the window frame itself is not drawn.
    if (windowVideo.videoWidth > 0) {
      if (canvas.width !== windowVideo.videoWidth || canvas.height !== windowVideo.videoHeight) {
        canvas.width = windowVideo.videoWidth;
        canvas.height = windowVideo.videoHeight;
      }
    }
    const now = performance.now();
    const dt = now - lastFrameAt;
    lastFrameAt = now;
    const camReady = !!(camVideo && camVideo.videoWidth > 0);
    const targetFull = layout === 'full' && camReady ? 1 : 0;
    if (fullAlpha !== targetFull) {
      const step = dt / FULL_FADE_MS;
      fullAlpha = targetFull > fullAlpha ? Math.min(1, fullAlpha + step) : Math.max(0, fullAlpha - step);
    }
    const plan = cameraDrawPlan(
      fullAlpha >= 1 ? 'off' : baseLayout,
      canvas.width,
      canvas.height,
      camReady,
      camReady ? camVideo!.videoWidth : 0,
      camReady ? camVideo!.videoHeight : 0,
      BUBBLE_SIZES[bubbleSize]
    );

    if (fullAlpha >= 1) {
      // Fully in full-face: nothing of the screen should bleed through.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else if (windowVideo.videoWidth > 0) {
      ctx.drawImage(windowVideo, 0, 0, canvas.width, canvas.height);
    }

    if (plan.camera?.kind === 'bubble' && camVideo && fullAlpha < 1) {
      const { box, rect } = plan.camera;
      const { d, x, y } = box;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
      ctx.clip();
      if (mirror) {
        ctx.translate(x + d / 2, 0);
        ctx.scale(-1, 1);
        ctx.translate(-(x + d / 2), 0);
      }
      ctx.drawImage(camVideo, rect.dx, rect.dy, rect.dw, rect.dh);
      ctx.restore();
      // Hairline ring so the bubble reads against light content.
      ctx.save();
      ctx.beginPath();
      ctx.arc(x + d / 2, y + d / 2, d / 2 - 1, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.stroke();
      ctx.restore();
    }
    // Full-face cover on top: its alpha ramps 0<->1, so the flip crossfades.
    if (fullAlpha > 0 && camReady && camVideo) drawCameraFull(camVideo, fullAlpha);
    // setTimeout pump: requestAnimationFrame stalls for occluded/hidden windows.
    setTimeout(drawFrame, frameMs);
  }
  drawFrame();

  function applyLayout(l: CameraLayout): void {
    layout = l;
    if (l !== 'full') baseLayout = l;
  }

  return {
    stream: canvas.captureStream(fps),
    setCameraOn: (on) => {
      applyLayout(on ? 'bubble' : 'off');
    },
    setCameraLayout: (l) => {
      applyLayout(l);
    },
    setBubble: (size, m) => {
      bubbleSize = size;
      mirror = m;
    },
    stop: () => {
      running = false;
    },
  };
}

function attachVideo(stream: MediaStream): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    video.onloadedmetadata = () => {
      video
        .play()
        .then(() => resolve(video))
        .catch((err) => reject(err instanceof Error ? err : new Error(String(err))));
    };
    video.onerror = () => reject(new Error('Could not start the capture preview stream.'));
  });
}

// ---------------------------------------------------------------------------
// Stream assembly
// ---------------------------------------------------------------------------

const CAM_DIMENSIONS: Record<string, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
};

async function buildSession(p: EngineBeginPayload): Promise<{
  recordStream: MediaStream;
  allStreams: MediaStream[];
  audioCtx: AudioContext | null;
  micGain: GainNode | null;
  micTrack: MediaStreamTrack | null;
  compositor: Compositor | null;
}> {
  const { opts } = p;
  const allStreams: MediaStream[] = [];
  let audioCtx: AudioContext | null = null;
  let micGain: GainNode | null = null;
  let micTrack: MediaStreamTrack | null = null;
  let compositor: Compositor | null = null;

  const audioTracks: MediaStreamTrack[] = [];
  let videoTrack: MediaStreamTrack;

  if (opts.mode === 'cam') {
    const dims = CAM_DIMENSIONS[opts.quality] ?? CAM_DIMENSIONS['1080p']!;
    // Health-checked: a macOS capture race can hand over a solid-green feed
    // that passes every readiness event - recording it would bake the green
    // into the video, so frames are pixel-verified before the recorder starts.
    const probe = document.createElement('video');
    probe.muted = true;
    const camSession = await attachHealthyCameraStream(
      probe,
      {
        deviceId: opts.cameraId ? { exact: opts.cameraId } : undefined,
        width: { ideal: dims.width },
        height: { ideal: dims.height },
        frameRate: { ideal: opts.fps },
      },
      {
        audio: opts.micOn
          ? {
              deviceId: opts.micId ? { exact: opts.micId } : undefined,
              echoCancellation: true,
              noiseSuppression: true,
            }
          : false,
      }
    );
    const camStream = camSession.stream;
    probe.srcObject = null;
    allStreams.push(camStream);
    const vt = camStream.getVideoTracks()[0];
    if (!vt) throw new Error('The camera did not provide a video stream.');
    videoTrack = vt;
    micTrack = camStream.getAudioTracks()[0] ?? null;
  } else {
    // Screen or window capture; the main process injects the picked source
    // (and loopback system audio when requested) via setDisplayMediaRequestHandler.
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: opts.fps } },
      audio: opts.systemAudio,
    });
    allStreams.push(displayStream);
    const vt = displayStream.getVideoTracks()[0];
    if (!vt) {
      throw new Error(
        'Screen capture produced no video. On macOS grant Screen Recording permission in System Settings, then restart Open Loom.'
      );
    }
    const systemTrack = displayStream.getAudioTracks()[0] ?? null;

    let micStream: MediaStream | null = null;
    if (opts.micOn) {
      micStream = await getUserMediaResilient({
        audio: {
          deviceId: opts.micId ? { exact: opts.micId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      allStreams.push(micStream);
      micTrack = micStream.getAudioTracks()[0] ?? null;
    }

    if (systemTrack && micTrack) {
      // Mix mic + system audio into one track via WebAudio (SPEC locked decision).
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      const sysSource = audioCtx.createMediaStreamSource(new MediaStream([systemTrack]));
      sysSource.connect(dest);
      const micSource = audioCtx.createMediaStreamSource(new MediaStream([micTrack]));
      micGain = audioCtx.createGain();
      micGain.gain.value = 1;
      micSource.connect(micGain);
      micGain.connect(dest);
      const mixed = dest.stream.getAudioTracks()[0];
      if (mixed) audioTracks.push(mixed);
    } else if (systemTrack) {
      audioTracks.push(systemTrack);
    }

    if (opts.mode === 'screen-cam' && !opts.sourceIsDisplay) {
      // Window capture: burn the webcam bubble into the canvas composite.
      const windowVideo = await attachVideo(new MediaStream([vt]));
      // Grab the camera even when it starts hidden so it can be toggled on
      // mid-recording; if it is denied or missing the window records alone.
      let camVideo: HTMLVideoElement | null = null;
      try {
        // Health-checked (see cam-mode note): never burn a green feed into
        // the composite.
        const el = document.createElement('video');
        el.muted = true;
        const camSession = await attachHealthyCameraStream(el, {
          deviceId: opts.cameraId ? { exact: opts.cameraId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        });
        allStreams.push(camSession.stream);
        camVideo = el;
      } catch {
        camVideo = null;
      }
      compositor = createCompositor(windowVideo, camVideo, opts.fps, {
        size: p.bubble.size,
        mirror: p.bubble.mirror,
        cameraOn: opts.cameraOn && camVideo !== null,
      });
      const compositeTrack = compositor.stream.getVideoTracks()[0];
      if (!compositeTrack) throw new Error('Compositing the window and camera failed.');
      videoTrack = compositeTrack;
    } else {
      // Full-display capture: the bubble window is captured naturally by the OS.
      videoTrack = vt;
    }
  }

  // A raw mic track fed straight to MediaRecorder desyncs over time: when the
  // capture drops samples (Bluetooth mic hiccup, device stall) the muxer packs
  // the remaining audio back-to-back, so every lost span pulls the rest of the
  // audio earlier than the video - cumulative lip-sync drift. Clocking the mic
  // through an AudioContext turns capture gaps into silence on an unbroken
  // timeline instead. The mixed mic+system path above already does this.
  if (micTrack && !micGain) {
    try {
      audioCtx = audioCtx ?? new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      const micSource = audioCtx.createMediaStreamSource(new MediaStream([micTrack]));
      micGain = audioCtx.createGain();
      micGain.gain.value = 1;
      micSource.connect(micGain);
      micGain.connect(dest);
      const clocked = dest.stream.getAudioTracks()[0];
      audioTracks.push(clocked ?? micTrack);
    } catch {
      audioTracks.push(micTrack);
    }
  }

  const recordStream = new MediaStream([videoTrack, ...audioTracks]);
  return { recordStream, allStreams, audioCtx, micGain, micTrack, compositor };
}

/**
 * Hold the start until the audio pipeline is actually delivering. A Bluetooth
 * mic (AirPods) engages its hands-free profile only when capture begins - the
 * switch stalls both the capture track and the WebAudio render clock for
 * 0.5-1.2s. Start the recorder inside that window and the muxer stamps the
 * first (late) audio at t=0, so the whole take's audio plays early by exactly
 * the stall (verified frame-by-frame, 2026-07-24). Waiting for a moving
 * context clock and an unmuted mic track starts audio and video on the same
 * timeline. Bounded: a take must never hang on a broken audio device.
 */
async function waitForLiveAudio(built: {
  recordStream: MediaStream;
  audioCtx: AudioContext | null;
  micTrack: MediaStreamTrack | null;
}): Promise<void> {
  if (built.recordStream.getAudioTracks().length === 0) return;
  const deadline = performance.now() + 4000;
  const ctx = built.audioCtx;
  if (ctx) {
    try {
      await ctx.resume();
    } catch {
      /* keep waiting on the clock below */
    }
    let last = ctx.currentTime;
    let advances = 0;
    // Two consecutive advancing reads = the render clock is genuinely running,
    // not one buffered tick flushed after a stall.
    while (performance.now() < deadline && advances < 2) {
      await new Promise((r) => setTimeout(r, 100));
      const now = ctx.currentTime;
      advances = now > last ? advances + 1 : 0;
      last = now;
    }
  }
  // A capture track that is not delivering frames reports muted=true; the
  // unmute is the "mic is actually live" signal.
  while (performance.now() < deadline && built.micTrack?.muted) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ---------------------------------------------------------------------------
// Session control
// ---------------------------------------------------------------------------

function humanMediaError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
        return 'Permission to capture was denied. Check Screen Recording, Camera and Microphone permissions in Setup.';
      case 'NotFoundError':
        return 'The selected camera or microphone was not found. Reconnect it or pick another device.';
      case 'NotReadableError':
        return 'The capture device is in use by another app. Close it and try again.';
      default:
        return `${err.name}: ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

function teardown(): void {
  if (!session) return;
  const s = session;
  session = null;
  s.compositor?.stop();
  for (const stream of s.allStreams) {
    for (const track of stream.getTracks()) track.stop();
  }
  for (const track of s.recorder.stream.getTracks()) track.stop();
  if (s.audioCtx && s.audioCtx.state !== 'closed') void s.audioCtx.close();
}

/** Stop the streams from a built-but-not-yet-started session (cancelled during setup). */
function stopBuilt(built: Awaited<ReturnType<typeof buildSession>>): void {
  built.compositor?.stop();
  for (const stream of built.allStreams) {
    for (const track of stream.getTracks()) track.stop();
  }
  for (const track of built.recordStream.getTracks()) track.stop();
  if (built.audioCtx && built.audioCtx.state !== 'closed') void built.audioCtx.close();
}

internal.onEngineBegin((payload) => {
  void (async () => {
    if (session) {
      internal.engineError('The previous recording session is still shutting down. Try again.');
      return;
    }
    const myToken = ++beginToken;
    try {
      const built = await buildSession(payload);
      // A cancel/restart arrived while buildSession was awaiting permission /
      // getDisplayMedia: abort now instead of starting a recorder (and leaving
      // the capture streams live) for a session the user already cancelled.
      if (myToken !== beginToken) {
        stopBuilt(built);
        return;
      }
      await waitForLiveAudio(built);
      if (myToken !== beginToken) {
        stopBuilt(built);
        return;
      }
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(built.recordStream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: payload.videoBitsPerSecond,
        audioBitsPerSecond: 160_000,
      });

      const s: EngineSession = {
        recorder,
        allStreams: built.allStreams,
        audioCtx: built.audioCtx,
        micGain: built.micGain,
        micTrack: built.micTrack,
        compositor: built.compositor,
        chunkChain: Promise.resolve(),
        stopping: false,
      };
      session = s;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size === 0) return;
        s.chunkChain = s.chunkChain.then(async () => {
          const buf = new Uint8Array(await event.data.arrayBuffer());
          internal.sendChunk(buf);
        });
      };
      recorder.onstop = () => {
        void s.chunkChain.then(() => {
          internal.engineStopped();
          teardown();
        });
      };
      recorder.onerror = (event) => {
        const err = (event as unknown as { error?: DOMException }).error;
        internal.engineError(`Recording failed: ${err?.message ?? 'unknown encoder error'}`);
        teardown();
      };

      // Surface dead streams instead of silently recording nothing (SPEC R13).
      const vt = built.recordStream.getVideoTracks()[0];
      vt?.addEventListener('ended', () => {
        if (session === s && !s.stopping) {
          internal.engineError('The capture source ended (window closed or permission revoked).');
          try {
            if (s.recorder.state !== 'inactive') s.recorder.stop();
          } catch {
            /* already stopped */
          }
          teardown();
        }
      });

      recorder.start(1000);
      internal.engineStarted(recorder.mimeType || mimeType || 'video/webm');
    } catch (err) {
      internal.engineError(humanMediaError(err));
      teardown();
    }
  })();
});

internal.onEngineStop(() => {
  const s = session;
  if (!s) {
    internal.engineStopped();
    return;
  }
  s.stopping = true;
  try {
    if (s.recorder.state !== 'inactive') {
      s.recorder.stop();
    } else {
      internal.engineStopped();
      teardown();
    }
  } catch {
    internal.engineStopped();
    teardown();
  }
});

internal.onEnginePause(() => {
  const s = session;
  if (s && s.recorder.state === 'recording') s.recorder.pause();
});

internal.onEngineResume(() => {
  const s = session;
  if (s && s.recorder.state === 'paused') s.recorder.resume();
});

internal.onEngineCancel(() => {
  // Bump the token unconditionally so a begin still inside buildSession aborts
  // even though no session exists yet (cancel during permission/setup).
  beginToken++;
  const s = session;
  if (!s) return;
  s.stopping = true;
  s.recorder.ondataavailable = null;
  s.recorder.onstop = null;
  try {
    if (s.recorder.state !== 'inactive') s.recorder.stop();
  } catch {
    /* already stopped */
  }
  teardown();
});

internal.onEngineSetCamera((on) => {
  session?.compositor?.setCameraOn(on);
});

internal.onEngineSetLayout((layout) => {
  session?.compositor?.setCameraLayout(layout);
});

internal.onEngineSetMic((on) => {
  const s = session;
  if (!s) return;
  if (s.micGain) {
    s.micGain.gain.value = on ? 1 : 0;
  } else if (s.micTrack) {
    s.micTrack.enabled = on;
  }
});

internal.onEngineSetBubble(({ size, mirror }) => {
  session?.compositor?.setBubble(size, mirror);
});

internal.engineReady();
