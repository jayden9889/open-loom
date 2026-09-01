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
  /** Seconds the final video will run (paused time and re-said stretches excluded). */
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
  /**
   * A destructive action (delete/restart) is waiting on the HUD's confirm
   * panel. Set by the main process so the global hotkeys share the same gate.
   */
  confirm?: 'cancel' | 'restart';
  /**
   * Seconds left on the "re-say the last bit" countdown. While present the
   * take is paused and the HUD shows the redo panel with its escape hatch.
   */
  redoCountdown?: number;
  /** The user typed talking notes for this take, so the HUD offers the toggle. */
  notesAvailable?: boolean;
  /** The notes overlay is currently on screen (toggleable; it can get in the way). */
  notesOn?: boolean;
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
    /**
     * Server-assigned video id. The server mints a DIFFERENT id when the
     * requested one is already taken, so every remote call (delete, patch,
     * activity, comment moderation) must address this id, never the local one
     * (documented additive extension, see docs/DECISIONS.md).
     */
    remoteId?: string;
    uploadedAt?: string;
    /**
     * Set when the local file was edited AFTER the share upload finished, so
     * the hosted copy no longer matches what the library plays. Written by
     * markShareStale (editor jobs call it on completion), cleared by the next
     * successful upload of this video. Drives the "your edits are not on the
     * shared link yet" state in Watch (documented additive extension, see
     * docs/DECISIONS.md).
     */
    staleSince?: string;
    privacy: 'link' | 'password';
    allowComments: boolean;
    allowReactions: boolean;
    allowDownload: boolean;
    /** Server mode: ask viewers for their name before playing (viewer insights). */
    requireName?: boolean;
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
  /**
   * In-flight resumable upload session, persisted the moment the session opens
   * so a quit or crash mid-upload can be recovered on the next launch (Google
   * keeps the session for 7 days). Cleared on success and on cancel; kept on
   * failure so a retry resumes instead of starting from byte zero.
   */
  youtubeUpload?: { sessionUri: string; total: number; startedAt: string };
  transcript?: { language: string; engine: string };
  /**
   * Why the last automatic transcription failed, in plain English. Written by
   * the auto-transcribe hook so a silent background failure is visible in the
   * Transcript tab; cleared on the next successful transcription.
   */
  transcriptError?: string;
  ai?: {
    title?: string;
    summary?: string;
    chapters?: { t: number; title: string }[];
    tasks?: string[];
    /**
     * Set when the user hand-edited any AI result (summary text, action
     * items, chapter names, manual chapters). Regeneration then refuses to
     * overwrite existing values unless explicitly forced.
     */
    edited?: boolean;
    /**
     * Set after a trim: the stored results describe footage that no longer
     * exists. Cleared by the next successful generation.
     */
    stale?: boolean;
    /** Why the last automatic AI generation failed; cleared on success. */
    error?: string;
  };
  customThumb?: boolean;
  edits?: {
    trimmedFrom?: string;
    /**
     * Size and duration of the banked original, captured on the FIRST edit so
     * later edits do not overwrite them with already-edited values. Lets the
     * keep/revert surfaces say what reverting restores and how much disk the
     * duplicate costs, without walking the directory.
     */
    originalDurationSec?: number;
    originalSizeBytes?: number;
    /**
     * Every edit applied since the original was banked, so "Revert" can say
     * how many it undoes rather than calling it "this edit".
     */
    history?: { kind: 'trim' | 'stitch'; at: string }[];
  };
  /**
   * A continuation take filmed via "End here and film a continuation", waiting
   * to be appended to this video. Cleared once it is stitched on, or when the
   * user chooses to keep the take as a separate recording.
   */
  continuation?: { takeId: string; recordedAt: string };
  /**
   * Runtime-only flag set by list() when video.mp4 is gone from disk (deleted
   * or moved outside the app). Never persisted to meta.json.
   */
  missing?: boolean;
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
  /** Show/hide the talking-notes overlay mid-take (it can sit over content). */
  notes: string;
  /**
   * Re-say the last ten seconds. The launcher advertises this in its footer
   * hint and the HUD carries the button, but during a full screen recording
   * the HUD is behind whatever is being shown, so without a global key the
   * feature is only reachable by hunting for a window mid take.
   */
  redo: string;
  /**
   * Mute or unmute the microphone mid-take. Same reachability problem as the
   * redo key: the HUD button is useless the moment the recording covers it,
   * and an unmuted mic during an interruption ruins the take.
   */
  mic: string;
}

