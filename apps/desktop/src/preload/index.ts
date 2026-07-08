/**
 * Typed preload bridge (SPEC section 5). Exposes:
 *  - window.openloom          the public OpenLoomAPI used by app views
 *  - window.openloomInternal  channels for the HUD/bubble/countdown/draw/engine windows
 * Sandboxed + context-isolated; nothing but these two objects reaches the page.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  BubbleSize,
  CameraLayout,
  EngineBeginPayload,
  JobProgress,
  OpenLoomAPI,
  OpenLoomInternal,
  RecordingOptions,
  RecordingState,
  Settings,
  VideoMeta,
} from '@shared/types';

function subscribe<T>(channel: string): (cb: (payload: T) => void) => () => void {
  return (cb) => {
    const listener = (_event: unknown, payload: T) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

const api: OpenLoomAPI = {
  // capture
  listCaptureSources: () => ipcRenderer.invoke('ol:listCaptureSources'),
  listMediaDevices: async () => {
    // Devices are enumerated in the renderer (needs a secure context + labels
    // after permission); preload just wraps the web API for a stable surface.
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      cameras: devices.filter((d) => d.kind === 'videoinput'),
      mics: devices.filter((d) => d.kind === 'audioinput'),
    };
  },
  startRecording: (opts: RecordingOptions) => ipcRenderer.invoke('ol:startRecording', opts),
  pauseRecording: () => ipcRenderer.invoke('ol:pauseRecording'),
  resumeRecording: () => ipcRenderer.invoke('ol:resumeRecording'),
  stopRecording: () => ipcRenderer.invoke('ol:stopRecording'),
  cancelRecording: () => ipcRenderer.invoke('ol:cancelRecording'),
  restartRecording: () => ipcRenderer.invoke('ol:restartRecording'),
  onRecordingState: subscribe<RecordingState>('ol:recording-state'),
  toggleCamera: (on: boolean) => ipcRenderer.send('ol:toggleCamera', on),
  toggleMic: (on: boolean) => ipcRenderer.send('ol:toggleMic', on),
  toggleDraw: (on: boolean) => ipcRenderer.send('ol:toggleDraw', on),
  setBubbleSize: (s: BubbleSize) => ipcRenderer.send('ol:setBubbleSize', s),
  setLayout: (layout: CameraLayout) => ipcRenderer.send('ol:setLayout', layout),

  // library
  listVideos: () => ipcRenderer.invoke('ol:listVideos'),
  getVideo: (id: string) => ipcRenderer.invoke('ol:getVideo', id),
  updateVideo: (id: string, patch: Partial<VideoMeta>) => ipcRenderer.invoke('ol:updateVideo', id, patch),
  deleteVideo: (id: string) => ipcRenderer.invoke('ol:deleteVideo', id),
  duplicateVideo: (id: string) => ipcRenderer.invoke('ol:duplicateVideo', id),
  revealVideo: (id: string) => ipcRenderer.send('ol:revealVideo', id),
  fileUrl: (id: string, file: string) =>
    `openloom-file://${encodeURIComponent(id)}/${encodeURIComponent(file)}`,
  listFolders: () => ipcRenderer.invoke('ol:listFolders'),
  createFolder: (name: string) => ipcRenderer.invoke('ol:createFolder', name),
  renameFolder: (id: string, name: string) => ipcRenderer.invoke('ol:renameFolder', id, name),
  deleteFolder: (id: string) => ipcRenderer.invoke('ol:deleteFolder', id),
  moveVideo: (id: string, folderId: string | null) => ipcRenderer.invoke('ol:moveVideo', id, folderId),
  searchVideos: (q: string) => ipcRenderer.invoke('ol:searchVideos', q),
  setCustomThumbnail: (id: string, source: { path?: string; atSec?: number }) =>
    ipcRenderer.invoke('ol:setCustomThumbnail', id, source),

  // editor
  trimVideo: (id: string, ranges: { start: number; end: number }[]) =>
    ipcRenderer.invoke('ol:trimVideo', id, ranges),
  stitchVideos: (id: string, appendId: string) => ipcRenderer.invoke('ol:stitchVideos', id, appendId),
  onJobProgress: subscribe<JobProgress>('ol:job-progress'),

  // transcribe + AI
  transcribeVideo: (id: string) => ipcRenderer.invoke('ol:transcribeVideo', id),
  generateAI: (id: string, kinds: string[]) => ipcRenderer.invoke('ol:generateAI', id, kinds),
  testAI: () => ipcRenderer.invoke('ol:testAI'),

  // share
  shareVideo: (id: string) => ipcRenderer.invoke('ol:shareVideo', id),
  unshareVideo: (id: string) => ipcRenderer.invoke('ol:unshareVideo', id),
  updateShareSettings: (id: string, patch: Partial<VideoMeta['share']>) =>
    ipcRenderer.invoke('ol:updateShareSettings', id, patch),
  getShareActivity: (id: string) => ipcRenderer.invoke('ol:getShareActivity', id),
  testShareProvider: (cfg: unknown) => ipcRenderer.invoke('ol:testShareProvider', cfg),
  deleteShareComment: (videoId: string, commentId: string) =>
    ipcRenderer.invoke('ol:deleteShareComment', videoId, commentId),

  // publish to YouTube (guided manual, unlisted)
  youtubePublishStart: (videoId: string) => ipcRenderer.invoke('ol:youtubePublishStart', videoId),
  youtubeSaveLink: (videoId: string, url: string) => ipcRenderer.invoke('ol:youtubeSaveLink', videoId, url),

  // settings & system
  getSettings: () => ipcRenderer.invoke('ol:getSettings'),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('ol:setSettings', patch),
  pickDirectory: () => ipcRenderer.invoke('ol:pickDirectory'),
  pickFile: (filter: string) => ipcRenderer.invoke('ol:pickFile', filter),
  getPermissions: () => ipcRenderer.invoke('ol:getPermissions'),
  requestPermission: (kind: string) => ipcRenderer.invoke('ol:requestPermission', kind),
  openSystemSettings: (pane: string) => ipcRenderer.send('ol:openSystemSettings', pane),
  installWhisper: () => ipcRenderer.invoke('ol:installWhisper'),
  onSetupLog: subscribe<string>('ol:setup-log'),
  fetchFfmpeg: () => ipcRenderer.invoke('ol:fetchFfmpeg'),
  copyToClipboard: (text: string) => ipcRenderer.send('ol:copyToClipboard', text),
  openExternal: (url: string) => ipcRenderer.send('ol:openExternal', url),
  appInfo: () => ipcRenderer.invoke('ol:appInfo'),

  // crash recovery
  listRecoverable: () => ipcRenderer.invoke('ol:listRecoverable'),
  recoverRecording: (tempId: string) => ipcRenderer.invoke('ol:recoverRecording', tempId),
  discardRecoverable: (tempId: string) => ipcRenderer.invoke('ol:discardRecoverable', tempId),

  // editor original handling
  revertEdits: (id: string) => ipcRenderer.invoke('ol:revertEdits', id),
  confirmEdits: (id: string) => ipcRenderer.invoke('ol:confirmEdits', id),
};

function subscribeVoid(channel: string): (cb: () => void) => () => void {
  return (cb) => {
    const listener = () => cb();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

const internal: OpenLoomInternal = {
  getRecordingState: () => ipcRenderer.invoke('ol:getRecordingState'),
  getSettings: () => ipcRenderer.invoke('ol:getSettings'),
  setBubbleMirror: (mirror: boolean) => ipcRenderer.send('ol:setBubbleMirror', mirror),
  onSettingsChanged: subscribe<Settings>('ol:settings-changed'),
  onNavigate: subscribe<{ view: string; mode?: string }>('ol:navigate'),
  onToast: subscribe<{ kind: 'info' | 'success' | 'error'; text: string }>('ol:toast'),

  engineReady: () => ipcRenderer.send('engine:ready'),
  engineStarted: (mimeType: string) => ipcRenderer.send('engine:started', { mimeType }),
  engineStopped: () => ipcRenderer.send('engine:stopped'),
  engineError: (message: string) => ipcRenderer.send('engine:error', message),
  sendChunk: (chunk: Uint8Array) => ipcRenderer.send('engine:chunk', chunk),
  onEngineBegin: subscribe<EngineBeginPayload>('engine:begin'),
  onEngineStop: subscribeVoid('engine:stop'),
  onEnginePause: subscribeVoid('engine:pause'),
  onEngineResume: subscribeVoid('engine:resume'),
  onEngineCancel: subscribeVoid('engine:cancel'),
  onEngineSetCamera: subscribe<boolean>('engine:set-camera'),
  onEngineSetLayout: subscribe<CameraLayout>('engine:set-layout'),
  onEngineSetMic: subscribe<boolean>('engine:set-mic'),
  onEngineSetBubble: subscribe<{ size: BubbleSize; mirror: boolean }>('engine:set-bubble'),
  onBubbleLayout: subscribe<CameraLayout>('bubble:set-layout'),

  countdownDone: () => ipcRenderer.send('countdown:done'),
  countdownCancel: () => ipcRenderer.send('countdown:cancel'),

  onDrawEnable: subscribe<boolean>('draw:enable'),
  onDrawRipple: subscribe<{ x: number; y: number }>('draw:ripple'),
};

contextBridge.exposeInMainWorld('openloom', api);
contextBridge.exposeInMainWorld('openloomInternal', internal);
