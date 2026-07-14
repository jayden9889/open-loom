/**
 * Electron binding for the guided "Publish to YouTube (unlisted)" helper
 * (SPEC S7). A MANUAL publish - no YouTube API - because uploads made through
 * an unaudited API project are force-locked to private with no appeal. This
 * reveals the recording's MP4, opens YouTube's upload page in the browser, and
 * captures the resulting link the user pastes back.
 */
import { clipboard, shell } from 'electron';
import type { VideoMeta } from '@shared/types';
import { library, revealVideo } from './library';
import { parseYouTubeUrl } from './youtube-core';

const YOUTUBE_UPLOAD_URL = 'https://www.youtube.com/upload';

/**
 * Kick off the guided flow: reveal video.mp4 in Finder and open the YouTube
 * upload page in the default browser (both reuse the app's existing primitives -
 * shell.showItemInFolder via revealVideo and shell.openExternal). If the
 * recording already has an AI-generated title, copy it to the clipboard so the
 * user can paste it straight into YouTube's title field.
 */
export function youtubePublishStart(id: string): { titleCopied: boolean } {
  const meta = library().get(id); // throws a clear error if the id is unknown
  revealVideo(id);
  void shell.openExternal(YOUTUBE_UPLOAD_URL);
  const aiTitle = meta.ai?.title?.trim();
  if (aiTitle) {
    clipboard.writeText(aiTitle);
    return { titleCopied: true };
  }
  return { titleCopied: false };
}

/**
 * Read the clipboard and return the canonical YouTube watch URL when the user
 * has one copied. The Watch view calls this on window focus mid-publish so the
 * paste-back field is prefilled the moment they return from the browser.
 */
export function youtubeReadClipboardLink(): string | null {
  return parseYouTubeUrl(clipboard.readText())?.url ?? null;
}

/**
 * Validate a pasted YouTube link, persist the normalised canonical URL on the
 * video meta (through the existing library update path) and return the updated
 * meta. Throws a user-facing error when the input is not a YouTube link.
 */
export function youtubeSaveLink(id: string, url: string): VideoMeta {
  const parsed = parseYouTubeUrl(url);
  if (!parsed) throw new Error('That does not look like a YouTube link.');
  const meta = library().update(id, { youtubeUrl: parsed.url });
  // The saved link exists to be pasted to a prospect - copying is part of the
  // save contract itself, not a UI courtesy.
  clipboard.writeText(parsed.url);
  return meta;
}
