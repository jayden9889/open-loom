/**
 * Embed support (SPEC S5): `?embed=1` renders the chromeless player variant
 * of the watch page, and the creator API exposes a ready-made iframe snippet.
 */
import type { Context } from 'hono';

export function isEmbed(c: Context): boolean {
  const v = c.req.query('embed');
  return v === '1' || v === 'true';
}

/** The iframe snippet the desktop Share dialog copies to the clipboard. */
export function embedSnippet(baseUrl: string, videoId: string): string {
  const src = `${baseUrl}/v/${videoId}?embed=1`;
  return `<iframe src="${src}" width="640" height="400" frameborder="0" allow="fullscreen" allowfullscreen title="Open Loom video"></iframe>`;
}
