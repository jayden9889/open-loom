## Open-Source Loom-Alternative Landscape (verified July 2026)

### Target to clone: what Loom actually is
Loom = (1) frictionless capture (screen + webcam bubble, system audio + mic), (2) **instant share link** created the moment you stop (video uploads *while* recording so the link is warm on stop), (3) a hosted viewer page with reactions/emoji, threaded + timestamped comments, (4) auto-transcript + AI titles/summaries/chapters, (5) viewer analytics (views, watch-through, who watched), (6) light trim/stitch editing, (7) workspaces/folders/permissions. The instant-link + hosted-viewer + async-comments loop is the actual moat, not the recorder. No single OSS project replicates all of it; the recorders nail capture/edit and the web apps nail sharing, and only Cap spans both.

---

### Cap (cap.so / CapSoftware/Cap) — the clear leader, closest to a true Loom clone
- **Repo/activity:** github.com/CapSoftware/Cap, **~20,000 stars, 1.7k forks, 79 releases**, latest **v0.5.3 (1 July 2026)**; 333 open issues, 163 open PRs — most active and most-starred in the space.
- **License (mixed, important):** **AGPLv3** for the platform; **MIT** for the `cap-camera*` and `scap-*` Rust crate families (reusable capture crates deliberately permissively licensed). AGPLv3 means a hosted fork must publish source — relevant to "learn from, not blindly copy."
- **Stack:** Desktop = **Tauri v2 + Rust** (44% Rust / 51% TS). Web/dashboard = **Next.js 15 + SolidStart + Tailwind**, backend on **Effect (`@effect/platform`)**, **Drizzle ORM + MySQL**, Docker Compose, deploys to Railway/Coolify.
- **Loom features covered:** "fast screen recording, polished local editing, **instant share links**, comments, transcripts, analytics, team workspaces, custom domains, custom S3 storage, and full self-hosting." Two capture modes: **Instant Mode** (uploads during recording so the link is ready on stop — Loom's core trick) and **Studio Mode** (record locally at high quality, edit, then share).
- **Self-hosting:** Best-in-class. Cap Cloud, or bring-your-own **S3-compatible** bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi), or fully local, or self-host the whole platform incl. custom domains.
- **Gaps:** no mobile app; real-time collab beyond comments is thin; advanced video effects minimal vs Screen Studio-class tools. macOS system-audio capture rides on ScreenCaptureKit (see hard-problems below), a recurring issue source.
- **Lesson:** the winning architecture is **Tauri (Rust) desktop for capture/perf + Next.js web app for the share/viewer/analytics loop + pluggable S3 storage**, with instant-upload-during-record as the headline behaviour.

### Screenity (alyssaxuu/screenity) — leader among browser-extension recorders
- **Repo/activity:** **~18.4k stars, 71 releases**, latest **v4.5.3 (19 June 2026)**, very low open-issue count (9). **GPL-3.0**.
- **Stack:** **Chrome Extension, Manifest V3**, ~87% JavaScript, SCSS/CSS, minor TS. Chromium-only (Chrome/Edge/Brave/Arc). No desktop binary, no server.
- **Covers:** unlimited tab/area/desktop/app/camera recording; **mic + internal (system) audio + push-to-talk**; on-screen annotation (draw/text/arrows/shapes), click/cursor highlight, spotlight; **blur sensitive content**; AI camera backgrounds/blur; smooth zoom; in-editor cut/trim/crop, add/remove audio; export **MP4/GIF/WebM**; save to **Google Drive** for a share link. No watermark, no time limit, records **locally/offline**.
- **Lacks (vs Loom):** no native hosted viewer, no comments/analytics/transcripts, no instant-link infra (sharing = Google Drive link). Multi-scene editing, caption generation, zoom keyframes are gated behind **Screenity Pro** (paid) — so the "free" repo is deliberately capped.
- **Lesson:** MV3 extension = fastest path to zero-install browser capture, but it structurally can't deliver the hosted-share loop; sharing gets outsourced to Drive.

