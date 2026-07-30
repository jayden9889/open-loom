# Getting started with Open Loom

Open Loom records your screen with your face on camera, keeps everything on your
Mac, and turns any recording into a link you can send. This is the five minute
tour: install it, record, and share.

Three short walkthrough videos go with this guide:

- **Record your first video** - the launcher, the modes, and the recording toolbar.
- **Connect your YouTube** - the one time Google setup, then one click publishing.
- **How Open Loom works** - the full tour of every feature.

(Links are on the [latest release](https://github.com/jayden9889/open-loom/releases/latest).)

## 1. Install and verify

Download `OpenLoom-0.1.2-arm64.dmg` from the
[latest release](https://github.com/jayden9889/open-loom/releases/latest) on an
Apple Silicon Mac. Before you open it, check it matches the published checksum -
the build is ad-hoc signed, so the signature alone proves nothing about who made
it:

```bash
shasum -a 256 -c SHA256SUMS.txt   # run in the folder with both files
# OpenLoom-0.1.2-arm64.dmg: OK
```

Drag Open Loom into Applications and open it. Because the build is not notarized,
macOS blocks it the first time. Allow it in **System Settings > Privacy &
Security > Open Anyway**. macOS remembers the choice.

On first launch a Setup screen checks four things and gives each a Fix button:
Screen Recording, Camera, Microphone and ffmpeg. Grant the ones you need. A
recording that comes out black almost always means Screen Recording is off.

## 2. Record your first video

1. Click **New recording** (sidebar or the menu-bar tray). The launcher opens on
   the left of your screen with a live camera preview.
2. Pick your **camera** and **microphone**. Toggle **Mic** off if you do not want
   sound.
3. Choose a mode at the bottom: **Full face** (your camera fills the whole video)
   or **Screen** (your screen with your face in a corner bubble). Your face stays
   in the recording either way. In Screen mode, click the display or single window
   you want to capture.
4. Click **Start recording**. After a short countdown you are live. Click during
   the countdown to skip it, or press Esc to cancel.

While recording, a small toolbar sits on the left. From it you can **pause**
(`Alt+Shift+P`), **stop and save** (`Cmd+Shift+L`), **restart** (`Cmd+Shift+R`),
mute the mic, and **draw on the screen** (`Control+1`). In Screen mode a small
slider at the bottom-centre flips the camera between **Full face** and **Face +
screen** live, mid-recording. Drawing is available on full-screen captures; it is
off in full-face view and for single-window captures.

When you press Stop, Open Loom turns the take into a clean, seekable MP4 and opens
it in the Watch view.

## 3. Where recordings live

Every recording is a folder inside your save folder (default
`~/Movies/OpenLoom`, change it in **Settings > General > Save folder**). Each
folder holds `video.mp4`, a thumbnail, a preview GIF, a transcript once you run
one, and a small `meta.json`. Move, back up or delete them with ordinary file
tools; **Reveal in Finder** is one click from any video.

## 4. Transcripts, titles and chapters (optional)

Open **Settings > Transcription** and pick an engine. **whisper.cpp** runs fully
offline on your Mac (nothing leaves the machine); the **Install whisper.cpp**
button clones, builds it and downloads the model for you. Or point Open Loom at
any OpenAI-compatible endpoint. With **Transcribe automatically** on, every new
recording is transcribed after it finishes processing.

Open **Settings > AI** and add your own provider (Anthropic, any
OpenAI-compatible endpoint, or a local Ollama) to have titles, summaries,
chapters and action items written from the transcript. Both are off by default,
and your keys are stored encrypted on your Mac.

## 5. Edit: cut the dead air

Open a recording, then **More actions (...) > Edit**.

- Click anywhere on the timeline to move the playhead; arrow keys nudge it.
- Press **S** to split at the playhead, then **Remove section** the part you do
  not want. Click a removed part to bring it back with **Restore**.
- **Remove quiet parts** finds every silent stretch and cuts them all in one go.
- Drag the two handles to trim the ends.
- `Cmd+Z` undoes any step (50 steps of history).

Nothing touches the file until you press **Save edit**. Even then, Open Loom keeps
the original until you choose **Keep edit** or **Revert**.

## 6. Publish to YouTube (optional)

One click uploads a recording to your own channel as unlisted and hands back the
link. It uses your own Google Cloud OAuth credentials - nothing is baked into the
app and there is no middle-man server. The one-time setup is in
[YOUTUBE-PUBLISH.md](YOUTUBE-PUBLISH.md).

## 7. Share a link (optional)

Sharing is off by default and every recording stays on your machine. When you
want links, choose a provider in **Settings > Sharing**:

- **Self-hosted OpenLoom Server** - a small Hono + SQLite service you run, with a
  hosted watch page, comments, reactions, analytics and password protection. Setup
  is in [SELF-HOSTING.md](SELF-HOSTING.md).
- **S3 bucket** - any S3-compatible bucket serves a static watch page.

Full details of the share dialog and viewer options are in [SHARING.md](SHARING.md).
