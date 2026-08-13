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
  openLauncher: () => ipcRenderer.send('ol:openLauncher'),
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
  redoLastTen: () => ipcRenderer.send('ol:redoLastTen'),
  cancelPendingRedo: () => ipcRenderer.send('ol:cancelPendingRedo'),
  resolveRecordingConfirm: (confirmed: boolean) =>
    ipcRenderer.send('ol:resolveRecordingConfirm', confirmed),
  onRecordingState: subscribe<RecordingState>('ol:recording-state'),
  toggleCamera: (on: boolean) => ipcRenderer.send('ol:toggleCamera', on),
  toggleMic: (on: boolean) => ipcRenderer.send('ol:toggleMic', on),
  toggleDraw: (on: boolean) => ipcRenderer.send('ol:toggleDraw', on),
  toggleNotes: () => ipcRenderer.send('ol:toggleNotes'),
  setDrawColor: (color: string) => ipcRenderer.send('ol:setDrawColor', color),
  clearDraw: () => ipcRenderer.send('ol:clearDraw'),
  setBubbleSize: (s: BubbleSize) => ipcRenderer.send('ol:setBubbleSize', s),
  setCameraLayout: (layout: CameraLayout) => ipcRenderer.send('ol:setCameraLayout', layout),

  // library
  listVideos: () => ipcRenderer.invoke('ol:listVideos'),
  getVideo: (id: string) => ipcRenderer.invoke('ol:getVideo', id),
  updateVideo: (id: string, patch: Partial<VideoMeta>) => ipcRenderer.invoke('ol:updateVideo', id, patch),
  deleteVideo: (id: string, opts?: { force?: boolean }) => ipcRenderer.invoke('ol:deleteVideo', id, opts),
  duplicateVideo: (id: string) => ipcRenderer.invoke('ol:duplicateVideo', id),
  revealVideo: (id: string) => ipcRenderer.send('ol:revealVideo', id),
  regeneratePreviews: (id: string) => ipcRenderer.invoke('ol:regeneratePreviews', id),
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
  stitchVideos: (id: string, appendId: string, appendRange?: { start: number; end: number }) =>
    ipcRenderer.invoke('ol:stitchVideos', id, appendId, appendRange),
  detectSilences: (id: string) => ipcRenderer.invoke('ol:detectSilences', id),
  cancelEditJob: (id: string) => ipcRenderer.invoke('ol:cancelEditJob', id),
  beginContinuation: (id: string) => ipcRenderer.invoke('ol:beginContinuation', id),
  cancelContinuation: () => ipcRenderer.invoke('ol:cancelContinuation'),
  dismissContinuation: (id: string) => ipcRenderer.invoke('ol:dismissContinuation', id),
  claimContinuationTake: (takeId: string) => ipcRenderer.invoke('ol:claimContinuationTake', takeId),
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

  // publish to YouTube (Data API upload, unlisted)
  youtubeStatus: () => ipcRenderer.invoke('ol:youtubeStatus'),
  youtubeConnect: () => ipcRenderer.invoke('ol:youtubeConnect'),
  youtubeDisconnect: () => ipcRenderer.invoke('ol:youtubeDisconnect'),
  youtubePublish: (videoId: string) => ipcRenderer.invoke('ol:youtubePublish', videoId),
  youtubeCancelPublish: (videoId: string) => ipcRenderer.invoke('ol:youtubeCancelPublish', videoId),
  youtubeUnpublish: (videoId: string) => ipcRenderer.invoke('ol:youtubeUnpublish', videoId),
  youtubeOpenStudioEdit: (videoId: string) => ipcRenderer.send('ol:youtubeOpenStudioEdit', videoId),

  // settings & system
  getSettings: () => ipcRenderer.invoke('ol:getSettings'),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('ol:setSettings', patch),
  pickDirectory: () => ipcRenderer.invoke('ol:pickDirectory'),
  pickFile: (filter: string) => ipcRenderer.invoke('ol:pickFile', filter),
  getPermissions: () => ipcRenderer.invoke('ol:getPermissions'),
  cameraEffects: () => ipcRenderer.invoke('ol:cameraEffects'),
  openCameraEffects: () => ipcRenderer.send('ol:openCameraEffects'),
  requestPermission: (kind: string) => ipcRenderer.invoke('ol:requestPermission', kind),
  resetScreenPermission: () => ipcRenderer.invoke('ol:resetScreenPermission'),
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
  onMicLevel: subscribe<number>('ol:mic-level'),

  engineReady: () => ipcRenderer.send('engine:ready'),
  engineStarted: (mimeType: string) => ipcRenderer.send('engine:started', { mimeType }),
  engineStopped: () => ipcRenderer.send('engine:stopped'),
  engineError: (message: string) => ipcRenderer.send('engine:error', message),
  engineMicLevel: (level: number) => ipcRenderer.send('engine:mic-level', level),
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
  onBubbleFadeOut: subscribeVoid('bubble:fade-out'),

  countdownDone: () => ipcRenderer.send('countdown:done'),
  countdownCancel: () => ipcRenderer.send('countdown:cancel'),

  onNotesText: subscribe<string>('notes:set-text'),

  onDrawEnable: subscribe<boolean>('draw:enable'),
  onDrawRipple: subscribe<{ x: number; y: number }>('draw:ripple'),
  onDrawColor: subscribe<string>('draw:color'),
  onDrawClear: subscribe<void>('draw:clear'),
};

contextBridge.exposeInMainWorld('openloom', api);
contextBridge.exposeInMainWorld('openloomInternal', internal);

/**
 * Drag-and-drop guard. A file dropped on a page with no drop handler makes
 * Chromium navigate the top frame to that file - which for a screen recorder is
 * a plausible mistake (users try to drag media in) and, worse, an attack vector:
 * the dropped document would run with this very preload bridge. Open Loom has no
 * drag-import UI, so we swallow every drag/drop at the window before Chromium can
 * act on it. Runs in every window because they all share this preload.
 */
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(
    type,
    (event) => {
      event.preventDefault();
      event.stopPropagation();
    },
    false
  );
}
