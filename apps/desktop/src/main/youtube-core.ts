/**
 * YouTube link parsing for the guided "Publish to YouTube (unlisted)" helper
 * (SPEC S7). Pure - no Electron - so it is unit-testable in isolation.
 *
 * Accepts the shapes a user actually copies out of a browser address bar or
 * YouTube's own Share button - watch?v=, youtu.be/ and the m. mobile host -
 * tolerating extra query params (&t=, &list=, &si=) and trailing slashes, and
 * returns a clean canonical watch URL plus the 11-character video id. Anything
 * that is not a recognisable YouTube video link returns null.
 */

/** YouTube video ids are exactly 11 URL-safe base64 characters. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export interface ParsedYouTube {
  /** Canonical https://www.youtube.com/watch?v=<id> link, tracking params stripped. */
  url: string;
  /** The 11-character YouTube video id. */
  id: string;
}

/**
 * Extract the video id from a pasted YouTube link and normalise it to a clean
 * canonical watch URL. Returns null for anything that is not a YouTube link.
 */
export function parseYouTubeUrl(input: string): ParsedYouTube | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  // Only real web links; blocks javascript:, ftp:, data:, etc.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname.replace(/\/+$/, '');

  let id: string | null = null;
  if (host === 'youtu.be') {
    // Short form: https://youtu.be/<id>[?t=..]
    id = path.split('/')[1] ?? null;
  } else if (host === 'youtube.com' || host === 'm.youtube.com') {
    // Long form: https://[m.]youtube.com/watch?v=<id>[&..]
    if (path === '/watch') id = parsed.searchParams.get('v');
  } else {
    return null;
  }

  if (!id || !VIDEO_ID_RE.test(id)) return null;
  return { url: `https://www.youtube.com/watch?v=${id}`, id };
}
