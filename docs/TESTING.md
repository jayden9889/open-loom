# Testing

Open Loom has two test layers: fast unit and integration tests with vitest, and an end-to-end smoke
test with Playwright driving the real Electron build.

## Prerequisites

- Node.js 20 or newer, and `npm install` run once.
- **ffmpeg and ffprobe on your PATH.** The ffmpeg pipeline tests generate and process a real sample
  video, so they need working binaries.

## Unit and integration tests (vitest)

```bash
npm test           # run once
npx vitest         # watch mode
npx vitest run apps/desktop/src/main/__tests__/ffmpeg.test.ts   # a single file
```

What is covered:

- **ffmpeg pipeline** against a generated sample: remux, transcode, trim, concat, thumbnail, GIF and
  waveform.
- **Library** scan and CRUD, folders, search, and the path-traversal-safe `openloom-file://` protocol.
- **Settings** load, merge and secret masking.
- **Editor** trim, cut and stitch planning.
- **Transcription** VTT parsing and provider selection.
- **AI** prompt building and response parsing.
- **Share providers** against a real, spawned server instance (upload, watch, comment, react, beacon,
  activity, password, delete).

The server tests spawn `openloom-server` on a temporary directory and a free port, so they exercise
the real HTTP API rather than a mock.

## End-to-end smoke test (Playwright)

The E2E test launches the packaged main process, asserts the typed preload bridge is present, and
confirms the app boots to Setup or Library with no renderer console errors.

```bash
npm run build      # build first: the test loads apps/desktop/out/main/index.js
npm run e2e
```

The test skips itself if the build is missing rather than failing obscurely.

### macOS permission note

Real screen-capture flows need Screen Recording permission granted to the Electron binary that runs
the test. Without it, capture streams come back empty. The runner detects the denied state and reports
a single actionable line with grant instructions rather than failing deep inside a capture call. Grant
it under System Settings, then Privacy and Security, then Screen and System Audio Recording.

## Before opening a pull request

```bash
npm run typecheck  # strict TypeScript, all workspaces
npm run lint       # eslint, must be clean
npm test           # all unit and integration tests green
npm run build      # production build succeeds
```