/**
 * Ceiling on the talking notes. The overlay is a glance card for the prompt
 * bullets of a ~3 minute proposal video (10-15 short lines), not a
 * teleprompter script - and the whole string rides inside settings.json,
 * which is read, written and broadcast as one blob.
 */
export const NOTES_MAX_CHARS = 500;

export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  startStop: 'CommandOrControl+Shift+L',
  pauseResume: 'Alt+Shift+P',
  cancel: 'Alt+Shift+C',
  restart: 'CommandOrControl+Shift+R',
  draw: 'Control+1',
  notes: 'Control+2',
  // B for "back ten seconds" and M for "mute". Both join the Alt+Shift family
  // the other mid-take keys already use (pause, cancel), which keeps them
  // clear of every accelerator above and clear of macOS itself: Option plus
  // Shift plus a letter is not a system shortcut, whereas Control plus a
  // digit is Mission Control's desktop switcher on a machine with more than
  // one desktop. Existing installs pick these up through the defaults merge
  // in getSettings, so nobody has to reset their shortcuts to get them.
  redo: 'Alt+Shift+B',
  mic: 'Alt+Shift+M',
};

/** Pre-2026-07-23 draw default; stored settings carrying it migrate to Control+1. */
export const LEGACY_DRAW_SHORTCUT = 'CommandOrControl+Shift+D';

export type TranscriptionEngine = 'whisper' | 'openai' | 'off';
export type AiProvider = 'anthropic' | 'openai' | 'ollama' | 'off';
export type ShareProviderKind = 'server' | 's3' | 'none';

/**
 * Curated model suggestions per AI provider so nobody has to type a model ID
 * blind (Settings renders these in a picker with a custom escape hatch).
 * Anthropic IDs verified against the current model catalogue, 2026-08; the
 * openai/ollama entries are suggestions for whatever compatible endpoint is
 * configured.
 */
