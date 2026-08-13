/**
 * OpenLoom Server share provider (SPEC S2): mints the share URL on stop,
 * then uploads video + assets with resumable 8 MB chunks. Resume works by
 * asking the server how many bytes it already has (HEAD Upload-Offset), so a
 * retried upload continues exactly where the connection dropped.
 * Pure module: no Electron imports.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  ShareActivity,
  ShareProvider,
  ShareResult,
  UploadPlan,
  UploadPlanFile,
  UploadProgress,
  VideoMeta,
} from '@shared/types';

export interface ServerShareConfig {
  /** Base URL of the openloom-server instance, e.g. https://videos.example.com */
  url: string;
  apiKey: string;
}

/** Local file name -> remote file name expected by the server API. */
const FILE_MAP: { local: string; remote: string; required: boolean }[] = [
  { local: 'video.mp4', remote: 'video.mp4', required: true },
  { local: 'thumb.jpg', remote: 'thumb.jpg', required: false },
  { local: 'preview.gif', remote: 'preview.gif', required: false },
  { local: 'transcript.vtt', remote: 'captions.vtt', required: false },
];

const CHUNK_BYTES = 8 * 1024 * 1024;

/** Server-side patch shape for PATCH /api/videos/:id. */
export interface ServerVideoPatch {
  title?: string;
  description?: string;
  durationSec?: number;
  privacy?: 'link' | 'password';
  password?: string;
  allowComments?: boolean;
  allowReactions?: boolean;
  allowDownload?: boolean;
  cta?: { label: string; url: string } | null;
  chapters?: { t: number; title: string }[] | null;
}

function humanFetchError(action: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(`Could not ${action}: ${detail}. Check the server URL in Settings, then Sharing.`);
}

/**
 * An HTTP error the share server itself answered (as opposed to a network
 * failure that never reached it). Carrying the status lets remove() tell "the
 * server confirms this row is gone" (404) apart from every other failure.
 */
export class ServerApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ServerApiError';
  }
}

/**
 * Recover the remote video id from a `/v/:id` share URL, falling back to the
 * local id. Used to reuse an already-created remote row on retry / caption
 * re-sync so we never POST a fresh create (which the server answers with a
 * brand-new id, orphaning the first row and killing the copied link).
 */
export function remoteIdFromShareUrl(url: string | undefined, fallback: string): string {
  const match = url ? /\/v\/([A-Za-z0-9_-]+)/.exec(url) : null;
  return match?.[1] ?? fallback;
}

export class ServerShareProvider implements ShareProvider {
  readonly kind = 'server' as const;

  constructor(private readonly cfg: ServerShareConfig) {}

