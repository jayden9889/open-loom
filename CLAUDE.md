# Open Loom

Claude Code reads this file automatically when you open the project.

**The instructions live in [`AGENTS.md`](AGENTS.md). Read that now.**

It is a single file so the guidance cannot drift between tools: Codex, Cursor
and anything else that looks for an agent instructions file read the same copy.

The short version, so nothing important depends on a second click:

- **Check for updates on the first session of a week.** Full procedure in
  `AGENTS.md`. It fetches from `jayden9889/open-loom`, refuses to touch a dirty
  working tree, fast-forwards only, rebuilds, and runs the gates before telling
  you it worked.
- **Never push to `jayden9889/open-loom`.** Updates flow one way: from that repo
  into this install, never back. Contributions go through a fork and a pull
  request the maintainer chooses to accept.
- **Never destroy the user's work to make an update fit.** No `reset --hard`, no
  `checkout .`, no `clean`, no silent stash. Ask.
- **Recordings are assets.** They live outside this repo and no code update
  should read, move or delete them.
- **Gates before "done":** `npm run typecheck`, `npm run lint`, `npm test`, plus
  `npx playwright test` for recording, editing or sharing changes. Run the app;
  do not conclude from reading that something works.
