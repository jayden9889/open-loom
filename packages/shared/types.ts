/**
 * Open Loom shared types.
 * Single source of truth for the data model (SPEC section 4) and the
 * preload IPC contract (SPEC section 5). Main, preload, renderer and the
 * share server all build against these names.
 */

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export type RecordingMode = 'screen-cam' | 'screen' | 'cam';
export type QualityPreset = '720p' | '1080p' | '4k';
export type BubbleSize = 'S' | 'M' | 'L';

/**
 * Live camera layout, switchable mid-recording in Screen+Camera mode (SPEC R6):
 * 'bubble' = screen with the camera bubble (default), 'full' = camera fills the
 * whole frame, 'off' = screen only. cam-only mode is always full face already.
 */
export type CameraLayout = 'bubble' | 'full' | 'off';

/** Pixel diameters for the webcam bubble sizes (SPEC R6). */
export const BUBBLE_SIZES: Record<BubbleSize, number> = { S: 160, M: 240, L: 320 };

/** Target encode bitrates per quality preset, bits per second (SPEC R8). */
export const QUALITY_BITRATES: Record<QualityPreset, number> = {
  '720p': 5_000_000,
  '1080p': 8_000_000,
  '4k': 20_000_000,
};

export interface RecordingOptions {
  mode: RecordingMode;
  /** desktopCapturer source id. Required for screen modes. */
  sourceId?: string;
  /** True when sourceId refers to a whole display rather than a window. */
  sourceIsDisplay?: boolean;
  cameraId?: string;
  micId?: string;
  cameraOn: boolean;
  micOn: boolean;
  systemAudio: boolean;
  quality: QualityPreset;
  fps: 30 | 60;
}

export type RecordingStatus = 'idle' | 'countdown' | 'recording' | 'paused' | 'processing';

export interface RecordingState {
  status: RecordingStatus;
  /** Seconds actually recorded (paused time excluded). */
  elapsedSec: number;
  mode?: RecordingMode;
  cameraOn?: boolean;
  /** Current live camera layout (Screen+Camera recordings only). */
  cameraLayout?: CameraLayout;
  micOn?: boolean;
  drawOn?: boolean;
  /** Draw is only possible while capturing a whole display (SPEC R10). */
  drawAvailable?: boolean;
  /** Present while status is `processing`. */
  processingNote?: string;
  /** Set on the transition out of `processing` so the UI can open the Watch view. */
  lastVideoId?: string;
  /** Human-readable error when a recording failed. Cleared on the next start. */
  error?: string;
}

/** A crashed or interrupted recording found on disk at launch (crash recovery, SPEC R8). */
export interface RecoverableRecording {
  tempId: string;
  startedAt: string;
  mode: RecordingMode;
  mimeType: string;
  approxDurationSec: number;
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Library data model (SPEC section 4)
// ---------------------------------------------------------------------------

export interface VideoMeta {
  /** nanoid(10), also the share id. */
  id: string;
  title: string;
  description?: string;
  /** ISO 8601. */
  createdAt: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  mode: RecordingMode;
  folderId?: string | null;
  share?: {
    provider: 'server' | 's3';
    url: string;
    uploadedAt?: string;
    privacy: 'link' | 'password';
    allowComments: boolean;
    allowReactions: boolean;
    allowDownload: boolean;
    cta?: { label: string; url: string };
    /**
     * Write-only transport field for updateShareSettings: a non-empty string
     * sets the viewer password, '' clears it. Never persisted locally and
     * never returned by getVideo (documented additive extension, see
     * docs/DECISIONS.md).
     */
    password?: string;
  };
  /**
   * Canonical youtube.com/watch?v=<id> link from the "Publish to YouTube"
   * uploader (SPEC S7), set once the Data API videos.insert upload succeeds.
   */
  youtubeUrl?: string;
  /**
   * Privacy YouTube actually applied to the upload. 'unlisted' once the API
   * project is audited; 'private' while it is not - the forced-private lock on
   * unaudited projects (docs/DECISIONS.md). 'private' is what makes the Watch
   * view show the one-click "Set to Unlisted" flip button.
   */
  youtubePrivacy?: 'unlisted' | 'private';
  transcript?: { language: string; engine: string };
  ai?: {
    title?: string;
    summary?: string;
    chapters?: { t: number; title: string }[];
    tasks?: string[];
  };
  customThumb?: boolean;
  edits?: { trimmedFrom?: string };
}

export interface Folder {
  id: string;
  name: string;
}

/** Shape of `library.json` in the save folder (folders + ordering cache). */
export interface LibraryIndex {
  folders: Folder[];
  /** Video ids in display order; unknown ids are appended by created date. */
  order: string[];
}

/** Files that live next to meta.json inside a video's library directory. */
export const VIDEO_FILES = {
  video: 'video.mp4',
  thumb: 'thumb.jpg',
  preview: 'preview.gif',
  waveform: 'waveform.json',
  captions: 'transcript.vtt',
  transcriptJson: 'transcript.json',
  meta: 'meta.json',
  original: 'video.orig.mp4',
} as const;

export type VideoFileName = (typeof VIDEO_FILES)[keyof typeof VIDEO_FILES];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface ShortcutSettings {
  startStop: string;
  pauseResume: string;
  cancel: string;
  restart: string;
  draw: string;
}

export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  startStop: 'CommandOrControl+Shift+L',
  pauseResume: 'Alt+Shift+P',
  cancel: 'Alt+Shift+C',
  restart: 'CommandOrControl+Shift+R',
  draw: 'Control+1',
};

