/**
 * New-recording panel (SPEC R1-R4): mode picker, source picker with live
 * thumbnails, camera + mic dropdowns with a live mic level meter, system
 * audio toggle (with an explainer when unsupported), quality + fps, start.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppInfo,
  CaptureSource,
  MediaDeviceInfoLite,
  QualityPreset,
  RecordingMode,
  Settings,
} from '@shared/types';
import { Icon } from '../components/icons';
import { Modal, Segmented, Toggle, useToasts, cleanIpcError } from '../components/ui';

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
        stream = await navigator.mediaDevices.getUserMedia({
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

export function NewRecordingPanel({
  settings,
  onClose,
  onStarted,
}: {
  settings: Settings;
  onClose: () => void;
  onStarted: () => void;
}) {
  const { push } = useToasts();
  const [mode, setMode] = useState<RecordingMode>(settings.recording.defaultMode);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [sourceId, setSourceId] = useState<string>('');
  const [cameras, setCameras] = useState<MediaDeviceInfoLite[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfoLite[]>([]);
  const [cameraId, setCameraId] = useState(settings.recording.cameraId);
  const [micId, setMicId] = useState(settings.recording.micId);
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [systemAudio, setSystemAudio] = useState(settings.recording.systemAudio);
  const [quality, setQuality] = useState<QualityPreset>(settings.recording.quality);
  const [fps, setFps] = useState<30 | 60>(settings.recording.fps);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const [loadingSources, setLoadingSources] = useState(true);
  const pickedManually = useRef(false);

  const refreshSources = useCallback(async () => {
    try {
      const list = await window.openloom.listCaptureSources();
      setSources(list);
      setSourceId((cur) => {
        if (cur && list.some((s) => s.id === cur)) return cur;
        pickedManually.current = false;
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
    })();
    return () => clearInterval(timer);
  }, [refreshSources]);

  const systemAudioSupported = info?.systemAudio ?? false;
  const needsSource = mode !== 'cam';
  const showCamera = mode !== 'screen';
  const source = sources.find((s) => s.id === sourceId);
  const canStart = !starting && (!needsSource || !!source) && (mode !== 'cam' || cameras.length > 0);

  const start = async () => {
    setStarting(true);
    try {
      // Persist device + quality choices for next time.
      await window.openloom.setSettings({
        recording: {
          ...settings.recording,
          quality,
          fps,
          defaultMode: mode,
          cameraId,
          micId,
          systemAudio,
        },
      });
      await window.openloom.startRecording({
        mode,
        sourceId: needsSource ? sourceId : undefined,
        sourceIsDisplay: needsSource ? (source?.display ?? false) : undefined,
        cameraId: cameraId || undefined,
        micId: micId || undefined,
        cameraOn: showCamera ? cameraOn : false,
        micOn,
        systemAudio: systemAudio && systemAudioSupported && needsSource,
        quality,
        fps,
      });
      onStarted();
    } catch (err) {
      push('error', cleanIpcError(err));
      setStarting(false);
    }
  };

  return (
    <Modal title="New recording" onClose={onClose} width={640}>
      <div className="recorder-panel">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            {
              value: 'screen-cam',
              label: (
                <>
                  <Icon.ScreenCam width={15} height={15} /> Screen + Camera
                </>
              ),
            },
            {
              value: 'screen',
              label: (
                <>
                  <Icon.Screen width={15} height={15} /> Screen only
                </>
              ),
            },
            {
              value: 'cam',
              label: (
                <>
                  <Icon.Camera width={15} height={15} /> Camera only
                </>
              ),
            },
          ]}
        />

        {needsSource && (
          <div className="source-picker">
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
                  onClick={() => {
                    pickedManually.current = true;
                    setSourceId(s.id);
                  }}
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

        <div className="recorder-devices">
          {showCamera && (
            <div className="field">
              <label className="field-label" htmlFor="nr-camera">
                Camera
              </label>
              <div className="field-row">
                <Toggle checked={cameraOn} onChange={setCameraOn} label="Camera on" />
                <select
                  id="nr-camera"
                  value={cameraId}
                  disabled={!cameraOn}
                  onChange={(e) => setCameraId(e.target.value)}
                >
                  {cameras.length === 0 && <option value="">No camera found</option>}
                  {cameras.map((c, i) => (
                    <option key={c.deviceId || i} value={c.deviceId}>
                      {c.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="field">
            <label className="field-label" htmlFor="nr-mic">
              Microphone
            </label>
            <div className="field-row">
              <Toggle checked={micOn} onChange={setMicOn} label="Microphone on" />
              <select id="nr-mic" value={micId} disabled={!micOn} onChange={(e) => setMicId(e.target.value)}>
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

          {needsSource && (
            <div className="field">
              <span className="field-label">Computer audio</span>
              <div className="field-row">
                <Toggle
                  checked={systemAudio && systemAudioSupported}
                  onChange={setSystemAudio}
                  disabled={!systemAudioSupported}
                  label="Record computer audio"
                />
                <span className="field-note">
                  {systemAudioSupported
                    ? 'Include the sound your computer plays.'
                    : info?.platform === 'darwin'
                      ? 'Needs macOS 14.2 or later. Your recordings will still capture your microphone.'
                      : 'Not available on this platform yet. Your recordings will still capture your microphone.'}
                </span>
              </div>
            </div>
          )}

          <div className="field-pair">
            <div className="field">
              <label className="field-label" htmlFor="nr-quality">
                Quality
              </label>
              <select id="nr-quality" value={quality} onChange={(e) => setQuality(e.target.value as QualityPreset)}>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="4k">4K</option>
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="nr-fps">
                Frame rate
              </label>
              <select id="nr-fps" value={fps} onChange={(e) => setFps(Number(e.target.value) as 30 | 60)}>
                <option value={30}>30 fps</option>
                <option value={60}>60 fps</option>
              </select>
            </div>
          </div>
        </div>

        <div className="recorder-foot">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!canStart} onClick={() => void start()}>
            <Icon.Record width={15} height={15} />
            {starting ? 'Starting' : 'Start recording'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
