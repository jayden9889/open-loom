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
   - User type **External**.
   - Add the scope `https://www.googleapis.com/auth/youtube.upload`.
   - While the app is unverified, add your own Google account under **Test users**
     (or you will have to click through the "unverified app" warning at consent).
4. **Create the client:** APIs & Services › Credentials › Create credentials ›
   OAuth client ID › Application type **Desktop app**. Copy the **Client ID** and
   **Client secret**.
5. **In Open Loom:** Settings › YouTube › paste the Client ID and Client secret,
   then **Connect YouTube**. Consent opens in your browser; approve and return.
   The secret and the resulting refresh token are stored encrypted on your Mac.

Now every recording has a working **Publish to YouTube** button.

## The "still private" step

Google **force-locks every upload from an un-audited API project to private**,
regardless of the privacy the app requests. This is Google policy, not an Open
Loom limitation (verified against the API docs). So on a fresh project your first
uploads land **private**, and the video page shows a one-click **Set to Unlisted**
that opens the YouTube Studio edit page - flip it there and your link works for
anyone you send it to.

To make uploads land **unlisted automatically** (no flip), pass Google's
compliance audit for the project - see below. Until then the flip is one click.

## Getting to true one-click unlisted: the compliance audit

Lifting the private lock requires the **YouTube API Services compliance audit**
for your Cloud project. It is a one-time form. What you need ready:

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

## Why not fully automatic unlisted today

The only way to get true hands-off unlisted right now is to automate your own
logged-in YouTube session (cookie / Studio internal API). That was rejected: it
violates YouTube's Terms, every open-source library for it is stale, Google
removed the internal-API discovery docs in March 2025, and a false-positive
abuse flag takes down your **whole Google account**. The official-API-plus-flip
path, graduating to the audit, keeps your account safe.
