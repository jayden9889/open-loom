/**
 * parseYouTubeUrl (SPEC S7): the pure link parser behind the guided
 * "Publish to YouTube (unlisted)" helper. Covers every shape a user can paste
 * out of a browser or YouTube's Share button, and every non-YouTube input.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAuthUrl,
  buildVideoInsertMetadata,
  contentRange,
  isQuotaError,
  isSessionReusable,
  parseLoopbackCallback,
  parseOwnChannel,
  parseResumeOffset,
  parseYouTubeUrl,
  pkcePair,
  queryRange,
  randomToken,
  SESSION_MAX_AGE_MS,
  videosDeleteUrl,
  YT_SCOPE_VERSION,
  studioEditUrl,
  UPLOAD_CHUNK_BYTES,
  watchUrl,
  YT_AUTH_ENDPOINT,
  YT_SCOPE,
} from '../youtube-core';

const ID = 'dQw4w9WgXcQ';
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`;

describe('parseYouTubeUrl - accepts real YouTube links', () => {
  it('parses a standard www watch?v= link', () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}`)).toEqual({ url: CANONICAL, id: ID });
  });

  it('parses a watch?v= link without the www subdomain', () => {
    expect(parseYouTubeUrl(`https://youtube.com/watch?v=${ID}`)).toEqual({ url: CANONICAL, id: ID });
  });

  it('parses a youtu.be short link', () => {
    expect(parseYouTubeUrl(`https://youtu.be/${ID}`)).toEqual({ url: CANONICAL, id: ID });
  });

  it('parses an m.youtube.com mobile link', () => {
    expect(parseYouTubeUrl(`https://m.youtube.com/watch?v=${ID}`)).toEqual({ url: CANONICAL, id: ID });
  });

  it('accepts http as well as https', () => {
    expect(parseYouTubeUrl(`http://www.youtube.com/watch?v=${ID}`)).toEqual({ url: CANONICAL, id: ID });
  });

  it('is case-insensitive on the host', () => {
    expect(parseYouTubeUrl(`HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`)).toEqual({ url: CANONICAL, id: ID });
  });
});

describe('parseYouTubeUrl - tolerates extra params, slashes and whitespace', () => {
  it('strips a &t= timestamp param and normalises to the canonical url', () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&t=43s`)).toEqual({ url: CANONICAL, id: ID });
  });

  it('strips a &list= playlist param', () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&list=PLabcdef123456`)).toEqual({
      url: CANONICAL,
      id: ID,
    });
  });

  it('keeps the id when v is not the first query param', () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?list=PLabc&v=${ID}`)).toEqual({ url: CANONICAL, id: ID });
  });

  it('strips a ?t= param on a youtu.be link', () => {
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=43`)).toEqual({ url: CANONICAL, id: ID });
  });

  it('tolerates a trailing slash on a youtu.be link', () => {
    expect(parseYouTubeUrl(`https://youtu.be/${ID}/`)).toEqual({ url: CANONICAL, id: ID });
  });

  it('tolerates a trailing slash on a watch link', () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/watch/?v=${ID}`)).toEqual({ url: CANONICAL, id: ID });
  });

  it('trims surrounding whitespace', () => {
    expect(parseYouTubeUrl(`   https://youtu.be/${ID}   `)).toEqual({ url: CANONICAL, id: ID });
  });
});

describe('parseYouTubeUrl - rejects everything that is not a YouTube video link', () => {
  it('rejects an empty string', () => {
    expect(parseYouTubeUrl('')).toBeNull();
  });

  it('rejects whitespace only', () => {
    expect(parseYouTubeUrl('   ')).toBeNull();
  });

  it('rejects plain text', () => {
    expect(parseYouTubeUrl('not a link at all')).toBeNull();
  });

  it('rejects a malformed url', () => {
    expect(parseYouTubeUrl('htp://youtu.be')).toBeNull();
    expect(parseYouTubeUrl('youtube.com/watch?v=' + ID)).toBeNull();
  });

  it('rejects a non-YouTube host', () => {
    expect(parseYouTubeUrl(`https://vimeo.com/watch?v=${ID}`)).toBeNull();
    expect(parseYouTubeUrl(`https://notyoutube.com/watch?v=${ID}`)).toBeNull();
    expect(parseYouTubeUrl(`https://youtube.evil.com/watch?v=${ID}`)).toBeNull();
  });

  it('rejects a non-web scheme even on a YouTube host', () => {
    expect(parseYouTubeUrl(`javascript:alert(1)//youtu.be/${ID}`)).toBeNull();
  });

  it('rejects a watch link with no v param', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/watch')).toBeNull();
  });

  it('rejects the YouTube home and channel pages', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/')).toBeNull();
    expect(parseYouTubeUrl('https://www.youtube.com/@somechannel')).toBeNull();
  });

  it('rejects an id that is not 11 characters', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}TOOLONG`)).toBeNull();
  });

  it('rejects a youtu.be link with no id', () => {
    expect(parseYouTubeUrl('https://youtu.be/')).toBeNull();
    expect(parseYouTubeUrl('https://youtu.be')).toBeNull();
  });
});

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('watchUrl / studioEditUrl', () => {
  it('builds the canonical watch url', () => {
    expect(watchUrl(ID)).toBe(CANONICAL);
  });
  it('builds the studio edit url', () => {
    expect(studioEditUrl(ID)).toBe(`https://studio.youtube.com/video/${ID}/edit`);
  });
});

describe('randomToken', () => {
  it('is URL-safe, unpadded and long enough for a PKCE verifier', () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(43);
  });
  it('does not repeat', () => {
    expect(randomToken()).not.toBe(randomToken());
  });
});

describe('pkcePair', () => {
  it('returns a verifier and its correct S256 challenge', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(b64url(createHash('sha256').update(verifier).digest()));
    // base64url must never contain +, / or = padding.
    expect(challenge).not.toMatch(/[+/=]/);
  });
});

describe('buildAuthUrl', () => {
  const url = new URL(
    buildAuthUrl({ clientId: 'cid.apps', redirectUri: 'http://127.0.0.1:9004', challenge: 'CH', state: 'ST' })
  );
  it('targets the Google consent endpoint', () => {
    expect(`${url.origin}${url.pathname}`).toBe(YT_AUTH_ENDPOINT);
  });
  it('carries the PKCE, offline and consent params', () => {
    const p = url.searchParams;
    expect(p.get('client_id')).toBe('cid.apps');
    expect(p.get('redirect_uri')).toBe('http://127.0.0.1:9004');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe(YT_SCOPE);
    expect(p.get('code_challenge')).toBe('CH');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('state')).toBe('ST');
  });
});

describe('parseLoopbackCallback', () => {
  it('extracts code and state from a full redirect url', () => {
    expect(parseLoopbackCallback('http://127.0.0.1:9004/?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    });
  });
  it('extracts from a bare path+query', () => {
    expect(parseLoopbackCallback('/?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
  });
  it('surfaces an error param', () => {
    expect(parseLoopbackCallback('/?error=access_denied')).toEqual({ error: 'access_denied' });
  });
  it('returns empty for an unrelated request (e.g. favicon)', () => {
    expect(parseLoopbackCallback('/favicon.ico')).toEqual({});
  });
});

describe('buildVideoInsertMetadata', () => {
  it('requests unlisted and declares not-made-for-kids by default', () => {
    const m = buildVideoInsertMetadata({ title: 'Demo', description: 'A walkthrough' });
    expect(m.snippet).toEqual({ title: 'Demo', description: 'A walkthrough' });
    expect(m.status).toEqual({ privacyStatus: 'unlisted', selfDeclaredMadeForKids: false });
  });
  it('strips angle brackets and caps the title at 100 chars', () => {
    const long = 'x'.repeat(150);
    const m = buildVideoInsertMetadata({ title: `<b>${long}</b>` });
    expect(m.snippet.title).not.toMatch(/[<>]/);
    expect(m.snippet.title.length).toBe(100);
  });
  it('falls back to a placeholder when the title is empty', () => {
    expect(buildVideoInsertMetadata({ title: '   ' }).snippet.title).toBe('Untitled recording');
  });
  it('honours an explicit privacyStatus', () => {
    expect(buildVideoInsertMetadata({ title: 'T', privacyStatus: 'private' }).status.privacyStatus).toBe(
      'private'
    );
  });
});

describe('YT_SCOPE', () => {
  it('requests force-ssl plus readonly (force-ssl covers upload AND videos.delete; readonly powers the connect-time channel check)', () => {
    const scopes = YT_SCOPE.split(' ');
    expect(scopes).toContain('https://www.googleapis.com/auth/youtube.force-ssl');
    expect(scopes).toContain('https://www.googleapis.com/auth/youtube.readonly');
    // The narrower upload scope cannot delete videos; it must not creep back in.
    expect(scopes).not.toContain('https://www.googleapis.com/auth/youtube.upload');
  });

  it('carries a scope version >= 2 so pre-widening tokens can be told apart', () => {
    expect(YT_SCOPE_VERSION).toBeGreaterThanOrEqual(2);
  });
});

describe('videosDeleteUrl', () => {
  it('targets videos.delete with the id as a query param', () => {
    expect(videosDeleteUrl(ID)).toBe(`https://www.googleapis.com/youtube/v3/videos?id=${ID}`);
  });
  it('URL-encodes the id defensively', () => {
    expect(videosDeleteUrl('a b')).toBe('https://www.googleapis.com/youtube/v3/videos?id=a%20b');
  });
});

describe('isQuotaError', () => {
  it('matches the 403 quotaExceeded family', () => {
    expect(isQuotaError(403, 'The request cannot be completed because you have exceeded your quota.')).toBe(true);
    expect(isQuotaError(403, 'quotaExceeded')).toBe(true);
  });
  it('matches the 400 uploadLimitExceeded daily upload cap', () => {
    expect(isQuotaError(400, 'The user has exceeded the number of videos they may upload. (uploadLimitExceeded)')).toBe(true);
    expect(isQuotaError(400, 'uploadLimit reached')).toBe(true);
  });
  it('does not match other errors on those statuses', () => {
    expect(isQuotaError(403, 'insufficient permissions')).toBe(false);
    expect(isQuotaError(400, 'invalidTitle')).toBe(false);
  });
  it('does not match quota wording on unrelated statuses', () => {
    expect(isQuotaError(500, 'quota')).toBe(false);
    expect(isQuotaError(401, 'uploadLimitExceeded')).toBe(false);
  });
});

describe('isSessionReusable', () => {
  const NOW = Date.parse('2026-08-12T12:00:00Z');
  const pending = {
    sessionUri: 'https://upload.example/session',
    total: 1000,
    startedAt: '2026-08-11T12:00:00Z',
  };

  it('accepts a fresh session whose byte count matches the file', () => {
    expect(isSessionReusable(pending, 1000, NOW)).toBe(true);
  });
  it('rejects when the file size changed (the declared length is committed at session start)', () => {
    expect(isSessionReusable(pending, 999, NOW)).toBe(false);
  });
  it('rejects a session older than the 7-day lifetime', () => {
    expect(isSessionReusable(pending, 1000, Date.parse(pending.startedAt) + SESSION_MAX_AGE_MS)).toBe(false);
    expect(isSessionReusable(pending, 1000, Date.parse(pending.startedAt) + SESSION_MAX_AGE_MS - 1)).toBe(true);
  });
  it('rejects a missing marker, an empty session uri and an unparseable start time', () => {
    expect(isSessionReusable(undefined, 1000, NOW)).toBe(false);
    expect(isSessionReusable({ ...pending, sessionUri: '' }, 1000, NOW)).toBe(false);
    expect(isSessionReusable({ ...pending, startedAt: 'garbage' }, 1000, NOW)).toBe(false);
  });
  it('rejects a start time in the future (clock skew reads as not trustworthy)', () => {
    expect(isSessionReusable({ ...pending, startedAt: '2026-08-13T12:00:00Z' }, 1000, NOW)).toBe(false);
  });
});

describe('resumable upload chunking', () => {
  it('uses a chunk size Google accepts (a multiple of 256 KiB)', () => {
    expect(UPLOAD_CHUNK_BYTES % (256 * 1024)).toBe(0);
    expect(UPLOAD_CHUNK_BYTES).toBeGreaterThan(0);
  });

  it('builds an inclusive Content-Range for a chunk', () => {
    expect(contentRange(0, 8388607, 105307498)).toBe('bytes 0-8388607/105307498');
    expect(contentRange(8388608, 10485759, 10485760)).toBe('bytes 8388608-10485759/10485760');
  });

  it('builds the query range used to ask how far the server got', () => {
    expect(queryRange(105307498)).toBe('bytes */105307498');
  });

  it('resumes at the byte after the last one the server stored', () => {
    expect(parseResumeOffset('bytes=0-262143')).toBe(262144);
    expect(parseResumeOffset('bytes=0-0')).toBe(1);
  });

  it('treats a missing or unparseable Range as "server has nothing"', () => {
    expect(parseResumeOffset(null)).toBe(0);
    expect(parseResumeOffset(undefined)).toBe(0);
    expect(parseResumeOffset('')).toBe(0);
    expect(parseResumeOffset('garbage')).toBe(0);
  });

  it('tolerates surrounding whitespace in the header', () => {
    expect(parseResumeOffset('  bytes=0-999  ')).toBe(1000);
  });
});

describe('parseOwnChannel', () => {
  it('extracts the channel id and title from a channels.list?mine=true response', () => {
    const json = { items: [{ id: 'UCabc123', snippet: { title: 'Sample Creator' } }] };
    expect(parseOwnChannel(json)).toEqual({ id: 'UCabc123', title: 'Sample Creator' });
  });
  it('returns null when the account has no channel (empty items)', () => {
    expect(parseOwnChannel({ items: [] })).toBeNull();
    expect(parseOwnChannel({ kind: 'youtube#channelListResponse' })).toBeNull();
  });
  it('returns null for garbage input', () => {
    expect(parseOwnChannel(null)).toBeNull();
    expect(parseOwnChannel('nope')).toBeNull();
    expect(parseOwnChannel({ items: [{ snippet: { title: 'no id' } }] })).toBeNull();
  });
  it('tolerates a missing title (id alone is enough to prove uploads can land)', () => {
    expect(parseOwnChannel({ items: [{ id: 'UCabc123' }] })).toEqual({ id: 'UCabc123', title: '' });
  });
});
