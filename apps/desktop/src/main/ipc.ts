/**
 * Registers every `ol:*` invoke handler behind the preload bridge
 * (SPEC section 5).
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import type { RecordingOptions, Settings, VideoMeta } from '@shared/types';
import { listCaptureSources } from './capture';
import { library, revealVideo, fileUrl, setCustomThumbnail, regeneratePreviews } from './library';
import * as recorder from './recorder-ipc';
import {
  getPermissions,
  requestPermission,
  openSystemSettings,
  resetScreenPermission,
  systemAudioSupported,
} from './permissions';
import { cameraEffectsStatus, openCameraEffectsPanel } from './camera-effects';
import { getSettingsMasked, setSettings, getSettings } from './settings';
import { fetchFfmpeg, cancelJob } from './ffmpeg';
import { validateShortcuts } from './shortcuts';
import { broadcast, getMainWindow, showLauncher } from './windows';
import {
  trimVideo,
  stitchVideos,
  revertEdits,
  confirmEdits,
  detectSilences,
  beginContinuation,
  cancelContinuation,
  dismissContinuation,
  claimContinuationTake,
} from './editor-jobs';
import { transcribeVideo, installWhisper } from './transcribe';
import { generateAI, testAI } from './ai';
import {
  shareVideo,
  unshareVideo,
  removeRemoteShare,
  syncShareMetadata,
  syncShareThumbnail,
  updateShareSettings,
  getShareActivity,
  testShareProvider,
  deleteShareComment,
} from './share';
import {
  youtubeStatus,
  youtubeConnect,
  youtubeDisconnect,
  youtubePublish,
  youtubeCancelPublish,
  youtubeUnpublish,
  youtubeOpenStudioEdit,
} from './youtube';
import { log } from './logger';

/**
 * Filesystem paths the user picked in a native dialog this session.
 *
 * Settings that name an executable (ffmpeg, whisper) are spawned by the main
 * process, so accepting one straight off the settings patch would turn any
 * renderer-side script execution into arbitrary code execution. The renderer
 * cannot fabricate an entry here: only the OS file picker adds to it.
 */
const dialogPicked = new Set<string>();

/** Settings fields whose value is later handed to child_process. */
const EXECUTABLE_SETTINGS: { get(s: Settings): string; label: string }[] = [
  { get: (s) => s.ffmpegPath, label: 'ffmpeg' },
  { get: (s) => s.transcription.whisperPath, label: 'whisper' },
];

/**
 * A patch may point an executable setting at a new path only if that path came
 * from the file picker. Clearing it (empty = resolve from PATH + app bin dir)
 * is always allowed.
 */
function assertExecutablePathsPicked(patch: Partial<Settings>, current: Settings): void {
  const merged = { ...current, ...patch, transcription: { ...current.transcription, ...patch.transcription } };
  for (const field of EXECUTABLE_SETTINGS) {
    const next = field.get(merged);
    if (!next || next === field.get(current)) continue;
    if (!dialogPicked.has(path.resolve(next))) {
      throw new Error(`Choose the ${field.label} binary with the Browse button so it can be verified.`);
    }
  }
}

