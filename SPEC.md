# Open Loom — Build Specification (v1)

**Open Loom** is a fully open-source, install-on-your-own-machine clone of Loom. Local-first
desktop recorder with Loom-parity UX, plus optional sharing via (a) a tiny self-hosted share
server that delivers the full Loom loop (hosted watch page, timestamped comments, emoji
reactions, viewer analytics, password protection) or (b) any S3-compatible bucket (Cloudflare
R2 free tier recommended) with a static share page. No accounts, no telemetry, no vendor lock.

This file is the single source of truth. Every builder/tester agent follows it. Deviations
require a written note in `docs/DECISIONS.md`.

---

## 1. Locked architecture decisions (do not relitigate)

| Decision | Choice | Why (research-verified 2026-07) |
|---|---|---|
| Desktop shell | **Electron 43** (latest stable) | System-audio loopback is native in Electron ≥39 on macOS 14.2+ (Core Audio taps); capture = plain web APIs; bubble = OS-composited window. Tauri needs a custom Rust media engine (Cap's approach, AGPL). |
| Build tooling | **electron-vite** + TypeScript + React 18 | Fast HMR, standard main/preload/renderer layout. |
| Recording API | `getDisplayMedia` (via `setDisplayMediaRequestHandler` + `desktopCapturer`) + `getUserMedia` + **MediaRecorder** | Solved, reliable path. |
| Codec strategy | Try `video/mp4;codecs=avc1.42E01E,mp4a.40.2` via `MediaRecorder.isTypeSupported()`; fallback `video/webm;codecs=vp9,opus`, then vp8. Always post-process with ffmpeg: remux (`-c copy`) when stream-copy is possible, else transcode to H.264 MP4. Final library format is **always seekable .mp4** | MediaRecorder WebM has no duration/cues (non-seekable). MP4-in-MediaRecorder only when OS encoder exists — must feature-detect. |
| ffmpeg | **Detect on system** (`ffmpeg`/`ffprobe` in PATH or configured path). First-run setup screen offers guided install + `scripts/fetch-ffmpeg.mjs` (downloads a static build to `~/Library/Application Support/OpenLoom/bin`). We do NOT bundle GPL binaries in the repo | Keeps repo MIT-clean and small. |
| System audio | `audio: 'loopback'` via `setDisplayMediaRequestHandler` (use `electron-audio-loopback` package). macOS <14.2 → toggle disabled with explainer. Mix mic + system audio via WebAudio `AudioContext` into the recorded stream | Native since Electron 39; no virtual driver. |
| Webcam bubble | Separate frameless, transparent, `alwaysOnTop('screen-saver')`, `visibleOnAllWorkspaces` BrowserWindow. Circular via CSS. Drag via `-webkit-app-region: drag`. Sizes S/M/L | OS composites it live; in full-screen capture it is recorded naturally (exactly Loom desktop behaviour). |
| Window-capture mode + camera | Composite in renderer: draw window stream + webcam onto `<canvas>` (rAF pump with `setTimeout` fallback), `canvas.captureStream(30)` → MediaRecorder. Bubble burned in bottom-left (position/size from bubble settings) | Bubble window isn't part of a window-only capture; burn-in matches Loom output. |
| Transcription | Pluggable engine: (1) **whisper.cpp** local — detect `whisper-cli` at configured path; `scripts/setup-whisper.sh` clones + builds + downloads `base.en` (Metal on mac); (2) any **OpenAI-compatible** `/v1/audio/transcriptions` endpoint (BYO key); (3) off | No Homebrew assumption. Local-first, private by default. |
| AI features | BYO provider: **Anthropic API**, **OpenAI-compatible**, or **Ollama** (local). Generates title, summary, chapters, action items from transcript. Keys via Electron `safeStorage`, never in repo | Loom AI parity without shipping secrets. |
| Sharing default | Provider adapter. Providers: `openloom-server` (full loop), `s3` (R2/B2/MinIO/AWS, static share page), `none` (local only). Share URL is **minted and copied to clipboard the moment recording stops**; upload runs in background with progress + retry (Loom's "instant link" trick) | YouTube API is DEAD as default: unverified-project uploads are force-locked private (no appeal) + ~100 uploads/day/project. Drive locks popular files for 24h. R2 egress is free. |
| Server | `packages/server`: **Hono + better-sqlite3**, single Docker container / `npx openloom-server`, API-key auth for the creator app, anonymous viewers | The full Loom loop (comments/reactions/analytics) needs a write path; keep it tiny and one-command. |
| License | **MIT** for everything in this repo | Max adoption; we bundle no GPL binaries. |
| Platforms | macOS 14.2+ first-class (dev machine = macOS 26). Windows/Linux: code paths kept portable (no hard mac-only APIs without guards), but v1 is only *tested* on macOS | Honest scope. |

**Naming:** product “Open Loom”, binary/app `OpenLoom`, bundle id `org.openloom.app`, server package `openloom-server`.

---

## 2. Repo layout (npm workspaces)

```
open-loom/
├─ package.json                 # workspaces: apps/desktop, packages/*
├─ SPEC.md  FEATURES.md  README.md  LICENSE  CONTRIBUTING.md
├─ docs/ (DECISIONS.md, SELF-HOSTING.md, SHARING.md, TRANSCRIPTION.md, TESTING.md)
├─ assets/ (logo.svg, logo-dark.svg, icon.png 1024, tray/trayTemplate.png + @2x)
├─ scripts/ (setup-whisper.sh, fetch-ffmpeg.mjs, make-icons.mjs, make-sample-video.sh)
├─ apps/desktop/
│  ├─ electron.vite.config.ts
│  ├─ package.json
│  └─ src/
│     ├─ main/                  # index.ts, windows.ts, capture.ts, recorder-ipc.ts,
│     │                         # settings.ts, library.ts, ffmpeg.ts, transcribe.ts,
│     │                         # ai.ts, share/{provider.ts,s3.ts,server.ts}, shortcuts.ts,
│     │                         # tray.ts, clicks.ts (uiohook optional), permissions.ts
│     ├─ preload/index.ts       # typed contextBridge API (see §5)
│     └─ renderer/
│        ├─ index.html          # main window app (React)
│        ├─ hud.html            # recording control bar window
│        ├─ bubble.html         # webcam bubble window
│        ├─ countdown.html      # 3-2-1 overlay
│        ├─ draw.html           # drawing overlay
│        └─ src/ (App.tsx, views/{Library,Watch,Editor,Settings,Setup}, components/, styles/)
├─ packages/shared/             # types.ts (VideoMeta, Settings, ShareResult…), design-tokens.css
└─ packages/server/
   ├─ package.json  Dockerfile  docker-compose.yml
   └─ src/ (index.ts, db.ts, routes/{videos,upload,watch,comments,reactions,analytics,embed}.ts,
            pages/ (watch page SSR + client js), public/)
```

---

## 3. Feature requirements (v1 = must ship & pass tests)

### Recorder
- **R1. Capture modes:** Screen+Camera (default), Screen only, Camera only. Mode picker in main-window “New recording” panel AND tray menu.
- **R2. Source picker:** full screen (each display) or application window, with live thumbnails (desktopCapturer). Loom-style picker UI.
- **R3. Devices:** camera + mic dropdowns (enumerateDevices), persisted. Mic level meter in picker. Camera/mic can each be off.
- **R4. System audio toggle** (loopback) mixed with mic. Disabled + tooltip on unsupported OS.
- **R5. Countdown** 3-2-1 overlay (setting, default on, skippable by click).
- **R6. Camera bubble:** circular, S(160)/M(240)/L(320px), draggable anywhere, size switcher on hover, mirror toggle, hide/show mid-recording. Shown in Screen+Camera mode whenever camera is on.
- **R7. HUD control bar** (frameless, always-on-top, left-center of screen, draggable): elapsed timer (red dot), pause/resume, stop (finish), restart, cancel/trash, camera on/off, mic mute, draw toggle. Tooltips + shortcut hints.
- **R8. Recording engine:** MediaRecorder, 1s timeslice, quality presets 720p/1080p/4K@30fps (bitrates ~5/8/20 Mbps), pause/resume support, max-duration guard (setting, default off), crash-safe: chunks land in temp file continuously; recovery on next launch offers to restore.
- **R9. Global shortcuts** (configurable): ⌘⇧L start/stop, ⌥⇧P pause/resume, ⌥⇧C cancel, ⌘⇧R restart. Registered app-wide (globalShortcut), also work when app hidden.
- **R10. Drawing tool:** during full-screen recording, transparent overlay canvas; pen strokes (red, 4px, glow-free), strokes fade after 3s; ⌘⇧D toggles; cursor becomes crosshair. In window-capture mode the draw button is disabled with tooltip (not captured).
- **R11. Click highlights** (setting, default off): ripple at click point via uiohook-napi; if the native module or accessibility permission is unavailable, the toggle shows “unavailable” and the app must still run perfectly.
- **R12. Tray/menubar app:** template icon, menu = New recording (modes), Pause, Stop, Cancel, Open Library, Settings, Quit. Dock + tray both work; closing main window keeps app alive in tray.
- **R13. Permissions flow:** first-run Setup view checks Screen Recording, Camera, Microphone, ffmpeg; each with status pill + “Fix” button (opens System Settings pane / triggers prompt / offers ffmpeg fetch). Never silent-fail: every dead-stream case surfaces a human explanation.
- **R14. On stop:** HUD + bubble close instantly → post-processing (remux/transcode + thumbnail + animated GIF preview + waveform JSON) with progress → Watch view opens. If sharing configured: share URL copied to clipboard AT STOP (toast: “Link copied — uploading…”) and upload runs in background (retry ×3, resumable for server provider).

### Library & watch
- **L1. Library grid:** cards with thumbnail → animated GIF preview on hover, title, duration badge, created date, shared/local badge, view count (if shared). Sort by date; search box filters by title + transcript text. Empty state with “Record your first video”.
- **L2. Folders:** create/rename/delete folders (flat, one level), drag videos into folders, sidebar shows folders + counts. Deleting a folder moves videos to Library.
- **L3. Video actions** (card context menu + watch page): Copy link (if shared), Share…, Rename, Move to folder, Download/Reveal in Finder, Duplicate, Delete (confirm; removes local files + tombstones server copy).
- **L4. Watch view (in-app):** custom player — play/pause (click video too), scrubber with hover-preview timestamp, current/total time, speed menu **0.8/1/1.2/1.5/1.7/2/2.5×**, volume, captions toggle (from VTT), fullscreen; keyboard: space, ←/→ 5s, ↑/↓ volume, F fullscreen, C captions.
- **L5. Sidebar tabs on watch view:** Transcript (clickable lines seek; search-in-transcript), Chapters (AI or manual; click seeks), Activity (views/comments/reactions when shared — live from server), Details (title inline-edit, description, created, size, resolution, share status + provider, CTA config).
- **L6. Title:** auto-name `Recording — 6 Jul 2026, 14:32` then AI title after transcript (if AI configured). Inline rename everywhere.
- **L7. Thumbnails:** auto frame at 25%; “Set custom thumbnail” (pick image or current frame); animated GIF preview auto-generated (first 4s, 480px, ~12fps).

### Editor
- **E1. Trim:** in Watch view → Edit: timeline with filmstrip + audio waveform, drag in/out handles, preview, non-destructive until Save; Save = ffmpeg (stream-copy when cut on keyframes is acceptable quality-wise, else precise re-encode; pick automatically, show which). Undo = restore original (original kept as `.orig.mp4` until user confirms).
- **E2. Remove middle section:** split marker → select region → delete → concat.
- **E3. Stitch:** “Add clip” appends another library video (same-codec fast concat else re-encode).
- **E4. Post-edit:** thumbnails/preview/transcript regenerate automatically (transcript re-run only with user confirm).

### Transcription, captions, AI
- **T1. Auto-transcribe after processing** when engine configured (setting default: on if whisper available). VTT + word/segment JSON stored next to video. Language auto-detect (whisper), or forced in settings.
- **T2. Captions** in player + burned-in export option (Editor → Export with captions).
- **T3. Search across transcripts** in library search.
- **A1. AI title / summary / chapters / action items** generated from transcript when AI provider configured; shown in Watch sidebar; all editable; chapters clickable. Provider = Anthropic | OpenAI-compatible | Ollama; model + key in Settings (safeStorage). Explicit “Generate” buttons too (retro-run on old videos).

### Sharing (parity core)
- **S1. Provider adapter** (`packages/shared/types.ts`): `prepareShare(meta) → {shareUrl, uploadPlan}`; `upload(plan, files, onProgress)`; `remove(videoId)`. Providers: server, s3, none.
- **S2. OpenLoom Server provider:** POST /api/videos (auth: API key) mints id + share URL; chunked PUT upload (resumable); uploads video.mp4, thumb.jpg, preview.gif, transcript.vtt, meta. Share page live immediately with “Processing…” until video arrives.
- **S3. S3 provider:** direct S3 multipart (R2/B2/MinIO/AWS endpoints; path-style toggle). Uploads video + assets + a **self-contained static `index.html` player page** (inline CSS/JS, no external requests) to `{prefix}/{id}/`; share URL = public bucket/custom-domain URL. Docs walk through R2 free-tier setup in 5 minutes (`docs/SHARING.md`).
- **S4. Share dialog** (Watch → Share): provider status, link with copy button, privacy (server: link-only / password), CTA button (label+URL), toggles: allow comments, allow reactions, allow download (server enforces), “Delete remote copy”.
- **S5. Embed:** copy `<iframe>` snippet (server watch page supports `?embed=1` chromeless).
- **S6. YouTube:** explicitly NOT a provider. `docs/SHARING.md` explains why (verified: unverified-API-project uploads locked private, ~100/day cap) + manual-upload guidance. This answers “why not YouTube unlisted”.

### Server (packages/server) — the full Loom loop, self-hosted
- **V1. Run:** `docker compose up -d` or `npx openloom-server`; env: `PORT`, `DATA_DIR`, `API_KEY` (creator auth), `BASE_URL`, `MAX_UPLOAD_MB`. SQLite + files on a volume. `GET /healthz`.
- **V2. Watch page** `/v/:id`: sleek Apple-style page (SSR + vanilla JS, self-contained, responsive, light/dark): player (same controls/speeds as app), title, creator name, date, chapters, transcript panel with seek, captions, CTA button, download (if allowed), emoji reaction bar (👍 ❤️ 😂 🎉 👀 +count, one per viewer per emoji, anonymous ok), timestamped comments (name remembered in localStorage, text + optional timestamp chip that seeks; threaded 1 level; creator can delete via key), view counting.
- **V3. Analytics:** view = unique session beacon; progress beacons at 5s cadence → per-video: total views, unique viewers, completion rate, per-viewer sessions (name if given, else Anonymous), views-over-time (day buckets); heat strip of watch coverage. Exposed to app via authed API → Watch “Activity” tab renders it (Insights parity).
- **V4. Privacy:** link-only by default; optional password (argon2/bcrypt hash; cookie session per video); optional disable comments/reactions/download per video; delete video removes files + rows.
- **V5. Processing endpoint behaviour:** page shows “Processing” state until upload completes (poll /api/videos/:id/status).

### Settings
- **G1.** General: save folder (native picker + “Reveal”), theme (auto/light/dark), countdown, click highlights, launch at login, default recording name pattern.
- **G2.** Recording: quality, fps, default mode, devices, system audio default, max duration.
- **G3.** Shortcuts: editable accelerators with conflict validation.
- **G4.** Transcription: engine, whisper binary+model path (+ “Install whisper.cpp” runs script with live log), language, auto-transcribe toggle.
- **G5.** AI: provider, endpoint, model, key (masked), feature toggles (title/summary/chapters/tasks), “Test connection”.
- **G6.** Sharing: provider picker with setup forms (server URL + API key “Test”; S3 endpoint/bucket/keys/custom domain “Test”), auto-copy-link-on-stop toggle, default privacy toggles.
- **G7.** About: version, licenses, logo, links; “Check ffmpeg/whisper” diagnostics; open logs.

### Design (Apple-sleek — non-negotiable)
- **D1.** Tokens in `packages/shared/design-tokens.css`; fonts `-apple-system, SF Pro`; light `#F5F5F7`/surface white; dark `#1D1D1F`/surface `#2C2C2E`; text `#1D1D1F`/`#F5F5F7`; accent **#635BFF** (violet), success `#30D158`, danger `#FF453A`; radius 12 (cards) / 8 (controls) / full (pills); spacing 4-grid; SF Symbols-style icons (inline SVG set, stroke 1.8); focus rings accent 2px; **no glow/blur/shadow as highlight** — hierarchy via solid fills, borders, contrast, scale. Subtle elevation shadows allowed (cards: 0 1px 3px rgba(0,0,0,.08)).
- **D2.** Main window: `titleBarStyle: 'hiddenInset'`, translucent sidebar (vibrancy `sidebar`), 100% keyboard navigable, 60fps interactions, hover states everywhere, spring-ish transitions ≤200ms.
- **D3.** Every visual is real — no placeholder blocks, no dead buttons, no lorem ipsum. Empty states designed. Error states human.
- **D4.** Share/watch pages match the same design language (self-contained CSS).

---

## 4. Data model

`meta.json` per video (and mirrored in server DB):
```ts
interface VideoMeta {
  id: string;            // nanoid(10), also share id
  title: string;
  description?: string;
  createdAt: string;     // ISO
  durationSec: number;
  width: number; height: number; fps: number;
  sizeBytes: number;
  mode: 'screen-cam' | 'screen' | 'cam';
  folderId?: string | null;
  share?: { provider: 'server'|'s3'; url: string; uploadedAt?: string;
            privacy: 'link'|'password'; allowComments: boolean; allowReactions: boolean;
            allowDownload: boolean; cta?: { label: string; url: string } };
  transcript?: { language: string; engine: string };
  ai?: { title?: string; summary?: string;
         chapters?: { t: number; title: string }[];
         tasks?: string[] };
  customThumb?: boolean;
  edits?: { trimmedFrom?: string };
}
```
Library index = scan of save folder (`*/meta.json`) + `library.json` cache (folders, order).
Settings via `electron-store`; secrets via `safeStorage` (stored as encrypted strings in the store).

Server SQLite: `videos(id, title, description, created_at, duration_sec, width, height, size_bytes, status, privacy, password_hash, allow_comments, allow_reactions, allow_download, cta_label, cta_url, chapters_json, transcript_vtt_path, files_dir)`, `comments(id, video_id, parent_id, author, text, at_sec, created_at)`, `reactions(video_id, emoji, session_id, created_at, UNIQUE(video_id,emoji,session_id))`, `views(id, video_id, session_id, viewer_name, started_at, last_beacon_at, max_position_sec, coverage_json)`.

---

## 5. IPC contract (preload exposes `window.openloom`)

```ts
interface OpenLoomAPI {
  // capture
  listCaptureSources(): Promise<{ id: string; name: string; thumbnailDataUrl: string; display: boolean }[]>;
  listMediaDevices(): Promise<{ cameras: MediaDeviceInfo[]; mics: MediaDeviceInfo[] }>;
  startRecording(opts: RecordingOptions): Promise<void>;   // orchestrates windows + countdown; renderer of hidden recorder window does capture
  pauseRecording(): Promise<void>; resumeRecording(): Promise<void>;
  stopRecording(): Promise<{ videoId: string }>;
  cancelRecording(): Promise<void>; restartRecording(): Promise<void>;
  onRecordingState(cb: (s: RecordingState) => void): () => void; // idle|countdown|recording|paused|processing {elapsedSec}
  toggleCamera(on: boolean): void; toggleMic(on: boolean): void; toggleDraw(on: boolean): void;
  setBubbleSize(s: 'S'|'M'|'L'): void;
  // library
  listVideos(): Promise<VideoMeta[]>; getVideo(id: string): Promise<VideoMeta>;
  updateVideo(id: string, patch: Partial<VideoMeta>): Promise<VideoMeta>;
  deleteVideo(id: string): Promise<void>; duplicateVideo(id: string): Promise<VideoMeta>;
  revealVideo(id: string): void; fileUrl(id: string, file: string): string; // openloom-file:// protocol
  listFolders(): Promise<Folder[]>; createFolder(name: string): Promise<Folder>;
  renameFolder(id: string, name: string): Promise<void>; deleteFolder(id: string): Promise<void>;
  moveVideo(id: string, folderId: string|null): Promise<void>;
  searchVideos(q: string): Promise<{ id: string; matches: string[] }[]>;
  setCustomThumbnail(id: string, source: {path?: string; atSec?: number}): Promise<void>;
  // editor
  trimVideo(id: string, ranges: {start: number; end: number}[]): Promise<void>; // keep-ranges
  stitchVideos(id: string, appendId: string): Promise<void>;
  onJobProgress(cb: (j: {videoId: string; kind: string; pct: number; note?: string}) => void): () => void;
  // transcribe + AI
  transcribeVideo(id: string): Promise<void>; generateAI(id: string, kinds: string[]): Promise<void>;
  // share
  shareVideo(id: string): Promise<{ url: string }>;  // mints + starts upload
  unshareVideo(id: string): Promise<void>;
  updateShareSettings(id: string, patch: Partial<VideoMeta['share']>): Promise<void>;
  getShareActivity(id: string): Promise<ShareActivity>; // views, comments, reactions from server
  testShareProvider(cfg: unknown): Promise<{ ok: boolean; error?: string }>;
  // settings & system
  getSettings(): Promise<Settings>; setSettings(patch: Partial<Settings>): Promise<Settings>;
  pickDirectory(): Promise<string|null>; pickFile(filter: string): Promise<string|null>;
  getPermissions(): Promise<{ screen: string; camera: string; mic: string; ffmpeg: boolean; whisper: boolean }>;
  requestPermission(kind: string): Promise<void>; openSystemSettings(pane: string): void;
  installWhisper(): Promise<void>; onSetupLog(cb: (line: string) => void): () => void;
  fetchFfmpeg(): Promise<void>;
  copyToClipboard(text: string): void; openExternal(url: string): void;
  appInfo(): Promise<{ version: string; platform: string }>;
}
```
Register a custom `openloom-file://` protocol (main) that serves files from the library dir only
(path-traversal-safe) so `<video>`/`<img>` in renderer can play local files with range support.

**Recording orchestration:** capture + MediaRecorder run in a hidden “engine” renderer window
(has DOM, keeps main window free). Main process coordinates windows (HUD, bubble, countdown,
draw), shortcuts, state machine, and receives chunk buffers via IPC stream → temp file append.

---

## 6. Server HTTP API

Creator (Bearer `API_KEY`): `POST /api/videos` {meta} → {id, shareUrl, uploadUrl}; `PUT /api/videos/:id/files/:name?offset=N` (chunked/resumable, `video.mp4|thumb.jpg|preview.gif|captions.vtt`); `POST /api/videos/:id/complete`; `PATCH /api/videos/:id` (title/privacy/toggles/cta/chapters/password); `DELETE /api/videos/:id`; `GET /api/videos/:id/activity` → {views, uniqueViewers, completionRate, viewers[], comments[], reactions{}, viewsByDay[], coverage[]}.
Viewer (anonymous): `GET /v/:id` (+`?embed=1`); `GET /v/:id/stream` (range); `POST /v/:id/unlock` {password}; `GET|POST /v/:id/comments` {author,text,atSec,parentId}; `POST /v/:id/reactions` {emoji,sessionId}; `POST /v/:id/beacon` {sessionId, name?, positionSec, coverage}; `GET /v/:id/status`.

---

## 7. Testing requirements (what “done” means)

- **Unit/integration (vitest):** ffmpeg pipeline (remux, trim, concat, thumb, gif — against a generated sample video), library scan/CRUD, settings, provider adapters (S3 against MinIO-style mock or local fake, server against real server instance), search, VTT parsing, server API (spawn real server on temp dir: upload→watch→comment→react→beacon→activity→password→delete).
- **E2E (Playwright `_electron`):** launch app with `--test-mode` (fake webcam via Chromium flags `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`; capture source auto-pick first screen). Flows: first-run setup → record 5s screen+cam (real getDisplayMedia of test display) → auto-stop → processing → watch page plays (duration ≈5s, seekable) → speed change → trim to 2s → transcript (if whisper installed) → share to local server → open share URL in browser context → comment + reaction + beacons → activity shows them → delete.
- **macOS TCC note:** real screen capture needs Screen Recording permission for the Electron dev binary; test runner detects `denied` and reports a single actionable line (grant instructions) rather than failing obscurely.
- **Design QA:** screenshot key views (library empty/full, recorder picker, watch, share dialog, settings, share page light/dark) for human review — agents do NOT self-certify design.
- **Repo hygiene test:** `git grep` gate for secrets/tokens/absolute local paths/internal author or company references; `npm run lint` + `tsc --noEmit` clean; fresh `npm ci && npm run build` green; README instructions actually work start-to-finish.

## 8. Credits & prior art (for README)
Loom (the product we re-implement openly — no code, assets, or branding copied), Cap (Tauri/Rust, AGPL — architectural inspiration incl. instant-mode), Screenity (GPL extension), OpenScreen (MIT, archived). Open Loom is original MIT code.
