/**
 * Server share provider: retrying a failed upload (or re-sharing) must reuse
 * the existing remote id instead of POSTing a fresh create, which the server
 * answers with a brand-new id - orphaning the first row and breaking the link
 * already copied to the clipboard. Captions are pushed on their own plan so a
 * multi-GB video is never re-uploaded just to add a track.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoMeta } from '@shared/types';
import { ServerShareProvider, remoteIdFromShareUrl } from '../share/server';

function meta(patch: Partial<VideoMeta> = {}): VideoMeta {
  return {
    id: 'localid123',
    title: 'Demo',
    createdAt: new Date().toISOString(),
    durationSec: 10,
    width: 1920,
    height: 1080,
    fps: 30,
    sizeBytes: 1000,
    mode: 'screen',
    folderId: null,
    ...patch,
  };
}

const provider = new ServerShareProvider({ url: 'https://videos.example.com', apiKey: 'k' });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('remoteIdFromShareUrl', () => {
  it('extracts the id from a /v/:id url', () => {
    expect(remoteIdFromShareUrl('https://videos.example.com/v/abc123', 'fallback')).toBe('abc123');
  });
  it('ignores query and hash', () => {
    expect(remoteIdFromShareUrl('https://videos.example.com/v/abc123?x=1#t', 'fallback')).toBe('abc123');
  });
  it('falls back when there is no /v/ segment', () => {
    expect(remoteIdFromShareUrl('https://videos.example.com/other', 'fallback')).toBe('fallback');
    expect(remoteIdFromShareUrl(undefined, 'fallback')).toBe('fallback');
  });
});

describe('resumeShare (retry / re-share)', () => {
  it('reuses the existing remote id and url without hitting the network', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const shared = meta({
      share: {
        provider: 'server',
        url: 'https://videos.example.com/v/remoteXYZ',
        privacy: 'link',
        allowComments: true,
        allowReactions: true,
        allowDownload: true,
      },
    });
    const result = provider.resumeShare(shared);
    expect(result.shareUrl).toBe('https://videos.example.com/v/remoteXYZ');
    expect(result.uploadPlan.context?.remoteId).toBe('remoteXYZ');
    // No POST /videos create: that is exactly what would mint an orphan id.
    expect(fetchSpy).not.toHaveBeenCalled();
    // The full asset set is still re-pushed (resumable), including captions.
    expect(result.uploadPlan.files.map((f) => f.remote)).toContain('video.mp4');
    expect(result.uploadPlan.files.map((f) => f.remote)).toContain('captions.vtt');
  });
});

describe('captionsPlan', () => {
  it('targets the existing remote id and carries only the captions track', () => {
    const shared = meta({
      share: {
        provider: 'server',
        url: 'https://videos.example.com/v/remoteXYZ',
        uploadedAt: new Date().toISOString(),
        privacy: 'link',
        allowComments: true,
        allowReactions: true,
        allowDownload: true,
      },
    });
    const plan = provider.captionsPlan(shared);
    expect(plan.context?.remoteId).toBe('remoteXYZ');
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]!.name).toBe('transcript.vtt');
    expect(plan.files[0]!.remote).toBe('captions.vtt');
    // The large video is not re-listed.
    expect(plan.files.map((f) => f.remote)).not.toContain('video.mp4');
  });
});