### OpenScreen (siddharthvaddem/openscreen) — Screen-Studio-class editor, now ARCHIVED
- **Repo/activity:** **39.2k stars, 2.9k forks, 13 releases**, latest **v1.5.0 (6 June 2026)** — but **archived 17 June 2026, no longer maintained**. Community successor: **github.com/EtienneLescot/openscreen**. **MIT.**
- **Stack:** **Electron** (not Tauri) + **PixiJS** for GPU compositing; ~82% TS, 9% C++, 1.7% Swift. Cross-platform (macOS Homebrew, Windows winget, Linux .deb/pacman/AppImage).
- **Covers:** screen/window capture, **mic + system audio**, webcam PiP overlays, **auto-zoom that follows cursor**, custom cursors, **on-device automatic captions (offline, no upload)**, backgrounds, motion blur, **timeline editing**, annotations, export MP4/GIF. Positioned as a **Screen Studio** alternative, not Loom.
- **Lacks:** **no cloud sharing, no collaboration, no hosted links, no analytics** — local-export only. This is the polished-demo-video niche, not async messaging.
- **Lesson:** proves an OSS local editor can rival paid Screen Studio, and that on-device captions + auto-zoom are achievable offline — but a single-maintainer desktop app archived even at 39k stars (sustainability warning).

### open-recorder (imbhargav5/open-recorder) — tiny native-Swift ScreenStudio alt
- **Repo/activity:** small (**~64 stars**, 47 releases, latest **v0.2.33, 27 June 2026**, 1,472 commits). **Apache-2.0.**
- **Stack:** **native Swift (91%) + Rust service backend (2.7%)**, ~37 MB, **macOS only**. Native editor (styling, backgrounds, cursor overlays, zoom), facecam, **system audio + mic**, export MOV/MP4/GIF/PNG.
- **Lacks:** macOS-only; no sharing/hosting/collab. Interesting as a "Swift UI + durable local Rust service" pattern and for tiny binary size.

### Screego (screego/server) — live screen SHARING, not recording
- **Repo/activity:** **10.4k stars, 714 forks, 50 releases**, latest **v1.12.4 (13 May 2026)**. **GPL-3.0.**
- **Stack:** **Go (53%) + TypeScript (46%), WebRTC**, bundled **TURN** server for NAT traversal. Ships as single Go binary or Docker container — trivial self-host.
- **Scope:** explicitly **live P2P screen-share only** ("only helps to share your screen. Nothing else") — **no recording, no async, no viewer page.** Not a Loom clone; relevant only as a reference for clean WebRTC + self-contained-binary distribution. Do not model Open Loom on it.

### Snapify (MarconLP/snapify) — web-only self-hostable Loom clone
- **Repo/activity:** **~1.0k stars, 134 forks**, 317 commits, **no tagged releases**. **AGPLv3.**
- **Stack:** **Next.js / T3-style** (96% TS), **Prisma**, **NextAuth** (GitHub OAuth), **AWS S3 / Backblaze B2**. One-click Vercel deploy; MySQL via Railway.
- **Covers:** browser recording (tab/desktop/app via `MediaRecorder`/`getDisplayMedia`), **public share links, expiration + unlisted options**, upload existing videos. This is the closest pure-web self-hosted Loom link-sharing loop.
- **Lacks:** **browser-only, no desktop app**, no documented **system-audio** capture, no transcripts/comments/analytics, no editor, no active release cadence. Good architectural reference for the share/viewer/storage half; thin on capture quality and the async layer.

