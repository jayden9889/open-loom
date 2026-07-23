/**
 * Camera layout switcher: the glass slider pinned bottom-center of the
 * recorded display during Screen+Camera recordings. Two positions - Full face
 * and Face + screen - with a sliding thumb; picking one flips the live camera
 * layout ('full' / 'bubble') with a fade in the recording. The window itself
 * is content-protected, so the slider never appears in the captured video.
 */
import './styles/switcher.css';

const root = document.getElementById('switcher-root')!;
root.innerHTML = `
  <div class="switcher" id="switcher" role="radiogroup" aria-label="Camera layout">
    <div class="switcher-thumb" aria-hidden="true"></div>
    <button type="button" class="switcher-opt" data-layout="full" role="radio">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="9" r="3.4" />
        <path d="M5.5 19.5a6.8 6.8 0 0 1 13 0" />
      </svg>
      Full face
    </button>
    <button type="button" class="switcher-opt" data-layout="bubble" role="radio">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="4.5" width="18" height="13" rx="2" />
        <circle cx="8" cy="14" r="2.2" />
      </svg>
      Face + screen
    </button>
  </div>
`;

const switcherEl = document.getElementById('switcher')!;
const options = Array.from(root.querySelectorAll<HTMLButtonElement>('.switcher-opt'));

let layout: 'bubble' | 'full' = 'bubble';

function render(): void {
  switcherEl.classList.toggle('full', layout === 'full');
  for (const btn of options) {
    const selected = btn.dataset['layout'] === layout;
    btn.classList.toggle('selected', selected);
    btn.setAttribute('aria-checked', String(selected));
  }
}

for (const btn of options) {
  btn.addEventListener('click', () => {
    const next = btn.dataset['layout'] as 'bubble' | 'full';
    if (next === layout) return;
    layout = next; // optimistic; the recording-state broadcast confirms
    render();
    window.openloom.setCameraLayout(next);
  });
}

window.openloom.onRecordingState((s) => {
  if (s.cameraLayout === 'bubble' || s.cameraLayout === 'full') {
    layout = s.cameraLayout;
    render();
  }
});

void window.openloomInternal.getRecordingState().then((s) => {
  if (s.cameraLayout === 'bubble' || s.cameraLayout === 'full') layout = s.cameraLayout;
  render();
});

render();
