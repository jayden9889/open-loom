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
import { Icon } from '../components/icons';
import { Segmented, Toggle, useToasts, cleanIpcError } from '../components/ui';
import { getUserMediaResilient } from '../media';

/** The launcher only offers the two face-on modes; legacy 'screen' maps to Screen. */
type LauncherMode = Extract<RecordingMode, 'screen-cam' | 'cam'>;

function applyTheme(theme: Settings['theme']): void {
  const rootEl = document.documentElement;
  if (theme === 'auto') delete rootEl.dataset['theme'];
  else rootEl.dataset['theme'] = theme;
}

function CameraPreview({ deviceId, mirror }: { deviceId: string; mirror: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    void (async () => {
      try {
        stream = await getUserMediaResilient({
          video: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        if (cancelled) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        setError(null);
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          void video.play().catch(() => undefined);
        }
      } catch {
        if (!cancelled) setError('Camera unavailable. Check the Camera permission in Setup.');
      }
    })();
    return () => {
      cancelled = true;
      if (stream) for (const t of stream.getTracks()) t.stop();
    };
  }, [deviceId]);

  if (error) return <div className="launcher-preview launcher-preview-error">{error}</div>;
  return (
    <video
      ref={videoRef}
      className={`launcher-preview${mirror ? ' mirrored' : ''}`}
      muted
      playsInline
      aria-label="Camera preview"
    />
  );
}

function MicMeter({ deviceId, enabled }: { deviceId: string; enabled: boolean }) {
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setLevel(0);
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
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (const v of data) {
            const c = (v - 128) / 128;
            sum += c * c;
          }
          setLevel(Math.min(1, Math.sqrt(sum / data.length) * 3));
          raf = requestAnimationFrame(tick);
        };
        tick();
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
    <div className="mic-meter" aria-label="Microphone level">
      <div className="mic-meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
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

  const refreshSources = useCallback(async () => {
    try {
      const list = await window.openloom.listCaptureSources();
      setSources(list);
      setSourceId((cur) => {
        if (cur && list.some((s) => s.id === cur)) return cur;
        return list.find((s) => s.display)?.id ?? list[0]?.id ?? '';
      });
    } catch (err) {
      push('error', cleanIpcError(err));
    } finally {
      setLoadingSources(false);
    }
  }, [push]);

  useEffect(() => {
    void refreshSources();
    const timer = setInterval(() => void refreshSources(), 3000);
    void window.openloom.appInfo().then(setInfo);
    void (async () => {
      const s = await window.openloom.getSettings();
      setSettings(s);
      applyTheme(s.theme);
      setMode(s.recording.defaultMode === 'cam' ? 'cam' : 'screen-cam');
      // Ask for device labels; without a one-time getUserMedia the names are blank.
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        for (const t of probe.getTracks()) t.stop();
      } catch {
        /* user may have denied camera; dropdowns will show generic names */
      }
      const devices = await window.openloom.listMediaDevices();
      setCameras(devices.cameras);
      setMics(devices.mics);
      // Drop a stale persisted id that no longer matches a real device, so we
      // never pin getUserMedia to a camera or mic that is gone.
      const savedCam = s.recording.cameraId;
      const savedMic = s.recording.micId;
      setCameraId(devices.cameras.some((c) => c.deviceId === savedCam) ? savedCam : devices.cameras[0]?.deviceId ?? '');
      setMicId(devices.mics.some((m) => m.deviceId === savedMic) ? savedMic : devices.mics[0]?.deviceId ?? '');
    })();
    const offSettings = window.openloomInternal.onSettingsChanged((s) => {
      setSettings(s);
      applyTheme(s.theme);
    });
    return () => {
      clearInterval(timer);
      offSettings();
    };
  }, [refreshSources, push]);

  // Escape dismisses the panel (it comes back via the app or on next launch).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const isScreen = mode === 'screen-cam';
  const source = sources.find((s) => s.id === sourceId);
  const canStart = !starting && !!settings && (isScreen ? !!source : cameras.length > 0);

  const start = async () => {
    if (!settings) return;
    setStarting(true);
    try {
      // Persist device + mode choices for next time.
      await window.openloom.setSettings({
        recording: { ...settings.recording, defaultMode: mode, cameraId, micId },
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
          <div className="source-grid" role="listbox" aria-label="Capture source">
            {loadingSources && sources.length === 0 && <div className="source-loading">Finding screens and windows</div>}
            {sources.map((s) => (
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
                  {s.display ? <Icon.Screen width={13} height={13} /> : <Icon.Library width={13} height={13} />}
                  {s.name}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {!isScreen && (
        <p className="launcher-note">
          Full-face recording: your camera fills the whole video.
        </p>
      )}

      <div className="launcher-foot">
        <button type="button" className="btn-primary launcher-start" disabled={!canStart} onClick={() => void start()}>
          <Icon.Record width={15} height={15} />
          {starting ? 'Starting' : 'Start recording'}
        </button>
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
    </div>
  );
}
