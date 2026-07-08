/**
 * Electron binding for the share layer (SPEC S1-S4, R14): reads provider
 * config from settings (decrypting secrets), mints share URLs the moment a
 * share is requested, runs uploads in the background with progress + retry
 * x3, and keeps meta.json's share block in sync.
 */
import path from 'node:path';
import type { Settings, ShareActivity, ShareProvider, ShareResult, UploadPlan, VideoMeta } from '@shared/types';
import fs from 'node:fs';
import { getSettings, getSecret } from '../settings';
import { SECRET_MASK } from '../settings-core';
import { library } from '../library';
import { emitJobProgress } from '../ffmpeg';
import { broadcast } from '../windows';
import { log } from '../logger';
import {
  createShareProvider,
  type ProviderConfigs,
  type S3ShareConfig,
  type ServerShareConfig,
} from './provider';
import { ServerShareProvider, type ServerVideoPatch } from './server';
import { S3ShareProvider } from './s3';

export { embedSnippet } from './provider';

const RETRIES = 3;
const RETRY_DELAYS_MS = [2_000, 5_000];

/** Video ids with an upload currently in flight (drives UI progress states). */
const activeUploads = new Set<string>();

function providerConfigs(settings: Settings): ProviderConfigs {
  const server: ServerShareConfig = {
    url: settings.sharing.server.url,
    apiKey: getSecret('sharing.server.apiKey'),
  };
  const s3: S3ShareConfig = {
    endpoint: settings.sharing.s3.endpoint,
    region: settings.sharing.s3.region,
    bucket: settings.sharing.s3.bucket,
    accessKeyId: settings.sharing.s3.accessKeyId,
    secretAccessKey: getSecret('sharing.s3.secretAccessKey'),
    prefix: settings.sharing.s3.prefix,
    publicBaseUrl: settings.sharing.s3.publicBaseUrl,
    pathStyle: settings.sharing.s3.pathStyle,
  };
  return { server, s3 };
}

function currentProvider(kind?: 'server' | 's3' | 'none'): ShareProvider {
  const settings = getSettings();
  return createShareProvider(kind ?? settings.sharing.provider, providerConfigs(settings));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isUploading(videoId: string): boolean {
  return activeUploads.has(videoId);
}

async function runUploadWithRetry(provider: ShareProvider, result: ShareResult, meta: VideoMeta): Promise<void> {
  const filesDir = path.join(library().root, meta.id);
  activeUploads.add(meta.id);
  try {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        await provider.upload(result.uploadPlan, filesDir, (info) => {
          emitJobProgress({ videoId: meta.id, kind: 'upload', pct: info.pct, note: info.note ?? info.file });
        });
        library().update(meta.id, {
          share: { ...(library().get(meta.id).share ?? shareBlock(provider, result)), uploadedAt: new Date().toISOString() },
        });
        emitJobProgress({ videoId: meta.id, kind: 'upload', pct: 100, note: 'Upload complete' });
        log.info(`share upload finished for ${meta.id} via ${provider.kind}`);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`share upload attempt ${attempt}/${RETRIES} failed for ${meta.id}: ${message}`);
        if (attempt === RETRIES) {
          // The share URL was already minted and copied, but the upload never
          // landed: the link is a dead 404. Surface it loudly (toast + a
          // persistent per-card state via the missing uploadedAt marker) so the
          // user never sends a link that is not live. Retry from the library.
          emitJobProgress({ videoId: meta.id, kind: 'upload', pct: 100, note: `Upload failed: ${message}` });
          broadcast('ol:toast', {
            kind: 'error',
            text: `The share upload failed, so the copied link is not live yet. Open the video in your library and retry. (${message})`,
          });
          return;
        }
        await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 5_000);
      }
    }
  } finally {
    activeUploads.delete(meta.id);
  }
}

function shareBlock(provider: ShareProvider, result: ShareResult): NonNullable<VideoMeta['share']> {
  const defaults = getSettings().sharing.defaults;
  return {
    provider: provider.kind as 'server' | 's3',
    url: result.shareUrl,
    // Password privacy needs a password, which is set later via the Share
    // dialog; a fresh share always starts as link-only.
    privacy: 'link',
    allowComments: defaults.allowComments,
    allowReactions: defaults.allowReactions,
    allowDownload: defaults.allowDownload,
  };
}

