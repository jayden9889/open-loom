/**
 * Webcam bubble window (SPEC R6): circular live camera, draggable anywhere,
 * S/M/L switcher + mirror toggle on hover. The window itself is the circle;
 * the OS composites it over everything and full-screen capture records it
 * naturally.
 */
import './styles/bubble.css';

const root = document.getElementById('bubble-root')!;
root.innerHTML = `
  <div class="bubble" id="bubble">
    <video id="bubble-video" autoplay playsinline muted></video>
    <div class="bubble-off" id="bubble-off" hidden>
      <span>Camera is off</span>
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
const offOverlay = document.getElementById('bubble-off')!;
const mirrorBtn = document.getElementById('bubble-mirror')!;

let mirror = true;
let currentStream: MediaStream | null = null;

function applyMirror(): void {
  video.style.transform = mirror ? 'scaleX(-1)' : 'none';
  mirrorBtn.classList.toggle('active', mirror);
}

// 'full' turns the (window-resized) bubble into an opaque full-frame camera so
// full-display capture records the face full-screen. The window itself is
// resized by the main process; this just swaps the circle styling for a
// rectangular cover-fit (SPEC R6).
window.openloomInternal.onBubbleLayout((layout) => {
  bubbleEl.classList.toggle('full', layout === 'full');
});

async function startCamera(): Promise<void> {
  const settings = await window.openloomInternal.getSettings();
  mirror = settings.bubble.mirror;
  applyMirror();
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: settings.recording.cameraId ? { exact: settings.recording.cameraId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    video.srcObject = currentStream;
    offOverlay.hidden = true;
  } catch {
    offOverlay.hidden = false;
    offOverlay.querySelector('span')!.textContent = 'Camera unavailable';
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
  if (currentStream) for (const t of currentStream.getTracks()) t.stop();
});

void startCamera();
