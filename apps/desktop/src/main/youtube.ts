/**
 * Electron binding for "Publish to YouTube (unlisted)" (SPEC S7). Uploads the
 * recording's final MP4 straight to the user's channel via the Data API's
 * resumable videos.insert, requesting unlisted, and returns the watch link.
 *
 * Reality check baked in: an unaudited API project has its uploads force-locked
 * to private regardless of the requested privacy (docs/DECISIONS.md). We read
 * back the privacy YouTube actually applied - 'private' until the project passes
 * the compliance audit - and the Watch view turns that into a one-click
 * "Set to Unlisted" step. Auth + token handling live in youtube-oauth.ts.
 */
import { shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { VideoMeta } from '@shared/types';
import { VIDEO_FILES } from '@shared/types';
import { library } from './library';
import { emitJobProgress } from './ffmpeg';
import {
  connect,
  connectedChannel,
  disconnect,
  getAccessToken,
  invalidateAccessToken,
  isConnected,
} from './youtube-oauth';
import {
  buildVideoInsertMetadata,
  contentRange,
  isQuotaError,
  isSessionReusable,
  parseResumeOffset,
  parseYouTubeUrl,
  queryRange,
  studioEditUrl,
  UPLOAD_CHUNK_BYTES,
  videosDeleteUrl,
  watchUrl,
  YT_SCOPE_VERSION,
} from './youtube-core';
import { getSettings } from './settings';
import { log } from './logger';

const RESUMABLE_START =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

/**
 * One AbortController per upload in flight, keyed by video id. Doubles as the
 * double-publish guard: youtubePublish refuses an id that is already here, and
 * youtubeCancelPublish aborts through it.
 */
const inflight = new Map<string, AbortController>();

/** Whether a YouTube account is connected, and which channel it uploads to. */
export function youtubeStatus(): { connected: boolean; channel: string; needsReconnect: boolean } {
  const connected = isConnected();
  return {
    connected,
    channel: connectedChannel(),
    // A token minted before the scope widened cannot delete videos; Settings
    // turns this into the "Reconnect to enable removing videos" prompt.
    needsReconnect: connected && getSettings().youtube.scopeVersion < YT_SCOPE_VERSION,
  };
}

/** Run the OAuth consent flow. */
export function youtubeConnect(): Promise<{
  connected: boolean;
  channel: string;
  channelLookupFailed?: boolean;
}> {
  return connect();
}

/** Forget the stored YouTube tokens, revoking them at Google first (best effort). */
export function youtubeDisconnect(): Promise<{ connected: boolean; revoked: boolean }> {
  return disconnect();
}

/** Abort an in-flight upload; the pending youtubePublish then rejects with 'Upload cancelled.'. */
export function youtubeCancelPublish(id: string): void {
  inflight.get(id)?.abort();
}

/** Number of uploads currently in flight (the before-quit prompt reads this). */
export function youtubeUploadsInFlight(): number {
  return inflight.size;
}

/** Abort every in-flight upload (the confirmed-quit path). */
export function youtubeCancelAllPublishes(): void {
  for (const controller of inflight.values()) controller.abort();
}

/** Turn a failed upload response into a plain-English, user-facing message. */
async function uploadError(res: Response, action: string): Promise<string> {
  const text = await res.text().catch(() => '');
  let detail = text;
  try {
    detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message || text;
  } catch {
    /* keep raw text */
  }
  if (res.status === 401) {
    // Surface the real reason - a bare 401 is usually the connected Google
    // account having no YouTube channel (youtubeSignupRequired), not a scope or
    // token fault, and the two fixes differ.
    if (/signup|channel/i.test(detail)) {
      return 'That Google account has no YouTube channel. Disconnect in Settings › YouTube, reconnect, and pick the Google account that owns your channel.';
    }
    return `YouTube rejected the sign-in (${detail || 'unauthorized'}). Disconnect and reconnect in Settings › YouTube, choosing the account that owns your channel.`;
  }
  // Covers both the 403 quotaExceeded family and the 400 uploadLimitExceeded
  // the videos endpoint uses for the per-channel daily cap - same remedy.
  if (isQuotaError(res.status, detail)) {
    return 'YouTube daily upload quota reached. Please try again tomorrow.';
  }
  if (res.status === 403 && /scope|permission|insufficient/i.test(detail)) {
    return 'The connected account did not grant upload permission. Disconnect and reconnect, and approve the YouTube access on the Google screen.';
  }
  return `Could not ${action}: ${detail || `HTTP ${res.status}`}`;
}

interface CreatedVideo {
  id?: string;
  status?: { privacyStatus?: string };
}

/** Ask the session how many bytes it actually holds, so a retry resumes there. */
async function serverOffset(
  sessionUri: string,
  total: number,
  getToken: () => Promise<string>,
  signal?: AbortSignal
): Promise<{ done: CreatedVideo } | { offset: number }> {
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: { authorization: `Bearer ${await getToken()}`, 'content-range': queryRange(total) },
    signal,
  });
  if (res.status === 200 || res.status === 201) return { done: (await res.json()) as CreatedVideo };
  if (res.status === 308) return { offset: parseResumeOffset(res.headers.get('range')) };
  throw new Error(await uploadError(res, 'resume the upload'));
}

