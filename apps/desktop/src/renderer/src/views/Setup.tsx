/**
 * First-run Setup (SPEC R13): Screen Recording, Camera, Microphone and ffmpeg
 * checks, each with a status pill and a working Fix button. The ffmpeg fix
 * downloads a static build with a live log.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppInfo, PermissionsSnapshot } from '@shared/types';
import { Icon } from '../components/icons';
import { useToasts, cleanIpcError } from '../components/ui';

type PillState = 'ok' | 'missing' | 'pending';

function Pill({ state, okText, missingText }: { state: PillState; okText: string; missingText: string }) {
  return (
    <span className={`pill pill-${state}`}>
      {state === 'ok' ? okText : state === 'pending' ? 'Checking' : missingText}
    </span>
  );
}

interface RowProps {
  title: string;
  detail: string;
  state: PillState;
  okText?: string;
  missingText?: string;
  fixLabel?: string;
  onFix?: () => void;
  fixing?: boolean;
}

function CheckRow(props: RowProps) {
  return (
    <div className="setup-row">
      <div className="setup-row-text">
        <h3>{props.title}</h3>
        <p>{props.detail}</p>
      </div>
      <div className="setup-row-actions">
        <Pill state={props.state} okText={props.okText ?? 'Ready'} missingText={props.missingText ?? 'Needs attention'} />
        {props.state !== 'ok' && props.onFix && (
          <button type="button" className="btn-secondary" onClick={props.onFix} disabled={props.fixing}>
            {props.fixing ? 'Working' : (props.fixLabel ?? 'Fix')}
          </button>
        )}
      </div>
    </div>
  );
}

export function SetupView({ onDone }: { onDone: () => void }) {
  const { push } = useToasts();
  const [perms, setPerms] = useState<PermissionsSnapshot | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [fetchingFfmpeg, setFetchingFfmpeg] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async () => {
    setPerms(await window.openloom.getPermissions());
  }, []);

  useEffect(() => {
    void refresh();
    void window.openloom.appInfo().then(setInfo);
    // Permission grants happen in System Settings; poll while this view is open.
    const timer = setInterval(() => void refresh(), 2000);
    const offLog = window.openloom.onSetupLog((line) =>
      setLogLines((l) => [...l.slice(-400), line])
    );
    return () => {
      clearInterval(timer);
      offLog();
    };
  }, [refresh]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logLines]);

  const isMac = info?.platform === 'darwin';

  const fixMedia = async (kind: 'camera' | 'mic') => {
    try {
      await window.openloom.requestPermission(kind);
      // If already denied (not just undetermined) the prompt will not show; open the pane.
      const next = await window.openloom.getPermissions();
      setPerms(next);
      const still = kind === 'camera' ? next.camera : next.mic;
      if (still !== 'granted') window.openloom.openSystemSettings(kind);
    } catch (err) {
      push('error', cleanIpcError(err));
    }
  };

  const fixFfmpeg = async () => {
    setFetchingFfmpeg(true);
    setLogLines(['Downloading a static ffmpeg build for this machine...']);
    try {
      await window.openloom.fetchFfmpeg();
      push('success', 'ffmpeg installed.');
    } catch (err) {
      push('error', cleanIpcError(err));
    } finally {
      setFetchingFfmpeg(false);
      void refresh();
    }
  };

  const screenState: PillState = !perms ? 'pending' : !isMac || perms.screen === 'granted' ? 'ok' : 'missing';
  const camState: PillState = !perms ? 'pending' : !isMac || perms.camera === 'granted' ? 'ok' : 'missing';
  const micState: PillState = !perms ? 'pending' : !isMac || perms.mic === 'granted' ? 'ok' : 'missing';
  const ffmpegState: PillState = !perms ? 'pending' : perms.ffmpeg ? 'ok' : 'missing';

  const screenReady = screenState === 'ok';
  const ffmpegReady = ffmpegState === 'ok';
  const canContinue = screenReady && ffmpegReady;

  return (
    <div className="setup">
      <div className="setup-drag" aria-hidden="true" />
      <div className="setup-card">
        <div className="setup-brand">
          <svg width="44" height="44" viewBox="0 0 1024 1024" aria-hidden="true">
            <rect x="24" y="64" width="976" height="896" rx="220" fill="#635BFF" />
            <path d="M 692.5 331.5 A 255 255 0 1 0 763 512" stroke="#FFFFFF" strokeWidth="86" strokeLinecap="round" fill="none" />
            <circle cx="734" cy="368" r="62" fill="#FFFFFF" />
          </svg>
          <div>
            <h1>Welcome to Open Loom</h1>
            <p>A couple of one-time checks before your first recording.</p>
          </div>
        </div>

        <div className="setup-rows">
          <CheckRow
            title="Screen Recording"
            detail={
              isMac
                ? 'macOS requires an explicit grant before any app can capture the screen. After granting, restart Open Loom if recording still looks black.'
                : 'Your platform grants screen capture at recording time.'
            }
            state={screenState}
            missingText={perms?.screen === 'denied' ? 'Denied' : 'Not granted'}
            fixLabel="Open System Settings"
            onFix={() => window.openloom.openSystemSettings('screen')}
          />
          <CheckRow
            title="Camera"
            detail="Used for the webcam bubble and camera-only recordings. You can record without it."
            state={camState}
            missingText={perms?.camera === 'denied' ? 'Denied' : 'Not granted'}
            onFix={() => void fixMedia('camera')}
          />
          <CheckRow
            title="Microphone"
            detail="Narration for your recordings. You can record without it."
            state={micState}
            missingText={perms?.mic === 'denied' ? 'Denied' : 'Not granted'}
            onFix={() => void fixMedia('mic')}
          />
          <CheckRow
            title="ffmpeg"
            detail="Turns raw captures into seekable MP4s, thumbnails and previews. Open Loom can download a static build for you, or use one already on your PATH."
            state={ffmpegState}
            missingText="Not found"
            fixLabel="Download ffmpeg"
            onFix={() => void fixFfmpeg()}
            fixing={fetchingFfmpeg}
          />
        </div>

        {(fetchingFfmpeg || logLines.length > 1) && (
          <pre className="setup-log" ref={logRef} aria-label="Install log">
            {logLines.join('\n')}
          </pre>
        )}

        <div className="setup-foot">
          <span className="setup-foot-note">
            {canContinue
              ? 'All set.'
              : !screenReady
                ? 'Screen Recording is required to record your screen.'
                : 'ffmpeg is required to save recordings.'}
          </span>
          <button type="button" className="btn-primary" disabled={!canContinue} onClick={onDone}>
            <Icon.Check width={15} height={15} />
            Start using Open Loom
          </button>
        </div>
      </div>
    </div>
  );
}
