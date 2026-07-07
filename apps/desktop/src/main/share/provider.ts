/**
 * Share provider construction (SPEC S1). Pure module: no Electron imports so
 * the providers are unit-testable; share/index.ts binds them to settings.
 */
import type { ShareProvider, VideoMeta } from '@shared/types';
import { ServerShareProvider, type ServerShareConfig } from './server';
import { S3ShareProvider, type S3ShareConfig } from './s3';

export type { ServerShareConfig } from './server';
export type { S3ShareConfig } from './s3';

/** The 'none' provider: local-only videos. Sharing actions explain themselves. */
export class NoneShareProvider implements ShareProvider {
  readonly kind = 'none' as const;

  prepareShare(_meta: VideoMeta): Promise<never> {
    return Promise.reject(
      new Error('Sharing is turned off. Pick a provider under Settings, then Sharing, and try again.')
    );
  }

  upload(): Promise<void> {
    return Promise.resolve();
  }

  remove(): Promise<void> {
    return Promise.resolve();
  }

  test(): Promise<{ ok: boolean; error?: string }> {
    return Promise.resolve({ ok: true });
  }
}

export interface ProviderConfigs {
  server: ServerShareConfig;
  s3: S3ShareConfig;
}

export function createShareProvider(kind: 'server' | 's3' | 'none', cfgs: ProviderConfigs): ShareProvider {
  switch (kind) {
    case 'server':
      return new ServerShareProvider(cfgs.server);
    case 's3':
      return new S3ShareProvider(cfgs.s3);
    case 'none':
      return new NoneShareProvider();
  }
}

/** Build the iframe embed snippet for a server-hosted share URL (SPEC S5). */
export function embedSnippet(shareUrl: string): string {
  const sep = shareUrl.includes('?') ? '&' : '?';
  return `<iframe src="${shareUrl}${sep}embed=1" width="640" height="400" frameborder="0" allow="fullscreen" allowfullscreen title="Open Loom video"></iframe>`;
}
