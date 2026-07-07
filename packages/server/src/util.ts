/**
 * Small shared helpers: id/file validation, HTML escaping, constant-time
 * comparison, range parsing, per-video unlock tokens.
 */
import crypto from 'node:crypto';

/** Video ids are nanoid-style; accept 6..32 url-safe chars. */
export const ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
/** Viewer session / view ids come from the client; same alphabet, 6..64. */
export const SESSION_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** The only files a video directory may contain (path-traversal-safe by construction). */
export const UPLOAD_FILES = ['video.mp4', 'thumb.jpg', 'preview.gif', 'captions.vtt'] as const;
export type UploadFileName = (typeof UPLOAD_FILES)[number];

export function isUploadFile(name: string): name is UploadFileName {
  return (UPLOAD_FILES as readonly string[]).includes(name);
}

export const CONTENT_TYPES: Record<UploadFileName, string> = {
  'video.mp4': 'video/mp4',
  'thumb.jpg': 'image/jpeg',
  'preview.gif': 'image/gif',
  'captions.vtt': 'text/vtt; charset=utf-8',
};

/** Emoji the reaction bar offers; the server accepts nothing else. */
export const REACTION_EMOJI = ['\u{1F44D}', '❤️', '\u{1F602}', '\u{1F389}', '\u{1F440}'] as const;

/** Watch-coverage resolution for the analytics heat strip. */
export const COVERAGE_BUCKETS = 100;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Constant-time string comparison (auth tokens, cookies). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Deterministic per-video unlock token: proves the viewer once presented the
 * correct password. Changing the password invalidates every cookie.
 */
export function unlockToken(videoId: string, passwordHash: string): string {
  return crypto.createHash('sha256').update(`${passwordHash}:${videoId}`).digest('hex');
}

export interface ByteRange {
  start: number;
  end: number;
}

/** Parse a single `bytes=` Range header against a file size. Null = invalid/absent. */
export function parseRange(header: string | undefined, size: number): ByteRange | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || size <= 0) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    // suffix range: last N bytes
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return null;
    const start = Math.max(0, size - n);
    return { start, end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export function nowIso(): string {
  return new Date().toISOString();
}
