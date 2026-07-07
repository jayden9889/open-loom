# Contributing to Open Loom

Thanks for helping build Open Loom. It is MIT-licensed and community-driven. This guide covers the
setup, the layout, and the bar a change needs to clear before it merges.

## Getting set up

```bash
git clone https://github.com/jayden9889/open-loom.git
cd open-loom
npm install
npm run dev
```

You will need Node.js 20 or newer, and ffmpeg and ffprobe on your PATH (the tests use them). See the
[README](README.md) for the first-run permissions walkthrough.

## Repo layout

This is an npm workspaces monorepo.

- `apps/desktop` the Electron app, split into `src/main` (Node, privileged), `src/preload` (the typed
  context bridge) and `src/renderer` (React UI).
- `packages/shared` shared TypeScript types and design tokens. The IPC contract and data model live
  in `types.ts` and are the single source of truth.
- `packages/server` the self-hosted share server (Hono and SQLite).
- `docs` product and operations documentation.
- `scripts` helper scripts (icons, sample video, ffmpeg fetch, whisper setup).

[SPEC.md](SPEC.md) is the authoritative specification. Any deviation from it is recorded in
[docs/DECISIONS.md](docs/DECISIONS.md), newest first.

## Ground rules

- **TypeScript strict.** No `any` escapes without a clear reason. `npm run typecheck` must pass.
- **Respect the IPC contract.** New capability that crosses the main/renderer boundary is added to the
  `OpenLoomAPI` (or the internal bridge) in `packages/shared/types.ts`, wired in `preload`, and
  handled in `main/ipc.ts`. Do not reach around the bridge; context isolation stays on and Node
  integration stays off.
- **Electron security.** Privileged work (filesystem, spawning ffmpeg, network for sharing) lives in
  the main process. The renderer talks to it only through the preload bridge.
- **Design is law.** Follow SPEC section 3, D1 to D4: the Apple-sleek tokens in
  `packages/shared/design-tokens.css`, real empty and error states, and no glow, blur or shadow used
  as a highlight device. British English in copy, and no em dashes (use hyphens or full stops).
- **Guard platform-specific APIs.** macOS is the tested target; keep Windows and Linux paths from
  crashing even where they are not yet exercised.
- **No secrets, no local paths, no personal or company names** in committed files. Keys go through the
  operating system keychain at runtime, never into the repo.
- **Everything works.** No placeholder blocks, no dead buttons, no TODO stubs, no lorem ipsum. If a
  control is visible, it does something real.

## Before you open a pull request

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

All four must be green. Add or update tests for behaviour you change, especially in the ffmpeg
pipeline, the library, and the share providers. See [docs/TESTING.md](docs/TESTING.md).

## Commits and pull requests

- Keep commits focused and their messages in the imperative mood.
- Describe what changed and why in the pull request, and link the relevant SPEC requirement (for
  example R14, S3, G6).
- If you deviate from SPEC.md, add a dated entry to `docs/DECISIONS.md` and reference it.

By contributing you agree that your contribution is licensed under the MIT Licence.
