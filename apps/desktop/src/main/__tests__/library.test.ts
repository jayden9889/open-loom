/**
 * Library store tests: scan, CRUD, folders, move semantics, search
 * (titles + transcript hook).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VideoMeta } from '@shared/types';
import { LibraryStore } from '../library-core';

let dir: string;
let store: LibraryStore;
let idCounter: number;

function makeStore(): LibraryStore {
  return new LibraryStore(dir, {
    trash: async (p) => {
      fs.rmSync(p, { recursive: true, force: true });
    },
    newId: () => `testid${(idCounter++).toString().padStart(4, '0')}`,
  });
}

function seedVideo(id: string, patch: Partial<VideoMeta> = {}): VideoMeta {
  const meta: VideoMeta = {
    id,
    title: `Video ${id}`,
    createdAt: new Date(2026, 0, idCounter++).toISOString(),
    durationSec: 12,
    width: 1920,
    height: 1080,
    fps: 30,
    sizeBytes: 1234,
    mode: 'screen',
    folderId: null,
    ...patch,
  };
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, 'meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, id, 'video.mp4'), 'fake video bytes');
  return meta;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-lib-test-'));
  idCounter = 1;
  store = makeStore();
});

describe('scan + list', () => {
  it('lists videos newest first and skips corrupt meta', () => {
    seedVideo('aaa');
    seedVideo('bbb');
    fs.mkdirSync(path.join(dir, 'corrupt'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'corrupt', 'meta.json'), '{ nope');
    const list = store.list();
    expect(list.map((v) => v.id)).toEqual(['bbb', 'aaa']);
  });

  it('ignores directories whose meta id does not match', () => {
    seedVideo('aaa');
    fs.mkdirSync(path.join(dir, 'evil'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'evil', 'meta.json'), JSON.stringify({ id: 'other', title: 'x' }));
    expect(store.list().map((v) => v.id)).toEqual(['aaa']);
  });
});

describe('CRUD', () => {
  it('get throws a human error for missing videos', () => {
    expect(() => store.get('missing000')).toThrow(/not found/);
  });

  it('updates meta in place', () => {
    seedVideo('aaa');
    const updated = store.update('aaa', { title: 'Renamed', description: 'Notes' });
    expect(updated.title).toBe('Renamed');
    expect(store.get('aaa').description).toBe('Notes');
  });

  it('update cannot change the id', () => {
    seedVideo('aaa');
    const updated = store.update('aaa', { id: 'zzz' } as Partial<VideoMeta>);
    expect(updated.id).toBe('aaa');
  });

  it('deletes via the injected trash and prunes ordering', async () => {
    seedVideo('aaa');
    await store.delete('aaa');
    expect(fs.existsSync(path.join(dir, 'aaa'))).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('duplicates files and strips share state', () => {
    seedVideo('aaa', {
      share: {
        provider: 'server',
        url: 'https://example.com/v/aaa',
        privacy: 'link',
        allowComments: true,
        allowReactions: true,
        allowDownload: true,
      },
    });
    const copy = store.duplicate('aaa');
    expect(copy.id).not.toBe('aaa');
    expect(copy.title).toBe('Video aaa copy');
    expect(copy.share).toBeUndefined();
    expect(fs.existsSync(path.join(dir, copy.id, 'video.mp4'))).toBe(true);
    expect(store.list()).toHaveLength(2);
  });
});

describe('folders', () => {
  it('creates, renames, lists', () => {
    const f = store.createFolder('  Demos ');
    expect(f.name).toBe('Demos');
    store.renameFolder(f.id, 'Client demos');
    expect(store.listFolders()).toEqual([{ id: f.id, name: 'Client demos' }]);
  });

  it('rejects empty names', () => {
    expect(() => store.createFolder('   ')).toThrow(/empty/);
  });

  it('moveVideo validates the target folder', () => {
    seedVideo('aaa');
    expect(() => store.moveVideo('aaa', 'ghost')).toThrow(/no longer exists/);
    const f = store.createFolder('Demos');
    store.moveVideo('aaa', f.id);
    expect(store.get('aaa').folderId).toBe(f.id);
    store.moveVideo('aaa', null);
    expect(store.get('aaa').folderId).toBeNull();
  });

  it('deleting a folder moves its videos back to the library', () => {
    const f = store.createFolder('Demos');
    seedVideo('aaa', { folderId: f.id });
    store.deleteFolder(f.id);
    expect(store.listFolders()).toEqual([]);
    expect(store.get('aaa').folderId).toBeNull();
  });
});

describe('search', () => {
  it('matches titles case-insensitively', () => {
    seedVideo('aaa', { title: 'Quarterly Update' });
    seedVideo('bbb', { title: 'Bug walkthrough' });
    const hits = store.search('quarterly');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('aaa');
    expect(hits[0]!.matches[0]).toBe('Quarterly Update');
  });

  it('searches transcript.json segments when present', () => {
    seedVideo('aaa', { title: 'Untitled' });
    fs.writeFileSync(
      path.join(dir, 'aaa', 'transcript.json'),
      JSON.stringify({ segments: [{ start: 0, end: 2, text: 'welcome to the demo of folders' }] })
    );
    const hits = store.search('demo of folders');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.matches[0]).toContain('welcome to the demo');
  });

  it('returns nothing for a blank query', () => {
    seedVideo('aaa');
    expect(store.search('   ')).toEqual([]);
  });
});
