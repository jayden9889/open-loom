# Security policy

## Reporting a vulnerability

Report privately through GitHub's [Report a vulnerability][advisory] form on this repository, which
opens a draft advisory only you and the maintainers can see. **Please do not open a public issue for
anything exploitable.**

Include what you would need yourself to reproduce it: the version, how you installed it, the steps,
and what an attacker gains. If you have a proof of concept, attach it to the advisory rather than
posting it anywhere public.

You should get a first reply within a week. If a fix is warranted it ships in a release, and you get
credit in the notes unless you would rather not.

[advisory]: https://github.com/jayden9889/open-loom/security/advisories/new

## What is in scope

Open Loom is a local desktop app plus an optional share server you host yourself. Both are in scope,
and the server is the more interesting target because it is the part exposed to the internet:

- The share server (`packages/server`): the watch page, comments, reactions, analytics, password
  protection, and the upload and creator APIs.
- The desktop app: how recordings, settings and credentials are stored, the OAuth flows, and
  anything reachable through a share link or a file the app opens.

Things that are already known and deliberate, so not vulnerabilities:

- **Releases are ad-hoc signed, not notarized.** macOS blocks the first launch and you clear it in
  System Settings. This is a distribution gap, not a code flaw.
- **What the auto-updater trusts.** When `autoUpdate` is on, the app checks the GitHub releases feed
  for `jayden9889/open-loom` over HTTPS, verifies the download against the SHA-512 in that feed, and
  installs it on quit. Because the builds are not yet signed with a developer certificate, that chain
  proves the file matches the release feed - it does not independently prove the feed is authentic,
  so it rests on HTTPS and on GitHub holding the release. If that trust boundary is not one you want,
  turn `autoUpdate` off in Settings and update by hand; the app then makes no outbound call on its own.
- **A share link is a capability.** Anyone holding the URL can watch, unless you set a password on
  the video. That is how link sharing works.
- **Your API keys live on your machine.** Transcription and AI keys are stored encrypted at rest via
  the OS keychain, but a local process running as you can reach a lot; the app does not defend
  against an attacker who already has your user account.

## Handling your own data

The app is local-first and sends nothing anywhere by default. Once you turn on sharing, AI or
YouTube publishing, you are handing data to whatever you pointed it at - your own server, your S3
bucket, your model provider, your YouTube channel. Open Loom never proxies any of it through us,
because there is no us to proxy through.
