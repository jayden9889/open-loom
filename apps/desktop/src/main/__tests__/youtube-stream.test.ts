/**
 * The resumable uploader streams each chunk in 256 KB pieces so the progress bar
 * moves smoothly rather than once per 8 MB. That relies on two things Node is
 * fussy about: a stream body needs `duplex: 'half'`, and an explicit
 * Content-Length (without it the body goes chunked, which Google's resumable
 * endpoint rejects). This proves both against a real socket, and that the byte
 * counts we report actually match what lands on the other end.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PIECE = 256 * 1024;

/** Mirrors chunkPieces in youtube.ts, reading from a Buffer instead of a file. */
async function* pieces(
  src: Buffer,
  onByte: (sent: number) => void
): AsyncGenerator<Buffer> {
  let done = 0;
  while (done < src.length) {
    const n = Math.min(PIECE, src.length - done);
    const slice = src.subarray(done, done + n);
    done += n;
    yield Buffer.from(slice);
    onByte(done);
  }
}

let server: http.Server;
let url = '';
let received: { body: Buffer; contentLength?: string; transferEncoding?: string } | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    req.on('end', () => {
      received = {
        body: Buffer.concat(parts),
        contentLength: req.headers['content-length'],
        transferEncoding: req.headers['transfer-encoding'],
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('streamed chunk upload', () => {
  it('delivers every byte intact with an explicit Content-Length, not chunked', async () => {
    const payload = Buffer.alloc(700 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;

    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-length': String(payload.length) },
      body: pieces(payload, () => undefined),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    expect(res.status).toBe(200);
    expect(received).not.toBeNull();
    expect(received!.body.length).toBe(payload.length);
    expect(received!.body.equals(payload)).toBe(true);
    expect(received!.contentLength).toBe(String(payload.length));
    // Chunked encoding here would be rejected by the resumable endpoint.
    expect(received!.transferEncoding).toBeUndefined();
  });

  it('reports progress in ascending steps that end at the exact total', async () => {
    const payload = Buffer.alloc(700 * 1024);
    const seen: number[] = [];

    await fetch(url, {
      method: 'PUT',
      headers: { 'content-length': String(payload.length) },
      body: pieces(payload, (sent) => seen.push(sent)),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    expect(seen.length).toBeGreaterThan(1); // more than one update per chunk
    expect(seen[seen.length - 1]).toBe(payload.length);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]!);
  });
});
