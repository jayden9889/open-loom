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
import { connect, disconnect, getAccessToken, isConnected } from './youtube-oauth';
import { buildVideoInsertMetadata, parseYouTubeUrl, studioEditUrl, watchUrl } from './youtube-core';
import { log } from './logger';

const RESUMABLE_START =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

/** Whether a YouTube account is connected. */
export function youtubeStatus(): { connected: boolean } {
  return { connected: isConnected() };
}

/** Run the OAuth consent flow. */
export function youtubeConnect(): Promise<{ connected: boolean }> {
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
    return 'YouTube rejected the sign-in. Disconnect and reconnect your account in Settings › YouTube.';
  }
  if (res.status === 403 && /quota/i.test(detail)) {
    return 'YouTube daily upload quota reached. Please try again tomorrow.';
  }
  return `Could not ${action}: ${detail || `HTTP ${res.status}`}`;
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
  const bytes = fs.readFileSync(videoPath);
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
      'x-upload-content-length': String(bytes.length),
      'x-upload-content-type': 'video/*',
    },
    body: JSON.stringify(metadata),
  });
  if (!start.ok) throw new Error(await uploadError(start, 'start the upload'));
  const sessionUri = start.headers.get('location');
  if (!sessionUri) throw new Error('YouTube did not return an upload URL. Please try again.');

  // Step 2: send the bytes to the session URI (fetch sets Content-Length).
  const put = await fetch(sessionUri, {
    method: 'PUT',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'video/*' },
    body: bytes,
  });
  if (!put.ok) throw new Error(await uploadError(put, 'upload the video'));

  const created = (await put.json()) as { id?: string; status?: { privacyStatus?: string } };
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
