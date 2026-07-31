# Releasing Open Loom

Releases are built by CI, not on a laptop. Push a `v*` tag and
`.github/workflows/release.yml` builds macOS, Windows and Linux, writes one
`SHA256SUMS.txt` covering every artifact, and opens a draft release.

```bash
npm version 0.1.4 --workspaces --include-workspace-root --no-git-tag-version
git commit -am "v0.1.4"
git tag v0.1.4
git push origin main v0.1.4
```

Then review the draft release on GitHub, check the checksums file lists every
artifact you expect, and publish it.

Use **workflow_dispatch** to rehearse the full matrix on a branch without
publishing anything.

## macOS signing and notarization

Without an Apple Developer account the macOS build is ad-hoc signed. It runs,
but Gatekeeper blocks it on first launch and users have to right-click and
choose Open. For a screen recorder, which by definition sees everything on
someone's display, that is a bad first impression and it costs installs.

Notarization removes it. It needs the [Apple Developer
Program](https://developer.apple.com/programs/) at 99 USD a year, then four
repository secrets:

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE_P12` | Your **Developer ID Application** certificate, exported from Keychain Access as `.p12`, then base64-encoded (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set on that `.p12` export |
| `APPLE_ID` | The Apple ID email on the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from [account.apple.com](https://account.apple.com), **not** your Apple ID password |
| `APPLE_TEAM_ID` | The 10-character Team ID from the developer account membership page |

Getting the certificate: in the Apple Developer portal create a **Developer ID
Application** certificate, download it, double-click to install it into
Keychain, then export it from Keychain Access as `.p12` with a password.

The workflow checks for `APPLE_CERTIFICATE_P12` and takes the signed path only
when it is present, so the build keeps working before the account exists.

The app already ships the hardened runtime and
`build/entitlements.mac.plist`, which is what notarization requires. The
entitlements hand back JIT, unsigned executable memory, library validation for
ffmpeg, and the camera and microphone devices. Without them a hardened build
launches to a blank window.

## Windows and Linux

Both build unsigned. Windows SmartScreen will warn on the installer until the
project has either an EV code-signing certificate or enough download reputation.
Linux AppImage and deb have no equivalent gate.

## What ships

| Platform | Artifacts |
|---|---|
| macOS | `.dmg` and `.zip`, arm64 and x64 |
| Windows | NSIS `.exe`, x64 and arm64 |
| Linux | `.AppImage` and `.deb`, x64 and arm64 |

ffmpeg is not bundled. The app fetches a static build on first run. macOS
downloads are sha256-pinned in `scripts/fetch-ffmpeg.mjs`; Windows and Linux
pull rolling upstream builds that have no stable versioned URL to pin against,
which is noted in that file.
