/**
 * Pure helpers behind the "Publish to YouTube (unlisted)" uploader (SPEC S7):
 * link parsing plus the OAuth 2.0 loopback + videos.insert request shapes. No
 * Electron and no network - just string/crypto transforms - so every branch is
 * unit-testable in isolation. youtube.ts / youtube-oauth.ts bind these to the
 * app's settings store, a loopback server and fetch.
 */
import { createHash, randomBytes } from 'node:crypto';

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

/** Canonical watch URL for a known-good 11-char video id. */
export function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** studio.youtube.com edit page for an upload - the target of the flip-to-Unlisted step. */
export function studioEditUrl(id: string): string {
  return `https://studio.youtube.com/video/${id}/edit`;
}

// ---------------------------------------------------------------------------
// OAuth 2.0 loopback (RFC 8252) - pure request builders
// ---------------------------------------------------------------------------

export const YT_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const YT_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
/** Upload + set metadata (incl. privacyStatus) on the user's own channel. */
export const YT_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

/** base64url of arbitrary bytes (no '=' padding, URL-safe alphabet). */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A URL-safe random token (default 32 bytes -> 43 chars), used for PKCE verifier and CSRF state. */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** PKCE pair: a random verifier and its S256 challenge (RFC 7636). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32); // 43 chars, within the 43-128 range
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Build the Google consent URL for the loopback flow (PKCE S256, offline access). */
export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: YT_SCOPE,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    // Force the consent screen so a refresh_token is always returned, even on
    // re-connect (Google omits it on silent re-auth otherwise).
    prompt: 'consent',
    state: opts.state,
  });
  return `${YT_AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Parse the loopback redirect the browser hits (e.g. `/?code=..&state=..` or
 * `/?error=access_denied`). Accepts a full URL or just the request path+query.
 * Returns whichever of code/state/error were present.
 */
export function parseLoopbackCallback(
  reqUrl: string
): { code?: string; state?: string; error?: string } {
  let search: URLSearchParams;
  try {
    // Resolve against a dummy base so a bare "/cb?code=.." path parses too.
    search = new URL(reqUrl, 'http://127.0.0.1').searchParams;
  } catch {
    return { error: 'invalid_callback' };
  }
  const out: { code?: string; state?: string; error?: string } = {};
  const code = search.get('code');
  const state = search.get('state');
  const error = search.get('error');
  if (code) out.code = code;
  if (state) out.state = state;
  if (error) out.error = error;
  return out;
}

// ---------------------------------------------------------------------------
// videos.insert request body
// ---------------------------------------------------------------------------

/** YouTube caps titles at 100 chars and rejects angle brackets; descriptions cap at 5000. */
function sanitiseText(input: string, max: number): string {
  return input.replace(/[<>]/g, '').slice(0, max).trim();
}

export interface VideoInsertMetadata {
  snippet: { title: string; description: string };
  status: { privacyStatus: 'unlisted' | 'private' | 'public'; selfDeclaredMadeForKids: boolean };
}

/**
 * Build the videos.insert metadata body. Requests unlisted; an unaudited API
 * project will still force the result to private (docs/DECISIONS.md), which the
 * caller detects from the response and surfaces as the flip-to-Unlisted step.
 * `selfDeclaredMadeForKids: false` is required by YouTube on API uploads.
 */
export function buildVideoInsertMetadata(opts: {
  title: string;
  description?: string;
  privacyStatus?: 'unlisted' | 'private' | 'public';
}): VideoInsertMetadata {
  const title = sanitiseText(opts.title, 100) || 'Untitled recording';
  return {
    snippet: { title, description: sanitiseText(opts.description ?? '', 5000) },
    status: { privacyStatus: opts.privacyStatus ?? 'unlisted', selfDeclaredMadeForKids: false },
  };
}