function handle(channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (err) {
      log.warn(`${channel} failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  });
}

/**
 * Tombstones for shared videos the user force-deleted locally while the remote
 * copy could not be removed (share host unreachable). Without a record, the
 * public link outlived every UI that could revoke it. Retried on each launch;
 * entries that still fail are kept for the next one.
 */
interface PendingUnshare {
  id: string;
  provider: 'server' | 's3';
  url: string;
}

function pendingUnsharePath(): string {
  return path.join(library().root, 'pending-unshare.json');
}

function readPendingUnshares(): PendingUnshare[] {
  try {
    return JSON.parse(fs.readFileSync(pendingUnsharePath(), 'utf8')) as PendingUnshare[];
  } catch {
    return [];
  }
}

function writePendingUnshares(entries: PendingUnshare[]): void {
  if (entries.length === 0) {
    fs.rmSync(pendingUnsharePath(), { force: true });
    return;
  }
  fs.writeFileSync(pendingUnsharePath(), JSON.stringify(entries, null, 2));
}

async function retryPendingUnshares(): Promise<void> {
  const entries = readPendingUnshares();
  if (entries.length === 0) return;
  const remaining: PendingUnshare[] = [];
  for (const entry of entries) {
    try {
      await removeRemoteShare(entry.id, entry.provider, entry.url);
      log.info(`removed the orphaned shared copy of ${entry.id} (${entry.url})`);
    } catch (err) {
      log.warn(`orphaned shared copy of ${entry.id} still could not be removed: ${String(err)}`);
      remaining.push(entry);
    }
  }
  writePendingUnshares(remaining);
}

export function registerIpc(): void {
  // -- capture ---------------------------------------------------------------
  ipcMain.on('ol:openLauncher', () => {
    if (!recorder.isRecordingActive()) showLauncher();
  });
  handle('ol:listCaptureSources', () => listCaptureSources());
  handle('ol:startRecording', (_e, opts: RecordingOptions) => recorder.startRecording(opts));
  handle('ol:pauseRecording', () => recorder.pauseRecording());
  handle('ol:resumeRecording', () => recorder.resumeRecording());
  handle('ol:stopRecording', () => recorder.stopRecording());
  // Both run through the confirm gate: a long take gets one chance to say no.
  handle('ol:cancelRecording', () => recorder.requestCancelRecording());
  handle('ol:restartRecording', () => recorder.requestRestartRecording());
  handle('ol:getRecordingState', () => recorder.currentState());
  ipcMain.on('ol:toggleCamera', (_e, on: boolean) => recorder.toggleCamera(on));
  ipcMain.on('ol:setCameraLayout', (_e, layout: unknown) => {
    if (layout === 'bubble' || layout === 'full' || layout === 'off') recorder.setCameraLayout(layout);
  });
  ipcMain.on('ol:toggleMic', (_e, on: boolean) => recorder.toggleMic(on));
  ipcMain.on('ol:toggleDraw', (_e, on: boolean) => recorder.toggleDraw(on));
  ipcMain.on('ol:setDrawColor', (_e, color: string) => recorder.setDrawColor(color));
  ipcMain.on('ol:clearDraw', () => recorder.clearDraw());
  ipcMain.on('ol:setBubbleSize', (_e, size: 'S' | 'M' | 'L') => {
    setSettings({ bubble: { size } } as Partial<Settings>);
    recorder.setBubbleSize(size);
  });
  ipcMain.on('ol:setBubbleMirror', (_e, mirror: boolean) => {
    const next = setSettings({ bubble: { mirror } } as Partial<Settings>);
    recorder.setBubbleSize(next.bubble.size);
  });

  // -- library ---------------------------------------------------------------
  handle('ol:listVideos', () => library().list());
  handle('ol:getVideo', (_e, id: string) => library().get(id));
  handle('ol:updateVideo', (_e, id: string, patch) => {
    const updated = library().update(id, patch);
    // A rename (or description/chapter edit) must reach the client's hosted
    // page, or the app and the share tell two different stories. Best-effort
    // background push; syncShareMetadata no-ops for unshared videos.
    const p = (patch ?? {}) as Partial<VideoMeta>;
    if ('title' in p || 'description' in p || 'ai' in p) void syncShareMetadata(id);
    return updated;
  });
  handle('ol:deleteVideo', async (_e, id: string, opts?: { force?: boolean }) => {
    // The delete confirmation promises the shared copy goes too. Local-only
    // deletion left the public link live forever with no UI left to revoke it,
    // because the recording it hung off no longer existed. So a remote that
    // cannot be reached fails the whole delete, loudly - unless the user
    // explicitly chose to delete anyway, in which case the orphaned link is
    // tombstoned and retried on later launches.
    const meta = library().get(id);
    if (meta.share) {
      try {
        await unshareVideo(id);
      } catch (err) {
        if (!opts?.force) {
          throw new Error(
            'The shared copy could not be removed, so the video was not deleted - its public link would have stayed live with no way to revoke it. Check the share host and try again.'
          );
        }
        log.warn(`could not remove the shared copy of ${id}; tombstoning it: ${String(err)}`);
        writePendingUnshares([
          ...readPendingUnshares(),
          { id, provider: meta.share.provider, url: meta.share.url },
        ]);
      }
    }
    await library().delete(id);
  });
  handle('ol:duplicateVideo', (_e, id: string) => library().duplicate(id));
  ipcMain.on('ol:revealVideo', (_e, id: string) => revealVideo(id));
  handle('ol:listFolders', () => library().listFolders());
  handle('ol:createFolder', (_e, name: string) => library().createFolder(name));
  handle('ol:renameFolder', (_e, id: string, name: string) => library().renameFolder(id, name));
  handle('ol:deleteFolder', (_e, id: string) => library().deleteFolder(id));
  handle('ol:moveVideo', (_e, id: string, folderId: string | null) => {
    library().moveVideo(id, folderId);
  });
  handle('ol:searchVideos', (_e, q: string) => library().search(q));
  handle('ol:setCustomThumbnail', async (_e, id: string, source) => {
    await setCustomThumbnail(id, source);
    // The hosted page shows the old auto-grabbed frame until the new one is
    // pushed; best-effort, no-op for unshared videos.
    void syncShareThumbnail(id);
  });
  handle('ol:regeneratePreviews', (_e, id: string) => regeneratePreviews(id));

  // -- editor ------------------------------------------------------------------
  handle('ol:trimVideo', (_e, id: string, ranges: { start: number; end: number }[]) => trimVideo(id, ranges));
  handle('ol:stitchVideos', (_e, id: string, appendId: string, appendRange?: { start: number; end: number }) =>
    stitchVideos(id, appendId, appendRange)
  );
  handle('ol:revertEdits', (_e, id: string) => revertEdits(id));
  handle('ol:confirmEdits', (_e, id: string) => confirmEdits(id));
  handle('ol:detectSilences', (_e, id: string) => detectSilences(id));
  handle('ol:cancelEditJob', (_e, id: string) => cancelJob(id));
  handle('ol:beginContinuation', (_e, id: string) => beginContinuation(id));
  handle('ol:cancelContinuation', () => cancelContinuation());
  handle('ol:dismissContinuation', (_e, id: string) => dismissContinuation(id));
  handle('ol:claimContinuationTake', (_e, takeId: string) => claimContinuationTake(takeId));

  // -- transcription + AI --------------------------------------------------------
  handle('ol:transcribeVideo', (_e, id: string) => transcribeVideo(id));
  handle('ol:generateAI', async (_e, id: string, kinds: string[]) => {
    await generateAI(id, kinds);
    // Chapters normally land AFTER auto-share on stop, so the hosted page
    // would otherwise never gain them (captions already sync this way).
    void syncShareMetadata(id);
  });
  handle('ol:testAI', () => testAI());
  handle('ol:installWhisper', () => installWhisper((line) => broadcast('ol:setup-log', line)));

  // -- sharing -----------------------------------------------------------------
  handle('ol:shareVideo', (_e, id: string) => shareVideo(id));
  handle('ol:unshareVideo', (_e, id: string) => unshareVideo(id));
  handle('ol:updateShareSettings', (_e, id: string, patch: Partial<VideoMeta['share']>) =>
    updateShareSettings(id, patch ?? {})
  );
  handle('ol:getShareActivity', (_e, id: string) => getShareActivity(id));
  handle('ol:testShareProvider', (_e, cfg: unknown) => testShareProvider(cfg));
  handle('ol:deleteShareComment', (_e, id: string, commentId: string) => deleteShareComment(id, commentId));

  // -- publish to YouTube (Data API upload, unlisted) --------------------------
  handle('ol:youtubeStatus', () => youtubeStatus());
  handle('ol:youtubeConnect', () => youtubeConnect());
  handle('ol:youtubeDisconnect', () => youtubeDisconnect());
  handle('ol:youtubePublish', (_e, id: string) => youtubePublish(id));
  handle('ol:youtubeCancelPublish', (_e, id: string) => youtubeCancelPublish(id));
  handle('ol:youtubeUnpublish', (_e, id: string) => youtubeUnpublish(id));
  ipcMain.on('ol:youtubeOpenStudioEdit', (_e, id: string) => youtubeOpenStudioEdit(id));

  // -- settings & system -------------------------------------------------------
  handle('ol:getSettings', () => getSettingsMasked());
  handle('ol:setSettings', (_e, patch: Partial<Settings>) => {
    const current = getSettings();
    if (patch.shortcuts) {
      const merged = { ...current.shortcuts, ...patch.shortcuts };
      const problem = validateShortcuts(merged);
      if (problem) throw new Error(problem);
    }
    assertExecutablePathsPicked(patch, current);
    // Same consent rule as the executables: saveDir is the root the
    // openloom-file:// protocol serves from, so a renderer-fabricated value
    // would widen what a compromised renderer can read. Only a directory the
    // user picked in the native dialog this session may become the new root.
    if (patch.saveDir && patch.saveDir !== current.saveDir && !dialogPicked.has(path.resolve(patch.saveDir))) {
      throw new Error('Choose the save folder with the Change button so it can be verified.');
    }
    setSettings(patch);
    const masked = getSettingsMasked();
    broadcast('ol:settings-changed', masked);
    return masked;
  });
  handle('ol:pickDirectory', async () => {
    const win = getMainWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    const picked = result.filePaths[0] ?? null;
    // Records the user's consent to this exact directory; the saveDir guard in
    // ol:setSettings reads it.
    if (picked) dialogPicked.add(path.resolve(picked));
    return picked;
  });
  handle('ol:pickFile', async (_e, filter: string) => {
    const filters =
      filter === 'image'
        ? [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }]
        : filter === 'video'
          ? [{ name: 'Videos', extensions: ['mp4', 'webm', 'mov'] }]
          : [{ name: 'All files', extensions: ['*'] }];
    const win = getMainWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters })
      : await dialog.showOpenDialog({ properties: ['openFile'], filters });
    if (result.canceled) return null;
    const picked = result.filePaths[0] ?? null;
    // Records the user's consent to this exact path; assertExecutablePathsPicked
    // and setCustomThumbnail both read it.
    if (picked) dialogPicked.add(path.resolve(picked));
    return picked;
  });
  handle('ol:getPermissions', () => getPermissions());
  handle('ol:requestPermission', (_e, kind: string) => requestPermission(kind));
  handle('ol:resetScreenPermission', () => resetScreenPermission());
  ipcMain.on('ol:openSystemSettings', (_e, pane: string) => openSystemSettings(pane));
  handle('ol:cameraEffects', () => cameraEffectsStatus());
  ipcMain.on('ol:openCameraEffects', () => openCameraEffectsPanel());
  handle('ol:fetchFfmpeg', () => fetchFfmpeg((line) => broadcast('ol:setup-log', line)));
  ipcMain.on('ol:copyToClipboard', (_e, text: string) => clipboard.writeText(text));
  ipcMain.on('ol:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  handle('ol:appInfo', () => ({
    version: app.getVersion(),
    platform: process.platform,
    osVersion: process.getSystemVersion?.() ?? '',
    systemAudio: systemAudioSupported(),
  }));
  handle('ol:fileUrl', (_e, id: string, file: string) => fileUrl(id, file));

  // -- crash recovery -----------------------------------------------------------
  handle('ol:listRecoverable', () => recorder.listRecoverable());
  handle('ol:recoverRecording', (_e, tempId: string) => recorder.recoverRecording(tempId));
  handle('ol:discardRecoverable', (_e, tempId: string) => recorder.discardRecoverable(tempId));

  // Orphaned share links from earlier force-deletes: retry removal in the
  // background once per launch (registerIpc runs at startup).
  void retryPendingUnshares();
}
