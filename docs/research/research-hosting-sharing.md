## Open Loom — Sharing/Hosting Options (verified July 2026)

Context: each user installs Open Loom locally; a recording must become a shareable link that opens a proper **player page** for anonymous viewers. Evaluated on setup burden, cost, playback UX, privacy, reliability, ToS risk.

---

### 1. YouTube unlisted via YouTube Data API v3 — DO NOT use as default

**Quota (current 2026, changed materially since the legacy "1,600 units" figure most blogs still quote):**
- The official quota calculator ([developers.google.com/youtube/v3/determine_quota_cost](https://developers.google.com/youtube/v3/determine_quota_cost), last modified 1 Jun 2026) now describes `videos.insert` and `search.list` as having their **own dedicated daily buckets (~100 calls/day each)**, separate from the shared **10,000 units/day** pool that covers all other endpoints. Corroborated by [socialcrawl.dev/blog/youtube-data-api-2026](https://www.socialcrawl.dev/blog/youtube-data-api-2026) and [blotato.com/blog/youtube-api-pricing](https://www.blotato.com/blog/youtube-api-pricing), which date a 4 Dec 2025 change that cut upload cost from ~1,600 units to ~100 and moved uploads to a dedicated ~100-uploads/day bucket effective 1 Jun 2026.
- CONFLICT / caveat: unupdated pages ([getphyllo.com](https://www.getphyllo.com/post/youtube-api-limits-how-to-calculate-api-usage-cost-and-fix-exceeded-api-quota)) still state 1,600 units → ~6 uploads/day on the 10k pool. Net for Open Loom: worst case 6 uploads/day/project, best case ~100/day/project. **Quota is NOT the blocker either way** — the policy below is.

**The killer policy (confirmed current, June 2026 docs):** API projects created after **28 July 2020** upload **private by default**, and videos uploaded via an **unverified API project are LOCKED to private** — you cannot set them unlisted/public until the project passes a YouTube API **audit** ([support.google.com/youtube/answer/7300965](https://support.google.com/youtube/answer/7300965), [github.com/porjo/youtubeuploader/issues/86](https://github.com/porjo/youtubeuploader/issues/86)). Per the help article: for videos locked private via an unverified API service **"you will not be able to appeal"** — the only fixes are re-upload through a verified service or via youtube.com directly, or apply for an API audit. This directly defeats Loom's core UX (an instantly-shareable link). Since Open Loom is installed per-user, either (a) all users share one API project → that single project must pass an audit or every user's videos are stuck private, or (b) each user creates their own Google Cloud project + passes their own audit → absurd for non-technical users.

**OAuth burden:** the upload scope (`youtube.upload` / `youtube`) is a Google **restricted scope**. Publishing the app requires OAuth verification incl. a demo video of the full grant flow, and restricted scopes require an **annual third-party security assessment by a Google-empanelled assessor** ([support.google.com/cloud/answer/13464321](https://support.google.com/cloud/answer/13464321)) — costs thousands of USD/year. Staying in "Testing" mode avoids that but caps you at **100 test users** and shows an "unverified app" warning screen. Either path is untenable for a distributed open-source installable.

**ToS risk:** high. Automated per-install uploads through one shared project is exactly the "unverified API service" pattern YouTube locks/bans. Verdict: **offer as an optional export ("Publish to YouTube" with the user's own account), never the default.** Even then videos land private unless the user's project is audited.

---

### 2. Google Drive upload + shareable link — weak, unreliable for video

- **Playback UX:** Drive's `/preview` embed gives a basic player, but it is **not a streaming CDN** — no HLS/adaptive bitrate, seeking is sluggish, and large files trigger the "can't scan for viruses" interstitial.
- **Hard reliability wall:** any file that gets modest traffic hits **"Sorry, you can't view or download this file at this time. Too many users have viewed or downloaded this file recently"** — a **24-hour lockout** with an undisclosed threshold ([support.google.com/drive/thread/258523607](https://support.google.com/drive/thread/258523607), [chromeready.com/7330](https://chromeready.com/7330/google-drive-quota-exceeded-error/)). For a Loom clone (share one link with a team, everyone opens it) this fires constantly. Disqualifying for the default.
- **Quota:** consumes the user's 15 GB free Drive; OAuth `drive.file` scope is lighter than YouTube (sensitive, not restricted) but still needs consent screen work.
- Verdict: **optional export only**, flagged as unreliable for wide sharing.

---

### 3. Self-host / managed object + video services

**3a. Cloudflare Stream — best "proper player" managed option.** ([developers.cloudflare.com/stream/pricing](https://developers.cloudflare.com/stream/pricing/), modified 21 Apr 2026): **$5 per 1,000 minutes stored** ($0.005/min-stored/mo), **$1 per 1,000 minutes delivered** ($0.001/min delivered); **ingress + encoding always free**; includes a built-in adaptive-bitrate player + HLS/DASH manifests. A 5-min clip watched by 20 people ≈ $0.025 storage/mo + $0.10 delivery. Gives true Loom-grade playback (transcoding, thumbnails, seeking, embed). Downside: requires a Cloudflare account + API token in the app (not zero-config) and is usage-billed (not free tier).

**3b. Cloudflare R2 + your own player page — cheapest at scale, no transcode.** ([developers.cloudflare.com/r2/pricing](https://developers.cloudflare.com/r2/pricing/)): **$0.015/GB-mo**, **egress FREE**, free tier **10 GB storage + 1M Class-A + 10M Class-B ops/mo**. A 100 MB clip = $0.0015/mo, unlimited views free. But R2 does not transcode or supply a player — Open Loom must ship its own share-page HTML5 player and rely on HTTP range requests (works for MP4/WebM; no adaptive bitrate). Presigned/public-bucket links are trivial. Free egress makes it the standout for a share-by-link tool.

**3c. Generic S3-compatible + presigned links.** Works (AWS S3, Backblaze B2, Wasabi, MinIO). Presigned URLs give private, expiring links; HTML5 range playback. AWS S3 egress is the trap at ~$0.09/GB (a viral clip = surprise bill). Backblaze B2 pairs with Cloudflare (Bandwidth Alliance) for free egress and MinIO lets a technical user self-host entirely. Same "you build the player page" requirement as R2. Good as a **pluggable optional provider**, not the non-technical default.

**3d. Supabase Storage.** ([supabase.com/docs/guides/storage/pricing](https://supabase.com/docs/guides/storage/pricing), [supabase.com/pricing](https://supabase.com/pricing)): free tier **1 GB storage, 50 MB max file size, ~5 GB storage egress**; Pro $25/mo then storage/egress at ~$0.09/GB after 250 GB. The **50 MB free-tier per-file cap** kills most screen recordings; usable only on Pro. Public bucket URLs + a Smart CDN (Pro) give decent range playback but again no transcoding and no bundled player. Reasonable optional provider for users already on Supabase; poor default.

---

### 4. Fully local — serve from the app + tunnel, or file export

**4a. Cloudflare Tunnel.** Named/production tunnels are **free** (Cloudflare Zero Trust free plan) but require the user to own a domain on Cloudflare — too much for non-technical users. **TryCloudflare quick tunnels** ([developers.cloudflare.com/.../trycloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)) are free and zero-config (random `*.trycloudflare.com` URL) BUT: **"intended for testing and development only,"** hard **200 concurrent-request limit → 429**, no SSE, no SLA, and the URL changes on every restart. Not viable for durable share links.

**4b. Tailscale Funnel.** ([tailscale.com/kb/1223/funnel](https://tailscale.com/kb/1223/funnel)): **free on all plans**, gives a stable public HTTPS URL to a local service that **anonymous non-Tailscale viewers can open**. Constraints: TLS only, ports **443/8443/10000**, and **non-configurable bandwidth limits**. Good for occasional private shares from a machine that stays on; fails Loom's "link works after I close my laptop" expectation (link dies when the machine sleeps/offline).

**4c. Plain file export.** Zero infra, fully private, but it is not a link — no player page, no analytics, defeats the entire Loom value prop. Keep only as a "Download MP4" secondary action.

Local-serve limitation common to all: the viewer only gets a player while the origin machine is online — the opposite of Loom's always-available cloud link.

---

## RECOMMENDED ARCHITECTURE — default + pluggable providers

**Default (out-of-box, opinionated): Cloudflare R2 + an Open-Loom-hosted HTML5 player share page.**
- Justification: **free egress** is the single most important property for a share-by-link product (one link, many anonymous views, unpredictable virality) — it removes the AWS-egress bill risk and Drive's 24h view-lockout entirely. 10 GB free tier + $0.015/GB-mo covers most solo users at near-zero cost. Store the recording as fragmented MP4/WebM (browser-native, range-seekable) and serve a bundled player page (Open Loom controls the UX, matching Loom: title, viewer, copy-link, download). User setup = paste one R2 API token + bucket; no domain, no transcoding pipeline, no OAuth verification, no ToS audit.

**Optional providers (adapter interface, user picks in settings):**
1. **Cloudflare Stream** — for users who want true adaptive-bitrate transcoding + thumbnails and will pay usage. Best pure playback quality.
2. **Any S3-compatible** (Backblaze B2/Wasabi/MinIO/AWS S3) — power users / full self-host; presigned links. Warn on AWS egress cost.
3. **Supabase Storage** — for users already in that ecosystem (Pro tier, >50 MB files).
4. **"Publish to YouTube (your account, unlisted)"** — explicit export button using the user's own OAuth, with a clear warning that videos may land private until their API project is audited. Never automatic.
5. **"Download MP4"** — universal fallback.
6. **Tailscale Funnel** — advanced "share from this machine" toggle for privacy-max users who accept the machine-must-stay-online tradeoff.

**Rejected as default:** YouTube API (unverified-project private-lock + restricted-scope security assessment + per-install audit is fatal for a distributed installable), Google Drive (24h view-quota lockout + no real streaming), TryCloudflare (dev-only, ephemeral URL, 200-req cap).

The provider adapter should be a thin interface — `upload(file) -> {playbackUrl, shareUrl}` — so the player page is uniform regardless of backend, giving consistent Loom-like UX while cost/hosting stays user-controlled.