/** Slice size handed to the socket; small enough that progress moves smoothly. */
const PIECE_BYTES = 256 * 1024;

/**
 * Stream one chunk to the socket in small pieces, reporting bytes as they are
 * written. Reporting per chunk instead would move the bar once per 8 MB - about
 * every twelve seconds on a typical connection, which reads as frozen. Node
 * applies backpressure here, so the count tracks the wire rather than racing it.
 */
async function* chunkPieces(
  handle: fs.promises.FileHandle,
  offset: number,
  size: number,
  onByte: (sent: number) => void
): AsyncGenerator<Buffer> {
  let done = 0;
  while (done < size) {
    const n = Math.min(PIECE_BYTES, size - done);
    // alloc, not allocUnsafe: an unzeroed buffer plus a short read would send
    // arbitrary process heap (tokens, keys) to YouTube inside the video file.
    const buf = Buffer.alloc(n);
    const { bytesRead } = await handle.read(buf, 0, n, offset + done);
    if (bytesRead !== n) {
      // The byte count was committed to the server at session start, so a file
      // that shrank under us cannot be papered over with padding - fail loudly.
      throw new Error('The recording file changed while it was uploading. Please try publishing again.');
    }
    done += n;
    yield buf;
    onByte(offset + done);
  }
}

/**
 * Send the file to the resumable session one chunk at a time, reporting progress
 * and resuming from the server's own byte count when a chunk fails. Only the
 * current chunk is held in memory, so a large recording never loads whole.
 * `getToken` is asked per request rather than once up front: an access token
 * lives an hour, so an upload that outlives it would otherwise 401 at the end.
 */
