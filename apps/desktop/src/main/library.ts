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
import { generatePreviews } from './preview-core';
import { getSettings } from './settings';
import { log } from './logger';
import { broadcast } from './windows';
import { requireBinaries, thumbnail, gifPreview, waveformPeaks, enqueueJob } from './ffmpeg';

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
        // Data-loss recoveries (corrupt library.json / meta.json) must reach
        // the user, not just the log file they will never open.
        notify: (msg) => broadcast('ol:toast', { kind: 'error', text: msg }),
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
/** True when the file starts with the JPEG SOI + marker bytes (FF D8 FF). */
function isJpeg(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(3);
    const read = fs.readSync(fd, head, 0, 3, 0);
    return read === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

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
    // The extension is renderer-supplied and thumb.jpg is part of the share
    // upload, so a mislabelled file would be published verbatim by a later
    // share. Only copy when the bytes really are a JPEG; anything else goes
    // through ffmpeg, which re-encodes and cannot pass arbitrary content on.
    if ((ext === '.jpg' || ext === '.jpeg') && isJpeg(source.path)) {
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

/**
 * Rebuild thumb.jpg / preview.gif / waveform.json for an existing recording.
 * User-initiated from the library card when preview generation failed after
 * the recording landed, so unlike that best-effort pass a total failure here
 * must surface rather than vanish into the log.
 */
export async function regeneratePreviews(id: string): Promise<void> {
  const store = library();
  const meta = store.get(id);
  const dir = store.videoDir(id);
  const videoPath = path.join(dir, VIDEO_FILES.video);
  if (!fs.existsSync(videoPath)) {
    throw new Error('The video file for this recording is missing, so its previews cannot be rebuilt.');
  }
  const bins = requireBinaries();
  const thumbPath = path.join(dir, VIDEO_FILES.thumb);
  const failed = await generatePreviews({
    thumbnail: async () => {
      // A thumbnail the user set deliberately is kept; only derived previews rebuild.
      if (meta.customThumb && fs.existsSync(thumbPath)) return;
      await enqueueJob(id, 'thumbnail', () => thumbnail(bins, videoPath, thumbPath, meta.durationSec * 0.25));
    },
    gif: () => enqueueJob(id, 'gif', () => gifPreview(bins, videoPath, path.join(dir, VIDEO_FILES.preview))),
    waveform: () =>
      enqueueJob(id, 'waveform', async () => {
        await waveformPeaks(bins, videoPath, path.join(dir, VIDEO_FILES.waveform));
      }),
    warn: (msg) => log.warn(`${id}: ${msg}`),
  });
  if (failed.length > 0) {
    throw new Error(`Some previews could not be rebuilt (${failed.join(', ')}). The recording itself is fine.`);
  }
}
