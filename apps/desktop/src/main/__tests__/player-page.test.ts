/**
 * The share page is static HTML built from stored meta, so it is the last line
 * of defence for the one stored value that becomes a link: the CTA url.
 * updateShareSettings rejects a non-http(s) CTA on the way in, but the page is
 * also rebuilt from meta on a later privacy toggle, and ol:updateVideo writes
 * that meta without passing through it.
 */
import { describe, expect, it } from 'vitest';
import { buildPlayerPage, type PlayerPageOptions } from '../share/player-page';

function opts(patch: Partial<PlayerPageOptions> = {}): PlayerPageOptions {
  return {
    title: 'Demo',
    creator: 'Someone',
    createdAt: new Date(2026, 0, 1).toISOString(),
    durationSec: 12,
    chapters: [],
    hasCaptions: false,
    hasThumb: true,
    allowDownload: false,
    ...patch,
  };
}

describe('CTA link scheme', () => {
  it('renders an http(s) CTA', () => {
    const html = buildPlayerPage(opts({ cta: { label: 'Book a call', url: 'https://example.com/book' } }));
    expect(html).toContain('href="https://example.com/book"');
    expect(html).toContain('Book a call');
  });

  it('drops a javascript: CTA instead of rendering the link', () => {
    const html = buildPlayerPage(opts({ cta: { label: 'Click', url: 'javascript:alert(1)' } }));
    expect(html).not.toContain('javascript:alert');
    expect(html).not.toContain('>Click<');
  });

  it('drops a data: CTA', () => {
    const html = buildPlayerPage(opts({ cta: { label: 'Click', url: 'data:text/html,<script>alert(1)</script>' } }));
    expect(html).not.toContain('data:text/html');
  });

  it('drops scheme-obfuscation attempts', () => {
    for (const url of ['JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'vbscript:msgbox', '//evil.example.com']) {
      const html = buildPlayerPage(opts({ cta: { label: 'Click', url } }));
      expect(html).not.toContain(`href="${url}"`);
    }
  });
});

describe('escaping', () => {
  it('escapes the title rather than letting it open a tag', () => {
    const html = buildPlayerPage(opts({ title: '<img src=x onerror=alert(1)>' }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('escapes the CTA label on an otherwise valid link', () => {
    const html = buildPlayerPage(opts({ cta: { label: '</a><script>alert(1)</script>', url: 'https://example.com' } }));
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
