/**
 * Electron binding for the library store: wires the OS trash, nanoid ids,
 * the openloom-file:// protocol and thumbnail regeneration.
 */
import { shell } from 'electron';
import { nanoid } from 'nanoid';
import fs from 'node:fs';
import path from 'node:path';
import type { VideoMeta } from '@shared/types';
import { VIDEO_FILES } from '@shared/types';
import { LibraryStore } from './library-core';
import { getSettings } from './settings';
import { log } from './logger';
import { requireBinaries, thumbnail, enqueueJob } from './ffmpeg';

let cached: { dir: string; store: LibraryStore } | null = null;

export function library(): LibraryStore {
  const dir = getSettings().saveDir;
  if (!cached || cached.dir !== dir) {
    cached = {
      dir,
      store: new LibraryStore(dir, {
        trash: async (absPath) => {
          await shell.trashItem(absPath);
        },
        newId: () => nanoid(10),
        warn: (msg) => log.warn(`library: ${msg}`),
      }),
    };
  }
  return cached.store;
}

export function revealVideo(id: string): void {
  const store = library();
  const videoPath = path.join(store.videoDir(id), VIDEO_FILES.video);
  if (fs.existsSync(videoPath)) {
    shell.showItemInFolder(videoPath);
  } else {
    shell.showItemInFolder(store.videoDir(id));
  }
}

export function fileUrl(id: string, file: string): string {
  return `openloom-file://${encodeURIComponent(id)}/${encodeURIComponent(file)}`;
}

/** Set a custom thumbnail from an image file or a frame of the video (SPEC L7). */
export async function setCustomThumbnail(
  id: string,
  source: { path?: string; atSec?: number }
): Promise<void> {
  const store = library();
  const meta: VideoMeta = store.get(id);
  const thumbPath = path.join(store.videoDir(id), VIDEO_FILES.thumb);
  if (source.path) {
    if (!fs.existsSync(source.path)) throw new Error('That image file could not be read.');
    const ext = path.extname(source.path).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') {
      fs.copyFileSync(source.path, thumbPath);
    } else {
      // Convert any other image format to JPEG via ffmpeg.
      const bins = requireBinaries();
      await enqueueJob(id, 'thumbnail', async () => {
        await thumbnail(bins, source.path!, thumbPath, 0);
      });
    }
  } else if (typeof source.atSec === 'number') {
    const bins = requireBinaries();
    const videoPath = path.join(store.videoDir(id), VIDEO_FILES.video);
    await enqueueJob(id, 'thumbnail', async () => {
      await thumbnail(bins, videoPath, thumbPath, Math.min(Math.max(0, source.atSec!), meta.durationSec));
    });
  } else {
    throw new Error('Pick an image file or a frame time for the thumbnail.');
  }
  store.update(id, { customThumb: true });
}
