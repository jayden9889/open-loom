/**
 * S3-compatible share provider (SPEC S3): R2 / B2 / MinIO / AWS. Uploads the
 * video (multipart when large), its assets and a self-contained static
 * player page to {prefix}/{id}/, then hands back the public URL.
 * Pure module: no Electron imports.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import type {
  ShareProvider,
  ShareResult,
  UploadPlan,
  UploadPlanFile,
  UploadProgress,
  VideoMeta,
} from '@shared/types';
import { buildPlayerPage, type PlayerPageOptions } from './player-page';

export interface S3ShareConfig {
  /** Custom endpoint for R2/B2/MinIO; empty = AWS default resolution. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix inside the bucket, e.g. "videos". */
  prefix: string;
  /** Public base URL of the bucket or custom domain, e.g. https://videos.example.com */
  publicBaseUrl: string;
  pathStyle: boolean;
}

const PART_BYTES = 8 * 1024 * 1024;
const MULTIPART_THRESHOLD = 16 * 1024 * 1024;

/** Local file name -> remote object name. index.html is generated at upload time. */
const FILE_MAP: { local: string; remote: string; required: boolean }[] = [
  { local: 'video.mp4', remote: 'video.mp4', required: true },
  { local: 'thumb.jpg', remote: 'thumb.jpg', required: false },
  { local: 'preview.gif', remote: 'preview.gif', required: false },
  { local: 'transcript.vtt', remote: 'captions.vtt', required: false },
];

const REMOTE_CONTENT_TYPES: Record<string, string> = {
  'video.mp4': 'video/mp4',
  'thumb.jpg': 'image/jpeg',
  'preview.gif': 'image/gif',
  'captions.vtt': 'text/vtt; charset=utf-8',
  'index.html': 'text/html; charset=utf-8',
};

export class S3ShareProvider implements ShareProvider {
  readonly kind = 's3' as const;
  private clientInstance: S3Client | null = null;

  constructor(private readonly cfg: S3ShareConfig) {}

  private requireConfig(): void {
    if (!this.cfg.bucket || !this.cfg.accessKeyId || !this.cfg.secretAccessKey) {
      throw new Error('The S3 provider is not configured. Fill in bucket and keys under Settings, then Sharing.');
    }
    if (!/^https?:\/\//.test(this.cfg.publicBaseUrl || '')) {
      throw new Error(
        'Set the public base URL of your bucket (r2.dev URL or custom domain) under Settings, then Sharing, so share links can be minted.'
      );
    }
  }

  private client(): S3Client {
    if (!this.clientInstance) {
      this.clientInstance = new S3Client({
        region: this.cfg.region || 'auto',
        ...(this.cfg.endpoint ? { endpoint: this.cfg.endpoint } : {}),
        forcePathStyle: this.cfg.pathStyle,
        credentials: {
          accessKeyId: this.cfg.accessKeyId,
          secretAccessKey: this.cfg.secretAccessKey,
        },
      });
    }
    return this.clientInstance;
  }

  private prefix(): string {
    return (this.cfg.prefix || 'videos').replace(/^\/+|\/+$/g, '');
  }

  private keyFor(videoId: string, name: string): string {
    return `${this.prefix()}/${videoId}/${name}`;
  }

  /** Everything the static page needs, carried from prepareShare to upload. */
  private pageOptions(meta: VideoMeta, filesDir: string): PlayerPageOptions {
    const exists = (name: string): boolean => {
      try {
        return fs.statSync(path.join(filesDir, name)).size > 0;
      } catch {
        return false;
      }
    };
    return {
      title: meta.ai?.title || meta.title,
      createdAt: meta.createdAt,
      durationSec: meta.durationSec,
      chapters: meta.ai?.chapters ?? [],
      hasCaptions: exists('transcript.vtt'),
      hasThumb: exists('thumb.jpg'),
      allowDownload: meta.share?.allowDownload ?? true,
      cta: meta.share?.cta ?? null,
    };
  }

  prepareShare(meta: VideoMeta): Promise<ShareResult> {
    this.requireConfig();
    const base = this.cfg.publicBaseUrl.replace(/\/+$/, '');
    // Public buckets do not resolve directory indexes, so link index.html explicitly.
    const shareUrl = `${base}/${this.prefix()}/${meta.id}/index.html`;
    const files: UploadPlanFile[] = [
      ...FILE_MAP.map((f) => ({ name: f.local, remote: this.keyFor(meta.id, f.remote), required: f.required })),
      { name: 'index.html', remote: this.keyFor(meta.id, 'index.html'), required: true },
    ];
    return Promise.resolve({
      shareUrl,
      uploadPlan: {
        videoId: meta.id,
        files,
        context: { meta: JSON.parse(JSON.stringify(meta)) as VideoMeta },
      },
    });
  }

