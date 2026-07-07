/**
 * Recorder engine (hidden window). Owns getDisplayMedia/getUserMedia,
 * WebAudio mixing of mic + system audio, canvas compositing for
 * window+camera mode, codec selection and MediaRecorder with a 1000ms
 * timeslice. Chunks stream to the main process over IPC and land in a
 * crash-safe temp file.
 */
import type { EngineBeginPayload } from '@shared/types';
import { BUBBLE_SIZES } from '@shared/types';

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
  let cameraOn = initial.cameraOn;
  let bubbleSize = initial.size;
  let mirror = initial.mirror;
  let running = true;

  const frameMs = 1000 / fps;

  function drawFrame(): void {
    if (!running) return;
    if (windowVideo.videoWidth > 0) {
      if (canvas.width !== windowVideo.videoWidth || canvas.height !== windowVideo.videoHeight) {
        canvas.width = windowVideo.videoWidth;
        canvas.height = windowVideo.videoHeight;
      }
      ctx.drawImage(windowVideo, 0, 0, canvas.width, canvas.height);
    }
    if (cameraOn && camVideo && camVideo.videoWidth > 0) {
      // Bubble scaled against a 1080p reference so it matches the on-screen size.
      const scale = canvas.height / 1080;
      const d = Math.round(BUBBLE_SIZES[bubbleSize] * scale);
      const margin = Math.round(24 * scale);
      const x = margin;
      const y = canvas.height - d - margin;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
      ctx.clip();
      // Cover-fit the camera into the circle.
      const vw = camVideo.videoWidth;
      const vh = camVideo.videoHeight;
      const s = Math.max(d / vw, d / vh);
      const dw = vw * s;
      const dh = vh * s;
      const dx = x + (d - dw) / 2;
      const dy = y + (d - dh) / 2;
      if (mirror) {
        ctx.translate(x + d / 2, 0);
        ctx.scale(-1, 1);
        ctx.translate(-(x + d / 2), 0);
      }
      ctx.drawImage(camVideo, dx, dy, dw, dh);
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
    // setTimeout pump: requestAnimationFrame stalls for occluded/hidden windows.
    setTimeout(drawFrame, frameMs);
  }
  drawFrame();

  return {
    stream: canvas.captureStream(fps),
    setCameraOn: (on) => {
      cameraOn = on;
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
    const camStream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: opts.cameraId ? { exact: opts.cameraId } : undefined,
        width: { ideal: dims.width },
        height: { ideal: dims.height },
        frameRate: { ideal: opts.fps },
      },
      audio: opts.micOn
        ? {
            deviceId: opts.micId ? { exact: opts.micId } : undefined,
            echoCancellation: true,
            noiseSuppression: true,
          }
        : false,
    });
    allStreams.push(camStream);
    const vt = camStream.getVideoTracks()[0];
    if (!vt) throw new Error('The camera did not provide a video stream.');
    videoTrack = vt;
    micTrack = camStream.getAudioTracks()[0] ?? null;
    if (micTrack) audioTracks.push(micTrack);
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
      micStream = await navigator.mediaDevices.getUserMedia({
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
    } else if (micTrack) {
      audioTracks.push(micTrack);
    }

    if (opts.mode === 'screen-cam' && !opts.sourceIsDisplay) {
      // Window capture: burn the webcam bubble into the canvas composite.
      const windowVideo = await attachVideo(new MediaStream([vt]));
      // Grab the camera even when it starts hidden so it can be toggled on
      // mid-recording; if it is denied or missing the window records alone.
      let camVideo: HTMLVideoElement | null = null;
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: opts.cameraId ? { exact: opts.cameraId } : undefined,
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        allStreams.push(camStream);
        camVideo = await attachVideo(camStream);
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

  const recordStream = new MediaStream([videoTrack, ...audioTracks]);
  return { recordStream, allStreams, audioCtx, micGain, micTrack, compositor };
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

internal.onEngineBegin((payload) => {
  void (async () => {
    if (session) {
      internal.engineError('The previous recording session is still shutting down. Try again.');
      return;
    }
    try {
      const built = await buildSession(payload);
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
