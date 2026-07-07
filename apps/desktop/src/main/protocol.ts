/**
 * openloom-file:// protocol. Serves files from the library save folder ONLY
 * (path-traversal safe via resolveLibraryPath) with HTTP Range support so
 * <video> can seek local files. URL shape: openloom-file://<videoId>/<file>.
 */
import { protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { resolveLibraryPath } from './library-core';
import { getSettings } from './settings';
import { log } from './logger';

export const SCHEME = 'openloom-file';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.json': 'application/json',
  '.vtt': 'text/vtt',
};

/** Must run before app.whenReady. */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { stream: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  let start: number;
  let end: number;
  if (rawStart === '') {
    // suffix range: last N bytes
    const suffix = Number(rawEnd);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return null;
  return { start, end };
}

/** Register the handler. Call after app.whenReady. */
export function installProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const videoId = decodeURIComponent(url.hostname || url.pathname.split('/').filter(Boolean)[0] || '');
      const fileName = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const libDir = getSettings().saveDir;
      const resolved = resolveLibraryPath(libDir, videoId, fileName);
      if (!resolved || !fs.existsSync(resolved)) {
        return new Response('Not found', { status: 404 });
      }
      const stat = fs.statSync(resolved);
      const mime = MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
      const range = parseRange(request.headers.get('range'), stat.size);
      const baseHeaders: Record<string, string> = {
        'content-type': mime,
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache',
        // Required for canvas pixel read-back: the Editor filmstrip loads
        // frames with crossOrigin='anonymous' and calls canvas.toDataURL(), so
        // the response must be CORS-clean or the canvas taints. In production
        // the renderer runs from a file:// (opaque/null) origin, so only '*'
        // reliably avoids tainting; a narrowed origin breaks read-back. Safe
        // because the openloom-file scheme is itself path-traversal-restricted
        // to the library dir (resolveLibraryPath), so no arbitrary path is ever
        // served, and the scheme is unreachable from ordinary web pages.
        'access-control-allow-origin': '*',
      };
      if (range) {
        const stream = fs.createReadStream(resolved, { start: range.start, end: range.end });
        return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
          status: 206,
          headers: {
            ...baseHeaders,
            'content-length': String(range.end - range.start + 1),
            'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
          },
        });
      }
      const stream = fs.createReadStream(resolved);
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 200,
        headers: { ...baseHeaders, 'content-length': String(stat.size) },
      });
    } catch (err) {
      log.error(`protocol error for ${request.url}: ${String(err)}`);
      return new Response('Internal error', { status: 500 });
    }
  });
}
