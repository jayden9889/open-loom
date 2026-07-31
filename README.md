<p align="center">
  <img src="assets/logo.svg" alt="Open Loom" width="140" height="140">
</p>

<h1 align="center">Open Loom</h1>

<p align="center">
  A local-first, open-source screen recorder with Loom-style sharing that runs on storage you own.
</p>

<p align="center">
  <a href="SPEC.md">Specification</a> &middot;
  <a href="FEATURES.md">Feature parity</a> &middot;
  <a href="docs/SHARING.md">Sharing</a> &middot;
  <a href="docs/YOUTUBE-PUBLISH.md">Publish to YouTube</a> &middot;
  <a href="docs/SELF-HOSTING.md">Self-hosting</a> &middot;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/jayden9889/open-loom/actions/workflows/ci.yml"><img src="https://github.com/jayden9889/open-loom/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-AGPL--3.0-635BFF" alt="AGPL-3.0 licence">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-635BFF" alt="Platform">
</p>

---

Record your screen with your camera, or just your camera. Everything lands as a plain, seekable MP4
in a library on your own disk. When you want to send a link, share through a share server you run yourself (hosted watch
page with comments, reactions and viewer analytics) or any S3-compatible bucket. No accounts, no
telemetry, no vendor lock. Free and open source under the AGPL-3.0.

<p align="center">
  <img src="docs/media/watch.png" alt="Open Loom watch view" width="49%">
  <img src="docs/media/share-dialog.png" alt="Open Loom share dialog" width="49%">
</p>
<p align="center">
  <img src="docs/media/watch-page.png" alt="Open Loom hosted watch page" width="70%">
</p>

## Watch how it works

A 65-second tour: recording with your face in the shot, drawing while you talk, cutting the dead
air, transcripts and AI, and the link you host yourself.

<p align="center">
  <a href="https://github.com/jayden9889/open-loom/releases/download/v0.1.3/open-loom-how-it-works.mp4">
    <img src="docs/media/how-it-works-poster.png" alt="Watch how Open Loom works" width="70%">
  </a>
</p>
<p align="center">
  <a href="https://github.com/jayden9889/open-loom/releases/download/v0.1.3/open-loom-how-it-works.mp4"><b>Play the tour</b></a>
</p>

