# Decision log

Deviations from SPEC.md and notable build-time decisions land here, newest first.
Format: date · decision · why.

- 2026-07-13 · Floating recording launcher replaces the in-window New-recording modal, and the
  camera becomes non-optional (supersedes the SPEC R1 mode picker; additive IPC only). Open Loom
  is used to record proposal walkthrough videos, so the face is the product: (1) A slim
  always-on-top launcher window (`launcher.html`, `showLauncher` in windows.ts) pinned to the left
  edge of the primary display opens on app launch (once setup is complete), on tray "New
  recording", on the sidebar Record button and after Setup finishes. It carries a live camera
  preview, mic toggle + level meter, compact device pickers, a source grid in Screen mode, and a
  single bottom switch: Full face (`cam`) | Screen (`screen-cam`). It is capture-excluded, is
  destroyed while a recording runs (releasing its preview camera) and returns when the session
  goes idle - both driven from the `emitState` transition funnel in recorder-ipc.ts. (2) The
  'screen' (no-camera) mode is no longer offered anywhere: the launcher has two modes,
  `startRecording` forces `cameraOn: true` for `screen-cam`, the HUD camera on/off button is gone
  and the HUD layout switch cycles bubble <-> full only ('off' stays in the CameraLayout type for
  the IPC surface and legacy manifests; `RecordingMode` keeps 'screen' so old library metadata
  still parses). (3) `OpenLoomAPI` gains `openLauncher(): void`. (4) Start-time capture failures
  are now also broadcast on the recording-state channel (`hardResetSession(error)`) because the
  launcher window that initiated the start dies with the session, so an IPC rejection alone could
  land in a destroyed renderer. (5) The global start hotkey always records `screen-cam` with the
  camera on. NewRecording.tsx (the modal) is deleted; the e2e suite drives the launcher window.

- 2026-07-08 · Publish to YouTube (unlisted) helper (SPEC S7; additive to sections 4 + 5, no
  breaking changes). A guided MANUAL publish on the Watch view - not a share provider and not an
  API integration - because uploads through an unaudited YouTube API project are force-locked to
  private with no appeal (see S6). New IPC `youtubePublishStart(videoId)` reveals `video.mp4` (via
  the existing `revealVideo` / `shell.showItemInFolder`) and opens `youtube.com/upload` (via the
  existing `shell.openExternal`), copying the AI title to the clipboard when present;
  `youtubeSaveLink(videoId, url)` validates the pasted link with the pure, unit-tested
  `parseYouTubeUrl` (`apps/desktop/src/main/youtube-core.ts`), normalises it to a canonical
  `watch?v=` URL, and persists it through the existing library update path. `VideoMeta` gains
  `youtubeUrl?: string`. The renderer adds a header button next to Reveal/Share plus an inline
  three-step panel in the Watch details side-panel, then renders the saved link with a Copy button.
  No new dependencies.

- 2026-07-07 · Pre-publication security hardening (no behaviour change to the shipping app):
  (1) Every Electron window (main, HUD, bubble, countdown, draw, engine) now runs through
  `applyNavigationGuards` in `apps/desktop/src/main/windows.ts`: `setWindowOpenHandler` denies all
  renderer-initiated child windows (opening genuine http/https links in the user's browser instead),
  and `will-navigate` blocks navigation away from the app's own origin (vite dev server in dev,
  `file://` in prod).
  (2) Server watch/embed/processing/password/404 pages emit a strict CSP meta tag from `shell()`
  (`default-src 'none'` with self media/img, inline style+script, self connect, `base-uri 'none'`,
  `form-action 'self'`). Inline styles/scripts are allowed (`'unsafe-inline'`) because the pages are
  fully self-contained; no nonces.
  (3) The main renderer window's CSP `connect-src` allows `https:` and `http://localhost:*` so a
  user-configured share server / AI endpoint / Ollama (any host) keeps working; overlay/engine
  windows stay tight.
  (4) `openloom-file://` keeps `access-control-allow-origin: *`. It is REQUIRED: the Editor filmstrip
  loads frames with `crossOrigin='anonymous'` and calls `canvas.toDataURL()`, and in production the
  renderer runs from an opaque `file://` origin, so any narrowed ACAO taints the canvas. Safe because
  the scheme is path-traversal-restricted to the library dir and is unreachable from web pages.
  (5) Download integrity for setup scripts. `scripts/fetch-ffmpeg.mjs`: macOS artifacts are now
  pinned to a specific martin-riedl.de build (ffmpeg 8.1.2) and verified against hardcoded SHA256s
  (captured 2026-07-07) before extract/chmod/run; mismatch deletes the file and aborts. Windows
  (BtbN) and Linux (johnvansickle) publish ONLY rolling `latest`/`release` builds with no stable
  versioned URL, so a durable checksum cannot be pinned without breaking every future setup once
  upstream rebuilds; those paths keep the host, run the same download-then-verify structure, and log
  the observed SHA256 while allowing the download through (`KNOWN_SHA256` has no entry for them).
  `scripts/setup-whisper.sh`: the ggml model URL is pinned to HuggingFace commit
  `5359861c739e955e79d9a303bcbc70fb988958b1` (was `/resolve/main/`) and the downloaded `ggml-base.en`
  is SHA256-verified (`a03779c8…6d002`) before install; other models download with a skip-verify note.