/**
 * Mint the share URL (fast, copied to the clipboard by the caller) and start
 * the background upload. Re-sharing an already shared video re-uploads to
 * the same URL.
 */
export async function shareVideo(id: string): Promise<{ url: string }> {
  const meta = library().get(id);
  const kind = meta.share?.provider ?? getSettings().sharing.provider;
  if (kind === 'none') {
    throw new Error('Sharing is turned off. Pick a provider under Settings, then Sharing, and try again.');
  }
  const provider = currentProvider(kind);
  // Re-sharing / retrying an already-shared video must reuse its remote id.
  // Re-running prepareShare on the server provider POSTs a fresh create, which
  // the server answers with a new id, orphaning the first row and breaking the
  // link already copied to the clipboard. The S3 provider keys off the local
  // id, so its prepareShare is idempotent and safe to re-run.
  const result =
    meta.share && provider instanceof ServerShareProvider
      ? provider.resumeShare(meta)
      : await provider.prepareShare(meta);
  const block: NonNullable<VideoMeta['share']> = meta.share
    ? { ...meta.share, url: result.shareUrl }
    : shareBlock(provider, result);
  library().update(id, { share: block });
  void runUploadWithRetry(provider, result, { ...meta, share: block });
  return { url: result.shareUrl };
}

/**
 * Push a freshly generated captions track to an already-shared remote copy.
 * Auto-share on stop mints and uploads before transcription finishes, so the
 * hosted page would otherwise never gain captions. Best-effort: no-op when the
 * video is not shared or has no transcript, and never throws into the caller
 * (the transcription pipeline).
 */
