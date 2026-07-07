# Transcription

Open Loom transcribes recordings so you get captions in the player, clickable and searchable
transcript lines, search across your whole library, and a source for AI titles, summaries and
chapters. Transcription is pluggable: run it locally with whisper.cpp, or point it at any
OpenAI-compatible endpoint. It is also the input for the AI features, which stay off until you
configure a provider.

## Local, private: whisper.cpp

whisper.cpp runs entirely on your machine (Metal-accelerated on macOS). Nothing is sent anywhere.

The quickest path is the helper script:

```bash
scripts/setup-whisper.sh
```

It clones and builds whisper.cpp, downloads the `ggml-base.en` model, and prints the resolved
`whisper-cli` binary and model paths. Options:

- `--dest <dir>` install root (defaults to the OpenLoom application-support directory)
- `--model <name>` model to download (default `base.en`)

From inside the app you can do the same thing with a live log: Settings, then Transcription, then
Install whisper.cpp. If you already have whisper.cpp, point the two path fields at your `whisper-cli`
binary and a `ggml-*.bin` model instead.

Building needs a C toolchain, and cmake for recent whisper.cpp checkouts. The script falls back to an
older Makefile-based tag when cmake is unavailable.

## Any OpenAI-compatible endpoint

If you would rather use a hosted service, choose API endpoint in Settings, then Transcription, and
set:

- Endpoint: any `/v1/audio/transcriptions` compatible URL
- Model: the model name the endpoint expects (for example `whisper-1`)
- API key: stored encrypted with your operating system keychain

## Language and automation

- **Language.** Leave it at `auto` to let whisper detect, or force a BCP-47 code like `en`.
- **Transcribe automatically.** Turn this on to run transcription after every recording finishes
  processing. The transcript, VTT captions and a word or segment JSON are written next to the video.

## Re-running

You can transcribe an existing video at any time from the Watch view, Transcript tab. Editing a video
(trim, cut, stitch) regenerates thumbnails and previews automatically and offers to re-run the
transcript.
