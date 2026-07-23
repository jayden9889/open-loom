/**
 * Webcam bubble window (SPEC R6): circular live camera, draggable anywhere,
 * S/M/L switcher + mirror toggle on hover. The window itself is the circle;
 * the OS composites it over everything and full-screen capture records it
 * naturally.
 *
 * The raw <video> surface is NEVER visible before it has decodable frames
 * (Chromium paints green garbage on an unready video). States: 'connecting'
 * shows a glass pulse ring, 'live' fades the video in, 'error' shows a glass
 * camera-off state.
 */
import './styles/bubble.css';
import { attachHealthyCameraStream, type HealthyCameraSession } from './media';

const root = document.getElementById('bubble-root')!;
root.innerHTML = `
  <div class="bubble" id="bubble">
    <video id="bubble-video" autoplay playsinline muted></video>
    <div class="bubble-state" id="bubble-state">
      <div class="bubble-ring" id="bubble-ring" aria-label="Starting camera"></div>
      <div class="bubble-error" id="bubble-error" hidden>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 14 18H4.5A1.5 1.5 0 0 1 3 16.5Z" />
          <path d="m15.5 10 5-2.5v9l-5-2.5" />
          <path d="M2.5 2.5l19 19" />
        </svg>
        <span>Camera unavailable</span>
      </div>
    </div>
    <div class="bubble-controls" id="bubble-controls">
      <button type="button" data-size="S" title="Small">S</button>
      <button type="button" data-size="M" title="Medium">M</button>
      <button type="button" data-size="L" title="Large">L</button>
      <button type="button" id="bubble-mirror" title="Mirror camera">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3v18"/><path d="M8 7 4 12l4 5"/><path d="m16 7 4 5-4 5"/>
        </svg>
      </button>
    </div>
  </div>
`;

const bubbleEl = document.getElementById('bubble')!;
const video = document.getElementById('bubble-video') as HTMLVideoElement;
const stateEl = document.getElementById('bubble-state')!;
const ringEl = document.getElementById('bubble-ring')!;
const errorEl = document.getElementById('bubble-error')!;
const mirrorBtn = document.getElementById('bubble-mirror')!;

let mirror = true;
let currentSession: HealthyCameraSession | null = null;

type BubbleState = 'connecting' | 'live' | 'error';

function setState(state: BubbleState): void {
  bubbleEl.classList.toggle('live', state === 'live');
  stateEl.hidden = state === 'live';
  ringEl.hidden = state !== 'connecting';
  errorEl.hidden = state !== 'error';
}

function applyMirror(): void {
  video.style.transform = mirror ? 'scaleX(-1)' : 'none';
  mirrorBtn.classList.toggle('active', mirror);
}

// 'full' turns the (window-resized) bubble into an opaque full-frame camera so
// full-display capture records the face full-screen. The window itself is
// resized by the main process; this just swaps the circle styling for a
// rectangular cover-fit (SPEC R6). A layout flip arrives as fade-out ->
// (main resizes the invisible window) -> set-layout, which fades back in.
window.openloomInternal.onBubbleFadeOut(() => {
  bubbleEl.classList.add('faded');
});
window.openloomInternal.onBubbleLayout((layout) => {
  bubbleEl.classList.toggle('full', layout === 'full');
  // Next frame so the shape change lands before the fade-in starts.
  requestAnimationFrame(() => bubbleEl.classList.remove('faded'));
});

async function startCamera(): Promise<void> {
  setState('connecting');
  const settings = await window.openloomInternal.getSettings();
  mirror = settings.bubble.mirror;
  applyMirror();
  try {
    // Health-checked capture: resolves only once the frames are provably real
    // camera content - a macOS capture race can deliver solid green frames
    // that pass every readiness event, so pixels are the only truth.
    currentSession = await attachHealthyCameraStream(video, {
      deviceId: settings.recording.cameraId ? { exact: settings.recording.cameraId } : undefined,
      width: { ideal: 1280 },
      height: { ideal: 720 },
    });
    setState('live');
  } catch {
    setState('error');
  }
}

for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-size]'))) {
  btn.addEventListener('click', () => {
    window.openloom.setBubbleSize(btn.dataset.size as 'S' | 'M' | 'L');
  });
}

mirrorBtn.addEventListener('click', () => {
  mirror = !mirror;
  applyMirror();
  window.openloomInternal.setBubbleMirror(mirror);
});

window.openloomInternal.onSettingsChanged((s) => {
  if (s.bubble.mirror !== mirror) {
    mirror = s.bubble.mirror;
    applyMirror();
  }
});

window.addEventListener('beforeunload', () => {
  currentSession?.stop();
});

void startCamera();
