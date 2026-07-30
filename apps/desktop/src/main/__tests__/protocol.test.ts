/**
 * openloom-file:// path-safety tests: the resolver must never yield a path
 * outside <libDir>/<videoId>/.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
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

describe('resolveLibraryPath - symlink containment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-symlink-'));
  const videoId = 'vid0000001';
  const videoDir = path.join(root, videoId);
  fs.mkdirSync(videoDir, { recursive: true });
  const secret = path.join(root, 'secret.txt');
  fs.writeFileSync(secret, 'private key material');

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('resolves a real file inside the video dir', () => {
    const real = path.join(videoDir, 'video.mp4');
    fs.writeFileSync(real, 'data');
    expect(resolveLibraryPath(root, videoId, 'video.mp4')).toBe(real);
  });

  it('rejects a file that is a symlink escaping the video dir', () => {
    const link = path.join(videoDir, 'thumb.jpg');
    fs.symlinkSync(secret, link);
    expect(resolveLibraryPath(root, videoId, 'thumb.jpg')).toBeNull();
  });

  it('allows a not-yet-created write target', () => {
    expect(resolveLibraryPath(root, videoId, 'waveform.json')).toBe(path.join(videoDir, 'waveform.json'));
  });
});
