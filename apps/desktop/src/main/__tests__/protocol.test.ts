/**
 * openloom-file:// path-safety tests: the resolver must never yield a path
 * outside <libDir>/<videoId>/.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveLibraryPath } from '../library-core';

const lib = path.resolve('/tmp/openloom-library');

describe('resolveLibraryPath', () => {
  it('resolves a valid id + file inside the library', () => {
    const p = resolveLibraryPath(lib, 'abc123XYZ_', 'video.mp4');
    expect(p).toBe(path.join(lib, 'abc123XYZ_', 'video.mp4'));
  });

  it('accepts the standard asset names', () => {
    for (const f of ['meta.json', 'thumb.jpg', 'preview.gif', 'waveform.json', 'transcript.vtt']) {
      expect(resolveLibraryPath(lib, 'aaaaaaaaaa', f)).not.toBeNull();
    }
  });

  it('rejects traversal in the file name', () => {
    expect(resolveLibraryPath(lib, 'abc123', '../secrets.txt')).toBeNull();
    expect(resolveLibraryPath(lib, 'abc123', '..%2Fsecrets')).toBeNull();
    expect(resolveLibraryPath(lib, 'abc123', 'a/../../x')).toBeNull();
    expect(resolveLibraryPath(lib, 'abc123', 'video..mp4')).toBeNull();
  });

  it('rejects traversal or separators in the video id', () => {
    expect(resolveLibraryPath(lib, '..', 'video.mp4')).toBeNull();
    expect(resolveLibraryPath(lib, 'a/b', 'video.mp4')).toBeNull();
    expect(resolveLibraryPath(lib, 'a\\b', 'video.mp4')).toBeNull();
    expect(resolveLibraryPath(lib, '.', 'video.mp4')).toBeNull();
    expect(resolveLibraryPath(lib, '', 'video.mp4')).toBeNull();
  });

  it('rejects absolute paths and hidden/odd file names', () => {
    expect(resolveLibraryPath(lib, 'abc123', '/etc/passwd')).toBeNull();
    expect(resolveLibraryPath(lib, 'abc123', '.hidden')).toBeNull();
    expect(resolveLibraryPath(lib, 'abc123', 'nested/file.mp4')).toBeNull();
    expect(resolveLibraryPath(lib, 'abc123', '')).toBeNull();
  });

  it('rejects ids longer than 32 chars', () => {
    expect(resolveLibraryPath(lib, 'a'.repeat(33), 'video.mp4')).toBeNull();
  });
});