async function uploadChunks(
  sessionUri: string,
  filePath: string,
  total: number,
  getToken: () => Promise<string>,
  onProgress: (sent: number) => void,
  signal?: AbortSignal,
  startOffset = 0
): Promise<CreatedVideo> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    let offset = startOffset;
    let failures = 0;
    let refreshedAuth = false;
    while (offset < total) {
      const size = Math.min(UPLOAD_CHUNK_BYTES, total - offset);

      let res: Response;
      try {
        res = await fetch(sessionUri, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${await getToken()}`,
            'content-range': contentRange(offset, offset + size - 1, total),
            // Required: a streamed body would otherwise go chunked, which the
            // resumable endpoint rejects.
            'content-length': String(size),
          },
          body: chunkPieces(handle, offset, size, onProgress),
          // Node needs this to accept a stream body; it is not in the DOM types.
          duplex: 'half',
          signal,
        } as RequestInit & { duplex: 'half' });
      } catch (err) {
        // A cancel is not a network drop: surface it, never retry it.
        if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
        // Connection dropped mid-chunk. The server may still have stored part
        // of it, so never assume our own offset - ask, then continue.
        if (++failures > 5) {
          throw new Error(
            `The upload kept losing its connection (${err instanceof Error ? err.message : String(err)}). Check your internet and try again.`
          );
        }
        await new Promise((r) => setTimeout(r, 1000 * failures));
        const probe = await serverOffset(sessionUri, total, getToken, signal);
        if ('done' in probe) return probe.done;
        offset = probe.offset;
        onProgress(offset);
        continue;
      }

      if (res.status === 200 || res.status === 201) return (await res.json()) as CreatedVideo;
      if (res.status === 308) {
        failures = 0;
        // Trust the server's count over ours; it can store less than we sent.
        const acked = parseResumeOffset(res.headers.get('range'));
        offset = acked > offset ? acked : offset + size;
        onProgress(offset);
        continue;
      }
      if (res.status === 401 && !refreshedAuth) {
        // The access token expired mid-upload (they last an hour). Force one
        // fresh mint and resume from the server's count; a second 401 after a
        // fresh token is a real auth fault and falls to the terminal throw.
        refreshedAuth = true;
        if (++failures > 5) throw new Error(await uploadError(res, 'upload the video'));
        invalidateAccessToken();
        const probe = await serverOffset(sessionUri, total, getToken, signal);
        if ('done' in probe) return probe.done;
        offset = probe.offset;
        onProgress(offset);
        continue;
      }
      if (res.status >= 500) {
        if (++failures > 5) throw new Error(await uploadError(res, 'upload the video'));
        await new Promise((r) => setTimeout(r, 1000 * failures));
        const probe = await serverOffset(sessionUri, total, getToken, signal);
        if ('done' in probe) return probe.done;
        offset = probe.offset;
        onProgress(offset);
        continue;
      }
      throw new Error(await uploadError(res, 'upload the video'));
    }
    // Every byte is acknowledged but no chunk returned the resource: ask once.
    const probe = await serverOffset(sessionUri, total, getToken, signal);
    if ('done' in probe) return probe.done;
    throw new Error('YouTube accepted every byte but did not finish the upload. Please try again.');
  } finally {
    await handle.close();
  }
}

/**
 * Tell Google to drop a resumable session (DELETE on the session URI), so a
 * cancelled partial upload is released rather than left to expire in a week.
 * Best effort: the session dies on its own anyway, so failure is only logged.
 */
async function releaseSession(sessionUri: string): Promise<void> {
  try {
    const token = await getAccessToken();
    await fetch(sessionUri, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  } catch (err) {
    log.warn(`youtube: could not release the cancelled upload session: ${String(err)}`);
  }
}

/**
 * Upload the recording's video.mp4 to YouTube as unlisted and persist the link.
 * `privacy` reflects what YouTube actually applied ('private' on an unaudited
 * project); the caller surfaces the flip-to-Unlisted step when it is 'private'.
 *
 * The session URI is persisted to the video's metadata the moment it opens, so
 * a quit or crash mid-upload can be recovered on the next launch, and a retry
 * after a failure resumes from the server's byte count instead of byte zero.
 * Cancellation (youtubeCancelPublish) rejects with 'Upload cancelled.'.
 */
export async function youtubePublish(
  id: string
): Promise<{ url: string; videoId: string; privacy: 'unlisted' | 'private' }> {
  if (inflight.has(id)) {
    throw new Error('This recording is already uploading to YouTube. Wait for it to finish, or cancel it first.');
  }
  const store = library();
  const meta = store.get(id); // throws a clear error if the id is unknown
  const videoPath = path.join(store.videoDir(id), VIDEO_FILES.video);
  if (!fs.existsSync(videoPath)) {
    throw new Error('The recording file is missing, so there is nothing to upload.');
  }

  const controller = new AbortController();
  inflight.set(id, controller);
  const getToken = (): Promise<string> => getAccessToken();
  let sessionUri: string | null = null;
  try {
    const total = fs.statSync(videoPath).size;

    // Reuse a persisted session from an interrupted attempt when it still fits
    // the file on disk; ask the server how far it got and continue from there.
    let created: CreatedVideo | null = null;
    let startOffset = 0;
    if (isSessionReusable(meta.youtubeUpload, total)) {
      try {
        const probe = await serverOffset(meta.youtubeUpload!.sessionUri, total, getToken, controller.signal);
        if ('done' in probe) {
          created = probe.done;
        } else {
          sessionUri = meta.youtubeUpload!.sessionUri;
          startOffset = probe.offset;
        }
      } catch (err) {
        if (controller.signal.aborted) throw err;
        log.warn(`youtube: saved upload session for ${id} is no longer usable, starting over: ${String(err)}`);
      }
    }

    // Step 1: open the resumable session (metadata only) unless one is live.
    if (!created && !sessionUri) {
      const metadata = buildVideoInsertMetadata({
        title: meta.ai?.title?.trim() || meta.title,
        description: meta.ai?.summary?.trim() || meta.description,
        privacyStatus: 'unlisted',
      });
      const start = await fetch(RESUMABLE_START, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await getToken()}`,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-length': String(total),
          'x-upload-content-type': 'video/*',
        },
        body: JSON.stringify(metadata),
        signal: controller.signal,
      });
      if (!start.ok) throw new Error(await uploadError(start, 'start the upload'));
      sessionUri = start.headers.get('location');
      if (!sessionUri) throw new Error('YouTube did not return an upload URL. Please try again.');
      // Persist the session before the first byte moves: this is what makes a
      // quit, crash or failure mid-upload recoverable instead of starting over.
      store.update(id, {
        youtubeUpload: { sessionUri, total, startedAt: new Date().toISOString() },
      });
    }

    // Step 2: send the bytes in acknowledged chunks, reporting progress as we go.
    // The last stretch is YouTube processing the file, which reports no progress,
    // so the bar stops at 99 until the response lands rather than sitting at 100.
    // Bytes arrive every 256 KB; only emit when the whole percent actually moves.
    let lastPct = -1;
    const progress = (sent: number): void => {
      const pct = total > 0 ? Math.min(99, Math.floor((sent / total) * 100)) : 0;
      if (pct === lastPct) return;
      lastPct = pct;
      emitJobProgress({ videoId: id, kind: 'youtube', pct, note: 'Uploading to YouTube' });
    };
    progress(startOffset);
    if (!created) {
      created = await uploadChunks(
        sessionUri!,
        videoPath,
        total,
        getToken,
        progress,
        controller.signal,
        startOffset
      );
    }
    emitJobProgress({ videoId: id, kind: 'youtube', pct: 100, note: 'Published to YouTube' });

    const videoId = created.id;
    if (!videoId) throw new Error('YouTube accepted the upload but did not return a video id.');

    const privacy: 'unlisted' | 'private' =
      created.status?.privacyStatus === 'unlisted' ? 'unlisted' : 'private';
    const url = watchUrl(videoId);
    store.update(id, { youtubeUrl: url, youtubePrivacy: privacy, youtubeUpload: undefined });
    log.info(`youtube: published ${videoId} as ${privacy}`);
    return { url, videoId, privacy };
  } catch (err) {
    if (controller.signal.aborted) {
      // User cancel, not a failure: release the partial session at Google,
      // forget it locally, and reject with a message the UI shows as info.
      if (sessionUri) await releaseSession(sessionUri);
      store.update(id, { youtubeUpload: undefined });
      emitJobProgress({ videoId: id, kind: 'youtube', pct: 0, failed: true, note: 'Upload cancelled' });
      log.info(`youtube: upload of ${id} was cancelled`);
      throw new Error('Upload cancelled.');
    }
    // Keep the persisted session on failure: a retry resumes where it stopped.
    emitJobProgress({ videoId: id, kind: 'youtube', pct: 0, failed: true, note: 'Upload failed' });
    throw err;
  } finally {
    inflight.delete(id);
  }
}