### Also-rans / adjacent (named across sources, verify before relying)
- **OBS Studio** — GPL, the gold-standard cross-platform recorder/streamer; heavyweight, no async-share loop, not a Loom UX. Reference for capture pipelines only.
- **ShareX** — Windows-only, GPL, 80+ upload destinations; power-user capture+upload, no hosted viewer/async.
- **Kap (wulkano/kap)** — macOS Electron recorder w/ plugins; historically the go-to but development has stalled (its long-open "record computer audio" issue #145 is a canonical example of the system-audio pain). Treat as legacy.
- **Capso (lzhgus/Capso)** — Swift 6 / SwiftUI native macOS screenshot+recorder, CleanShot-X-style; ships a `CaptureKit` ScreenCaptureKit wrapper + editor/timeline; small/new.

---

### Hard problems the READMEs/issues expose (design these deliberately)
1. **System audio capture is the single hardest cross-platform problem.**
   - **macOS:** must use **ScreenCaptureKit** (14.4+ for clean system audio). Well-documented failure modes across projects: **`SCStreamErrorDomain -3805` (connectionInvalid)** and streams that "start" but **never fire the audio sample-buffer callback** even with audio playing (pyobjc #647). Reference impl: **insidegui/AudioCap** (macOS 14.4+). Cap ships MIT `scap-*` crates precisely to solve this reusably.
   - **Electron** still lacks first-class loopback audio — tracked in **electron/electron #47490** (request to use ScreenCaptureKit for loopback). Choosing Electron inherits this gap.
   - **Kap #145** ("record computer audio") is the archetypal years-open request.
   - **Windows** = WASAPI loopback; **Linux** = PulseAudio/PipeWire monitor sources — each a separate code path. Budget for three OS-specific audio backends.
2. **Instant links require upload-during-record**, not upload-on-stop. Cap's "Instant Mode" streams chunks to S3 while recording so the link is warm on stop; Snapify/browser tools upload after stop (slower). This is the feature users feel as "Loom-fast."
3. **Editing = a real timeline/compositor.** OpenScreen leans on **PixiJS** (GPU), Capso/Cap build native timeline/preview/export. Auto-zoom-follows-cursor, backgrounds, and motion blur are compute-heavy — the differentiator between "recorder" and "Screen-Studio-class."
4. **On-device transcription/captions** are now table-stakes and doable offline (OpenScreen generates captions on-device, no upload) — likely local Whisper-class models. Loom's AI summaries/chapters are the unmatched layer in OSS.
5. **Storage pluggability** is how every serious project handles self-hosting: S3-compatible (R2/B2/MinIO/Wasabi) is the de-facto contract. Bake it in from day one.

---

### Architectural choices the successful ones made (converged pattern)
- **Winner = Tauri v2 + Rust desktop** (Cap) over Electron: smaller binary, native ScreenCaptureKit/WASAPI access, better perf. Electron (OpenScreen, Kap) works but inherits the loopback-audio gap and heavier footprint. Native Swift (open-recorder, Capso) wins on size/perf but forfeits cross-platform.
- **Split architecture:** Rust/native **desktop capture engine** + **Next.js web app** for the share/viewer/comments/analytics loop + **pluggable S3 storage**. Neither half alone is a Loom clone.
- **Two-mode recording** (Instant upload-while-recording vs Studio local-high-quality-then-edit) is Cap's key UX insight — worth copying directly.
- **Licensing:** AGPLv3 for the app + MIT for reusable capture crates (Cap's model) protects the hosted product while letting the hard-won capture code be shared/credited.

### Gaps that justify a new "Open Loom"
- **No OSS project fully closes the async-messaging loop**: threaded + timestamped **comments**, **emoji reactions**, **viewer analytics** (who watched, watch-through, engagement graph), and **AI summaries/chapters/action-items**. Cap has comments/transcripts/analytics but they're the least mature part; everyone else has none.
- **Cross-platform system audio that just works** remains unsolved end-to-end — a project that ships reliable macOS+Windows+Linux loopback out of the box would be genuinely differentiated.
- **Sustainability gap:** the best pure editor (OpenScreen, 39k stars) was **archived June 2026**; leading projects are effectively single-maintainer. A well-governed, truly installable/self-hosted clone has an open lane.
- **True one-command self-host of the *full* Loom experience** (capture desktop app + hosted viewer + comments + analytics + local S3/MinIO) in one Docker compose — Cap is closest but complex (MySQL + Effect + Solid + Next); a simpler, batteries-included self-host would win adopters.
- **Net:** Open Loom's reason to exist = **Cap's split architecture (Tauri capture + web share loop + pluggable S3) + reliable cross-platform system audio + the async layer (comments/reactions/analytics/AI summaries) done well + genuinely simple self-host.** Credit Cap/Screenity/OpenScreen; reuse Cap's MIT `scap-*`/`cap-camera*` capture crates rather than reimplementing ScreenCaptureKit from scratch.