- 2026-07-07 · Integration + polish pass (all additive to SPEC section 5, no breaking changes):
  (1) `OpenLoomInternal` gains `onToast(cb)` on the internal bridge. The share-on-stop flow (SPEC
  R14) runs in the main process, so main needs a channel to surface the "Link copied - uploading"
  toast to the renderer. Uses a new `ol:toast` broadcast; App.tsx pushes it into the existing toast
  provider.
  (2) Share-on-stop is wired in `recorder-ipc.ts` (`maybeAutoShareOnStop`): when a provider is
  configured and "Copy link on stop" (G6) is on, the moment a recording lands it mints the share
  URL via the existing `shareVideo`, copies it to the clipboard in main, and lets the upload run in
  the background. With no provider configured the recording simply lands in the library, no error.
  (3) ShareDialog (S4) and ActivityPanel (V3) were built but unmounted; they are now mounted in the
  Watch view (Share button opens the dialog; Activity tab renders the panel) and the Library card
  context menu ("Share…"). No new component logic, only wiring.
  (4) Library cards show a live upload badge driven by the existing `ol:job-progress` (kind
  'upload') events, with a Retry affordance on failure (SPEC R14 "failed-upload state with Retry").
  (5) Settings, Sharing "Test" buttons now call the real `testShareProvider` IPC (they previously
  showed a "follow-up module" notice). Masked secrets are resolved to the stored values in main.
  (6) electron-builder config added at `apps/desktop/electron-builder.yml` (appId org.openloom.app,
  productName OpenLoom; mac dmg+zip, win nsis, linux AppImage+deb; icons from assets/icon.png;
  assets copied as extraResources so the tray icon resolves at runtime, hence a new
  `process.resourcesPath` candidate in tray.ts). `npm run dist` added at root and in apps/desktop.

- 2026-07-06 · Foundation build decisions (all additive to SPEC section 5, no breaking changes):
  (1) OpenLoomAPI gains crash-recovery methods `listRecoverable` / `recoverRecording` /
  `discardRecoverable` (SPEC R8 requires recovery UX but section 5 had no surface for it).
  (2) `appInfo()` returns extra fields `osVersion` + `systemAudio` so the renderer can
  render the R4 unsupported-OS explainer without OS sniffing.
  (3) `RecordingState` gains `drawAvailable`, `processingNote`, `lastVideoId`, `error`
  so the HUD/main window can honour R10 (draw disabled in window capture) and R14.
  (4) Auxiliary windows (engine/HUD/bubble/countdown/draw) use a second bridge
  `window.openloomInternal` (typed in packages/shared/types.ts) - keeps the public
  contract exactly as specced.
  (5) Default title pattern uses a hyphen ("Recording - 6 Jul 2026, 14:32") - the house
  style bans em dashes in copy; SPEC L6's literal shows one.
  (6) Preload is built as CJS (.cjs) because sandboxed preloads cannot be ESM; main
  process is ESM.
  (7) packages/server is a dependency-locked placeholder package.json only; the server
  implementation is a follow-up module (editor/transcription/AI/sharing backends too -
  their IPC handlers reject with a clear human message and their Settings panes persist).
  (8) System audio uses Electron's native `audio: 'loopback'` in
  setDisplayMediaRequestHandler (Electron 43 >= 39); electron-audio-loopback stays a
  dependency for the sharing agent's older-Electron fallback but is not imported.

- 2026-07-06 · Repo bootstrapped: SPEC.md locked (Electron 43 + electron-vite + React,
  MediaRecorder pipeline, pluggable share providers, Hono+SQLite self-host server, MIT).
  YouTube-unlisted rejected as share backend after verification against Google docs
  (unverified-API-project uploads locked private, no appeal; ~100 uploads/day/project);
  see FEATURES.md and docs/SHARING.md.