Two shorter guides:
[your first recording](https://github.com/jayden9889/open-loom/releases/download/v0.1.3/open-loom-record-first.mp4)
(42s) and
[connecting YouTube publishing](https://github.com/jayden9889/open-loom/releases/download/v0.1.3/open-loom-connect-youtube.mp4)
(45s).

## Highlights

- **Face-first capture.** A slim always-on-top launcher with a live camera preview, and one switch
  between **Full face** and **Screen** (screen with your camera bubble composited in). Pick a whole
  display or a single application window. Every recording includes your camera by design - if you
  want screen capture with no webcam, Open Loom is not the tool for you.
- **Camera bubble.** Circular, draggable, three sizes, mirror toggle. In Screen mode a bottom-centre
  slider flips the camera between **Full face** and **Face + screen** live, mid-recording.
- **System audio.** Native loopback on macOS 14.2 and later, mixed with your microphone. No virtual
  driver.
- **Recording controls.** Countdown, pause and resume, restart, cancel, an on-screen control bar,
  configurable global shortcuts, a drawing tool and optional click highlights.
- **Crash recovery.** An interrupted recording is offered back to you on the next launch.
- **Library.** Thumbnail grid with animated hover previews, folders, and search across titles and
  transcripts. Uncapped, on your disk.
- **Watch and edit.** Custom player with speeds from 0.8x to 2.5x, captions and chapters. Trim, cut
  out middle sections, and stitch clips together.
- **Transcription and AI.** Local whisper.cpp (private and offline) or any OpenAI-compatible
  endpoint. Bring your own key for AI titles, summaries, chapters and action items, including local
  Ollama.
- **Sharing that works instantly.** The share link is minted and copied to your clipboard the moment
  a recording stops; the upload runs in the background. Watch pages carry timestamped comments,
  emoji reactions, viewer analytics, password protection and a call-to-action button.

The full comparison with Loom, feature by feature, is in [FEATURES.md](FEATURES.md).

## Requirements

- Node.js **20.19+ or 22.12+** (older 20.x releases fail to build: vite and electron-vite require
  those floors). `.nvmrc` pins a known-good version - `nvm use` picks it up.
- ffmpeg and ffprobe on your PATH. If they are missing, the first-run Setup screen offers a guided
  download of a static build.
- **Building from source on macOS:** Xcode Command Line Tools (`xcode-select --install`). One
  optional native addon (the FaceCam Portrait and Studio Light effects) compiles Objective-C++
  against AVFoundation at install time. Without the tools it fails quietly, `npm install` still
  succeeds, and the app runs with those two effects doing nothing - the reason only appears in the
  log. Everything else works.
- macOS 14.2 or newer for system-audio capture. The rest of the app works on macOS 13 and later.
- Windows and Linux builds ship from the same source and CI, but the maintainer develops on macOS,
  so those two get far less real-world mileage. Bug reports from them are especially welcome.

## Install the app

Grab your platform from the [latest release](https://github.com/jayden9889/open-loom/releases/latest):

| Platform | File |
|---|---|
| macOS, Apple Silicon | `OpenLoom-<version>-arm64.dmg` |
| macOS, Intel | `OpenLoom-<version>-x64.dmg` |
| Windows | `OpenLoom-<version>-x64.exe` |
| Linux, AppImage | `OpenLoom-<version>-x86_64.AppImage` (mark executable and run) |
| Linux, Debian and Ubuntu | `OpenLoom-<version>-amd64.deb` (`sudo dpkg -i`) |

`arm64` builds exist for every platform. Linux keeps its own architecture names,
so x86-64 reads as `x86_64` on the AppImage and `amd64` on the deb.

On macOS, drag Open Loom into Applications and open it.

**Verify the download first.** The build is ad-hoc signed, so the signature proves nothing about
who made it. Every release ships a `SHA256SUMS.txt`; check the file you downloaded matches before
you open it:

```bash
shasum -a 256 -c SHA256SUMS.txt   # run in the folder holding both files
# OpenLoom-0.1.4-arm64.dmg: OK
```

If it does not say `OK`, do not open it - you have a tampered or corrupted copy.

The build is ad-hoc signed but **not notarized**, so macOS will refuse it on first launch with
"Apple could not verify Open Loom is free of malware". To allow it: open **System Settings >
Privacy & Security**, scroll to the Security section, and click **Open Anyway** next to the Open
Loom message, then confirm. macOS remembers the choice. (The older right-click > Open trick was
removed in macOS 15 Sequoia; on macOS 14 and earlier it still works.)

It then lives in your menu bar and Dock.

On Windows, SmartScreen will warn about an unrecognised publisher for the same reason: the
installer is unsigned. Choose **More info** then **Run anyway**. Linux builds have no such gate.

New here? The [Getting started guide](docs/GETTING-STARTED.md) walks through your first recording,
connecting YouTube, editing, and sharing.

## Run from source

```bash
git clone https://github.com/jayden9889/open-loom.git
cd open-loom
npm install
npm run dev          # launches Electron with hot reload
```

To produce installers for your platform:

```bash
npm run dist         # builds and packages via electron-builder
```

`npm run dist` writes a dmg and zip on macOS, an NSIS installer on Windows, and AppImage and deb
packages on Linux, into `release/`.

## First run: permissions

The first launch opens a Setup screen that checks four things and gives each a Fix button.

- **Screen Recording (macOS).** Required to capture your screen. macOS shows a system prompt the
  first time; if you miss it, open System Settings, then Privacy and Security, then Screen and System
  Audio Recording, and enable Open Loom. A recording that comes out black almost always means this
  permission is off.
- **Camera.** Only needed for camera and screen-plus-camera modes. The Fix button triggers the macOS
  prompt.
- **Microphone.** Only needed when the mic is on. Same prompt path.
- **ffmpeg.** Needed to turn a raw capture into a seekable MP4. If it is not on your PATH, the Fix
  button downloads a static build into the app's data folder.

You can re-run these checks any time from Settings, then About.

## Choosing where videos are saved

Open Settings, then General, then Save folder, and pick any directory. Every recording is a folder
inside it holding `video.mp4`, a thumbnail, a preview GIF, a transcript and a small `meta.json`.
Move, back up or delete these with ordinary file tools. Reveal in Finder is one click from any video.

## Sharing

Sharing is off by default and every recording stays on your machine. When you want links, choose a
provider in Settings, then Sharing.

### Local only (default)

Nothing leaves your disk. You can still trim, transcribe, and reveal the MP4 to attach it to email or
drop it into any tool by hand.

### Self-hosted share server

`openloom-server` is a small Hono and SQLite service that delivers the full loop: hosted watch page,
comments, reactions, analytics and password protection.

```bash
cd packages/server
echo "API_KEY=$(openssl rand -base64 24)" > .env
echo "BASE_URL=https://videos.example.com" >> .env
docker compose up -d
```

Docker Compose reads `.env` automatically, so the key stays in a file that can be checked again
(`cat .env`) rather than only in scrolled-past terminal output. Put the same `API_KEY` and `BASE_URL`
into Settings, then Sharing, then use Test to confirm the app can reach it. A link only becomes
trustworthy once that domain is actually pointed at the box with HTTPS in front of it; the
recommended setup, a subdomain and automatic HTTPS with Caddy, plus the from-source path and
backups, is the full walkthrough in [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

### Cloudflare R2 (about five minutes)

Any S3-compatible bucket works. R2 is a good default because egress is free. Create a bucket, add a
public custom domain or dev URL, create an API token, then fill Settings, then Sharing, then S3 with
the endpoint, bucket, keys and public base URL, and press Test. Open Loom uploads the video plus a
self-contained static player page, so the share link is a plain public URL. Step by step in
[docs/SHARING.md](docs/SHARING.md).

## Transcription

Transcription runs locally with whisper.cpp or through any OpenAI-compatible endpoint. To set up the
local engine:

```bash
scripts/setup-whisper.sh
```

This clones and builds whisper.cpp (Metal on macOS) and downloads the `base.en` model. Settings, then
Transcription also has an Install whisper.cpp button that runs the same steps with a live log, or you
can point the two path fields at an existing `whisper-cli` binary and model. Turn on Transcribe
automatically to run it after each recording. Details in [docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md).

## AI features

AI titles, summaries, chapters and action items are generated from a video's transcript with a
provider you bring yourself. In Settings, then AI, pick Anthropic, an OpenAI-compatible endpoint, or
local Ollama, set the model and key, and press Test connection. Keys are stored encrypted with your
operating system keychain and never leave your machine except to the provider you chose. Ollama needs
no key and keeps everything local.

## Keyboard shortcuts

Global shortcuts work even when Open Loom is hidden, and are editable in Settings, then Shortcuts.

| Action | Default |
|---|---|
| Start or stop recording | Cmd+Shift+L |
| Pause or resume | Alt+Shift+P |
| Cancel recording | Alt+Shift+C |
| Restart recording | Cmd+Shift+R |
| Toggle drawing | Control+1 |

In the watch player:

| Action | Key |
|---|---|
| Play or pause | Space |
| Skip 5 seconds | Left / Right |
| Volume | Up / Down |
| Fullscreen | F |
| Captions | C |

## FAQ

**Why not YouTube unlisted as the share backend?** Videos uploaded through an unverified YouTube API
project are locked to private with no appeal, and uploads sit in a small shared daily quota. That
breaks "record, link works instantly" for an installable tool. Open Loom uses storage you own
instead. Full analysis in [docs/SHARING.md](docs/SHARING.md).

**Where are my videos?** In your save folder, as ordinary MP4 files you own. There is no cloud copy
unless you choose a share provider, and even then the original never leaves your disk.

**Do I need a server to use Open Loom?** No. Recording, the library, editing, transcription and AI
all work with sharing set to local only.

**Is anything sent anywhere?** No telemetry, ever. Network requests only happen when you share
(to your own server or bucket) or when you use an AI or transcription endpoint you configured.

## Troubleshooting

- **The recording is black.** macOS Screen Recording permission is off. Open System Settings, then
  Privacy and Security, then Screen and System Audio Recording, enable Open Loom, and restart it.
- **No system audio.** Loopback capture needs macOS 14.2 or newer. On older macOS the toggle is
  disabled with an explanation. Your microphone still records.
- **ffmpeg not found.** Install ffmpeg, or use the Setup screen (or Settings, then About) to download
  a static build.
- **Click highlights say unavailable.** The optional input hook could not load, or Accessibility
  permission is off. The rest of the app is unaffected.

## Scripts

```bash
npm run typecheck    # strict TypeScript across all workspaces
npm test             # vitest unit and integration tests (needs ffmpeg on PATH)
npm run build        # production build (apps/desktop/out)
npm run dist         # package installers via electron-builder
npm run e2e          # Playwright smoke test against the built app
npm run lint         # eslint
npm run make:icons   # regenerate assets/icon.png and tray templates
npm run make:sample  # generate a 5s H.264 sample video for tests
```

Running and testing details are in [docs/TESTING.md](docs/TESTING.md).

## Repo layout

npm workspaces: `apps/desktop` (Electron app, split into main, preload and renderer),
`packages/shared` (types and design tokens), `packages/server` (the self-hosted share server). The
full tree is in [SPEC.md](SPEC.md) section 2.

## Credits and prior art

Open Loom re-implements the Loom product experience openly. No Loom code, assets or branding are
copied. It also stands on the shoulders of earlier open-source recorders as prior art: Cap
(Tauri and Rust, AGPL, source of the instant-share idea), Screenity (a GPL browser extension), and
OpenScreen (MIT, archived). Open Loom is original code.

## Licence

GNU Affero General Public License v3.0 or later, copyright Jayden Mortimer. In plain words: use it,
modify it, share it, run it at work, sell it if you like - all free. The one obligation is
reciprocity. If you distribute a modified version, or run one as a service other people use over a
network, you have to publish your changes under the same licence.

Licence history: v0.1.1 and earlier shipped under plain MIT, v0.1.2 and v0.1.3 under MIT with the
Commons Clause. Those releases stay under the licence they shipped with. See [LICENSE](LICENSE).