  private base(): string {
    const url = (this.cfg.url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) {
      throw new Error('No share server is configured. Enter its URL under Settings, then Sharing.');
    }
    return url;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${this.cfg.apiKey}` };
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  private async api(method: string, apiPath: string, body?: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${this.base()}/api${apiPath}`, {
        method,
        headers: this.headers(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw humanFetchError(`reach the share server (${method} ${apiPath})`, err);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new ServerApiError(
        typeof data.error === 'string' ? data.error : `The share server answered ${res.status} for ${method} ${apiPath}.`,
        res.status
      );
    }
    return data;
  }

  async prepareShare(meta: VideoMeta): Promise<ShareResult> {
    // meta.title is what the app shows everywhere (the AI title is only a
    // suggestion until the user adopts it), so it is what the client's page
    // must say too - anything else makes a rename in the app a silent lie.
    const created = await this.api('POST', '/videos', {
      id: meta.id,
      title: meta.title,
      description: meta.description,
      createdAt: meta.createdAt,
      durationSec: meta.durationSec,
      width: meta.width,
      height: meta.height,
      sizeBytes: meta.sizeBytes,
      chapters: meta.ai?.chapters ?? null,
      allowComments: meta.share?.allowComments ?? true,
      allowReactions: meta.share?.allowReactions ?? true,
      allowDownload: meta.share?.allowDownload ?? true,
    });
    const remoteId = typeof created.id === 'string' ? created.id : meta.id;
    const shareUrl = typeof created.shareUrl === 'string' ? created.shareUrl : `${this.base()}/v/${remoteId}`;
    const files: UploadPlanFile[] = FILE_MAP.map((f) => ({ name: f.local, remote: f.remote, required: f.required }));
    return { shareUrl, uploadPlan: { videoId: meta.id, files, context: { remoteId } } };
  }

  /**
   * Build an upload plan for a video that already has a remote row (retry after
   * a failed upload, or a re-share) WITHOUT creating a fresh one. Reuses the
   * existing remote id so the previously copied link keeps working and no
   * orphan row is minted.
   */
  resumeShare(meta: VideoMeta): ShareResult {
    const remoteId = meta.share?.remoteId ?? remoteIdFromShareUrl(meta.share?.url, meta.id);
    const shareUrl = meta.share?.url || `${this.base()}/v/${remoteId}`;
    const files: UploadPlanFile[] = FILE_MAP.map((f) => ({ name: f.local, remote: f.remote, required: f.required }));
    return { shareUrl, uploadPlan: { videoId: meta.id, files, context: { remoteId } } };
  }

  /**
   * Upload plan carrying only the captions track, pointed at the existing
   * remote id. Auto-share on stop fires before transcription finishes, so the
   * hosted page ships without captions; this pushes transcript.vtt to the live
   * share once it exists. video.mp4 is not re-listed, so nothing large moves.
   */
  captionsPlan(meta: VideoMeta): UploadPlan {
    const remoteId = meta.share?.remoteId ?? remoteIdFromShareUrl(meta.share?.url, meta.id);
    const files: UploadPlanFile[] = [{ name: 'transcript.vtt', remote: 'captions.vtt', required: false }];
    return { videoId: meta.id, files, context: { remoteId } };
  }

  /**
   * Upload plan carrying only thumb.jpg, pointed at the existing remote id.
   * Used when the user picks a custom thumbnail after sharing, so the hosted
   * page shows the frame they chose instead of the auto-grabbed one.
   */
  thumbnailPlan(meta: VideoMeta): UploadPlan {
    const remoteId = meta.share?.remoteId ?? remoteIdFromShareUrl(meta.share?.url, meta.id);
    const files: UploadPlanFile[] = [{ name: 'thumb.jpg', remote: 'thumb.jpg', required: false }];
    return { videoId: meta.id, files, context: { remoteId } };
  }

  private remoteId(plan: UploadPlan): string {
    const id = plan.context?.remoteId;
    return typeof id === 'string' && id ? id : plan.videoId;
  }

  private async currentOffset(remoteId: string, remoteName: string): Promise<number> {
    let res: Response;
    try {
      res = await fetch(`${this.base()}/api/videos/${remoteId}/files/${remoteName}`, {
        method: 'HEAD',
        headers: this.headers(),
      });
    } catch (err) {
      throw humanFetchError('check upload progress with the share server', err);
    }
    if (!res.ok) return 0;
    const offset = Number(res.headers.get('upload-offset') ?? '0');
    return Number.isInteger(offset) && offset >= 0 ? offset : 0;
  }

  private async uploadFile(
    remoteId: string,
    localPath: string,
    remoteName: string,
    onBytes: (bytesDone: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const size = fs.statSync(localPath).size;
    let offset = await this.currentOffset(remoteId, remoteName);
    if (offset > size) offset = 0; // remote has more than we do: restart clean
    const fd = fs.openSync(localPath, 'r');
    try {
      while (offset < size) {
        const len = Math.min(CHUNK_BYTES, size - offset);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        let res: Response;
        try {
          res = await fetch(`${this.base()}/api/videos/${remoteId}/files/${remoteName}?offset=${offset}`, {
            method: 'PUT',
            headers: this.headers(),
            body: new Uint8Array(buf),
            signal,
          });
        } catch (err) {
          if (signal?.aborted) throw err;
          throw humanFetchError(`upload ${remoteName}`, err);
        }
        if (res.status === 409) {
          // Another chunk landed meanwhile; realign and continue.
          const data = (await res.json().catch(() => ({}))) as { offset?: number };
          offset = typeof data.offset === 'number' ? data.offset : await this.currentOffset(remoteId, remoteName);
          continue;
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new ServerApiError(
            data.error ?? `The share server answered ${res.status} while uploading ${remoteName}.`,
            res.status
          );
        }
        offset += len;
        onBytes(offset);
      }
      onBytes(size);
    } finally {
      fs.closeSync(fd);
    }
  }

  async upload(plan: UploadPlan, filesDir: string, onProgress: UploadProgress, signal?: AbortSignal): Promise<void> {
    const remoteId = this.remoteId(plan);
    // Weight progress by bytes across the whole plan so the bar is monotonic:
    // per-file percentages made it visibly snap back to 0 between files.
    const sizes = new Map<string, number>();
    for (const file of plan.files) {
      const localPath = path.join(filesDir, file.name);
      if (fs.existsSync(localPath)) sizes.set(file.name, fs.statSync(localPath).size);
    }
    const totalBytes = [...sizes.values()].reduce((a, b) => a + b, 0);
    let doneBytes = 0;
    for (const file of plan.files) {
      const localPath = path.join(filesDir, file.name);
      if (!sizes.has(file.name)) {
        if (file.required) throw new Error(`${file.name} is missing from the video folder; nothing to upload.`);
        continue;
      }
      await this.uploadFile(
        remoteId,
        localPath,
        file.remote,
        (bytes) =>
          onProgress({
            file: file.name,
            pct: totalBytes === 0 ? 100 : Math.min(99, Math.round(((doneBytes + bytes) / totalBytes) * 100)),
            note: `Uploading ${file.name}`,
          }),
        signal
      );
      doneBytes += sizes.get(file.name) ?? 0;
    }
    // A captions-only plan must not POST complete: the server rejects complete
    // with 409 until video.mp4 exists, which happens whenever transcription
    // finishes before the main upload does. The main upload's own complete
    // registers the captions afterwards.
    if (plan.files.some((f) => f.remote === 'video.mp4')) {
      await this.api('POST', `/videos/${remoteId}/complete`);
    }
    // The per-chunk emission is capped at 99 so the bar cannot show a finished
    // upload while the final request is still in flight. Nothing else would
    // ever emit 100, so the bar would sit at 99 on a perfectly good upload.
    onProgress({ file: '', pct: 100, note: 'Upload complete' });
  }

  async remove(videoId: string): Promise<void> {
    try {
      await this.api('DELETE', `/videos/${videoId}`);
    } catch (err) {
      // ONLY a server-confirmed 404 means the row is already gone (= success
      // for the caller's intent). A message-text match would also swallow
      // network failures and proxy error pages that merely mention "not
      // found", reporting an unreachable server as a completed delete while
      // the public link stays live.
      if (err instanceof ServerApiError && err.status === 404) return;
      throw err;
    }
  }

  async updateRemote(videoId: string, patch: ServerVideoPatch): Promise<void> {
    await this.api('PATCH', `/videos/${videoId}`, patch);
  }

  async fetchActivity(videoId: string): Promise<ShareActivity> {
    const data = await this.api('GET', `/videos/${videoId}/activity`);
    return data as unknown as ShareActivity;
  }

  async deleteComment(videoId: string, commentId: string): Promise<void> {
    await this.api('DELETE', `/videos/${videoId}/comments/${commentId}`);
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const base = this.base();
      let health: Response;
      try {
        health = await fetch(`${base}/healthz`);
      } catch (err) {
        return { ok: false, error: `Could not reach ${base}: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!health.ok) return { ok: false, error: `${base}/healthz answered ${health.status}; is that an OpenLoom server?` };
      const ping = await fetch(`${base}/api/ping`, { headers: this.headers() });
      if (ping.status === 401) return { ok: false, error: 'The server is up but rejected the API key.' };
      if (!ping.ok) return { ok: false, error: `The server answered ${ping.status} to an authenticated ping.` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
