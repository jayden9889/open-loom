# Open Loom ↔ Loom feature parity map

Researched against Loom's July 2026 feature set (Atlassian-era docs + pricing). Statuses:
**✅ v1** shipped in this repo · **🔜 roadmap** planned, issue-tracked · **☁️ n/a** only
meaningful inside Loom's proprietary cloud/enterprise offering — Open Loom's equivalent is
noted where one exists.

## Recorder

| Loom feature | Loom plan gate | Open Loom |
|---|---|---|
| Screen + Camera mode | Free | ✅ v1 |
| Screen-only mode | Free | ✅ v1 |
| Camera-only mode | Free (720p cap) | ✅ v1 (no artificial cap) |
| Full screen / window capture | Free | ✅ v1 (per-display + per-window) |
| Browser-tab capture | Free (extension) | 🔜 roadmap (browser extension) |
| Camera bubble (circular, draggable) | Free | ✅ v1 |
| Bubble sizes S/M/L | Free | ✅ v1 |
| Hide/show camera mid-recording | Free | ✅ v1 |
| Switch face/screen layout mid-recording | Business+ | ✅ v1 (free — flip Screen+Camera / Camera full face / Screen only, live, both capture paths) |
| Flip / mirror camera | Free | ✅ v1 |
| Virtual backgrounds / blur | Free | ✅ via macOS camera effects (see Portrait row below; Background Replacement on macOS 15+) |
| Avatar mode | Paid | 🔜 roadmap |
| Mic + camera device pickers | Free | ✅ v1 |
| System (computer) audio | Free | ✅ v1 (macOS 14.2+, native loopback — no virtual driver) |
| Background noise suppression | Free | ✅ v1 (Chromium `noiseSuppression` constraint) |
| 3-2-1 countdown (toggle) | Free | ✅ v1 |
| Pause / resume | Free | ✅ v1 |
| Restart / cancel recording | Free | ✅ v1 |
| Recording control bar (timer, controls) | Free | ✅ v1 |
| Drawing tool while recording | Business+ | ✅ v1 (free — full-screen mode; ink holds while you talk, melts when you tap Done) |
| Click/mouse highlight | Business+ | ✅ v1 (free, optional accessibility permission) |
| Background blur (Portrait) + Studio Light | — | ✅ via macOS camera effects (Neural Engine matting inside the camera pipeline - the FaceCam pane shows live status and opens the system panel; Apple Silicon or Continuity Camera) |
| Confetti | Free | 🔜 roadmap |
| Global keyboard shortcuts (customisable) | Free | ✅ v1 |
| Menubar / tray quick-start | Free | ✅ v1 |
| Recording length limit | 5 min (Free) / unlimited (paid) | ✅ unlimited, always |
| 720p / 1080p / 4K quality | 720p Free, 4K paid | ✅ v1 — all free |
| Crash recovery of in-progress recording | — | ✅ v1 (Loom doesn't advertise this) |

## Library, watch page, editing

| Loom feature | Loom plan gate | Open Loom |
|---|---|---|
| Video library with thumbnails | Free (25-video cap) | ✅ v1 (uncapped, your disk) |
| Animated GIF hover previews | Free | ✅ v1 |
| Folders | Free | ✅ v1 |
| Spaces (team areas) | Paid | ☁️ n/a — nearest: shared self-host server library (🔜) |
| Search (titles + transcript) | Free | ✅ v1 |
| Watch page player | Free | ✅ v1 |
| Playback speeds 0.8–2.5× | Free | ✅ v1 (same steps) |
| Chapters with jump links | Business+AI | ✅ v1 (AI or manual) |
| Closed captions | Free | ✅ v1 |
| Custom thumbnail | Business+ | ✅ v1 |
| Trim (waveform editor) | Business+ | ✅ v1 |
| Split & delete middle sections | Business+ | ✅ v1 |
| Stitch clips together | Business+ | ✅ v1 |
| Edit by transcript | Business+AI | 🔜 roadmap |
| Text/arrow overlays post-record | Business+AI | 🔜 roadmap |
| Download MP4 | Free | ✅ v1 (it's your file) |
| Choose where videos are saved | — (cloud only) | ✅ v1 (Loom can't do this) |

## Transcription & AI

| Loom feature | Loom plan gate | Open Loom |
|---|---|---|
| Auto transcription (50+ languages) | Free | ✅ v1 (local whisper.cpp — private, offline; or any OpenAI-compatible endpoint) |
| Caption translation | Free | 🔜 roadmap |
| AI auto titles | Free | ✅ v1 (bring your own key: Anthropic / OpenAI-compatible / local Ollama) |
| AI summaries | Business+AI | ✅ v1 (BYO key) |
| AI chapters | Business+AI | ✅ v1 (BYO key) |
| AI tasks / action items | Business+AI | ✅ v1 (BYO key) |
| Filler word / silence removal | Business+AI | 🔜 roadmap |
| AI workflows (video→doc, video→Jira) | Business+AI | ☁️ n/a |

## Sharing & engagement

| Loom feature | Loom plan gate | Open Loom |
|---|---|---|
| Instant share link on stop (clipboard) | Free | ✅ v1 (link minted at stop; upload continues in background) |
| Publish to YouTube (unlisted) | — | ✅ v1 (guided manual publish: reveals the MP4, opens youtube.com/upload, copies the AI title, and captures the link you paste back; no API, because unaudited-API uploads are force-locked to private) |
| Hosted watch page | Free | ✅ v1 (your own OpenLoom Server — one Docker command — or any S3-compatible bucket with a static player page) |
| Emoji reactions | Free | ✅ v1 (server mode) |
| Time-stamped comments (threaded) | Free | ✅ v1 (server mode) |
| Video replies | Free | 🔜 roadmap |
| Viewer insights (who watched) | Free | ✅ v1 (server mode) |
| Engagement insights (completion rate) | Business+ | ✅ v1 (server mode, incl. watch-coverage strip) |
| Views over time | Business+ | ✅ v1 (server mode) |
| Password-protected videos | Business+ | ✅ v1 (server mode) |
| Email-gated / workspace-only privacy | Paid | ☁️ n/a — nearest: password + private server |
| Public link expiration | Enterprise | 🔜 roadmap |
| Disable comments / reactions / download | Free | ✅ v1 |
| CTA button on watch page | Business+ | ✅ v1 |
| Embed (iframe) | Free | ✅ v1 |
| Custom branding / player colours | Business+ | ✅ v1 (it's your server — CSS variables) |
| Custom domain | Business+ | ✅ v1 (point your domain at your server/bucket) |
| Integrations (Slack, Jira, Gmail…) | Varies | ☁️ n/a — the share link pastes anywhere; native integrations 🔜 |
| SSO / SCIM, admin controls, retention | Enterprise | ☁️ n/a (single-user tool; server is yours) |
| Mobile apps | Free | 🔜 roadmap |

## Why not YouTube-unlisted as the share backend?

Verified against Google's own docs (July 2026): videos uploaded through an **unverified
YouTube API project are locked to private** — viewers can't open them, and there is **no
appeal** (the only paths are a formal YouTube API audit of the app, or manual re-upload).
Uploads also sit in a dedicated ~**100 uploads/day per project** quota bucket shared by every
user of the app, and the `youtube.upload` OAuth scope requires Google app verification.
That breaks "record → link works instantly" for an installable open-source tool, so Open Loom
uses storage **you** own instead. Full analysis: `docs/SHARING.md`.

That said, Open Loom makes the manual path close to one gesture. The **Publish to YouTube
(unlisted)** helper on each recording reveals the MP4, opens `youtube.com/upload`, copies the AI
title ready to paste, and then captures the resulting `youtube.com` link straight back onto the
video as its shareable link (with a Copy button). It is a guided manual publish, never an
automated backend, precisely because the API path is force-locked to private.
