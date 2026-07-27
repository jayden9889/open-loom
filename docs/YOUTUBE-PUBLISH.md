# Publish to YouTube

One click on a recording's **Publish to YouTube** button uploads it to your own
channel and hands back the watch link. It uses the official YouTube Data API
(resumable `videos.insert`) with your own Google Cloud OAuth credentials -
Open Loom ships no baked-in secret and talks to no middle-man server.

## First-run setup (once)

You need a Google Cloud "Desktop app" OAuth client. About five minutes.

1. **Create/pick a project** at <https://console.cloud.google.com>.
2. **Enable the API:** APIs & Services › Library › search **YouTube Data API v3** › Enable.
3. **Configure the consent screen:** APIs & Services › OAuth consent screen.
   - User type **External**. (Internal locks out every account outside your
     Workspace org, including personal @gmail.com - the `org_internal` error.)
   - Add the scopes `https://www.googleapis.com/auth/youtube.upload` and
     `https://www.googleapis.com/auth/youtube.readonly` (readonly lets Open Loom
     name the channel you connected and refuse channel-less accounts).
   - While the app is unverified, add **the Google account that owns your YouTube
     channel** under **Test users** (or you will have to click through the
     "unverified app" warning at consent). Testing mode expires refresh tokens
     after 7 days, so expect a weekly reconnect until you publish the consent
     screen to production.
4. **Create the client:** APIs & Services › Credentials › Create credentials ›
   OAuth client ID › Application type **Desktop app**. Copy the **Client ID** and
   **Client secret**.
5. **In Open Loom:** Settings › YouTube › paste the Client ID and Client secret,
   then **Connect YouTube**. Consent opens in your browser; **pick the Google
   account (or brand account) that owns your channel** and approve. Open Loom
   resolves the channel the token reaches and shows its name in Settings -
   an account with no channel is refused on the spot instead of failing with a
   cryptic 401 at first publish. The secret and the resulting refresh token are
   stored encrypted on your Mac.

Now every recording has a working **Publish to YouTube** button.

## If your upload lands private

Open Loom always *requests* unlisted, and reads back the privacy YouTube
actually applied. On a fresh, un-audited project we saw uploads land **unlisted
immediately** (tested July 2026), so for most people there is nothing to do.

Google's published policy is stricter than that: it says uploads from an
un-audited API project created after 28 July 2020 may be restricted to private
regardless of what the app asks for. Enforcement is clearly not universal, but
plan for it. If a video does land private, Open Loom notices and the video page
shows a one-click **Set to Unlisted** that opens the YouTube Studio edit page -
flip it there and your link works for anyone you send it to.

To remove the restriction permanently, pass Google's compliance audit for your
project - see below. You only need this if your uploads are actually landing
private.

## The compliance audit (only if you need it)

Lifting the private restriction requires the **YouTube API Services compliance
audit** for your Cloud project. It is a one-time form. What you need ready:

- A **privacy policy URL** (a simple hosted page stating the app uploads to the
  user's own channel and stores nothing server-side).
- A short **demo video** of the publish flow (screen recording is fine - Open
  Loom records itself).
- **How you use the API** written plainly: "a local desktop screen recorder that
  uploads the user's own recordings to their own channel as unlisted, 1-5/day".
- The **OAuth client / project number** from the Cloud console.

Submit via the audit request linked from
<https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits>.
Turnaround is typically days to a few weeks. Once approved, uploads requested as
`unlisted` land unlisted and the flip step disappears automatically (the app
reads the privacy YouTube returns).

## Why the official API, and not a session hack

The alternative to the Data API is automating your own logged-in YouTube session
(cookie / Studio internal API). That was rejected: it violates YouTube's Terms,
every open-source library for it is stale, Google removed the internal-API
discovery docs in March 2025, and a false-positive abuse flag takes down your
**whole Google account**. The official API keeps your account safe, and in
practice it already returns unlisted links.

## How the upload works

Uploads use the resumable protocol in 8 MB chunks, each one acknowledged before
the next is sent, and streamed to the socket in 256 KB pieces so the progress bar
reflects real bytes rather than jumping once per chunk. If a chunk fails, Open
Loom asks YouTube how many bytes it actually holds and resumes from there rather
than starting over. Only one chunk is held in memory, so file size does not drive
memory use.

Upload time is bound by your upstream bandwidth: roughly `file size / upload
speed`. A 100 MB recording on a 6 Mbps uplink takes a little over two minutes,
and no amount of chunking changes that - the protocol requires contiguous,
sequentially acknowledged ranges, so chunks cannot be sent in parallel. If
uploads feel slow, the lever is recording bitrate, not the uploader.
