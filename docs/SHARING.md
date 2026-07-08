# Sharing

Open Loom keeps every recording on your disk. Sharing is opt-in and provider-based. Pick a provider
in Settings, then Sharing.

| Provider | What you get | What it needs |
|---|---|---|
| **Local only** (default) | Nothing leaves your machine | Nothing |
| **OpenLoom Server** | Hosted watch page, timestamped comments, emoji reactions, viewer analytics, password protection | A small container you run (see [SELF-HOSTING.md](SELF-HOSTING.md)) |
| **S3 bucket** | Public static watch page on storage you own | Any S3-compatible bucket (R2, B2, MinIO, AWS) |

The share link is minted and copied to your clipboard the moment a recording stops (when Copy link on
stop is on). The upload then runs in the background with a progress badge, retries on failure, and
the watch page shows a processing state until the file arrives.

## OpenLoom Server provider

This is the full Loom loop. Run the server (see [SELF-HOSTING.md](SELF-HOSTING.md) for the
recommended domain and HTTPS setup), then in Settings, then Sharing:

1. Choose OpenLoom Server.
2. Enter the server URL and the creator API key from when you set it up (see
   [SELF-HOSTING.md](SELF-HOSTING.md) if the key needs finding again).
3. Press Test. It checks the server is up and the key is accepted.

Each share uploads `video.mp4`, `thumb.jpg`, `preview.gif` and the captions, resumably. The watch
page carries comments, reactions, analytics and, if you set one, a password and a call-to-action
button. You can moderate comments and delete the remote copy from the app's Share dialog.

## S3 provider (Cloudflare R2 in about five minutes)

Any S3-compatible bucket works. Cloudflare R2 is a good default because egress is free.

1. **Create a bucket.** In the Cloudflare dashboard, R2, create a bucket, for example
   `openloom-videos`.
2. **Make it reachable, with a custom domain.** Attach a custom domain (Settings, then Public
   access, then Custom Domains) so the link reads as your own infrastructure, for example
   `videos.example.com`, rather than a raw bucket URL. The r2.dev development URL works too and is
   fine while testing, but a link actually sent to someone is more credible on a domain you control.
3. **Create an API token.** R2, Manage API Tokens, create a token with Object Read and Write for the
   bucket. Note the Access Key ID and Secret Access Key, and your account's S3 endpoint, which looks
   like `https://<account-id>.r2.cloudflarestorage.com`.
4. **Fill Settings, then Sharing, then S3.**
   - Endpoint: the S3 endpoint above
   - Region: `auto` for R2
   - Bucket: your bucket name
   - Access key ID and Secret access key: from the token
   - Public base URL: your custom domain (recommended) or the r2.dev URL for testing
   - Path-style addressing: leave off for R2, on for MinIO
5. **Press Test.** It performs a real request against the bucket with your keys.

Open Loom uploads the video and its assets plus a self-contained `index.html` player page (inline CSS
and JavaScript, no external requests) into `{prefix}/{id}/`. The share link is the public URL. Because
the page is static, comments, reactions, analytics and passwords are not available on S3 shares; for
those, use the OpenLoom Server provider.

## Embedding

Server shares support a chromeless embed. Copy the iframe snippet from the Share dialog. It points at
the watch page with `?embed=1`.

## Why not YouTube unlisted?

A recurring question is why Open Loom does not just upload to YouTube as unlisted and hand you that
link. It was evaluated and rejected against Google's own documentation.

- **Unverified projects are locked private.** Videos uploaded through a YouTube API project that has
  not passed Google's audit are forced to private, and viewers cannot open them. There is no appeal
  short of a formal API audit of the application, or manual re-upload by hand.
- **The upload scope needs verification.** The `youtube.upload` OAuth scope is a sensitive scope that
  requires Google app verification before it works for anyone other than the developer.
- **Quota is tiny and shared.** Uploads sit in a dedicated bucket of roughly a hundred uploads per
  day per project, shared across every user of the application.

Any of these on its own breaks the core promise, that recording produces a link which works
instantly. Together they make YouTube unusable as a default backend for an installable, open-source
tool. Google Drive is no better: it locks popular files for 24 hours. So Open Loom shares to storage
you own, where the link works the moment the upload lands and there is no gatekeeper. If you still
want a video on YouTube, the MP4 in your library uploads by hand like any other file.
