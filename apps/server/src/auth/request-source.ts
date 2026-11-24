import { isIP } from 'node:net';
import type { MiddlewareHandler } from 'hono';

// Transport metadata is never read from request headers. A WeakMap avoids
// retaining requests, leaking raw addresses into audit records, or forging an
// internal header at the public boundary.
const sources = new WeakMap<Request, string>();
export function normalizeAuthAddress(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64 || value.includes('%')) return;
  const address = value.trim();
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return normalized;
}

/** Exact addresses only: no implicit loopback, wildcard, DNS or hop-count trust. */
export function parseAuthTrustedProxies(value: string | undefined): string[] {
  if (value === undefined || !value.trim()) return [];
  if (value.length > 2048) throw Error('Invalid authentication trusted proxies');
  const raw = value.split(',');
  const parsed = raw.map(normalizeAuthAddress);
  if (raw.length > 32 || parsed.some(item => !item)) throw Error('Authentication trusted proxies must be at most 32 exact IP addresses');
  return [...new Set(parsed as string[])];
}

export function resolveAuthSource(request: Request, peer: unknown, trusted: ReadonlySet<string>): string | undefined {
  let source = normalizeAuthAddress(peer);
  if (!source || !trusted.has(source)) return source;
  const header = request.headers.get('x-forwarded-for');
  if (!header) return source;
  // Reject the whole chain if malformed/oversized. Never fall back to another
  // attacker-controlled header (CF-Connecting-IP, X-Real-IP, Forwarded).
  if (header.length > 2048) return source;
  const raw = header.split(',');
  if (raw.length > 16) return source;
  const chain = raw.map(normalizeAuthAddress);
  if (chain.some(item => !item)) return source;
  for (let index = chain.length - 1; index >= 0 && trusted.has(source); index--) source = chain[index]!;
  return source;
}

export function authRequestSource(proxies: readonly string[] = []): MiddlewareHandler {
  const trusted = new Set(proxies.map(address => {
    const normalized = normalizeAuthAddress(address);
    if (!normalized) throw Error('Invalid authentication trusted proxy');
    return normalized;
  }));
  if (trusted.size > 32) throw Error('Too many authentication trusted proxies');
  return async (context, next) => {
    const source = resolveAuthSource(context.req.raw, context.env?.incoming?.socket?.remoteAddress, trusted);
    if (source) sources.set(context.req.raw, source);
    await next();
  };
}

export function authSource(request: Request): string | undefined { return sources.get(request); }