/** Pre-2026-07-23 draw default; stored settings carrying it migrate to Control+1. */
export const LEGACY_DRAW_SHORTCUT = 'CommandOrControl+Shift+D';

export type TranscriptionEngine = 'whisper' | 'openai' | 'off';
export type AiProvider = 'anthropic' | 'openai' | 'ollama' | 'off';
export type ShareProviderKind = 'server' | 's3' | 'none';

// ---------------------------------------------------------------------------
// Camera effects (Settings > FaceCam)
//
// Portrait (background blur), Studio Light and friends are macOS SYSTEM
// video effects: the OS applies them on the Neural Engine inside the camera
// pipeline, before frames ever reach an app, so they land in previews, the
// bubble and recordings automatically and cost the app nothing. They are
// user-controlled (Control Center > Video Effects); an app can only read
// their state and open that panel. This is deliberate - two hand-rolled
// in-app pipelines (segmentation relighting, then segmentation blur) were
// built and killed for quality; the OS matting is the gold standard.
// ---------------------------------------------------------------------------

export interface CameraEffectsStatus {
  /** OS-level camera effects exist on this machine (macOS + supported camera). */
  supported: boolean;
  /** Portrait (background blur) currently on. */
  portrait: boolean;
  /** Studio Light currently on. */
  studioLight: boolean;
  /** Reactions (gesture effects) currently on. */
  reactions: boolean;
}

export interface Settings {
  setupComplete: boolean;
  /** Absolute path of the library save folder. */
  saveDir: string;
  theme: 'auto' | 'light' | 'dark';
  countdown: boolean;
  clickHighlights: boolean;
  launchAtLogin: boolean;
  /** Tokens: {date} {time} {n}. */
  namePattern: string;
  /** Optional explicit path to an ffmpeg binary; empty = resolve from PATH + app bin dir. */
  ffmpegPath: string;
  recording: {
    quality: QualityPreset;
    fps: 30 | 60;
    defaultMode: RecordingMode;
    cameraId: string;
    micId: string;
    systemAudio: boolean;
    /** Minutes; 0 = no limit. */
    maxDurationMin: number;
  };
  bubble: {
    size: BubbleSize;
    mirror: boolean;
  };
  shortcuts: ShortcutSettings;
  transcription: {
    engine: TranscriptionEngine;
    whisperPath: string;
    whisperModelPath: string;
    /** OpenAI-compatible /v1/audio/transcriptions endpoint. */
    endpoint: string;
    /** Model name sent to the API endpoint engine (e.g. whisper-1). */
    model: string;
    /** Stored encrypted (safeStorage); read back masked. Write plaintext to update. */
    apiKey: string;
    /** BCP-47 code or 'auto'. */
    language: string;
    auto: boolean;
  };
  ai: {
    provider: AiProvider;
    endpoint: string;
    model: string;
    /** Stored encrypted (safeStorage); read back masked. Write plaintext to update. */
    apiKey: string;
    features: { title: boolean; summary: boolean; chapters: boolean; tasks: boolean };
  };
  sharing: {
    provider: ShareProviderKind;
    autoCopyOnStop: boolean;
    server: {
      url: string;
      /** Stored encrypted (safeStorage); read back masked. Write plaintext to update. */
      apiKey: string;
    };
    s3: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      /** Stored encrypted (safeStorage); read back masked. Write plaintext to update. */
      secretAccessKey: string;
      prefix: string;
      /** Public base URL of the bucket or custom domain. */
      publicBaseUrl: string;
      pathStyle: boolean;
    };
    defaults: {
      privacy: 'link' | 'password';
      allowComments: boolean;
      allowReactions: boolean;
      allowDownload: boolean;
    };
  };
  youtube: {
    /** OAuth 2.0 "Desktop app" client id from Google Cloud Console. Not secret. */
    clientId: string;
    /** OAuth 2.0 "Desktop app" client secret. Stored encrypted (safeStorage); read back masked. */
    clientSecret: string;
    /** Long-lived refresh token from the loopback consent. Stored encrypted; read back masked. Empty = not connected. */
    refreshToken: string;
  };
}

