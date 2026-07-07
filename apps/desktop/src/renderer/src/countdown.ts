/**
 * 3-2-1 countdown overlay (SPEC R5). Click anywhere to skip; Escape cancels
 * the recording entirely.
 */
import './styles/countdown.css';

const root = document.getElementById('countdown-root')!;
root.innerHTML = `
  <div class="countdown">
    <div class="countdown-number" id="countdown-number">3</div>
    <div class="countdown-hint">Click to start now &middot; Esc to cancel</div>
  </div>
`;

const numberEl = document.getElementById('countdown-number')!;
let value = 3;
let finished = false;

function finish(): void {
  if (finished) return;
  finished = true;
  window.openloomInternal.countdownDone();
}

const timer = setInterval(() => {
  value -= 1;
  if (value <= 0) {
    clearInterval(timer);
    finish();
    return;
  }
  numberEl.textContent = String(value);
  numberEl.classList.remove('pop');
  // Restart the pop animation.
  void numberEl.offsetWidth;
  numberEl.classList.add('pop');
}, 1000);

document.addEventListener('click', () => {
  clearInterval(timer);
  finish();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    clearInterval(timer);
    finished = true;
    window.openloomInternal.countdownCancel();
  }
});

numberEl.classList.add('pop');
