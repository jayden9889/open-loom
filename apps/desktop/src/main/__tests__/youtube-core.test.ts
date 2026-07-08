/**
 * parseYouTubeUrl (SPEC S7): the pure link parser behind the guided
 * "Publish to YouTube (unlisted)" helper. Covers every shape a user can paste
 * out of a browser or YouTube's Share button, and every non-YouTube input.
 */
import { describe, expect, it } from 'vitest';
import { parseYouTubeUrl } from '../youtube-core';

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