// ---------------------------------------------------------------------------
// Sharing provider adapter (SPEC S1)
// ---------------------------------------------------------------------------

export interface UploadPlanFile {
  /** Local file name inside the video dir, e.g. 'video.mp4'. */
  name: string;
  /** Remote key/path or URL fragment the provider will write to. */
  remote: string;
  required: boolean;
}

export interface UploadPlan {
  videoId: string;
  files: UploadPlanFile[];
  /** Provider-private payload carried from prepareShare to upload. */
  context?: Record<string, unknown>;
}

export interface ShareResult {
  shareUrl: string;
  uploadPlan: UploadPlan;
}

export type UploadProgress = (info: { file: string; pct: number; note?: string }) => void;

/**
 * Provider adapter every sharing backend implements (server, s3, none).
 * `prepareShare` must be fast: it mints the share URL that is copied to the
 * clipboard the moment recording stops; `upload` then runs in the background.
 */
export interface ShareProvider {
  readonly kind: ShareProviderKind;
  prepareShare(meta: VideoMeta): Promise<ShareResult>;
  upload(plan: UploadPlan, filesDir: string, onProgress: UploadProgress): Promise<void>;
  remove(videoId: string): Promise<void>;
  test(cfg: unknown): Promise<{ ok: boolean; error?: string }>;
}

// ---------------------------------------------------------------------------
// Share activity (server provider, Watch view Activity tab)
// ---------------------------------------------------------------------------

export interface ShareComment {
  id: string;
  parentId?: string | null;
  author: string;
  text: string;
  atSec?: number | null;
  createdAt: string;
}

export interface ShareViewer {
  name: string;
  sessions: number;
  maxPositionSec: number;
  lastSeenAt: string;
}

export interface ShareActivity {
  views: number;
  uniqueViewers: number;
  /** 0..1 average watched fraction. */
  completionRate: number;
  viewers: ShareViewer[];
  comments: ShareComment[];
  /** emoji -> count. */
  reactions: Record<string, number>;
  viewsByDay: { day: string; views: number }[];
  /** 0..1 watch coverage per bucket across the timeline (heat strip). */
  coverage: number[];
}

// ---------------------------------------------------------------------------
// Transcription provider interface (backends plug in behind this)
// ---------------------------------------------------------------------------

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  language: string;
  engine: string;
  segments: TranscriptSegment[];
  vtt: string;
}

export interface TranscriptionProvider {
  readonly engine: TranscriptionEngine;
  transcribe(audioPath: string, language: string, onProgress: (pct: number) => void): Promise<TranscriptResult>;
}

// ---------------------------------------------------------------------------
// System / permissions / jobs
// ---------------------------------------------------------------------------

export type PermissionStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

export interface PermissionsSnapshot {
  screen: PermissionStatus;
  camera: PermissionStatus;
  mic: PermissionStatus;
  ffmpeg: boolean;
  whisper: boolean;
}

export interface JobProgress {
  videoId: string;
  /** e.g. 'remux' | 'transcode' | 'thumbnail' | 'gif' | 'waveform' | 'trim' | 'upload'. */
  kind: string;
  /** 0..100. */
  pct: number;
  note?: string;
}

export interface CaptureSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  /** True for a whole display, false for an application window. */
  display: boolean;
}

/** Structural subset of the DOM MediaDeviceInfo (keeps shared types DOM-free). */
export interface MediaDeviceInfoLite {
  deviceId: string;
  kind: 'audioinput' | 'audiooutput' | 'videoinput';
  label: string;
  groupId: string;
}

