import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { HISTORY_DELTA_HEADER } from '@agentopsdeck/shared';
import { timeHistorySync } from '../storage/history-diagnostics.js';

type Page = { updatedAt: number; sourceCursor?: string | undefined; [key: string]: unknown };
type Signature = { identity: string; hashes: string[]; bytes: number; at: number };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Call only AFTER a fresh authorized read and its post-await fences.
 * Per route-registration, bounded signatures ONLY, never transcript bodies.
 * Eviction/restart merely selects the ordinary full response. */
export function createConditionalHistory(maxBytes = 2 * 1024 * 1024, capacity = 256, now = Date.now) {
  const signatures = new Map<string, Signature>();
  let bytes = 0;
  const remove = (key: string) => { const old = signatures.get(key); if (old) bytes -= old.bytes; signatures.delete(key); };
  const check = (requestUrl: string, base: string | undefined, page: Page) => {
    const { updatedAt, sourceCursor, ...content } = page;
    const url = new URL(requestUrl);
    const identity = JSON.stringify([url.pathname, url.searchParams.get('limit'), url.searchParams.get('before')]);
    const etag = `W/"history-${hash(JSON.stringify([identity, content]))}"`;
    const headers: Record<string, string> = { 'cache-control': 'no-store', etag,
      'x-agentopsdeck-history-meta': JSON.stringify({ updatedAt, sourceCursor: sourceCursor ?? null }) };
    return { status: base === etag ? 304 as const : 200 as const, headers, identity, etag };
  };
  const encode = (requestUrl: string, base: string | undefined, delta: boolean, page: Page) => {
    const { status, headers, identity, etag } = check(requestUrl, base, page);
    if (status === 304) return { status, body: null, headers };
    const full = JSON.stringify(page);
    let response = full;
    if (delta && Array.isArray(page.messages) && page.messages.length <= 1000) {
      const hashes = page.messages.map(message => hash(JSON.stringify(message)));
      const previous = base ? signatures.get(base) : undefined;
      // Path/page identity prevents an arbitrary validator from referencing a
      // different window. Current authorization was checked by the caller;
      // slots can reveal ONLY messages already present in this current page.
      if (previous && previous.identity === identity && now() - previous.at < 300_000) {
        const indices = new Map(previous.hashes.map((fingerprint, index) => [fingerprint, index]));
        const { messages, ...metadata } = page;
        const slots = (messages as unknown[]).map((message, index) => indices.get(hashes[index]!) ?? message);
        const delta = JSON.stringify({ historyDelta: 1, base, slots, metadata });
        // Small or mostly-changed pages stay full. Compare raw JSON bytes;
        // compression ratios depend on content and are measured separately.
        if (Buffer.byteLength(delta) < Buffer.byteLength(full) * .9) {
          response = delta;
          headers[HISTORY_DELTA_HEADER] = '1';
        }
      }
      const size = (identity.length + hashes.length * 64) * 2;
      remove(etag);
      if (size <= maxBytes && capacity > 0) {
        while (signatures.size && (bytes + size > maxBytes || signatures.size >= capacity)) remove(signatures.keys().next().value!);
        signatures.set(etag, { identity, hashes, bytes: size, at: now() }); bytes += size;
      }
    }
    headers['content-type'] = 'application/json';
    return { status: 200 as const, body: response, headers };
  };
  return Object.assign((c: Context, page: Page) => {
    const response = timeHistorySync('encode', () => encode(c.req.url, c.req.header('if-none-match'), c.req.header(HISTORY_DELTA_HEADER) === '1', page));
    for (const [key, value] of Object.entries(response.headers)) c.header(key, value);
    return response.status === 304 ? c.body(null, 304) : c.body(response.body!, 200);
  }, { encode, check });
}