/**
 * Delete this recording's upload from the user's channel (videos.delete) and
 * clear the stored link, so a mistaken publish can be undone from inside the
 * app. Needs the youtube.force-ssl scope: tokens minted before the scope
 * widened are refused with a plain pointer at the reconnect prompt.
 */
export async function youtubeUnpublish(id: string): Promise<void> {
  const store = library();
  const meta = store.get(id);
  const parsed = meta.youtubeUrl ? parseYouTubeUrl(meta.youtubeUrl) : null;
  if (!parsed) throw new Error('This recording has not been published to YouTube yet.');
  if (getSettings().youtube.scopeVersion < YT_SCOPE_VERSION) {
    throw new Error(
      'Removing videos needs a fresh YouTube sign-in. Reconnect in Settings › YouTube, then try again.'
    );
  }
  const accessToken = await getAccessToken();
  const res = await fetch(videosDeleteUrl(parsed.id), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  // 204 = deleted; 404 = already gone (removed by hand in Studio). Either way
  // it is off the channel, so the local link is cleared for both.
  if (res.status !== 204 && res.status !== 404) {
    throw new Error(await uploadError(res, 'remove the video from YouTube'));
  }
  store.update(id, { youtubeUrl: '', youtubePrivacy: undefined });
  log.info(`youtube: removed ${parsed.id} from the channel`);
}

/**
 * On launch, look for uploads that were mid-flight when the app last quit or
 * crashed. A session the server reports finished just never got its video id
 * recorded - recover it here so the video is not stranded on the channel with
 * no link in the app. An unfinished one keeps its marker, which makes the
 * Watch view offer "Resume upload"; markers past Google's 7-day session
 * lifetime are cleared. Never throws - launch must not hang on this.
 */
export async function recoverPendingYouTubeUploads(): Promise<void> {
  if (!isConnected()) return;
  let store: ReturnType<typeof library>;
  let metas: VideoMeta[];
  try {
    store = library();
    metas = store.list();
  } catch {
    return;
  }
  const getToken = (): Promise<string> => getAccessToken();
  for (const meta of metas) {
    const pending = meta.youtubeUpload;
    if (!pending) continue;
    if (meta.youtubeUrl || !isSessionReusable(pending, pending.total)) {
      // Already recorded as published, or the session has expired: forget it.
      store.update(meta.id, { youtubeUpload: undefined });
      continue;
    }
    try {
      const probe = await serverOffset(pending.sessionUri, pending.total, getToken);
      if ('done' in probe && probe.done.id) {
        const privacy: 'unlisted' | 'private' =
          probe.done.status?.privacyStatus === 'unlisted' ? 'unlisted' : 'private';
        store.update(meta.id, {
          youtubeUrl: watchUrl(probe.done.id),
          youtubePrivacy: privacy,
          youtubeUpload: undefined,
        });
        log.info(`youtube: recovered finished upload ${probe.done.id} for ${meta.id}`);
      }
      // 308 (bytes still missing): keep the marker; Watch offers "Resume upload".
    } catch (err) {
      // Leave the marker: a resume attempt probes again and falls back to a
      // fresh session on its own if this one really is dead.
      log.warn(`youtube: could not check the interrupted upload for ${meta.id}: ${String(err)}`);
    }
  }
}

/**
 * Open studio.youtube.com's edit page for this recording's upload so the user
 * can flip an unaudited-project private upload to Unlisted in one place.
 */
export function youtubeOpenStudioEdit(id: string): void {
  const meta = library().get(id);
  const parsed = meta.youtubeUrl ? parseYouTubeUrl(meta.youtubeUrl) : null;
  if (!parsed) throw new Error('This recording has not been published to YouTube yet.');
  void shell.openExternal(studioEditUrl(parsed.id));
}
