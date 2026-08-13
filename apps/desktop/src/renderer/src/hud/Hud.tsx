/**
 * Recording HUD (SPEC R7): frameless vertical control bar. Elapsed timer with
 * red dot, pause/resume, stop, restart, cancel, mic
 * toggle, draw toggle. The camera itself is never off - the layout only moves
 * the face between the corner bubble and full frame. A hint strip at the
 * bottom names the hovered control and its configured shortcut (the window is
 * too narrow for side tooltips).
 */
import { useEffect, useState } from 'react';
import type { RecordingState, ShortcutSettings } from '@shared/types';
import { DEFAULT_SHORTCUTS } from '@shared/types';

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function prettyAccel(accel: string): string {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  return accel
    .replace('CommandOrControl', isMac ? '⌘' : 'Ctrl')
    .replace('Command', '⌘')
    .replace('Control', 'Ctrl')
    .replace('Shift', isMac ? '⇧' : 'Shift')
    .replace('Alt', isMac ? '⌥' : 'Alt')
    .replaceAll('+', isMac ? '' : '+');
}

interface HudButtonProps {
  label: string;
  hint: string;
  onClick: () => void;
  onHint: (hint: string | null) => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}

function HudButton(props: HudButtonProps) {
  return (
    <button
      type="button"
      className={`hud-btn${props.active ? ' active' : ''}${props.danger ? ' danger' : ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      onMouseEnter={() => props.onHint(props.hint)}
      onMouseLeave={() => props.onHint(null)}
      onFocus={() => props.onHint(props.hint)}
      onBlur={() => props.onHint(null)}
    >
      {props.children}
    </button>
  );
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const PEN_COLORS = ['red', 'violet', 'yellow'] as const;
type PenColor = (typeof PEN_COLORS)[number];

/**
 * Perceptual mic meter fill: the same decibel mapping the waveform uses, so
 * conversational speech sits mid-meter instead of hugging the floor.
 */
function micLevelToFill(level: number): number {
  if (level <= 0) return 0;
  const db = 20 * Math.log10(Math.max(level, 1e-4));
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

export function Hud() {
  const [state, setState] = useState<RecordingState>({ status: 'recording', elapsedSec: 0 });
  const [shortcuts, setShortcuts] = useState<ShortcutSettings>(DEFAULT_SHORTCUTS);
  const [hint, setHint] = useState<string | null>(null);
  const [penColor, setPenColor] = useState<PenColor>('red');
  const [micLevel, setMicLevel] = useState(0);

  // Sync the overlay's pen to the HUD's colour whenever draw mode turns on.
  useEffect(() => {
    if (state.drawOn) window.openloom.setDrawColor(penColor);
  }, [state.drawOn, penColor]);

  useEffect(() => {
    void window.openloomInternal.getRecordingState().then(setState);
    void window.openloomInternal.getSettings().then((s) => setShortcuts(s.shortcuts));
    const offState = window.openloom.onRecordingState(setState);
    const offSettings = window.openloomInternal.onSettingsChanged((s) => setShortcuts(s.shortcuts));
    const offMic = window.openloomInternal.onMicLevel(setMicLevel);
    return () => {
      offState();
      offSettings();
      offMic();
    };
  }, []);

  const paused = state.status === 'paused';

  // The redo countdown owns the window: the wider panel with the escape hatch.
  if (state.redoCountdown != null) {
    return (
      <div className="hud hud-panel">
        <p className="hud-panel-title">Back 10 seconds</p>
        <p className="hud-panel-body">
          Breathe. Recording carries on in <strong>{Math.max(1, state.redoCountdown)}</strong> -
          say that last bit again.
        </p>
        <button
          type="button"
          className="hud-panel-btn"
          onClick={() => window.openloom.cancelPendingRedo()}
        >
          Keep it as it was
        </button>
      </div>
    );
  }

  // A destructive action is waiting on its confirm; name the cost.
  if (state.confirm) {
    const deleting = state.confirm === 'cancel';
    return (
      <div className="hud hud-panel">
        <p className="hud-panel-title">{deleting ? 'Delete this take?' : 'Start this take over?'}</p>
        <p className="hud-panel-body">
          {formatElapsed(state.elapsedSec)} of footage will be discarded
          {deleting ? '.' : ' and a fresh take starts.'} Recording carries on until you choose.
        </p>
        <button
          type="button"
          className="hud-panel-btn hud-panel-keep"
          onClick={() => window.openloom.resolveRecordingConfirm(false)}
        >
          Keep recording
        </button>
        <button
          type="button"
          className="hud-panel-btn hud-panel-danger"
          onClick={() => window.openloom.resolveRecordingConfirm(true)}
        >
          {deleting ? 'Delete the take' : 'Start over'}
        </button>
      </div>
    );
  }

  return (
    <div className="hud">
      <div className="hud-grip" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <div className={`hud-timer${paused ? ' paused' : ''}`}>
        <span className="hud-dot" aria-hidden="true" />
        <span className="hud-time">{formatElapsed(state.elapsedSec)}</span>
      </div>

      <HudButton
        label={paused ? 'Resume' : 'Pause'}
        hint={`${paused ? 'Resume' : 'Pause'} ${prettyAccel(shortcuts.pauseResume)}`}
        onHint={setHint}
        onClick={() => void (paused ? window.openloom.resumeRecording() : window.openloom.pauseRecording())}
      >
        {paused ? (
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="7" y="5" width="3.4" height="14" rx="1.2" fill="currentColor" />
            <rect x="13.6" y="5" width="3.4" height="14" rx="1.2" fill="currentColor" />
          </svg>
        )}
      </HudButton>

      <HudButton
        label="Re-say the last 10 seconds"
        hint="Re-say the last 10s"
        onHint={setHint}
        onClick={() => window.openloom.redoLastTen()}
        disabled={paused}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 10a8 8 0 1 0 2.3-5.6" {...stroke} />
          <path d="M4 4v5h5" {...stroke} />
          <text
            x="12"
            y="15.5"
            textAnchor="middle"
            fontSize="7.5"
            fontWeight="700"
            fill="currentColor"
            stroke="none"
          >
            10
          </text>
        </svg>
      </HudButton>

      <HudButton
        label="Stop and save"
        hint={`Stop ${prettyAccel(shortcuts.startStop)}`}
        onHint={setHint}
        onClick={() => void window.openloom.stopRecording().catch(() => undefined)}
        danger
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" />
        </svg>
      </HudButton>

      <HudButton
        label="Restart recording"
        hint={`Restart ${prettyAccel(shortcuts.restart)}`}
        onHint={setHint}
        onClick={() => void window.openloom.restartRecording().catch(() => undefined)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
          <path d="M4 10a8 8 0 1 1 2.3 6.3" />
          <path d="M4 15v-5h5" />
        </svg>
      </HudButton>

      <HudButton
        label="Cancel recording"
        hint={`Discard ${prettyAccel(shortcuts.cancel)}`}
        onHint={setHint}
        onClick={() => void window.openloom.cancelRecording()}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
          <path d="M4 7h16" />
          <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
          <path d="M6.5 7 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5L17.5 7" />
        </svg>
      </HudButton>

      <div className="hud-sep" aria-hidden="true" />

      <HudButton
        label={state.micOn ? 'Mute microphone' : 'Unmute microphone'}
        hint={state.micOn ? 'Mute mic' : 'Unmute mic'}
        onHint={setHint}
        onClick={() => window.openloom.toggleMic(!state.micOn)}
        active={!!state.micOn}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
          <rect x="9.2" y="3.5" width="5.6" height="10" rx="2.8" />
          <path d="M6 11.5a6 6 0 0 0 12 0" />
          <path d="M12 17.5V21" />
          {!state.micOn && <path d="M4.5 4.5 19.5 19.5" />}
        </svg>
      </HudButton>

      {state.micOn && (
        <div className="hud-mic-meter" aria-label="Microphone level">
          <div
            className="hud-mic-meter-fill"
            style={{ transform: `scaleX(${micLevelToFill(micLevel)})` }}
          />
        </div>
      )}

      <HudButton
        label={state.drawOn ? 'Stop drawing' : 'Draw on screen'}
        hint={
          state.drawAvailable
            ? `Draw ${prettyAccel(shortcuts.draw)}`
            : state.cameraLayout === 'full'
              ? 'Draw is off in full-face view'
              : 'Draw needs full-screen capture'
        }
        onHint={setHint}
        onClick={() => window.openloom.toggleDraw(!state.drawOn)}
        active={!!state.drawOn}
        disabled={!state.drawAvailable}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
          <path d="M4 20c.6-2.7 1.4-4 3-5.7L16.6 4.7a2.1 2.1 0 0 1 3 3L10 17.3c-1.7 1.6-3 2.3-6 2.7Z" />
        </svg>
      </HudButton>

      {state.drawOn && (
        <div className="hud-draw-tools">
          {PEN_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`hud-pen hud-pen-${c}${penColor === c ? ' selected' : ''}`}
              aria-label={`${c} pen`}
              onMouseEnter={() => setHint(`${c.charAt(0).toUpperCase()}${c.slice(1)} pen`)}
              onMouseLeave={() => setHint(null)}
              onClick={() => setPenColor(c)}
            />
          ))}
          <button
            type="button"
            className="hud-btn hud-pen-clear"
            aria-label="Clear all ink"
            onMouseEnter={() => setHint('Clear ink now')}
            onMouseLeave={() => setHint(null)}
            onClick={() => window.openloom.clearDraw()}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
              <path d="m14 5 5 5-8.5 8.5a2 2 0 0 1-1.4.6H6l-2-2 10-12Z" />
              <path d="M11 8.5 15.5 13" />
              <path d="M13 19h7" />
            </svg>
          </button>
          <button
            type="button"
            className="hud-btn hud-draw-exit"
            aria-label="Done drawing"
            onMouseEnter={() => setHint('Done - ink fades away')}
            onMouseLeave={() => setHint(null)}
            onClick={() => window.openloom.toggleDraw(false)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
              <path d="m5 12.5 5 5L19 7" />
            </svg>
          </button>
        </div>
      )}

      <div className="hud-hint" aria-live="polite">
        {hint ?? ''}
      </div>
    </div>
  );
}
