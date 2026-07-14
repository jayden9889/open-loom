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
      clearInterval(timer);
      offSettings();
    };
  }, [refreshSources, push]);

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
          {/* Everything below the heading shares ONE scroll region, so the
              source list can never bleed under the footer. */}
          <div className="launcher-sources-scroll">
            {loadingSources && sources.length === 0 && <div className="source-loading">Finding screens and windows</div>}

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
