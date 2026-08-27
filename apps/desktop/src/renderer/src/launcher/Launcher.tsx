/**
 * Floating recording launcher: the slim always-on-top panel pinned to the
 * left edge of the screen. Face-first by design - a live camera preview is
 * always on and every recording includes the camera (proposal videos are the
 * product). One switch at the bottom picks Full face or Screen; Screen mode
 * adds a compact source picker and burns the face bubble into the recording.
 * Quality, fps and system audio come from Settings in the main window.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppInfo,
  CaptureSource,
  MediaDeviceInfoLite,
  RecordingMode,
  Settings,
} from '@shared/types';
import { NOTES_MAX_CHARS } from '@shared/types';
import { Icon } from '../components/icons';
import { Segmented, Toggle, useToasts, cleanIpcError } from '../components/ui';
import {
  attachHealthyCameraStream,
  getUserMediaResilient,
  type HealthyCameraSession,
} from '../media';

/** The launcher only offers the two face-on modes; legacy 'screen' maps to Screen. */
type LauncherMode = Extract<RecordingMode, 'screen-cam' | 'cam'>;

/** Chromium's synthetic OS-default aliases (audio only in practice). */
const SYNTHETIC_DEVICE_IDS = new Set(['default', 'communications']);

/**
 * enumerateDevices can list one physical device several times: Chromium
 * injects "default"/"communications" audio aliases, and macOS driver
 * migrations (DAL plugin + Camera Extension) can register a camera twice.
 * Strip the aliases, dedupe by deviceId, then collapse entries sharing
 * kind + label + a non-empty groupId. Label alone is never enough evidence
 * to collapse - two identical USB mics, or an iPhone's Continuity and Desk
 * View feeds, are genuinely distinct devices.
 */