export interface MediaDeviceLists {
  cameras: MediaDeviceInfoLite[];
  mics: MediaDeviceInfoLite[];
}

export interface AppInfo {
  version: string;
  platform: string;
  /** OS release string, e.g. Darwin kernel version. */
  osVersion: string;
  /** Whether system-audio loopback capture is available on this machine. */
  systemAudio: boolean;
}

export interface SearchMatch {
  id: string;
  /** Snippets that matched (title and/or transcript lines). */
  matches: string[];
}

// ---------------------------------------------------------------------------
// Preload IPC contract (SPEC section 5) - preload exposes `window.openloom`
// ---------------------------------------------------------------------------

export interface OpenLoomAPI {
  // capture
  /** Show + focus the floating recording launcher panel (additive; see docs/DECISIONS.md). */
  openLauncher(): void;
  listCaptureSources(): Promise<CaptureSource[]>;
  listMediaDevices(): Promise<MediaDeviceLists>;
  startRecording(opts: RecordingOptions): Promise<void>;
  pauseRecording(): Promise<void>;
  resumeRecording(): Promise<void>;
  stopRecording(): Promise<{ videoId: string }>;
  cancelRecording(): Promise<void>;
  restartRecording(): Promise<void>;
  onRecordingState(cb: (s: RecordingState) => void): () => void;
  toggleCamera(on: boolean): void;
  toggleMic(on: boolean): void;
  toggleDraw(on: boolean): void;
  /** Pen colour for the draw overlay ('red' | 'violet' | 'yellow'). */
  setDrawColor(color: string): void;
  /** Instantly wipe every stroke on the draw overlay. */
  clearDraw(): void;
  setBubbleSize(s: BubbleSize): void;
  /** Switch the live camera layout mid-recording (Screen+Camera only). */
  setCameraLayout(layout: CameraLayout): void;

  // library
  listVideos(): Promise<VideoMeta[]>;
  getVideo(id: string): Promise<VideoMeta>;
  updateVideo(id: string, patch: Partial<VideoMeta>): Promise<VideoMeta>;
  deleteVideo(id: string): Promise<void>;
  duplicateVideo(id: string): Promise<VideoMeta>;
  revealVideo(id: string): void;
  fileUrl(id: string, file: string): string;
  listFolders(): Promise<Folder[]>;
  createFolder(name: string): Promise<Folder>;
  renameFolder(id: string, name: string): Promise<void>;
  deleteFolder(id: string): Promise<void>;
  moveVideo(id: string, folderId: string | null): Promise<void>;
  searchVideos(q: string): Promise<SearchMatch[]>;
  setCustomThumbnail(id: string, source: { path?: string; atSec?: number }): Promise<void>;

  // editor
  trimVideo(id: string, ranges: { start: number; end: number }[]): Promise<void>;
  stitchVideos(id: string, appendId: string): Promise<void>;
  onJobProgress(cb: (j: JobProgress) => void): () => void;

  // transcribe + AI
  transcribeVideo(id: string): Promise<void>;
  generateAI(id: string, kinds: string[]): Promise<void>;
  /** Verify the saved AI provider settings with a tiny real request (additive; see docs/DECISIONS.md). */
  testAI(): Promise<{ ok: boolean; error?: string }>;

  // share
  shareVideo(id: string): Promise<{ url: string }>;
  unshareVideo(id: string): Promise<void>;
  updateShareSettings(id: string, patch: Partial<VideoMeta['share']>): Promise<void>;
  getShareActivity(id: string): Promise<ShareActivity>;
  testShareProvider(cfg: unknown): Promise<{ ok: boolean; error?: string }>;
  /** Delete a viewer comment on the share server via the creator key (additive; see docs/DECISIONS.md). */
  deleteShareComment(videoId: string, commentId: string): Promise<void>;

  // publish to YouTube (Data API upload, unlisted; additive to SPEC section 5, see docs/DECISIONS.md)
  /** Whether a YouTube account is connected (a refresh token is stored). */
  youtubeStatus(): Promise<{ connected: boolean }>;
  /** Run the Google OAuth loopback consent and store the refresh token. Returns the new connection state. */
  youtubeConnect(): Promise<{ connected: boolean }>;
  /** Forget the stored YouTube tokens (does not revoke server-side). */
  youtubeDisconnect(): Promise<{ connected: boolean }>;
  /**
   * Upload the video's final MP4 via videos.insert requesting unlisted, persist the
   * watch link and return it. `privacy` is what YouTube actually applied: 'private'
   * while the API project is unaudited (caller shows the flip-to-unlisted step).
   */
  youtubePublish(videoId: string): Promise<{ url: string; videoId: string; privacy: 'unlisted' | 'private' }>;
  /** Open the studio.youtube.com edit page for this recording's upload so the user can flip it to Unlisted. */
  youtubeOpenStudioEdit(videoId: string): void;

