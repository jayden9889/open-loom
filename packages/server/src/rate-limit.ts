/**
 * Tiny in-memory fixed-window rate limiter plus a client-IP helper. Zero deps:
 * a Map of counters pruned lazily. Enough to blunt anonymous
 * comment/reaction/beacon/unlock floods on a single-process self-host without
 * pulling in a rate-limit package. Counters live for the process lifetime and
 * reset when it restarts, which is fine for the abuse it guards against.
 */
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

interface Counter {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, Counter>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Records a hit for `key`; returns true while still inside the allowance. */
  allow(key: string): boolean {
    const now = Date.now();
    const current = this.hits.get(key);
    if (!current || now >= current.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10000) this.prune(now);
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }

  private prune(now: number): void {
    for (const [k, v] of this.hits) {
      if (now >= v.resetAt) this.hits.delete(k);
    }
  }
}

/** Best-effort client IP: honour a reverse proxy's forwarding headers, else the socket. */
export function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header('x-real-ip');
  if (real && real.trim()) return real.trim();
  try {
    const info = getConnInfo(c);
    if (info.remote.address) return info.remote.address;
  } catch {
    /* not a node-server context */
  }
  return 'unknown';
}

/** The rate limiters shared across the viewer routes, built once per app. */
export interface Limiters {
  comments: RateLimiter;
  reactions: RateLimiter;
  beacon: RateLimiter;
  /** Caps distinct new view rows a single IP can mint for one video. */
  viewMint: RateLimiter;
  /** Unlock attempts per IP+video, with the window doubling as a lockout. */
  unlock: RateLimiter;
}

export function createLimiters(): Limiters {
  return {
    comments: new RateLimiter(20, 60_000),
    reactions: new RateLimiter(40, 60_000),
    beacon: new RateLimiter(120, 60_000),
    viewMint: new RateLimiter(40, 600_000),
    unlock: new RateLimiter(8, 900_000),
  };
}