  /**
   * Upload plan carrying only the captions object plus a rebuilt player page,
   * pointed at this video's existing keys. Used to add captions to an
   * already-published static share once transcription finishes, without
   * re-uploading the (potentially multi-GB) video.
   */
  captionsPlan(meta: VideoMeta): UploadPlan {
    const files: UploadPlanFile[] = [
      { name: 'transcript.vtt', remote: this.keyFor(meta.id, 'captions.vtt'), required: false },
      { name: 'index.html', remote: this.keyFor(meta.id, 'index.html'), required: true },
    ];
    return { videoId: meta.id, files, context: { meta: JSON.parse(JSON.stringify(meta)) as VideoMeta } };
  }

  private async putObject(key: string, body: Buffer | string, contentType: string): Promise<void> {
    await this.client().send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
        ContentType: contentType,
        CacheControl: key.endsWith('index.html') ? 'public, max-age=60' : 'public, max-age=31536000, immutable',
      })
    );
  }

  private async uploadLarge(key: string, localPath: string, onPct: (pct: number) => void): Promise<void> {
    const size = fs.statSync(localPath).size;
    const create = await this.client().send(
      new CreateMultipartUploadCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        ContentType: REMOTE_CONTENT_TYPES['video.mp4'],
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );
    const uploadId = create.UploadId;
    if (!uploadId) throw new Error('The S3 endpoint did not return a multipart upload id.');
    const parts: { ETag: string; PartNumber: number }[] = [];
    const fd = fs.openSync(localPath, 'r');
    try {
      let offset = 0;
      let partNumber = 1;
      while (offset < size) {
        const len = Math.min(PART_BYTES, size - offset);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        const part = await this.client().send(
          new UploadPartCommand({
            Bucket: this.cfg.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: buf,
          })
        );
        if (!part.ETag) throw new Error(`The S3 endpoint returned no ETag for part ${partNumber}.`);
        parts.push({ ETag: part.ETag, PartNumber: partNumber });
        offset += len;
        partNumber++;
        onPct(Math.round((offset / size) * 100));
      }
      await this.client().send(
        new CompleteMultipartUploadCommand({
          Bucket: this.cfg.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        })
      );
    } catch (err) {
      await this.client()
        .send(new AbortMultipartUploadCommand({ Bucket: this.cfg.bucket, Key: key, UploadId: uploadId }))
        .catch(() => undefined);
      throw err;
    } finally {
      fs.closeSync(fd);
    }
  }

  async upload(plan: UploadPlan, filesDir: string, onProgress: UploadProgress): Promise<void> {
    this.requireConfig();
    const meta = plan.context?.meta as VideoMeta | undefined;
    if (!meta) throw new Error('The upload plan is missing its video metadata; share the video again.');

    for (const file of plan.files) {
      if (file.name === 'index.html') {
        onProgress({ file: file.name, pct: 0, note: 'Publishing the player page' });
        await this.putObject(file.remote, buildPlayerPage(this.pageOptions(meta, filesDir)), REMOTE_CONTENT_TYPES['index.html']!);
        onProgress({ file: file.name, pct: 100 });
        continue;
      }
      const localPath = path.join(filesDir, file.name);
      if (!fs.existsSync(localPath)) {
        if (file.required) throw new Error(`${file.name} is missing from the video folder; nothing to upload.`);
        continue;
      }
      const size = fs.statSync(localPath).size;
      const remoteName = path.basename(file.remote);
      const contentType = REMOTE_CONTENT_TYPES[remoteName] ?? 'application/octet-stream';
      onProgress({ file: file.name, pct: 0, note: `Uploading ${file.name}` });
      if (size > MULTIPART_THRESHOLD && file.name === 'video.mp4') {
        await this.uploadLarge(file.remote, localPath, (pct) =>
          onProgress({ file: file.name, pct, note: `Uploading ${file.name}` })
        );
      } else {
        await this.putObject(file.remote, fs.readFileSync(localPath), contentType);
        onProgress({ file: file.name, pct: 100 });
      }
    }
  }

  /** Re-publish only the static page (title/CTA/download toggles changed). */
  async updatePage(meta: VideoMeta, filesDir: string): Promise<void> {
    this.requireConfig();
    await this.putObject(
      this.keyFor(meta.id, 'index.html'),
      buildPlayerPage(this.pageOptions(meta, filesDir)),
      REMOTE_CONTENT_TYPES['index.html']!
    );
  }

  async remove(videoId: string): Promise<void> {
    this.requireConfig();
    const names = ['video.mp4', 'thumb.jpg', 'preview.gif', 'captions.vtt', 'index.html'];
    await this.client().send(
      new DeleteObjectsCommand({
        Bucket: this.cfg.bucket,
        Delete: { Objects: names.map((n) => ({ Key: this.keyFor(videoId, n) })), Quiet: true },
      })
    );
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      this.requireConfig();
      const key = `${this.prefix()}/openloom-connection-test.txt`;
      await this.putObject(key, 'Open Loom can write to this bucket.', 'text/plain; charset=utf-8');
      await this.client().send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
