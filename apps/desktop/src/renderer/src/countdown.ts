/**
 * 3-2-1 countdown overlay (SPEC R5). Click anywhere to skip; Escape cancels
 * the recording entirely.
 */
import './styles/countdown.css';

const root = document.getElementById('countdown-root')!;
root.innerHTML = `
  <div class="countdown">
    <div class="countdown-disc">
      <svg class="countdown-ring" viewBox="0 0 168 168" aria-hidden="true">
        <circle class="countdown-ring-track" cx="84" cy="84" r="80"></circle>
        <circle class="countdown-ring-arc" id="countdown-ring-arc" cx="84" cy="84" r="80"></circle>
      </svg>
      <div class="countdown-digits" id="countdown-digits"></div>
    </div>
    <div class="countdown-hint">Click to start now &middot; Esc to cancel</div>
  </div>
`;

const digitsEl = document.getElementById('countdown-digits')!;
const ringArc = document.getElementById('countdown-ring-arc')!;

/** Cross-fade: the outgoing digit shrinks away while the incoming one lands. */
function showDigit(n: number): void {
  const outgoing = digitsEl.querySelector('.countdown-digit.is-in');
  if (outgoing) {
    outgoing.classList.remove('is-in');
    outgoing.classList.add('is-out');
    // Timed removal, not animationend: reduced-motion disables the exit animation.
    setTimeout(() => outgoing.remove(), 400);
  }
  const incoming = document.createElement('span');
  incoming.className = 'countdown-digit is-in';
  incoming.textContent = String(n);
  digitsEl.appendChild(incoming);
  ringArc.classList.remove('is-filling');
  // Force reflow so the one-second ring fill replays for this digit.
  void ringArc.getBoundingClientRect();
  ringArc.classList.add('is-filling');
}

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
  showDigit(value);
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

showDigit(value);
