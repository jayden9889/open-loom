/**
 * Main window app shell: translucent sidebar (folders + navigation), view
 * routing (Setup, Library, Watch, Settings), recording status strip, crash
 * recovery banner and toasts. Recordings start from the floating launcher
 * panel (its own window, left edge of the screen).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Folder,
  PermissionsSnapshot,
  RecordingState,
  RecoverableRecording,
  Settings,
  VideoMeta,
} from '@shared/types';
import { Icon } from './components/icons';
import { ToastProvider, useToasts, cleanIpcError, formatDuration } from './components/ui';
import { SetupView } from './views/Setup';
import { LibraryView } from './views/Library';
import { WatchView } from './views/Watch';
import { EditorView } from './views/Editor';
import { SettingsView } from './views/Settings';

export type View =
  | { name: 'library'; folderId: string | null }
  | { name: 'watch'; id: string; fresh?: boolean }
  | { name: 'editor'; id: string }
  | { name: 'settings'; pane?: string }
  | { name: 'setup' };

function applyTheme(theme: Settings['theme']): void {
  const rootEl = document.documentElement;
  if (theme === 'auto') delete rootEl.dataset['theme'];
  else rootEl.dataset['theme'] = theme;
}

function AppInner() {
  const { push } = useToasts();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [permissions, setPermissions] = useState<PermissionsSnapshot | null>(null);
  const [view, setView] = useState<View>({ name: 'library', folderId: null });
  const [videos, setVideos] = useState<VideoMeta[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [recState, setRecState] = useState<RecordingState>({ status: 'idle', elapsedSec: 0 });
  const [recoverables, setRecoverables] = useState<RecoverableRecording[]>([]);
  const [booted, setBooted] = useState(false);

  const reloadLibrary = useCallback(async () => {
    try {
      const [v, f] = await Promise.all([window.openloom.listVideos(), window.openloom.listFolders()]);
      setVideos(v);
      setFolders(f);
    } catch (err) {
      push('error', cleanIpcError(err));
    }
  }, [push]);

  // Boot: settings, permissions, library, recovery, subscriptions.
  useEffect(() => {
    void (async () => {
      try {
        const [s, p, rec] = await Promise.all([
          window.openloom.getSettings(),
          window.openloom.getPermissions(),
          window.openloom.listRecoverable(),
        ]);
        setSettings(s);
        applyTheme(s.theme);
        setPermissions(p);
        setRecoverables(rec);
        const platform = (await window.openloom.appInfo()).platform;
        const needsSetup =
          !s.setupComplete || !p.ffmpeg || (platform === 'darwin' && p.screen !== 'granted');
        if (needsSetup) setView({ name: 'setup' });
        await reloadLibrary();
      } catch (err) {
        push('error', cleanIpcError(err));
      } finally {
        setBooted(true);
      }
    })();
  }, [reloadLibrary, push]);

  useEffect(() => {
    const offState = window.openloom.onRecordingState((s) => {
      setRecState((prev) => {
        if (s.error && s.error !== prev.error) push('error', s.error);
        if (s.lastVideoId && s.lastVideoId !== prev.lastVideoId) {
          void reloadLibrary().then(() => setView({ name: 'watch', id: s.lastVideoId!, fresh: true }));
        }
        return s;
      });
    });
    const offNav = window.openloomInternal.onNavigate((nav) => {
      if (nav.view === 'settings') setView({ name: 'settings' });
      if (nav.view === 'library') setView({ name: 'library', folderId: null });
      if (nav.view === 'new-recording') window.openloom.openLauncher();
    });
    const offSettings = window.openloomInternal.onSettingsChanged((s) => {
      setSettings(s);
      applyTheme(s.theme);
    });
    // Toasts pushed from the main process (e.g. the share-on-stop flow).
    const offToast = window.openloomInternal.onToast((t) => push(t.kind, t.text));
    // Keep the shared/local badge honest as background uploads finish.
    const offJob = window.openloom.onJobProgress((j) => {
      if (j.kind === 'upload' && j.pct >= 100) void reloadLibrary();
    });
    return () => {
      offState();
      offNav();
      offSettings();
      offToast();
      offJob();
    };
  }, [push, reloadLibrary]);

  const folderCounts = useMemo(() => {
    const counts = new Map<string | null, number>();
    for (const v of videos) {
      const key = v.folderId ?? null;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [videos]);

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      try {
        const next = await window.openloom.setSettings(patch);
        setSettings(next);
        applyTheme(next.theme);
        return next;
      } catch (err) {
        push('error', cleanIpcError(err));
        return null;
      }
    },
    [push]
  );

  if (!booted || !settings || !permissions) {
    return <div className="boot" aria-label="Loading" />;
  }

  if (view.name === 'setup') {
    return (
      <SetupView
        onDone={async () => {
          await updateSettings({ setupComplete: true });
          setPermissions(await window.openloom.getPermissions());
          setView({ name: 'library', folderId: null });
          window.openloom.openLauncher();
        }}
      />
    );
  }

  const isRecording = recState.status === 'recording' || recState.status === 'paused';
  const isProcessing = recState.status === 'processing';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-drag" aria-hidden="true" />
        <button
          type="button"
          className="btn-primary sidebar-record"
          onClick={() => window.openloom.openLauncher()}
          disabled={isRecording || isProcessing}
        >
          <Icon.Record width={16} height={16} />
          New recording
        </button>

        <nav className="sidebar-nav" aria-label="Library">
          <button
            type="button"
            className={`side-item${view.name === 'library' && view.folderId === null ? ' selected' : ''}`}
            onClick={() => setView({ name: 'library', folderId: null })}
          >
            <Icon.Library width={16} height={16} />
            <span>Library</span>
            <span className="side-count">{videos.length}</span>
          </button>

          <div className="side-group">
            <span>Folders</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="New folder"
              title="New folder"
              onClick={async () => {
                const name = `New folder ${folders.length + 1}`;
                try {
                  const f = await window.openloom.createFolder(name);
                  await reloadLibrary();
                  setView({ name: 'library', folderId: f.id });
                } catch (err) {
                  push('error', cleanIpcError(err));
                }
              }}
            >
              <Icon.FolderPlus width={15} height={15} />
            </button>
          </div>

          {folders.length === 0 && <p className="side-empty">Group recordings into folders.</p>}
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`side-item${view.name === 'library' && view.folderId === f.id ? ' selected' : ''}`}
              onClick={() => setView({ name: 'library', folderId: f.id })}
            >
              <Icon.Folder width={16} height={16} />
              <span>{f.name}</span>
              <span className="side-count">{folderCounts.get(f.id) ?? 0}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button
            type="button"
            className={`side-item${view.name === 'settings' ? ' selected' : ''}`}
            onClick={() => setView({ name: 'settings' })}
          >
            <Icon.Settings width={16} height={16} />
            <span>Settings</span>
          </button>
        </div>
      </aside>

      <main className="content">
        <div className="content-drag" aria-hidden="true" />

        {(isRecording || isProcessing) && (
          <div className={`rec-strip${isProcessing ? ' processing' : ''}`}>
            {isRecording ? (
              <>
                <span className="rec-strip-dot" />
                {recState.status === 'paused' ? 'Paused' : 'Recording'} · {formatDuration(recState.elapsedSec)}
                <span className="rec-strip-hint">Use the control bar on screen to stop.</span>
              </>
            ) : (
              <>
                <span className="spinner" aria-hidden="true" />
                Processing recording{recState.processingNote ? ` · ${recState.processingNote}` : ''}
              </>
            )}
          </div>
        )}

        {recoverables.length > 0 && view.name === 'library' && (
          <div className="recover-banner">
            <Icon.Warning width={16} height={16} />
            <div className="recover-text">
              <strong>
                {recoverables.length === 1
                  ? 'A recording did not finish saving.'
                  : `${recoverables.length} recordings did not finish saving.`}
              </strong>
              <span>Open Loom kept the captured video. Recover it into your library or discard it.</span>
            </div>
            <div className="recover-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={async () => {
                  for (const r of recoverables) {
                    try {
                      await window.openloom.discardRecoverable(r.tempId);
                    } catch (err) {
                      push('error', cleanIpcError(err));
                    }
                  }
                  setRecoverables(await window.openloom.listRecoverable());
                }}
              >
                Discard
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={async () => {
                  for (const r of recoverables) {
                    try {
                      await window.openloom.recoverRecording(r.tempId);
                      push('success', 'Recording recovered into your library.');
                    } catch (err) {
                      push('error', cleanIpcError(err));
                    }
                  }
                  setRecoverables(await window.openloom.listRecoverable());
                  await reloadLibrary();
                }}
              >
                Recover
              </button>
            </div>
          </div>
        )}

        {view.name === 'library' && (
          <LibraryView
            videos={videos}
            folders={folders}
            folderId={view.folderId}
            onOpen={(id) => setView({ name: 'watch', id })}
            onChanged={reloadLibrary}
            onRecord={() => window.openloom.openLauncher()}
            onOpenSharingSettings={() => setView({ name: 'settings', pane: 'sharing' })}
          />
        )}
        {view.name === 'watch' && (
          <WatchView
            id={view.id}
            freshRecording={view.fresh ?? false}
            folders={folders}
            settings={settings}
            onBack={() => setView({ name: 'library', folderId: null })}
            onEdit={() => setView({ name: 'editor', id: view.id })}
            onChanged={reloadLibrary}
            onDeleted={() => {
              void reloadLibrary();
              setView({ name: 'library', folderId: null });
            }}
            onOpenSharingSettings={() => setView({ name: 'settings', pane: 'sharing' })}
          />
        )}
        {view.name === 'editor' && (
          <EditorView
            id={view.id}
            onBack={() => setView({ name: 'watch', id: view.id })}
            onChanged={reloadLibrary}
          />
        )}
        {view.name === 'settings' && (
          <SettingsView settings={settings} onUpdate={updateSettings} initialPane={view.pane} />
        )}
      </main>
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