function dedupeDevices(devices: MediaDeviceInfoLite[]): MediaDeviceInfoLite[] {
  const byId = new Map<string, MediaDeviceInfoLite>();
  for (const d of devices) {
    if (SYNTHETIC_DEVICE_IDS.has(d.deviceId)) continue;
    const prev = byId.get(d.deviceId);
    // Prefer the record with a real label (pre-permission entries are blank).
    if (!prev || (prev.label === '' && d.label !== '')) byId.set(d.deviceId, d);
  }
  const seen = new Set<string>();
  const out: MediaDeviceInfoLite[] = [];
  for (const d of byId.values()) {
    if (d.groupId !== '') {
      const key = `${d.kind}|${d.label}|${d.groupId}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(d);
  }
  return out;
}

function applyTheme(_theme: Settings['theme']): void {
  // The launcher is a dark glass overlay in both app themes (DESIGN.md overlay
  // family) - its controls always use the dark palette.
  document.documentElement.dataset['theme'] = 'dark';
}

function CameraPreview({ deviceId, mirror }: { deviceId: string; mirror: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let session: HealthyCameraSession | null = null;
    let cancelled = false;
    setReady(false);
    void (async () => {
      const video = videoRef.current;
      if (!video) return;
      try {
        // Health-checked capture: only reveals once frames are provably real
        // (a macOS capture race can deliver solid green frames that pass
        // every readiness event).
        session = await attachHealthyCameraStream(
          video,
          {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          { isCancelled: () => cancelled }
        );
        setError(null);
        setReady(true);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error && err.message.includes('blank')
              ? 'The camera is not sending a live picture. Close other apps using it and hit refresh.'
              : 'Camera unavailable. Check the Camera permission in Setup.'
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      session?.stop();
    };
  }, [deviceId]);

  if (error) return <div className="launcher-preview launcher-preview-error">{error}</div>;
  return (
    <div className="launcher-preview">
      {!ready && <div className="preview-ring" aria-label="Starting camera" />}
      <video
        ref={videoRef}
        className={`${mirror ? 'mirrored' : ''}${ready ? ' ready' : ''}`}
        muted
        playsInline
        aria-label="Camera preview"
      />
    </div>
  );
}

function MicMeter({ deviceId, enabled }: { deviceId: string; enabled: boolean }) {
  // The level is written straight to the fill element every frame; routing it
  // through React state at 60fps re-rendered the launcher and fought the CSS
  // width transition, which made the meter lag the voice.
  const fillRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // One state flip when a real level is first heard - the loudest first-take
  // fear is "did it record silence", so the meter carries an explicit check.
  const [heard, setHeard] = useState(false);
  const heardRef = useRef(false);

  useEffect(() => {
    heardRef.current = false;
    setHeard(false);
    if (!enabled) {
      if (fillRef.current) fillRef.current.style.transform = 'scaleX(0)';
      return;
    }
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;
    void (async () => {
      try {
        stream = await getUserMediaResilient({
          audio: { deviceId: deviceId ? { exact: deviceId } : undefined },
        });
        if (cancelled) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        setError(null);
        ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        // Meter ballistics. Raw RMS is noisy frame to frame, so writing it
        // straight to the DOM made the bar strobe rather than move. The shown
        // value chases the real level by exponential smoothing (a lerp toward
        // the target), with a fast attack so a word registers the instant you
        // speak and a slow release so it glides back instead of snapping.
        // Time constants are in seconds and the step is derived from the frame
        // delta, so it behaves identically on a 60Hz and a 120Hz display
        // rather than moving twice as fast on the latter.
        const ATTACK_TAU = 0.05;
        const RELEASE_TAU = 0.25;
        let shown = 0;
        let last = performance.now();
        const tick = (now: number) => {
          // Clamp the delta so a backgrounded tab returning does not teleport
          // the bar on its first frame back.
          const dt = Math.min(100, now - last) / 1000;
          last = now;
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (const v of data) {
            const c = (v - 128) / 128;
            sum += c * c;
          }
          const level = Math.min(1, Math.sqrt(sum / data.length) * 3);
          // "Did we hear you" reads the RAW level, not the smoothed one, so the
          // reassurance still fires the moment you speak.
          if (level > 0.12 && !heardRef.current) {
            heardRef.current = true;
            setHeard(true);
          }
          const tau = level > shown ? ATTACK_TAU : RELEASE_TAU;
          shown += (level - shown) * (1 - Math.exp(-dt / tau));
          if (fillRef.current) fillRef.current.style.transform = `scaleX(${shown.toFixed(4)})`;
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        if (!cancelled) setError('Microphone unavailable');
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (stream) for (const t of stream.getTracks()) t.stop();
      if (ctx && ctx.state !== 'closed') void ctx.close();
    };
  }, [deviceId, enabled]);

  if (!enabled) return null;
  if (error) return <span className="mic-meter-error">{error}</span>;
  return (
    <div className="launcher-mic-check">
      <div className="mic-meter" aria-label="Microphone level">
        <div ref={fillRef} className="mic-meter-fill" style={{ transform: 'scaleX(0)' }} />
      </div>
      <span className={`mic-meter-caption${heard ? ' heard' : ''}`} aria-live="polite">
        {heard ? 'Mic sounds good' : 'Say something to test your mic'}
      </span>
    </div>
  );
}

export function Launcher() {
  const { push } = useToasts();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mode, setMode] = useState<LauncherMode>('screen-cam');
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [cameras, setCameras] = useState<MediaDeviceInfoLite[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfoLite[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [micId, setMicId] = useState('');
  const [micOn, setMicOn] = useState(true);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const [loadingSources, setLoadingSources] = useState(true);
  const [screenBlocked, setScreenBlocked] = useState(false);
  const [notes, setNotes] = useState('');
  const lastSourceError = useRef<string | null>(null);
  // The source recorded last time, applied once when both settings and the
  // source list have arrived (either can win the race).
  const lastSourceId = useRef('');
  const lastSourceApplied = useRef(false);
  const notesSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshSources = useCallback(async () => {
    // macOS keys Screen Recording to the app's code signature and path, so a
    // fresh install always starts denied - and every enumeration throws while
    // it is. This runs on a timer, so without the gate below a denied install
    // raises an error toast every three seconds, which teaches the user to
    // ignore toasts and buries the one message that would actually fix it.
    try {
      const perms = await window.openloom.getPermissions();
      if (perms.screen !== 'granted') {
        setScreenBlocked(true);
        setSources([]);
        setLoadingSources(false);
        return;
      }
      setScreenBlocked(false);
    } catch {
      // A failing probe is not itself grounds to hide the picker; fall through
      // and let the enumeration report the real fault.
    }
    try {
      const list = await window.openloom.listCaptureSources();
      setSources(list);
      setSourceId((cur) => {
        if (cur && list.some((s) => s.id === cur)) return cur;
        return list.find((s) => s.display)?.id ?? list[0]?.id ?? '';
      });
      lastSourceError.current = null;
    } catch (err) {
      // Same reasoning as above: on a polled call an unchanged fault must
      // surface once, not once per tick.
      const message = cleanIpcError(err);
      if (lastSourceError.current !== message) {
        lastSourceError.current = message;
        push('error', message);
      }
    } finally {
      setLoadingSources(false);
    }
  }, [push]);

  useEffect(() => {
    void refreshSources();
    // This used to re-enumerate on a 3s timer, which meant capturing and
    // encoding a thumbnail of every open window twenty times a minute for as
    // long as the panel sat open - a constant battery cost for a list that only
    // changes while you are off doing something else. Refresh when the panel is
    // actually being looked at instead. The launcher window is reused rather
    // than destroyed, so 'focus' covers re-showing it and visibilitychange
    // covers the inactive show; the header's refresh button covers the rest.
    const onFocus = () => void refreshSources();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refreshSources();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    void window.openloom.appInfo().then(setInfo);
    void (async () => {
      const s = await window.openloom.getSettings();
      setSettings(s);
      applyTheme(s.theme);
      setMode(s.recording.defaultMode === 'cam' ? 'cam' : 'screen-cam');
      setNotes(s.recording.notes);
      lastSourceId.current = s.recording.lastSourceId;
      // Ask for device labels; without a one-time getUserMedia the names are blank.
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        for (const t of probe.getTracks()) t.stop();
      } catch {
        /* user may have denied camera; dropdowns will show generic names */
      }
      const devices = await window.openloom.listMediaDevices();
      const cams = dedupeDevices(devices.cameras);
      const micList = dedupeDevices(devices.mics);
      setCameras(cams);
      setMics(micList);
      // Drop a stale persisted id that no longer matches a real device, so we
      // never pin getUserMedia to a camera or mic that is gone.
      const savedCam = s.recording.cameraId;
      const savedMic = s.recording.micId;
      setCameraId(cams.some((c) => c.deviceId === savedCam) ? savedCam : cams[0]?.deviceId ?? '');
      setMicId(micList.some((m) => m.deviceId === savedMic) ? savedMic : micList[0]?.deviceId ?? '');
    })();
    const offSettings = window.openloomInternal.onSettingsChanged((s) => {
      setSettings(s);
      applyTheme(s.theme);
    });
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      offSettings();
    };
  }, [refreshSources, push]);

  // A mic or camera plugged in (or yanked) while the panel sits open appears
  // in the dropdowns immediately - no reopen. The current pick survives when
  // its device still exists; a vanished device falls back to the first one
  // WITH a toast - a silent swap to the built-in mic is only discovered in
  // playback, after the take is wasted.
  const micIdRef = useRef(micId);
  micIdRef.current = micId;
  const cameraIdRef = useRef(cameraId);
  cameraIdRef.current = cameraId;
  useEffect(() => {
    const onDeviceChange = () => {
      void (async () => {
        try {
          const devices = await window.openloom.listMediaDevices();
          const cams = dedupeDevices(devices.cameras);
          const micList = dedupeDevices(devices.mics);
          setCameras(cams);
          setMics(micList);
          const micGone = micIdRef.current && !micList.some((m) => m.deviceId === micIdRef.current);
          const camGone = cameraIdRef.current && !cams.some((c) => c.deviceId === cameraIdRef.current);
          if (micGone) {
            push('error', `Your microphone disconnected - now using ${micList[0]?.label || 'the default mic'}.`);
          }
          if (camGone) {
            push('error', `Your camera disconnected - now using ${cams[0]?.label || 'the default camera'}.`);
          }
          setCameraId((cur) => (cams.some((c) => c.deviceId === cur) ? cur : cams[0]?.deviceId ?? ''));
          setMicId((cur) => (micList.some((m) => m.deviceId === cur) ? cur : micList[0]?.deviceId ?? ''));
        } catch {
          /* keep the current lists; the next change event retries */
        }
      })();
    };
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
  }, [push]);

  // Offer the source recorded last time first, when it still exists. Runs once
  // both the settings and a source list are in; a vanished source falls back
  // to the default pick without a word.
  useEffect(() => {
    if (lastSourceApplied.current) return;
    const last = lastSourceId.current;
    if (!settings || sources.length === 0) return;
    lastSourceApplied.current = true;
    if (last && sources.some((s) => s.id === last)) setSourceId(last);
  }, [sources, settings]);

  /** Persist the talking notes, debounced so a restart mid-typing keeps them. */
  const saveNotes = useCallback((text: string) => {
    setNotes(text);
    if (notesSaveTimer.current) clearTimeout(notesSaveTimer.current);
    notesSaveTimer.current = setTimeout(() => {
      void window.openloom
        .getSettings()
        .then((s) => window.openloom.setSettings({ recording: { ...s.recording, notes: text } }))
        .catch(() => undefined);
    }, 500);
  }, []);

  // Escape dismisses the panel (it comes back via the app or on next launch).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        console.warn('[launcher] Escape pressed - closing panel');
        window.close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const isScreen = mode === 'screen-cam';
  const displays = sources.filter((s) => s.display);
  const windows = sources.filter((s) => !s.display);
  const source = sources.find((s) => s.id === sourceId);
  const canStart = !starting && !!settings && (isScreen ? !!source : cameras.length > 0);

  const start = async () => {
    if (!settings) return;
    setStarting(true);
    try {
      // Persist device + mode choices (and the notes as typed, in case the
      // debounced save has not fired yet) for next time.
      if (notesSaveTimer.current) clearTimeout(notesSaveTimer.current);
      await window.openloom.setSettings({
        recording: { ...settings.recording, defaultMode: mode, cameraId, micId, notes },
      });
      await window.openloom.startRecording({
        mode,
        sourceId: isScreen ? sourceId : undefined,
        sourceIsDisplay: isScreen ? (source?.display ?? false) : undefined,
        cameraId: cameraId || undefined,
        micId: micId || undefined,
        cameraOn: true,
        micOn,
        systemAudio: isScreen && settings.recording.systemAudio && (info?.systemAudio ?? false),
        quality: settings.recording.quality,
        fps: settings.recording.fps,
      });
      // On success this window is torn down by the main process.
    } catch (err) {
      push('error', cleanIpcError(err));
      setStarting(false);
    }
  };

  return (
    <div className="launcher">
      <div className="launcher-drag">
        <span className="launcher-title">Open Loom</span>
        <button
          type="button"
          className="icon-btn launcher-close"
          aria-label="Close"
          title="Close"
          onClick={() => window.close()}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <CameraPreview deviceId={cameraId} mirror={settings?.bubble.mirror ?? true} />

      <div className="launcher-devices">
        <select
          aria-label="Camera device"
          id="nr-camera"
          value={cameraId}
          onChange={(e) => setCameraId(e.target.value)}
        >
          {cameras.length === 0 && <option value="">No camera found</option>}
          {cameras.map((c, i) => (
            <option key={c.deviceId || i} value={c.deviceId}>
              {c.label || `Camera ${i + 1}`}
            </option>
          ))}
        </select>
        <div className="launcher-mic-row">
          <Toggle checked={micOn} onChange={setMicOn} label="Mic" />
          <select
            aria-label="Microphone device"
            id="nr-mic"
            value={micId}
            disabled={!micOn}
            onChange={(e) => setMicId(e.target.value)}
          >
            {mics.length === 0 && <option value="">No microphone found</option>}
            {mics.map((m, i) => (
              <option key={m.deviceId || i} value={m.deviceId}>
                {m.label || `Microphone ${i + 1}`}
              </option>
            ))}
          </select>
        </div>
        <MicMeter deviceId={micId} enabled={micOn} />
      </div>

      {/* The most consequential choice on the panel - it decides what gets
          recorded - so it sits ABOVE the picker it controls, never below the
          Start button where a first-timer only finds it after recording. */}
      <div className="launcher-mode">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            {
              value: 'cam',
              label: (
                <>
                  <Icon.Camera width={15} height={15} /> Full face
                </>
              ),
            },
            {
              value: 'screen-cam',
              label: (
                <>
                  <Icon.ScreenCam width={15} height={15} /> Screen
                </>
              ),
            },
          ]}
        />
        <p className="launcher-hint">Your face stays in the recording in both modes.</p>
      </div>

      {isScreen && (
        <div className="launcher-sources">
          <div className="source-picker-head">
            <span className="field-label">What to record</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Refresh sources"
              title="Refresh"
              onClick={() => void refreshSources()}
            >
              <Icon.Refresh width={14} height={14} />
            </button>
          </div>
          {/* Everything below the heading shares ONE scroll region, so the
              source list can never bleed under the footer. */}
          <div className="launcher-sources-scroll">
            {screenBlocked && (
              <div className="source-blocked">
                <p className="source-blocked-title">Screen Recording is off</p>
                <p>macOS has to allow Open Loom to see your screen before it can list anything to record.</p>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => window.openloom.openSystemSettings('screen')}
                >
                  Open System Settings
                </button>
                {/* macOS only hands the capture stream to a process that was
                    already trusted when it started, so a fresh grant does not
                    apply to the running app. */}
                <p className="source-blocked-note">Tick Open Loom in the list, then quit and reopen the app.</p>
              </div>
            )}

            {!screenBlocked && loadingSources && sources.length === 0 && <div className="source-loading">Finding screens and windows</div>}

            {/* Full screen first: records the whole display, so you can switch
                tabs and apps freely while filming - the standard walkthrough mode. */}
            {displays.length > 0 && (
              <div className="source-grid source-grid-displays" role="listbox" aria-label="Full screen">
                {displays.map((s, i) => (
                  <button
                    key={s.id}
                    type="button"
                    role="option"
                    aria-selected={sourceId === s.id}
                    className={`source-card source-card-display${sourceId === s.id ? ' selected' : ''}`}
                    onClick={() => setSourceId(s.id)}
                  >
                    {s.thumbnailDataUrl ? (
                      <img src={s.thumbnailDataUrl} alt="" />
                    ) : (
                      <div className="source-thumb-empty">
                        <Icon.Screen width={22} height={22} />
                      </div>
                    )}
                    <span className="source-name">
                      <Icon.Screen width={13} height={13} />
                      {displays.length > 1 ? `Full screen ${i + 1}` : 'Full screen'}
                      <span className="source-sub">switch tabs freely</span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            {windows.length > 0 && (
              <>
                <span className="field-label source-group-label">Or a single window</span>
                <div className="source-grid" role="listbox" aria-label="Single window">
                  {windows.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      role="option"
                      aria-selected={sourceId === s.id}
                      className={`source-card${sourceId === s.id ? ' selected' : ''}`}
                      onClick={() => setSourceId(s.id)}
                    >
                      {s.thumbnailDataUrl ? (
                        <img src={s.thumbnailDataUrl} alt="" />
                      ) : (
                        <div className="source-thumb-empty">
                          <Icon.Screen width={22} height={22} />
                        </div>
                      )}
                      <span className="source-name">
                        <Icon.Library width={13} height={13} />
                        {s.name}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {!isScreen && (
        <p className="launcher-note">
          Full-face recording: your camera fills the whole video.
        </p>
      )}

      <div className="launcher-notes">
        <div className="launcher-notes-head">
          <label className="field-label" htmlFor="nr-notes">
            Talking notes
          </label>
          {/* Always visible: a cap you only discover by losing text is a trap. */}
          <span className="launcher-notes-count">
            {notes.length}/{NOTES_MAX_CHARS}
          </span>
        </div>
        <textarea
          id="nr-notes"
          /* Grows with the note (to six lines) so you can read back what you
             will read on screen, instead of writing into a two-line letterbox. */
          rows={Math.min(6, Math.max(2, notes.split('\n').length))}
          maxLength={NOTES_MAX_CHARS}
          placeholder="Jot what to say - it floats on screen while you record. Only you see it."
          value={notes}
          onChange={(e) => saveNotes(e.target.value.slice(0, NOTES_MAX_CHARS))}
          onPaste={(e) => {
            // maxLength clips a long paste before onChange can see it - say so,
            // or the user walks into the call believing the lost lines exist.
            const incoming = e.clipboardData.getData('text');
            if (notes.length + incoming.length > NOTES_MAX_CHARS) {
              push('info', `Trimmed to ${NOTES_MAX_CHARS} characters - notes work best as prompts, not a script.`);
            }
          }}
        />
      </div>

      <div className="launcher-foot">
        <button type="button" className="btn-primary launcher-start" disabled={!canStart} onClick={() => void start()}>
          <Icon.Record width={15} height={15} />
          {starting ? 'Starting' : 'Start recording'}
        </button>
        <p className="launcher-hint">
          Fluff a line while recording? The ↺10 button re-says the last ten seconds.
        </p>
      </div>
    </div>
  );
}