export const AI_MODEL_SUGGESTIONS: Record<Exclude<AiProvider, 'off'>, { default: string; models: string[] }> = {
  anthropic: { default: 'claude-opus-5', models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] },
  openai: { default: 'gpt-4o-mini', models: ['gpt-4o-mini', 'gpt-4o'] },
  ollama: { default: 'llama3.1', models: ['llama3.1', 'qwen2.5', 'mistral'] },
};

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
  /**
   * Update checks contact GitHub, which is the only outbound call the app makes
   * on its own. A local-first tool has to let you switch that off.
   */
  autoUpdate: boolean;
  recording: {
    quality: QualityPreset;
    fps: 30 | 60;
    defaultMode: RecordingMode;
    cameraId: string;
    micId: string;
    systemAudio: boolean;
    /** Minutes; 0 = no limit. */
    maxDurationMin: number;
    /**
     * The user's talking notes, shown in a capture-excluded overlay during a
     * take so they are never memorising a script. Persisted so a restart or a
     * second take keeps them.
     */
    notes: string;
    /** desktopCapturer id of the last recorded source, restored when it still exists. */
    lastSourceId: string;
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
    /** Title of the connected account's YouTube channel, resolved at connect time. Display only; '' = unknown. */
    channelTitle: string;
    /**
     * Generation of YT_SCOPE the stored refresh token was consented under
     * (youtube-core's YT_SCOPE_VERSION at connect time). 0 = a token minted
     * before the scope widened to allow removing videos; Settings › YouTube
     * shows a "Reconnect to enable removing videos" prompt for those.
     */
    scopeVersion: number;
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
 * Result of a provider connection test. `warning` is a non-fatal caveat shown
 * alongside success (e.g. an http:// server URL sending the API key in clear).
 */
export interface ShareProviderTestResult {
  ok: boolean;
  error?: string;
  warning?: string;
}

/**
 * Provider adapter every sharing backend implements (server, s3, none).
 * `prepareShare` must be fast: it mints the share URL that is copied to the
 * clipboard the moment recording stops; `upload` then runs in the background.
 * `signal` aborts an in-flight upload (the Cancel button / quit guard).
 */
export interface ShareProvider {
  readonly kind: ShareProviderKind;
  prepareShare(meta: VideoMeta): Promise<ShareResult>;
  upload(plan: UploadPlan, filesDir: string, onProgress: UploadProgress, signal?: AbortSignal): Promise<void>;
  remove(videoId: string): Promise<void>;
  test(cfg: unknown): Promise<ShareProviderTestResult>;
}

/**
 * A remote share copy the user chose to leave behind when its delete failed
 * (server unreachable, expired key). Persisted in `pending-unshare.json` in
 * the library root and retried on launch and on the next successful provider
 * contact, so a public link is never silently stranded live forever.
 */
export interface PendingUnshare {
  /** Local video id at the time of deletion (the local copy may be gone). */
  videoId: string;
  provider: 'server' | 's3';
  url: string;
  /** Server-assigned remote id (server provider) or the object key id (s3). */
  remoteId: string;
  recordedAt: string;
  /** Plain-English reason the last removal attempt failed. */
  lastError?: string;
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
  /**
   * `onProgress` may carry an honest phase note ("Uploading audio") alongside
   * the percentage; `signal` aborts the engine (kills the whisper-cli child or
   * the in-flight request) for cancel and timeout support.
   */
  transcribe(
    audioPath: string,
    language: string,
    onProgress: (pct: number, note?: string) => void,
    signal?: AbortSignal
  ): Promise<TranscriptResult>;
}

// ---------------------------------------------------------------------------
// System / permissions / jobs
// ---------------------------------------------------------------------------

export type PermissionStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

export interface PermissionsSnapshot {
  screen: PermissionStatus;
  camera: PermissionStatus;
  mic: PermissionStatus;
  /**
   * macOS Accessibility grant (isTrustedAccessibilityClient). Click highlights
   * need it: without it the input hook starts fine and simply never delivers a
   * click, so this snapshot is the only place the truth is visible.
   */
  accessibility: PermissionStatus;
  /**
   * Whether the optional uiohook-napi native module that click highlights ride
   * on actually loaded and has not failed since. Deliberately separate from
   * `accessibility`: false here means the module is missing or broke, while
   * true alongside a denied `accessibility` means the hook runs and simply
   * never sees a click. Only the pair tells the UI which one to send the user
   * to fix.
   */
  clickHighlights: boolean;
  ffmpeg: boolean;
  whisper: boolean;
  /**
   * One plain sentence when the save folder is unusable right now (drive
   * unplugged, folder gone, not writable), null when it is fine. Rides on the
   * permissions snapshot because that is the health check the app already
   * re-runs at boot, on focus and from every Re-check button.
   */
  saveDirProblem: string | null;
}

/**
 * Where the last update check landed (About pane). 'unavailable' means checks
 * cannot work on this install at all (and `detail` says why); 'failed' means
 * this check did not complete; 'available'/'downloaded' carry the new version.
 */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloaded' | 'failed' | 'unavailable';
  /** One plain sentence for the About pane. */
  detail: string;
  /** ISO time of the last completed check, null before the first one. */
  checkedAt: string | null;
  /** New version, when one is known. */
  version?: string;
}

export interface JobProgress {
  videoId: string;
  /** e.g. 'remux' | 'transcode' | 'thumbnail' | 'gif' | 'waveform' | 'trim' | 'upload'. */
  kind: string;
  /** 0..100. */
  pct: number;
  note?: string;
  /**
   * True on a terminal event that is NOT a success (upload failed or was
   * cancelled). Consumers that treat `pct >= 100` as "done" must treat this as
   * "over" too - a failure used to report pct 100, which read as completed.
   */
  failed?: boolean;
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
  startRecording(opts: RecordingOptions): Promise<void>;
  pauseRecording(): Promise<void>;
  resumeRecording(): Promise<void>;
  stopRecording(): Promise<{ videoId: string }>;
  /** Ask to discard the take. Short takes go immediately; longer ones raise the HUD confirm. */
  cancelRecording(): Promise<void>;
  /** Ask to start the take over. Same confirm gate as cancel (additive; see docs/DECISIONS.md). */
  restartRecording(): Promise<void>;
  /**
   * Go back ten seconds and say it again: pauses the take, counts down on the
   * HUD, then resumes with the fluffed stretch marked for removal at finalise
   * (additive; see docs/DECISIONS.md).
   */
  redoLastTen(): void;
  /** Escape hatch for redoLastTen while its countdown runs: keep the take as it was. */
  cancelPendingRedo(): void;
  /** Answer the HUD confirm raised by cancel/restart. `confirmed` false keeps recording. */
  resolveRecordingConfirm(confirmed: boolean): void;
  onRecordingState(cb: (s: RecordingState) => void): () => void;
  toggleCamera(on: boolean): void;
  toggleMic(on: boolean): void;
  toggleDraw(on: boolean): void;
  /** Hide/show the talking-notes overlay mid-take without losing its position. */
  toggleNotes(): void;
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
  /**
   * `force` deletes locally even when the shared copy cannot be removed (the
   * orphaned link is tombstoned and retried on later launches). Without it a
   * failed unshare fails the whole delete, so the public link never silently
   * outlives the UI that could revoke it.
   */
  deleteVideo(id: string, opts?: { force?: boolean }): Promise<void>;
  duplicateVideo(id: string): Promise<VideoMeta>;
  /** Rebuild thumb.jpg / preview.gif / waveform.json for an existing recording. */
  regeneratePreviews(id: string): Promise<void>;
  revealVideo(id: string): void;
  fileUrl(id: string, file: string): string;
  listFolders(): Promise<Folder[]>;
  createFolder(name: string): Promise<Folder>;
  renameFolder(id: string, name: string): Promise<void>;
  deleteFolder(id: string): Promise<void>;
  moveVideo(id: string, folderId: string | null): Promise<void>;
  searchVideos(q: string): Promise<SearchMatch[]>;
  setCustomThumbnail(id: string, source: { path?: string; atSec?: number }): Promise<void>;
  /** Rebuild thumb/gif/waveform for a recording whose preview generation failed. */

  // editor
  trimVideo(id: string, ranges: { start: number; end: number }[]): Promise<void>;
  /** `appendRange` appends only that stretch of the clip (additive; see docs/DECISIONS.md). */
  stitchVideos(id: string, appendId: string, appendRange?: { start: number; end: number }): Promise<void>;
  /** Abort this video's running or queued trim/stitch; the pending call rejects as cancelled (additive; see docs/DECISIONS.md). */
  cancelEditJob(id: string): Promise<void>;
  /**
   * "End it here, film the rest" (additive; see docs/DECISIONS.md): arm a
   * continuation so the next recording that lands is offered as an append onto
   * this video, with the launcher flipped to its recording mode so the takes
   * match. cancelContinuation disarms; dismissContinuation clears a waiting
   * take's offer (the take stays in the library); claimContinuationTake is
   * called with a just-landed recording id and answers the base video to route
   * back to, or null when no continuation was armed.
   */
  beginContinuation(id: string): Promise<void>;
  cancelContinuation(): Promise<void>;
  dismissContinuation(id: string): Promise<void>;
  claimContinuationTake(takeId: string): Promise<{ baseId: string } | null>;
  /** Quiet stretches in the current file, for the cut-quiet-parts action (additive; see docs/DECISIONS.md). */
  detectSilences(id: string): Promise<{ start: number; end: number }[]>;
  onJobProgress(cb: (j: JobProgress) => void): () => void;

  // transcribe + AI
  transcribeVideo(id: string): Promise<void>;
  /** Abort this video's in-flight transcription; the pending transcribeVideo call rejects (additive; see docs/DECISIONS.md). */
  /**
   * `force` overwrites hand-edited results (the Regenerate path, behind a
   * confirm). Without it, generation refuses to replace edited values
   * (additive; see docs/DECISIONS.md).
   */
  generateAI(id: string, kinds: string[], force?: boolean): Promise<void>;
  /** Abort this video's in-flight AI generation; the pending generateAI call rejects (additive; see docs/DECISIONS.md). */
  /** Verify the saved AI provider settings with a tiny real request (additive; see docs/DECISIONS.md). */
  testAI(): Promise<{ ok: boolean; error?: string }>;
  /** Verify the saved transcription engine settings (a tiny silent-audio request for the API engine) (additive; see docs/DECISIONS.md). */

  // share
  shareVideo(id: string): Promise<{ url: string }>;
  unshareVideo(id: string): Promise<void>;
  updateShareSettings(id: string, patch: Partial<VideoMeta['share']>): Promise<void>;
  getShareActivity(id: string): Promise<ShareActivity>;
  testShareProvider(cfg: unknown): Promise<ShareProviderTestResult>;
  /** Delete a viewer comment on the share server via the creator key (additive; see docs/DECISIONS.md). */
  deleteShareComment(videoId: string, commentId: string): Promise<void>;
  /** Abort this video's in-flight share upload (additive; see docs/DECISIONS.md). */
  /** Remote share copies whose delete failed and the user chose to leave behind (additive; see docs/DECISIONS.md). */
  /** Retry removing every pending remote copy now; resolves with what is still stranded. */

  // publish to YouTube (Data API upload, unlisted; additive to SPEC section 5, see docs/DECISIONS.md)
  /**
   * Whether a YouTube account is connected (a refresh token is stored). `channel` is the
   * connected channel's title ('' = unknown). `needsReconnect` is true when the stored
   * token predates the current scope set, so removing videos needs a fresh consent.
   */
  youtubeStatus(): Promise<{ connected: boolean; channel: string; needsReconnect: boolean }>;
  /**
   * Run the Google OAuth loopback consent and store the refresh token. Resolves the
   * account's channel and rejects if the account has none (nothing is stored then),
   * so a wrong-account connect fails loudly here instead of at first publish.
   * `channelLookupFailed` is true when the connect stored a token but could not
   * confirm which channel it reaches (network or API hiccup) - worth a warning.
   */
  youtubeConnect(): Promise<{ connected: boolean; channel: string; channelLookupFailed?: boolean }>;
  /**
   * Forget the stored YouTube tokens, revoking them at Google first. `revoked` says
   * whether the Google-side revoke succeeded; local state is cleared either way.
   */
  youtubeDisconnect(): Promise<{ connected: boolean; revoked: boolean }>;
  /**
   * Upload the video's final MP4 via videos.insert requesting unlisted, persist the
   * watch link and return it. `privacy` is what YouTube actually applied: 'private'
   * while the API project is unaudited (caller shows the flip-to-unlisted step).
   */
  youtubePublish(videoId: string): Promise<{ url: string; videoId: string; privacy: 'unlisted' | 'private' }>;
  /** Abort this recording's in-flight upload. The pending youtubePublish call then rejects with 'Upload cancelled.'. */
  youtubeCancelPublish(videoId: string): Promise<void>;
  /** Delete this recording's upload from the user's channel (videos.delete) and clear the stored link. */
  youtubeUnpublish(videoId: string): Promise<void>;
  /** Open the studio.youtube.com edit page for this recording's upload so the user can flip it to Unlisted. */
  youtubeOpenStudioEdit(videoId: string): void;

  // settings & system
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  pickDirectory(): Promise<string | null>;
  pickFile(filter: string): Promise<string | null>;
  /**
   * Accelerators the OS refused at the last apply, keyed by shortcut name.
   * Saving a shortcut always succeeds, so without reading this back Settings
   * shows a green toast for a key another app already owns and the user only
   * finds out when they press it to stop a recording.
   */
  shortcutFailures(): Promise<Partial<ShortcutSettings>>;
  getPermissions(): Promise<PermissionsSnapshot>;
  requestPermission(kind: string): Promise<void>;
  /**
   * macOS only: clear the stale Screen Recording entry (TCC pins grants to a
   * build's code signature, so the System Settings tick can show ON while the
   * OS refuses the current binary) and open the right settings pane. Resolves
   * true when the reset ran; false on other platforms or tccutil failure.
   */
  resetScreenPermission(): Promise<boolean>;
  openSystemSettings(pane: string): void;
  /** State of the macOS system camera effects (Portrait / Studio Light). */
  cameraEffects(): Promise<CameraEffectsStatus>;
  /** Open the system Video Effects panel (the Control Center camera controls). */
  openCameraEffects(): void;
  installWhisper(): Promise<void>;
  /** Stop a running whisper.cpp install (kills the build; partial files are reused by the next run) (additive; see docs/DECISIONS.md). */
  /** Whether an install is running plus its buffered log, so reopening Settings reflects reality (additive; see docs/DECISIONS.md). */
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
  /** The camera died mid take; main warns the user and keeps the recording running. */
  cameraLost(): void;
  onSettingsChanged(cb: (s: Settings) => void): () => void;
  onNavigate(cb: (nav: { view: string; mode?: string; id?: string }) => void): () => void;
  /** Toasts pushed from the main process (e.g. the share-on-stop flow). */
  onToast(cb: (t: { kind: 'info' | 'success' | 'error'; text: string }) => void): () => void;
  /** Live microphone level during a take (0..1 RMS, ~2Hz), for the HUD meter. */
  onMicLevel(cb: (level: number) => void): () => void;
  // engine window
  engineReady(): void;
  engineStarted(mimeType: string): void;
  engineStopped(): void;
  engineError(message: string): void;
  /** Engine-side mic RMS sample; main relays it to the HUD and feeds the silence watchdog. */
  engineMicLevel(level: number): void;
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
  // notes overlay window
  /** The talking notes to display; sent by main once the window has loaded. */
  onNotesText(cb: (text: string) => void): () => void;
  // draw window
  onDrawEnable(cb: (on: boolean) => void): () => void;
  onDrawRipple(cb: (p: { x: number; y: number }) => void): () => void;
  onDrawColor(cb: (color: string) => void): () => void;
  onDrawClear(cb: () => void): () => void;
}
