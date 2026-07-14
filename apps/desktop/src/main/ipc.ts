/**
 * Registers every `ol:*` invoke handler behind the preload bridge
 * (SPEC section 5).
 */
import { app, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import type { RecordingOptions, Settings, VideoMeta } from '@shared/types';
import { listCaptureSources } from './capture';
import { library, revealVideo, fileUrl, setCustomThumbnail } from './library';
import * as recorder from './recorder-ipc';
import { getPermissions, requestPermission, openSystemSettings, systemAudioSupported } from './permissions';
import { cameraEffectsStatus, openCameraEffectsPanel } from './camera-effects';
import { getSettingsMasked, setSettings, getSettings } from './settings';
import { fetchFfmpeg } from './ffmpeg';
import { validateShortcuts } from './shortcuts';
import { broadcast, getMainWindow, showLauncher } from './windows';
import { trimVideo, stitchVideos, revertEdits, confirmEdits } from './editor-jobs';
import { transcribeVideo, installWhisper } from './transcribe';
import { generateAI, testAI } from './ai';
import {
  shareVideo,
  unshareVideo,
  updateShareSettings,
  getShareActivity,
  testShareProvider,
  deleteShareComment,
} from './share';
import { youtubePublishStart, youtubeReadClipboardLink, youtubeSaveLink } from './youtube';
import { log } from './logger';

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
  handle('ol:cancelRecording', () => recorder.cancelRecording());
  handle('ol:restartRecording', () => recorder.restartRecording());
  handle('ol:getRecordingState', () => recorder.currentState());
  ipcMain.on('ol:toggleCamera', (_e, on: boolean) => recorder.toggleCamera(on));
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
  handle('ol:updateVideo', (_e, id: string, patch) => library().update(id, patch));
  handle('ol:deleteVideo', (_e, id: string) => library().delete(id));
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
  handle('ol:setCustomThumbnail', (_e, id: string, source) => setCustomThumbnail(id, source));

  // -- editor ------------------------------------------------------------------
  handle('ol:trimVideo', (_e, id: string, ranges: { start: number; end: number }[]) => trimVideo(id, ranges));
  handle('ol:stitchVideos', (_e, id: string, appendId: string) => stitchVideos(id, appendId));
  handle('ol:revertEdits', (_e, id: string) => revertEdits(id));
  handle('ol:confirmEdits', (_e, id: string) => confirmEdits(id));

  // -- transcription + AI --------------------------------------------------------
  handle('ol:transcribeVideo', (_e, id: string) => transcribeVideo(id));
  handle('ol:generateAI', (_e, id: string, kinds: string[]) => generateAI(id, kinds));
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

  // -- publish to YouTube (guided manual, unlisted) ----------------------------
  handle('ol:youtubePublishStart', (_e, id: string) => youtubePublishStart(id));
  handle('ol:youtubeSaveLink', (_e, id: string, url: string) => youtubeSaveLink(id, url));
  handle('ol:youtubeReadClipboardLink', () => youtubeReadClipboardLink());

  // -- settings & system -------------------------------------------------------
  handle('ol:getSettings', () => getSettingsMasked());
  handle('ol:setSettings', (_e, patch: Partial<Settings>) => {
    if (patch.shortcuts) {
      const merged = { ...getSettings().shortcuts, ...patch.shortcuts };
      const problem = validateShortcuts(merged);
      if (problem) throw new Error(problem);
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
    return result.canceled ? null : (result.filePaths[0] ?? null);
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
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle('ol:getPermissions', () => getPermissions());
  handle('ol:requestPermission', (_e, kind: string) => requestPermission(kind));
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
}
