/**
 * Settings view (SPEC G1-G7). Every pane persists and drives a live backend:
 * General, Recording, Shortcuts, Transcription (whisper.cpp install + API
 * endpoint), AI (provider test) and Sharing (server / S3 config with a real
 * Test button). About shows ffmpeg/whisper diagnostics.
 */
import { useEffect, useRef, useState } from 'react';
import type { AppInfo, CameraEffectsStatus, PermissionsSnapshot, Settings, ShortcutSettings } from '@shared/types';
import { Icon } from '../components/icons';
import { attachHealthyCameraStream, type HealthyCameraSession } from '../media';
import { Modal, Segmented, Toggle, cleanIpcError, useToasts } from '../components/ui';

type Pane =
  | 'general'
  | 'recording'
  | 'facecam'
  | 'shortcuts'
  | 'transcription'
  | 'ai'
  | 'sharing'
  | 'youtube'
  | 'about';

const PANES: { id: Pane; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'recording', label: 'Recording' },
  { id: 'facecam', label: 'FaceCam' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'transcription', label: 'Transcription' },
  { id: 'ai', label: 'AI' },
  { id: 'sharing', label: 'Sharing' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'about', label: 'About' },
];

function Row({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-label">{label}</span>
        {note && <span className="settings-note">{note}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/** Text input that saves on blur/Enter. */
function SavedInput({
  value,
  onSave,
  placeholder,
  type = 'text',
  ariaLabel,
}: {
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
  type?: string;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      type={type}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onSave(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function ShortcutField({
  value,
  onSave,
  ariaLabel,
}: {
  value: string;
  onSave: (accel: string) => void;
  ariaLabel: string;
}) {
  const [capturing, setCapturing] = useState(false);

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!capturing) return;
    e.preventDefault();
    if (e.key === 'Escape') {
      setCapturing(false);
      return;
    }
    const mods: string[] = [];
    if (e.metaKey || e.ctrlKey) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (['Shift', 'Alt', 'Control', 'Meta'].includes(e.key)) return; // wait for a real key
    if (mods.length === 0) return; // require at least one modifier for a global shortcut
    setCapturing(false);
    onSave([...mods, key].join('+'));
  };

  return (
    <button
      type="button"
      className={`shortcut-field${capturing ? ' capturing' : ''}`}
      aria-label={ariaLabel}
      onClick={() => setCapturing(true)}
      onKeyDown={onKeyDown}
      onBlur={() => setCapturing(false)}
    >
      {capturing ? 'Press keys' : value}
    </button>
  );
}

/**
 * Live camera preview for the FaceCam pane. macOS camera effects (Portrait,
 * Studio Light) are applied by the system INSIDE the camera pipeline, so
 * this raw preview already shows exactly what recordings get. Frames are
 * health-checked before anything shows and the camera is released the
 * moment the pane unmounts.
 */
function FacecamPreview({ cameraId, mirror }: { cameraId: string; mirror: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'connecting' | 'live' | 'error'>('connecting');

  useEffect(() => {
    let cancelled = false;
    let session: HealthyCameraSession | null = null;
    setState('connecting');
    void (async () => {
      try {
        session = await attachHealthyCameraStream(
          videoRef.current!,
          {
            deviceId: cameraId ? { exact: cameraId } : undefined,
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          { isCancelled: () => cancelled }
        );
        if (cancelled) {
          session.stop();
          return;
        }
        setState('live');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
      session?.stop();
    };
  }, [cameraId]);

  const overlay: React.CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none' };
  return (
    <div
      style={{
        position: 'relative',
        width: 320,
        aspectRatio: '16 / 9',
        borderRadius: 'var(--ol-radius-card)',
        overflow: 'hidden',
        background: 'var(--ol-surface-2)',
        border: '1px solid var(--ol-border)',
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity: state === 'live' ? 1 : 0,
          transition: 'opacity var(--ol-dur) var(--ol-ease)',
          transform: mirror ? 'scaleX(-1)' : undefined,
        }}
      />
      {state !== 'live' && (
        <div style={{ ...overlay, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {state === 'connecting' ? (
            <div className="spinner" aria-label="Starting camera" />
          ) : (
            <span className="settings-note">Camera unavailable</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Live on/off pill for a system camera effect. */
function EffectState({ on }: { on: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        fontSize: 13,
        fontWeight: 600,
        color: on ? 'var(--ol-success)' : 'var(--ol-text-dim)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: on ? 'var(--ol-success)' : 'var(--ol-border)',
        }}
      />
      {on ? 'On' : 'Off'}
    </span>
  );
}

export function SettingsView({
  settings,
  onUpdate,
  initialPane,
}: {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => Promise<Settings | null>;
  initialPane?: string;
}) {
  const { push } = useToasts();
  const [pane, setPane] = useState<Pane>((initialPane as Pane) ?? 'general');
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [perms, setPerms] = useState<PermissionsSnapshot | null>(null);

  useEffect(() => {
    void window.openloom.appInfo().then(setInfo);
    void window.openloom.getPermissions().then(setPerms);
  }, []);

  const s = settings;
  const save = (patch: Partial<Settings>) => void onUpdate(patch);

  const saveShortcut = (key: keyof ShortcutSettings, accel: string) => {
    void onUpdate({ shortcuts: { ...s.shortcuts, [key]: accel } }).then((next) => {
      if (next) push('success', 'Shortcut updated.');
    });
  };

  // macOS camera effects are toggled in the system panel; poll their state
  // while the FaceCam pane is open so the pills track Control Center live.
  const [fx, setFx] = useState<CameraEffectsStatus | null>(null);
  useEffect(() => {
    if (pane !== 'facecam') return;
    let alive = true;
    const read = () => void window.openloom.cameraEffects().then((v) => alive && setFx(v));
    read();
    const timer = window.setInterval(read, 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [pane]);

  // Whisper install (live log modal) + AI connection test state.
  const [installOpen, setInstallOpen] = useState(false);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const [aiTest, setAiTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'fail'; error?: string }>({
    state: 'idle',
  });
  const [shareTest, setShareTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'fail'; error?: string }>({
    state: 'idle',
  });
  // YouTube account connection (OAuth loopback runs in the main process).
  const [ytConnected, setYtConnected] = useState<boolean | null>(null);
  const [ytBusy, setYtBusy] = useState(false);
  useEffect(() => {
    if (pane !== 'youtube') return;
    void window.openloom.youtubeStatus().then((v) => setYtConnected(v.connected), () => setYtConnected(null));
  }, [pane]);

  const connectYouTube = () => {
    setYtBusy(true);
    void window.openloom.youtubeConnect().then(
      (v) => {
        setYtConnected(v.connected);
        setYtBusy(false);
        if (v.connected) push('success', 'YouTube account connected.');
      },
      (err) => {
        setYtBusy(false);
        push('error', cleanIpcError(err));
      }
    );
  };

  const disconnectYouTube = () => {
    setYtBusy(true);
    void window.openloom.youtubeDisconnect().then(
      (v) => {
        setYtConnected(v.connected);
        setYtBusy(false);
        push('info', 'YouTube account disconnected.');
      },
      (err) => {
        setYtBusy(false);
        push('error', cleanIpcError(err));
      }
    );
  };

  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!installOpen) return;
    return window.openloom.onSetupLog((line) => {
      setInstallLog((l) => [...l.slice(-500), line]);
      requestAnimationFrame(() => {
        const el = logRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }, [installOpen]);

  const runWhisperInstall = () => {
    setInstallOpen(true);
    setInstallLog([]);
    setInstalling(true);
    void window.openloom
      .installWhisper()
      .then(async () => {
        push('success', 'whisper.cpp installed and selected.');
        setPerms(await window.openloom.getPermissions());
      })
      .catch((err) => {
        const msg = cleanIpcError(err);
        setInstallLog((l) => [...l, msg]);
        push('error', msg);
      })
      .finally(() => setInstalling(false));
  };

  const runAiTest = () => {
    setAiTest({ state: 'running' });
    void window.openloom
      .testAI()
      .then((r) => setAiTest(r.ok ? { state: 'ok' } : { state: 'fail', error: r.error }))
      .catch((err) => setAiTest({ state: 'fail', error: cleanIpcError(err) }));
  };

  // Reach the configured share provider with a real request (server: /healthz +
  // authed probe; S3: HEAD the bucket). Masked secrets are resolved in main.
  const runShareTest = (provider: 'server' | 's3') => {
    setShareTest({ state: 'running' });
    const cfg =
      provider === 'server'
        ? { provider, url: s.sharing.server.url, apiKey: s.sharing.server.apiKey }
        : {
            provider,
            endpoint: s.sharing.s3.endpoint,
            region: s.sharing.s3.region,
            bucket: s.sharing.s3.bucket,
            accessKeyId: s.sharing.s3.accessKeyId,
            secretAccessKey: s.sharing.s3.secretAccessKey,
            publicBaseUrl: s.sharing.s3.publicBaseUrl,
            prefix: s.sharing.s3.prefix,
            pathStyle: s.sharing.s3.pathStyle,
          };
    void window.openloom
      .testShareProvider(cfg)
      .then((r) => setShareTest(r.ok ? { state: 'ok' } : { state: 'fail', error: r.error }))
      .catch((err) => setShareTest({ state: 'fail', error: cleanIpcError(err) }));
  };

  const pickPath = async (onPicked: (p: string) => void) => {
    const file = await window.openloom.pickFile('all');
    if (file) onPicked(file);
  };

  return (
    <div className="settings">
      <header className="view-head">
        <h2>Settings</h2>
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {PANES.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`settings-nav-item${pane === p.id ? ' selected' : ''}`}
              onClick={() => setPane(p.id)}
            >
              {p.label}
            </button>
          ))}
        </nav>

        <div className="settings-panes">
          {pane === 'general' && (
            <section aria-label="General">
              <Row label="Save folder" note={s.saveDir}>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={async () => {
                      const dir = await window.openloom.pickDirectory();
                      if (dir) save({ saveDir: dir });
                    }}
                  >
                    Change
                  </button>
                </div>
              </Row>
              <Row label="Theme">
                <Segmented
                  value={s.theme}
                  onChange={(theme) => save({ theme })}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                  ]}
                />
              </Row>
              <Row label="Countdown" note="Show 3-2-1 before recording starts.">
                <Toggle checked={s.countdown} onChange={(v) => save({ countdown: v })} label="Countdown" />
              </Row>
              <Row
                label="Click highlights"
                note="Show a ripple where you click while recording. Needs the optional input hook; on macOS it also needs Accessibility permission."
              >
                <Toggle
                  checked={s.clickHighlights}
                  onChange={(v) => save({ clickHighlights: v })}
                  label="Click highlights"
                />
              </Row>
              <Row label="Launch at login">
                <Toggle checked={s.launchAtLogin} onChange={(v) => save({ launchAtLogin: v })} label="Launch at login" />
              </Row>
              <Row label="Default recording name" note="Tokens: {date} {time} {mode}">
                <SavedInput
                  value={s.namePattern}
                  onSave={(v) => save({ namePattern: v || 'Recording - {date}, {time}' })}
                  ariaLabel="Default recording name pattern"
                />
              </Row>
            </section>
          )}

          {pane === 'recording' && (
            <section aria-label="Recording">
              <Row label="Quality">
                <Segmented
                  value={s.recording.quality}
                  onChange={(quality) => save({ recording: { ...s.recording, quality } })}
                  options={[
                    { value: '720p', label: '720p' },
                    { value: '1080p', label: '1080p' },
                    { value: '4k', label: '4K' },
                  ]}
                />
              </Row>
              <Row label="Frame rate">
                <Segmented
                  value={String(s.recording.fps) as '30' | '60'}
                  onChange={(v) => save({ recording: { ...s.recording, fps: Number(v) as 30 | 60 } })}
                  options={[
                    { value: '30', label: '30 fps' },
                    { value: '60', label: '60 fps' },
                  ]}
                />
              </Row>
              <Row label="Default mode" note="Your camera is always in the recording; this picks how the launcher opens.">
                <Segmented
                  value={s.recording.defaultMode === 'cam' ? 'cam' : 'screen-cam'}
                  onChange={(defaultMode) => save({ recording: { ...s.recording, defaultMode } })}
                  options={[
                    { value: 'screen-cam', label: 'Screen' },
                    { value: 'cam', label: 'Full face' },
                  ]}
                />
              </Row>
              <Row
                label="Computer audio by default"
                note={
                  info?.systemAudio
                    ? 'Include system sound in new recordings.'
                    : 'Not supported on this machine (macOS 14.2+ or Windows required).'
                }
              >
                <Toggle
                  checked={s.recording.systemAudio && (info?.systemAudio ?? false)}
                  disabled={!info?.systemAudio}
                  onChange={(v) => save({ recording: { ...s.recording, systemAudio: v } })}
                  label="Computer audio by default"
                />
              </Row>
              <Row label="Maximum duration" note="Recording stops automatically at the limit. 0 means no limit.">
                <div className="field-row">
                  <input
                    type="number"
                    min={0}
                    max={480}
                    value={s.recording.maxDurationMin}
                    onChange={(e) =>
                      save({
                        recording: {
                          ...s.recording,
                          maxDurationMin: Math.max(0, Math.min(480, Number(e.target.value) || 0)),
                        },
                      })
                    }
                    aria-label="Maximum duration in minutes"
                    style={{ width: 84 }}
                  />
                  <span className="field-note">minutes</span>
                </div>
              </Row>
              <Row label="Camera bubble" note="Size of the webcam bubble while recording.">
                <Segmented
                  value={s.bubble.size}
                  onChange={(size) => save({ bubble: { ...s.bubble, size } })}
                  options={[
                    { value: 'S', label: 'Small' },
                    { value: 'M', label: 'Medium' },
                    { value: 'L', label: 'Large' },
                  ]}
                />
              </Row>
              <Row label="Mirror camera">
                <Toggle
                  checked={s.bubble.mirror}
                  onChange={(mirror) => save({ bubble: { ...s.bubble, mirror } })}
                  label="Mirror camera"
                />
              </Row>
            </section>
          )}

          {pane === 'facecam' && (
            <section aria-label="FaceCam">
              <p className="settings-intro">
                Your camera's look comes from macOS camera effects: Portrait blurs the room behind you and Studio
                Light relights your face - matted by the system on the Neural Engine, inside the camera itself. That
                is why they look native: previews, the bubble and recordings all get the exact same frames, at zero
                cost to the app.
              </p>
              <Row label="Preview" note="Live from your camera - recordings look exactly like this. The camera is released when you leave this pane.">
                <FacecamPreview cameraId={s.recording.cameraId} mirror={s.bubble.mirror} />
              </Row>
              <Row label="Portrait" note="Background blur, matted by macOS.">
                <EffectState on={!!fx?.portrait} />
              </Row>
              <Row label="Studio Light" note="Softbox-style relight of your face.">
                <EffectState on={!!fx?.studioLight} />
              </Row>
              <Row
                label="Camera effects"
                note={
                  fx && !fx.supported
                    ? 'Not available here: needs macOS on Apple Silicon (built-in camera) or Continuity Camera.'
                    : 'Toggle Portrait and Studio Light in the system panel. Also reachable from Control Center (the green camera icon) while the camera is on.'
                }
              >
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={fx ? !fx.supported : false}
                  onClick={() => window.openloom.openCameraEffects()}
                >
                  Open Camera Effects…
                </button>
              </Row>
            </section>
          )}

          {pane === 'shortcuts' && (
            <section aria-label="Shortcuts">
              <p className="settings-intro">
                Click a shortcut, then press the new keys. Global shortcuts need at least one modifier and work even
                when Open Loom is hidden. Conflicting combinations are rejected.
              </p>
              <Row label="Start / stop recording">
                <ShortcutField value={s.shortcuts.startStop} onSave={(a) => saveShortcut('startStop', a)} ariaLabel="Start or stop shortcut" />
              </Row>
              <Row label="Pause / resume">
                <ShortcutField value={s.shortcuts.pauseResume} onSave={(a) => saveShortcut('pauseResume', a)} ariaLabel="Pause or resume shortcut" />
              </Row>
              <Row label="Cancel recording">
                <ShortcutField value={s.shortcuts.cancel} onSave={(a) => saveShortcut('cancel', a)} ariaLabel="Cancel shortcut" />
              </Row>
              <Row label="Restart recording">
                <ShortcutField value={s.shortcuts.restart} onSave={(a) => saveShortcut('restart', a)} ariaLabel="Restart shortcut" />
              </Row>
              <Row label="Toggle drawing">
                <ShortcutField value={s.shortcuts.draw} onSave={(a) => saveShortcut('draw', a)} ariaLabel="Draw shortcut" />
              </Row>
            </section>
          )}

          {pane === 'transcription' && (
            <section aria-label="Transcription">
              <p className="settings-intro">
                Transcription runs locally with whisper.cpp (private, offline) or through any OpenAI-compatible
                endpoint. New recordings are transcribed automatically when the toggle below is on.
              </p>
              <Row label="Engine">
                <Segmented
                  value={s.transcription.engine}
                  onChange={(engine) => save({ transcription: { ...s.transcription, engine } })}
                  options={[
                    { value: 'whisper', label: 'whisper.cpp' },
                    { value: 'openai', label: 'API endpoint' },
                    { value: 'off', label: 'Off' },
                  ]}
                />
              </Row>
              {s.transcription.engine === 'whisper' && (
                <>
                  <Row
                    label="whisper-cli path"
                    note={
                      perms?.whisper
                        ? 'whisper-cli found.'
                        : 'Not found yet. Install below or point at an existing binary.'
                    }
                  >
                    <div className="btn-row">
                      <SavedInput
                        value={s.transcription.whisperPath}
                        placeholder="/path/to/whisper-cli"
                        onSave={(v) => save({ transcription: { ...s.transcription, whisperPath: v } })}
                        ariaLabel="whisper-cli path"
                      />
                      <button
                        type="button"
                        className="btn-secondary"
                        aria-label="Browse for whisper-cli"
                        onClick={() =>
                          void pickPath((p) => save({ transcription: { ...s.transcription, whisperPath: p } }))
                        }
                      >
                        Browse
                      </button>
                    </div>
                  </Row>
                  <Row label="Model path">
                    <div className="btn-row">
                      <SavedInput
                        value={s.transcription.whisperModelPath}
                        placeholder="/path/to/ggml-base.en.bin"
                        onSave={(v) => save({ transcription: { ...s.transcription, whisperModelPath: v } })}
                        ariaLabel="Whisper model path"
                      />
                      <button
                        type="button"
                        className="btn-secondary"
                        aria-label="Browse for whisper model"
                        onClick={() =>
                          void pickPath((p) => save({ transcription: { ...s.transcription, whisperModelPath: p } }))
                        }
                      >
                        Browse
                      </button>
                    </div>
                  </Row>
                  <Row
                    label="Install whisper.cpp"
                    note="Clones and builds whisper.cpp, downloads the base.en model and fills the paths above."
                  >
                    <button type="button" className="btn-secondary" disabled={installing} onClick={runWhisperInstall}>
                      <Icon.Download width={15} height={15} />
                      {installing ? 'Installing' : 'Install whisper.cpp'}
                    </button>
                  </Row>
                </>
              )}
              {s.transcription.engine === 'openai' && (
                <>
                  <Row label="Endpoint" note="Any /v1/audio/transcriptions compatible URL.">
                    <SavedInput
                      value={s.transcription.endpoint}
                      placeholder="https://api.example.com/v1/audio/transcriptions"
                      onSave={(v) => save({ transcription: { ...s.transcription, endpoint: v } })}
                      ariaLabel="Transcription endpoint"
                    />
                  </Row>
                  <Row label="Model" note="The model name the endpoint expects.">
                    <SavedInput
                      value={s.transcription.model}
                      placeholder="whisper-1"
                      onSave={(v) => save({ transcription: { ...s.transcription, model: v || 'whisper-1' } })}
                      ariaLabel="Transcription model"
                    />
                  </Row>
                  <Row label="API key" note="Stored encrypted on this machine.">
                    <SavedInput
                      type="password"
                      value={s.transcription.apiKey}
                      placeholder="sk-..."
                      onSave={(v) => save({ transcription: { ...s.transcription, apiKey: v } })}
                      ariaLabel="Transcription API key"
                    />
                  </Row>
                </>
              )}
              {s.transcription.engine !== 'off' && (
                <>
                  <Row label="Language" note="Use 'auto' to detect, or a code like 'en'.">
                    <SavedInput
                      value={s.transcription.language}
                      onSave={(v) => save({ transcription: { ...s.transcription, language: v || 'auto' } })}
                      ariaLabel="Transcription language"
                    />
                  </Row>
                  <Row label="Transcribe automatically" note="Run after each recording finishes processing.">
                    <Toggle
                      checked={s.transcription.auto}
                      onChange={(auto) => save({ transcription: { ...s.transcription, auto } })}
                      label="Auto transcribe"
                    />
                  </Row>
                </>
              )}
            </section>
          )}

          {pane === 'ai' && (
            <section aria-label="AI">
              <p className="settings-intro">
                Bring your own provider for titles, summaries, chapters and action items, generated from each
                video&apos;s transcript. Keys are stored encrypted with your OS keychain.
              </p>
              <Row label="Provider">
                <Segmented
                  value={s.ai.provider}
                  onChange={(provider) => save({ ai: { ...s.ai, provider } })}
                  options={[
                    { value: 'anthropic', label: 'Anthropic' },
                    { value: 'openai', label: 'OpenAI-compatible' },
                    { value: 'ollama', label: 'Ollama' },
                    { value: 'off', label: 'Off' },
                  ]}
                />
              </Row>
              {s.ai.provider !== 'off' && (
                <>
                  {s.ai.provider !== 'anthropic' && (
                    <Row label="Endpoint" note={s.ai.provider === 'ollama' ? 'Usually http://localhost:11434' : 'Base URL of the API.'}>
                      <SavedInput
                        value={s.ai.endpoint}
                        placeholder={s.ai.provider === 'ollama' ? 'http://localhost:11434' : 'https://api.example.com/v1'}
                        onSave={(v) => save({ ai: { ...s.ai, endpoint: v } })}
                        ariaLabel="AI endpoint"
                      />
                    </Row>
                  )}
                  <Row label="Model">
                    <SavedInput
                      value={s.ai.model}
                      placeholder={s.ai.provider === 'ollama' ? 'llama3.1' : 'model name'}
                      onSave={(v) => save({ ai: { ...s.ai, model: v } })}
                      ariaLabel="AI model"
                    />
                  </Row>
                  {s.ai.provider !== 'ollama' && (
                    <Row label="API key" note="Stored encrypted on this machine.">
                      <SavedInput
                        type="password"
                        value={s.ai.apiKey}
                        placeholder="key"
                        onSave={(v) => save({ ai: { ...s.ai, apiKey: v } })}
                        ariaLabel="AI API key"
                      />
                    </Row>
                  )}
                  <Row label="Generate">
                    <div className="check-grid">
                      {(
                        [
                          ['title', 'Titles'],
                          ['summary', 'Summaries'],
                          ['chapters', 'Chapters'],
                          ['tasks', 'Action items'],
                        ] as [keyof Settings['ai']['features'], string][]
                      ).map(([key, label]) => (
                        <label key={key} className="check-item">
                          <input
                            type="checkbox"
                            checked={s.ai.features[key]}
                            onChange={(e) =>
                              save({ ai: { ...s.ai, features: { ...s.ai.features, [key]: e.target.checked } } })
                            }
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </Row>
                  <Row
                    label="Connection"
                    note={
                      aiTest.state === 'ok'
                        ? 'Connected. The model answered.'
                        : aiTest.state === 'fail'
                          ? aiTest.error
                          : 'Sends a one-word test prompt to verify the settings above.'
                    }
                  >
                    <div className="btn-row">
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={aiTest.state === 'running'}
                        onClick={runAiTest}
                      >
                        {aiTest.state === 'running' ? 'Testing' : 'Test connection'}
                      </button>
                      {aiTest.state === 'ok' && <span className="pill pill-ok">Working</span>}
                      {aiTest.state === 'fail' && <span className="pill pill-missing">Failed</span>}
                    </div>
                  </Row>
                </>
              )}
            </section>
          )}

          {pane === 'sharing' && (
            <section aria-label="Sharing">
              <p className="settings-intro">
                Share through your own OpenLoom Server (comments, reactions, analytics) or any S3-compatible bucket
                with a static watch page. Off keeps every recording local. Use Test to confirm the app can reach the
                provider before you rely on it.
              </p>
              <Row label="Provider">
                <Segmented
                  value={s.sharing.provider}
                  onChange={(provider) => save({ sharing: { ...s.sharing, provider } })}
                  options={[
                    { value: 'server', label: 'OpenLoom Server' },
                    { value: 's3', label: 'S3 bucket' },
                    { value: 'none', label: 'Off' },
                  ]}
                />
              </Row>
              {s.sharing.provider === 'server' && (
                <>
                  <Row label="Server URL">
                    <SavedInput
                      value={s.sharing.server.url}
                      placeholder="https://videos.example.com"
                      onSave={(v) => save({ sharing: { ...s.sharing, server: { ...s.sharing.server, url: v } } })}
                      ariaLabel="Share server URL"
                    />
                  </Row>
                  <Row label="API key" note="The creator key configured on your server. Stored encrypted.">
                    <div className="btn-row">
                      <SavedInput
                        type="password"
                        value={s.sharing.server.apiKey}
                        placeholder="key"
                        onSave={(v) => save({ sharing: { ...s.sharing, server: { ...s.sharing.server, apiKey: v } } })}
                        ariaLabel="Share server API key"
                      />
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={shareTest.state === 'running' || !s.sharing.server.url.trim()}
                        onClick={() => runShareTest('server')}
                      >
                        {shareTest.state === 'running' ? 'Testing' : 'Test'}
                      </button>
                    </div>
                  </Row>
                  <Row
                    label="Connection"
                    note={
                      shareTest.state === 'ok'
                        ? 'Reached the server. The creator key was accepted.'
                        : shareTest.state === 'fail'
                          ? shareTest.error
                          : 'Test checks the server is up and the API key is valid.'
                    }
                  >
                    {shareTest.state === 'ok' && <span className="pill pill-ok">Working</span>}
                    {shareTest.state === 'fail' && <span className="pill pill-missing">Failed</span>}
                    {(shareTest.state === 'idle' || shareTest.state === 'running') && (
                      <span className="settings-note">{shareTest.state === 'running' ? 'Testing…' : 'Not tested yet'}</span>
                    )}
                  </Row>
                </>
              )}
              {s.sharing.provider === 's3' && (
                <>
                  <Row label="Endpoint" note="R2, B2, MinIO or AWS endpoint URL.">
                    <SavedInput
                      value={s.sharing.s3.endpoint}
                      placeholder="https://<account>.r2.cloudflarestorage.com"
                      onSave={(v) => save({ sharing: { ...s.sharing, s3: { ...s.sharing.s3, endpoint: v } } })}
                      ariaLabel="S3 endpoint"
                    />
                  </Row>
                  <div className="field-pair">
                    <Row label="Region">
                      <SavedInput
                        value={s.sharing.s3.region}
                        placeholder="auto"
                        onSave={(v) => save({ sharing: { ...s.sharing, s3: { ...s.sharing.s3, region: v } } })}
                        ariaLabel="S3 region"
                      />
                    </Row>
                    <Row label="Bucket">
                      <SavedInput
                        value={s.sharing.s3.bucket}
                        placeholder="openloom-videos"
                        onSave={(v) => save({ sharing: { ...s.sharing, s3: { ...s.sharing.s3, bucket: v } } })}
                        ariaLabel="S3 bucket"
                      />
                    </Row>
                  </div>
                  <Row label="Access key ID">
                    <SavedInput
                      value={s.sharing.s3.accessKeyId}
                      onSave={(v) => save({ sharing: { ...s.sharing, s3: { ...s.sharing.s3, accessKeyId: v } } })}
                      ariaLabel="S3 access key id"
                    />
                  </Row>
                  <Row label="Secret access key" note="Stored encrypted on this machine.">
                    <SavedInput
                      type="password"
                      value={s.sharing.s3.secretAccessKey}
                      onSave={(v) => save({ sharing: { ...s.sharing, s3: { ...s.sharing.s3, secretAccessKey: v } } })}
                      ariaLabel="S3 secret access key"
                    />
                  </Row>
                  <Row label="Public base URL" note="The public bucket URL or your custom domain.">
                    <SavedInput
                      value={s.sharing.s3.publicBaseUrl}
                      placeholder="https://videos.example.com"
                      onSave={(v) => save({ sharing: { ...s.sharing, s3: { ...s.sharing.s3, publicBaseUrl: v } } })}
                      ariaLabel="S3 public base URL"
                    />
                  </Row>
                  <Row label="Key prefix">
                    <SavedInput
                      value={s.sharing.s3.prefix}
                      onSave={(v) => save({ sharing: { ...s.sharing, s3: { ...s.sharing.s3, prefix: v } } })}
                      ariaLabel="S3 key prefix"
                    />
                  </Row>
                  <Row label="Path-style addressing" note="Needed by MinIO and some S3-compatible stores.">
                    <Toggle
                      checked={s.sharing.s3.pathStyle}
                      onChange={(v) => save({ sharing: { ...s.sharing, s3: { ...s.sharing.s3, pathStyle: v } } })}
                      label="Path style"
                    />
                  </Row>
                  <Row
                    label="Connection"
                    note={
                      shareTest.state === 'ok'
                        ? 'Reached the bucket. The keys work.'
                        : shareTest.state === 'fail'
                          ? shareTest.error
                          : 'Test checks the endpoint, bucket and keys with a real request.'
                    }
                  >
                    <div className="btn-row">
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={shareTest.state === 'running' || !s.sharing.s3.bucket.trim()}
                        onClick={() => runShareTest('s3')}
                      >
                        {shareTest.state === 'running' ? 'Testing' : 'Test'}
                      </button>
                      {shareTest.state === 'ok' && <span className="pill pill-ok">Working</span>}
                      {shareTest.state === 'fail' && <span className="pill pill-missing">Failed</span>}
                    </div>
                  </Row>
                </>
              )}
              {s.sharing.provider !== 'none' && (
                <>
                  <Row label="Copy link on stop" note="Mint and copy the share link the moment recording stops.">
                    <Toggle
                      checked={s.sharing.autoCopyOnStop}
                      onChange={(v) => save({ sharing: { ...s.sharing, autoCopyOnStop: v } })}
                      label="Copy link on stop"
                    />
                  </Row>
                  <Row label="Default privacy">
                    <div className="check-grid">
                      {(
                        [
                          ['allowComments', 'Allow comments'],
                          ['allowReactions', 'Allow reactions'],
                          ['allowDownload', 'Allow download'],
                        ] as [keyof Settings['sharing']['defaults'] & string, string][]
                      ).map(([key, label]) => (
                        <label key={key} className="check-item">
                          <input
                            type="checkbox"
                            checked={Boolean(s.sharing.defaults[key as 'allowComments'])}
                            onChange={(e) =>
                              save({
                                sharing: {
                                  ...s.sharing,
                                  defaults: { ...s.sharing.defaults, [key]: e.target.checked },
                                },
                              })
                            }
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </Row>
                </>
              )}
            </section>
          )}

          {pane === 'youtube' && (
            <section aria-label="YouTube">
              <p className="settings-intro">
                Publish recordings straight to your own YouTube channel as unlisted. Open Loom uses
                your own Google Cloud OAuth credentials - nothing is shared with anyone else.
              </p>
              <Row
                label="Client ID"
                note="From a Google Cloud “Desktop app” OAuth client (APIs & Services › Credentials)."
              >
                <SavedInput
                  value={s.youtube.clientId}
                  placeholder="xxxxxxxx.apps.googleusercontent.com"
                  onSave={(v) => save({ youtube: { ...s.youtube, clientId: v } })}
                  ariaLabel="YouTube OAuth client ID"
                />
              </Row>
              <Row label="Client secret" note="Stored encrypted on this machine.">
                <SavedInput
                  type="password"
                  value={s.youtube.clientSecret}
                  onSave={(v) => save({ youtube: { ...s.youtube, clientSecret: v } })}
                  ariaLabel="YouTube OAuth client secret"
                />
              </Row>
              <Row
                label="Account"
                note={
                  ytConnected
                    ? 'Connected. Recordings can be published from the video page.'
                    : 'Connect once - consent opens in your browser, then returns here.'
                }
              >
                <div className="btn-row">
                  {ytConnected ? (
                    <>
                      <span className="pill pill-ok">Connected</span>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={ytBusy}
                        onClick={disconnectYouTube}
                      >
                        Disconnect
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={ytBusy || !s.youtube.clientId.trim() || !s.youtube.clientSecret}
                      onClick={connectYouTube}
                    >
                      {ytBusy ? 'Connecting…' : 'Connect YouTube'}
                    </button>
                  )}
                </div>
              </Row>
              <p className="settings-note">
                New uploads land unlisted only once your Google Cloud project passes YouTube&apos;s API
                compliance audit. Until then they upload as private and the video page shows a one-click
                “Set to Unlisted”.
              </p>
            </section>
          )}

          {pane === 'about' && (
            <section aria-label="About">
              <div className="about-brand">
                <svg width="52" height="52" viewBox="0 0 1024 1024" aria-hidden="true">
                  <rect x="24" y="64" width="976" height="896" rx="220" fill="#635BFF" />
                  <path d="M 692.5 331.5 A 255 255 0 1 0 763 512" stroke="#FFFFFF" strokeWidth="86" strokeLinecap="round" fill="none" />
                  <circle cx="734" cy="368" r="62" fill="#FFFFFF" />
                </svg>
                <div>
                  <h3>Open Loom</h3>
                  <p>
                    Version {info?.version ?? ''} · {info?.platform ?? ''} {info?.osVersion ?? ''}
                  </p>
                  <p className="settings-note">Open-source, local-first screen recording. MIT licensed.</p>
                </div>
              </div>
              <Row label="ffmpeg" note={perms?.ffmpeg ? 'Found and working.' : 'Not found. Recordings cannot be processed without it.'}>
                <span className={`pill ${perms?.ffmpeg ? 'pill-ok' : 'pill-missing'}`}>{perms?.ffmpeg ? 'Ready' : 'Missing'}</span>
              </Row>
              <Row label="whisper.cpp" note={perms?.whisper ? 'Found.' : 'Optional. Needed for local transcription.'}>
                <span className={`pill ${perms?.whisper ? 'pill-ok' : 'pill-missing'}`}>{perms?.whisper ? 'Ready' : 'Not found'}</span>
              </Row>
              <Row label="Diagnostics">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={async () => {
                    try {
                      setPerms(await window.openloom.getPermissions());
                      push('success', 'Checks refreshed.');
                    } catch (err) {
                      push('error', cleanIpcError(err));
                    }
                  }}
                >
                  <Icon.Refresh width={15} height={15} />
                  Re-run checks
                </button>
              </Row>
            </section>
          )}
        </div>
      </div>

      {installOpen && (
        <Modal
          title="Install whisper.cpp"
          onClose={() => {
            if (!installing) setInstallOpen(false);
          }}
          width={560}
        >
          <p className="settings-note modal-note">
            Cloning and building whisper.cpp, then downloading the base.en model (about 140 MB). This runs once and
            can take a few minutes.
          </p>
          <pre className="setup-log" ref={logRef} aria-label="Install log">
            {installLog.length > 0 ? installLog.join('\n') : 'Starting'}
          </pre>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" disabled={installing} onClick={() => setInstallOpen(false)}>
              {installing ? 'Running' : 'Close'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