  // settings & system
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  pickDirectory(): Promise<string | null>;
  pickFile(filter: string): Promise<string | null>;
  getPermissions(): Promise<PermissionsSnapshot>;
  requestPermission(kind: string): Promise<void>;
  openSystemSettings(pane: string): void;
  /** State of the macOS system camera effects (Portrait / Studio Light). */
  cameraEffects(): Promise<CameraEffectsStatus>;
  /** Open the system Video Effects panel (the Control Center camera controls). */
  openCameraEffects(): void;
  installWhisper(): Promise<void>;
  onSetupLog(cb: (line: string) => void): () => void;
  fetchFfmpeg(): Promise<void>;
  copyToClipboard(text: string): void;
  openExternal(url: string): void;
  appInfo(): Promise<AppInfo>;

  // crash recovery (additive to SPEC section 5; see docs/DECISIONS.md)
  listRecoverable(): Promise<RecoverableRecording[]>;
  recoverRecording(tempId: string): Promise<{ videoId: string }>;
  discardRecoverable(tempId: string): Promise<void>;

  // editor original handling (additive to SPEC section 5; see docs/DECISIONS.md)
  /** Restore video.orig.mp4 over the edited video and regenerate previews. */
  revertEdits(id: string): Promise<void>;
  /** Accept the edit: delete video.orig.mp4 and clear the edits marker. */
  confirmEdits(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal bridge for auxiliary windows (engine, HUD, bubble, countdown, draw)
// Exposed by preload as `window.openloomInternal`.
// ---------------------------------------------------------------------------

export interface EngineBeginPayload {
  opts: RecordingOptions;
  videoBitsPerSecond: number;
  bubble: { size: BubbleSize; mirror: boolean };
  /** Physical pixel size of the recorded display (null for camera-only mode). */
  captureSize: { width: number; height: number } | null;
}

export interface OpenLoomInternal {
  getRecordingState(): Promise<RecordingState>;
  getSettings(): Promise<Settings>;
  setBubbleMirror(mirror: boolean): void;
  onSettingsChanged(cb: (s: Settings) => void): () => void;
  onNavigate(cb: (nav: { view: string; mode?: string }) => void): () => void;
  /** Toasts pushed from the main process (e.g. the share-on-stop flow). */
  onToast(cb: (t: { kind: 'info' | 'success' | 'error'; text: string }) => void): () => void;
  // engine window
  engineReady(): void;
  engineStarted(mimeType: string): void;
  engineStopped(): void;
  engineError(message: string): void;
  sendChunk(chunk: Uint8Array): void;
  onEngineBegin(cb: (p: EngineBeginPayload) => void): () => void;
  onEngineStop(cb: () => void): () => void;
  onEnginePause(cb: () => void): () => void;
  onEngineResume(cb: () => void): () => void;
  onEngineCancel(cb: () => void): () => void;
  onEngineSetCamera(cb: (on: boolean) => void): () => void;
  onEngineSetLayout(cb: (layout: CameraLayout) => void): () => void;
  onEngineSetMic(cb: (on: boolean) => void): () => void;
  onEngineSetBubble(cb: (b: { size: BubbleSize; mirror: boolean }) => void): () => void;
  /** Bubble window: switch between circular ('bubble'), full-frame ('full') and hidden ('off'). */
  onBubbleLayout(cb: (layout: CameraLayout) => void): () => void;
  /** Bubble window: fade to transparent; the set-layout that follows fades back in. */
  onBubbleFadeOut(cb: () => void): () => void;
  // countdown window
  countdownDone(): void;
  countdownCancel(): void;
  // draw window
  onDrawEnable(cb: (on: boolean) => void): () => void;
  onDrawRipple(cb: (p: { x: number; y: number }) => void): () => void;
  onDrawColor(cb: (color: string) => void): () => void;
  onDrawClear(cb: () => void): () => void;
}
