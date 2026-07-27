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
import { VIDEO_FILES } from '@shared/types';
import { library } from './library';
import { emitJobProgress } from './ffmpeg';
import { connect, connectedChannel, disconnect, getAccessToken, isConnected } from './youtube-oauth';
import {
  buildVideoInsertMetadata,
  contentRange,
  parseResumeOffset,
  parseYouTubeUrl,
  queryRange,
  studioEditUrl,
  UPLOAD_CHUNK_BYTES,
  watchUrl,
} from './youtube-core';
import { log } from './logger';

const RESUMABLE_START =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

/** Whether a YouTube account is connected, and which channel it uploads to. */
export function youtubeStatus(): { connected: boolean; channel: string } {
  return { connected: isConnected(), channel: connectedChannel() };
}

/** Run the OAuth consent flow. */
export function youtubeConnect(): Promise<{ connected: boolean; channel: string }> {
  return connect();
}

/** Forget the stored YouTube tokens. */
export function youtubeDisconnect(): { connected: boolean } {
  return disconnect();
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
  if (res.status === 403 && /quota/i.test(detail)) {
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
  accessToken: string
): Promise<{ done: CreatedVideo } | { offset: number }> {
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: { authorization: `Bearer ${accessToken}`, 'content-range': queryRange(total) },
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
    const buf = Buffer.allocUnsafe(n);
    await handle.read(buf, 0, n, offset + done);
    done += n;
    yield buf;
    onByte(offset + done);
  }
}

/**
 * Send the file to the resumable session one chunk at a time, reporting progress
 * and resuming from the server's own byte count when a chunk fails. Only the
 * current chunk is held in memory, so a large recording never loads whole.
 */
async function uploadChunks(
  sessionUri: string,
  filePath: string,
  total: number,
  accessToken: string,
  onProgress: (sent: number) => void
): Promise<CreatedVideo> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    let offset = 0;
    let failures = 0;
    while (offset < total) {
      const size = Math.min(UPLOAD_CHUNK_BYTES, total - offset);

      let res: Response;
      try {
        res = await fetch(sessionUri, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-range': contentRange(offset, offset + size - 1, total),
            // Required: a streamed body would otherwise go chunked, which the
            // resumable endpoint rejects.
            'content-length': String(size),
          },
          body: chunkPieces(handle, offset, size, onProgress),
          // Node needs this to accept a stream body; it is not in the DOM types.
          duplex: 'half',
        } as RequestInit & { duplex: 'half' });
      } catch (err) {
        // Connection dropped mid-chunk. The server may still have stored part
        // of it, so never assume our own offset - ask, then continue.
        if (++failures > 5) {
          throw new Error(
            `The upload kept losing its connection (${err instanceof Error ? err.message : String(err)}). Check your internet and try again.`
          );
        }
        await new Promise((r) => setTimeout(r, 1000 * failures));
        const probe = await serverOffset(sessionUri, total, accessToken);
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
      if (res.status >= 500) {
        if (++failures > 5) throw new Error(await uploadError(res, 'upload the video'));
        await new Promise((r) => setTimeout(r, 1000 * failures));
        const probe = await serverOffset(sessionUri, total, accessToken);
        if ('done' in probe) return probe.done;
        offset = probe.offset;
        onProgress(offset);
        continue;
      }
      throw new Error(await uploadError(res, 'upload the video'));
    }
    // Every byte is acknowledged but no chunk returned the resource: ask once.
    const probe = await serverOffset(sessionUri, total, accessToken);
    if ('done' in probe) return probe.done;
    throw new Error('YouTube accepted every byte but did not finish the upload. Please try again.');
  } finally {
    await handle.close();
  }
}

/**
 * Upload the recording's video.mp4 to YouTube as unlisted and persist the link.
 * `privacy` reflects what YouTube actually applied ('private' on an unaudited
 * project); the caller surfaces the flip-to-Unlisted step when it is 'private'.
 */
export async function youtubePublish(
  id: string
): Promise<{ url: string; videoId: string; privacy: 'unlisted' | 'private' }> {
  const store = library();
  const meta = store.get(id); // throws a clear error if the id is unknown
  const videoPath = path.join(store.videoDir(id), VIDEO_FILES.video);
  if (!fs.existsSync(videoPath)) {
    throw new Error('The recording file is missing, so there is nothing to upload.');
  }

  const accessToken = await getAccessToken();
  const total = fs.statSync(videoPath).size;
  const metadata = buildVideoInsertMetadata({
    title: meta.ai?.title?.trim() || meta.title,
    description: meta.ai?.summary?.trim() || meta.description,
    privacyStatus: 'unlisted',
  });

  // Step 1: open the resumable session (metadata only).
  const start = await fetch(RESUMABLE_START, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-length': String(total),
      'x-upload-content-type': 'video/*',
    },
    body: JSON.stringify(metadata),
  });
  if (!start.ok) throw new Error(await uploadError(start, 'start the upload'));
  const sessionUri = start.headers.get('location');
  if (!sessionUri) throw new Error('YouTube did not return an upload URL. Please try again.');

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
  progress(0);
  let created: CreatedVideo;
  try {
    created = await uploadChunks(sessionUri, videoPath, total, accessToken, progress);
  } catch (err) {
    emitJobProgress({ videoId: id, kind: 'youtube', pct: 100, note: 'Upload failed' });
    throw err;
  }
  emitJobProgress({ videoId: id, kind: 'youtube', pct: 100, note: 'Published to YouTube' });

  const videoId = created.id;
  if (!videoId) throw new Error('YouTube accepted the upload but did not return a video id.');

  const privacy: 'unlisted' | 'private' =
    created.status?.privacyStatus === 'unlisted' ? 'unlisted' : 'private';
  const url = watchUrl(videoId);
  store.update(id, { youtubeUrl: url, youtubePrivacy: privacy });
  log.info(`youtube: published ${videoId} as ${privacy}`);
  return { url, videoId, privacy };
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
