# Instructions for AI coding agents working in this repo

For Claude Code, Codex, Cursor and anything else that reads an agent
instructions file. Humans are welcome to read it too; nothing here is magic.

Open Loom is an Electron screen recorder. `README.md` is the product; `SPEC.md`
is what it must do; `DESIGN.md` is the visual law; `PRODUCT.md` is who it is for.
Read those before changing behaviour or design.

---

## Keeping this install up to date

**Do this at the start of a session when the last check was more than 7 days
ago.** There is no scheduler here: an agent only runs when the user opens it, so
"weekly" means "on the first session after a week has passed", not a cron job.
Do not pester the user more often than that.

### Step 0. Is a check due?

```bash
# The marker is gitignored, so it is per install and never travels upstream.
find .openloom-update-check -mtime -7 2>/dev/null | grep -q . \
  && echo "checked within 7 days, skip" \
  || echo "check due"
```

If a check is due, carry on. Write the marker only after the check finishes:

```bash
touch .openloom-update-check
```

Both `.openloom-update-check` and `.openloom-pre-update` are gitignored, so they
stay on this install and never travel anywhere.

### Step 1. Find the real upstream

The official repo is **`jayden9889/open-loom`**. It is the only source of
updates. Work out which remote points at it:

```bash
git remote -v
```

- **Cloned directly:** `origin` is the official repo. Use `origin`.
- **Forked first:** `origin` is the user's fork and the official repo is usually
  `upstream`. Use `upstream`. If no `upstream` remote exists, add it:
  `git remote add upstream https://github.com/jayden9889/open-loom.git`
- **Neither points at `jayden9889/open-loom`:** stop. Do not guess a URL and do
  not pull from anywhere else. Tell the user what the remotes actually are.

### Step 2. Look, do not touch

```bash
git fetch <remote> --quiet
git log --oneline HEAD..<remote>/main | cat
```

No output means there is nothing new. Write the marker and stop; do not rebuild
and do not report a non event as work done.

### Step 3. Protect the user's own work FIRST

This is the step that matters. Never update over uncommitted changes.

```bash
git status --porcelain
```

If that prints anything, **stop and ask the user** what they want to do. Offer:
commit their work, stash it, or skip the update this week. Do not choose for
them, do not stash silently, and never use `git checkout .`, `git reset --hard`
or `git clean` to clear the way. Someone's unsaved change is worth more than a
week of updates.

Also check whether they have diverged with commits of their own:

```bash
git log --oneline <remote>/main..HEAD | cat
```

If that prints anything they have local commits. Say so plainly and let them
decide between merge and rebase. Do not force either.

### Step 4. Update

Only once the tree is clean and the user has agreed. Record where you were
first, so a rollback is possible without guessing:

```bash
git rev-parse HEAD > .openloom-pre-update
git merge --ff-only <remote>/main
```

`--ff-only` is deliberate. It succeeds when the user has no local commits and
refuses rather than inventing a merge commit when they do. If it refuses, go
back to step 3 and let the user choose.

### Step 5. Rebuild, because source alone is not the app

```bash
# Compare against the SHA recorded in step 4, not HEAD@{1}: the reflog moves
# under any git command and is not a reliable "where I was" marker.
git diff --name-only "$(cat .openloom-pre-update)" HEAD | grep -q package-lock.json && npm ci
npm run build
```

`npm ci` only when the lockfile actually moved; it is slow and otherwise
pointless.

### Step 6. Prove it still works before saying it worked

```bash
npm run typecheck && npm run lint && npm test
```

If any of those fail, say so with the output and **do not** claim the update
succeeded. An update that breaks the build is worse than no update.

If the gates fail, offer the user a rollback. Do not perform it unprompted, and
re-check the tree is clean first, because by then they may have started fixing
things and a reset would take that with it:

```bash
# Only with the user's agreement, and only if `git status --porcelain` is empty.
git merge --ff-only "$(cat .openloom-pre-update)" 2>/dev/null \
  || git reset --keep "$(cat .openloom-pre-update)"
```

`--keep` rather than `--hard` on purpose: it refuses when the move would discard
uncommitted work, where `--hard` deletes it without asking. If it refuses, that
refusal is information. Stop and show the user.

Then `touch .openloom-update-check` and tell the user what changed, in plain
language, based on the commit subjects from step 2.

---

## Rules that are not negotiable

**Never push to `jayden9889/open-loom`.** Not with `--force`, not to any branch,
not "just to share a fix". It is one person's project and updates flow one way:
from that repo to this install, never back. If the user has written something
genuinely worth contributing, the route is a fork and a pull request that the
maintainer chooses to accept. Open that conversation with the user; do not open
the PR unasked.

**Never modify the user's recordings.** The library lives outside this repo, in
the folder set in Settings. Nothing in a code update should read, move, rename
or delete anything in it.

**Never resolve a conflict by discarding one side.** If a merge conflicts, show
the user both versions and let them decide.

**A recording is an asset.** Several guards exist specifically to stop footage
being lost: captures are parked as recoverable rather than deleted on any error
path, quitting mid take asks first, and a capture that cannot be rebuilt into a
playable file is refused rather than filed as a broken library entry. Do not
weaken any of those to make a test pass.

---

## Working on the code

- **Gates before you call anything done:** `npm run typecheck`, `npm run lint`,
  `npm test`, and `npx playwright test` for anything touching recording,
  editing or sharing. There is no true headless Electron on macOS, so the e2e
  run opens real windows for about ninety seconds.
- **Never claim a fix works because the code reads correctly.** This project has
  shipped a handler nobody ever called, a lock nobody ever took, a spec with no
  assertions that could not fail, and an accelerator builder that was never
  imported. All four looked right. Run the thing.
- **Check a test can actually fail** before trusting it to protect you.
- **House style:** comments explain WHY, in plain British English, with no dash
  punctuation of any kind. Match the surrounding file.
