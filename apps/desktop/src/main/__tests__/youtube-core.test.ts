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
  parseLoopbackCallback,
  parseYouTubeUrl,
  pkcePair,
  randomToken,
  studioEditUrl,
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