export async function syncShareCaptions(id: string): Promise<void> {
  const meta = library().get(id);
  if (!meta.share) return;
  const filesDir = path.join(library().root, meta.id);
  if (!fs.existsSync(path.join(filesDir, 'transcript.vtt'))) return;
  const provider = currentProvider(meta.share.provider);
  let plan: UploadPlan;
  if (provider instanceof ServerShareProvider) {
    plan = provider.captionsPlan(meta);
  } else if (provider instanceof S3ShareProvider) {
    plan = provider.captionsPlan(meta);
  } else {
    return;
  }
  activeUploads.add(meta.id);
  try {
    await provider.upload(plan, filesDir, (info) => {
      emitJobProgress({ videoId: meta.id, kind: 'upload', pct: info.pct, note: info.note ?? info.file });
    });
    log.info(`captions synced to share for ${meta.id} via ${provider.kind}`);
  } catch (err) {
    log.warn(`caption sync to share failed for ${meta.id}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    activeUploads.delete(meta.id);
  }
}

/** Delete the remote copy and clear the local share block. */
export async function unshareVideo(id: string): Promise<void> {
  const meta = library().get(id);
  if (!meta.share) return;
  const provider = currentProvider(meta.share.provider);
  await provider.remove(id);
  library().update(id, { share: undefined });
}

/**
 * Apply privacy/toggle/CTA changes locally and on the remote copy.
 * `patch.password` is transport-only: forwarded to the server, never stored.
 */
export async function updateShareSettings(id: string, patch: Partial<NonNullable<VideoMeta['share']>>): Promise<void> {
  const meta = library().get(id);
  if (!meta.share) {
    throw new Error('This video is not shared yet. Share it first, then adjust its settings.');
  }
  const { password, ...localPatch } = patch;

  if (meta.share.provider === 'server') {
    const provider = currentProvider('server') as ServerShareProvider;
    const remotePatch: ServerVideoPatch = {};
    if (localPatch.privacy !== undefined) remotePatch.privacy = localPatch.privacy;
    if (password !== undefined) remotePatch.password = password;
    if (localPatch.allowComments !== undefined) remotePatch.allowComments = localPatch.allowComments;
    if (localPatch.allowReactions !== undefined) remotePatch.allowReactions = localPatch.allowReactions;
    if (localPatch.allowDownload !== undefined) remotePatch.allowDownload = localPatch.allowDownload;
    if ('cta' in localPatch) remotePatch.cta = localPatch.cta ?? null;
    if (Object.keys(remotePatch).length > 0) await provider.updateRemote(id, remotePatch);
  } else {
    if (localPatch.privacy === 'password' || password) {
      throw new Error(
        'Password protection needs the OpenLoom Server provider. S3 buckets serve static files and cannot check passwords.'
      );
    }
    if (localPatch.allowComments !== undefined || localPatch.allowReactions !== undefined) {
      throw new Error('Comments and reactions need the OpenLoom Server provider; a static S3 page has no write path.');
    }
    // Download toggle + CTA changes re-publish the static page.
    const provider = currentProvider('s3') as S3ShareProvider;
    const nextMeta: VideoMeta = { ...meta, share: { ...meta.share, ...localPatch } };
    await provider.updatePage(nextMeta, path.join(library().root, id));
  }

  library().update(id, { share: { ...meta.share, ...localPatch } });
}

/** Live viewer analytics from the share server (Watch view Activity tab). */
export async function getShareActivity(id: string): Promise<ShareActivity> {
  const meta = library().get(id);
  if (!meta.share) {
    throw new Error('This video is not shared, so there is no viewer activity yet.');
  }
  if (meta.share.provider !== 'server') {
    throw new Error(
      'Viewer analytics need the OpenLoom Server provider. Static S3 pages cannot report views or comments.'
    );
  }
  const provider = currentProvider('server') as ServerShareProvider;
  return provider.fetchActivity(id);
}

/** Delete a viewer comment via the creator API key (server provider). */
export async function deleteShareComment(id: string, commentId: string): Promise<void> {
  const meta = library().get(id);
  if (meta.share?.provider !== 'server') {
    throw new Error('Comment moderation needs the OpenLoom Server provider.');
  }
  const provider = currentProvider('server') as ServerShareProvider;
  await provider.deleteComment(id, commentId);
}

interface TestConfigInput {
  provider?: unknown;
  url?: unknown;
  apiKey?: unknown;
  endpoint?: unknown;
  region?: unknown;
  bucket?: unknown;
  accessKeyId?: unknown;
  secretAccessKey?: unknown;
  prefix?: unknown;
  publicBaseUrl?: unknown;
  pathStyle?: unknown;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * Test a provider config from the Settings form. Masked secrets (the
 * renderer only ever sees the mask) are substituted with the stored values.
 */
export async function testShareProvider(cfg: unknown): Promise<{ ok: boolean; error?: string }> {
  const input = (cfg ?? {}) as TestConfigInput;
  const settings = getSettings();
  const kind = input.provider ?? settings.sharing.provider;

  if (kind === 'server') {
    const apiKeyRaw = str(input.apiKey);
    const provider = new ServerShareProvider({
      url: str(input.url, settings.sharing.server.url),
      apiKey: !apiKeyRaw || apiKeyRaw === SECRET_MASK ? getSecret('sharing.server.apiKey') : apiKeyRaw,
    });
    return provider.test();
  }
  if (kind === 's3') {
    const secretRaw = str(input.secretAccessKey);
    const s3 = settings.sharing.s3;
    const provider = new S3ShareProvider({
      endpoint: str(input.endpoint, s3.endpoint),
      region: str(input.region, s3.region) || 'auto',
      bucket: str(input.bucket, s3.bucket),
      accessKeyId: str(input.accessKeyId, s3.accessKeyId),
      secretAccessKey: !secretRaw || secretRaw === SECRET_MASK ? getSecret('sharing.s3.secretAccessKey') : secretRaw,
      prefix: str(input.prefix, s3.prefix) || 'videos',
      publicBaseUrl: str(input.publicBaseUrl, s3.publicBaseUrl),
      pathStyle: typeof input.pathStyle === 'boolean' ? input.pathStyle : s3.pathStyle,
    });
    return provider.test();
  }
  return { ok: true };
}
