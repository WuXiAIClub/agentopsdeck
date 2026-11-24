import { WEBSITE_MAX_BYTES, validWebsiteId, type ConnectorWebsite, type WebsiteSnapshot } from '@agentopsdeck/shared';
import { parseWebsiteActions, type WebsiteActionPolicy } from './website-actions.js';
import { parseWebsiteCookiePolicy, type WebsiteCookiePolicy } from './website-cookie-session.js';
import { parseWebsiteSockets, type WebsiteSocketPolicy } from './website-sockets.js';

export type WebsiteService = ConnectorWebsite & { url: string; browse?: boolean; actions?: WebsiteActionPolicy[]; session?: WebsiteCookiePolicy; sockets?: WebsiteSocketPolicy[] };
export function parseWebsiteServices(input: string | undefined): WebsiteService[] {
  if (!input) return [];
  const invalid = () => new Error('AOD_WEBSITES_JSON must contain at most 16 unique, labelled loopback services with explicit ports (no credentials/query/fragment); browse must be boolean and requires the origin root path');
  let values: unknown;
  try { values = JSON.parse(input); } catch { throw invalid(); }
  if (!Array.isArray(values) || values.length > 16) throw invalid();
  const ids = new Set<string>();
  return values.map(value => {
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['id', 'label', 'url', 'browse', 'actions', 'session', 'sockets'].includes(key))
      || (value.browse !== undefined && typeof value.browse !== 'boolean')
      || !validWebsiteId(value.id) || ids.has(value.id) || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80
      || /[\x00-\x1f\x7f]/.test(value.label) || typeof value.url !== 'string' || /[\x00-\x20\x7f\\]/.test(value.url)) throw invalid();
    let url: URL;
    try { url = new URL(value.url); } catch { throw invalid(); }
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || !/^https?:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):[0-9]+(?:\/|$)/.test(value.url)
      || url.username || url.password || url.search || url.hash || (value.browse === true && url.pathname !== '/')) throw invalid();
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    ids.add(value.id);
    const actions = parseWebsiteActions(value.actions);
    const session = parseWebsiteCookiePolicy(value.session);
    const sockets = parseWebsiteSockets(value.sockets);
    if (sockets?.length && value.browse !== true) throw invalid();
    if (session && !actions?.length || actions?.some(a => a.csrf) && !session?.csrf) throw invalid();
    if (actions?.length && url.pathname !== '/') throw invalid();
    return { id: value.id, label: value.label.trim(), url: url.href, ...(value.browse === true ? { browse: true } : {}), ...(actions ? { actions } : {}), ...(session ? { session } : {}), ...(sockets ? { sockets } : {}) };
  });
}

export class WebsiteReadError extends Error {
  constructor(readonly status: 415 | 502 | 504, message: string) { super(message); }
}
/** No caller-provided headers, URL, path or redirects. Budget counts decoded
 * bytes, not Content-Length (which might describe compressed bytes). */
export async function readWebsiteSnapshot(service: WebsiteService, signal?: AbortSignal, fetcher: typeof fetch = fetch,
  retain: (work: Promise<unknown>) => void = () => {}): Promise<WebsiteSnapshot> {
  const controller = new AbortController();
  let timedOut = false, stopped = false;
  let interrupt!: (error: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
  const abort = () => {
    controller.abort();
    interrupt(controller.signal.reason);
  };
  // Independently bound both headers and body reads: a fetch implementation or
  // stream may fail to settle when its signal is aborted.
  const timer = setTimeout(() => { timedOut = true; abort(); }, 8_000);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const consume = async (): Promise<WebsiteSnapshot> => {
    controller.signal.throwIfAborted();
    const response = await fetcher(service.url, { method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
      headers: { accept: 'text/html, text/plain;q=0.9', 'accept-encoding': 'identity' } });
    if (stopped || controller.signal.aborted) {
      // A late response must not retain a body after the caller has left.
      if (response.body) retain(response.body.cancel().catch(() => {}));
      controller.signal.throwIfAborted();
      throw new WebsiteReadError(502, 'Website snapshot read stopped.');
    }
    reader = response.body?.getReader();
    if (!response.ok) throw new WebsiteReadError(502, 'Website returned an unsuccessful response.');
    const type = response.headers.get('content-type') ?? '';
    if (!/^text\/(html|plain)(?:\s*;|$)/i.test(type) || (/charset\s*=/i.test(type) && !/charset\s*=\s*"?utf-8"?(?:\s*;|\s*$)/i.test(type))) {
      throw new WebsiteReadError(415, 'Only UTF-8 HTML and plain text snapshots are supported.');
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, content = '';
    if (reader) for (;;) {
      controller.signal.throwIfAborted();
      const chunk = await reader.read();
      controller.signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > WEBSITE_MAX_BYTES) throw new WebsiteReadError(502, 'Website snapshot exceeds 512 KiB.');
      content += decoder.decode(chunk.value, { stream: true });
    }
    controller.signal.throwIfAborted();
    content += decoder.decode();
    return { serviceId: service.id, label: service.label, format: /^text\/html/i.test(type) ? 'html' : 'text', content, fetchedAt: Date.now() };
  };
  try {
    const physical = consume();
    retain(physical);
    return await Promise.race([physical, interrupted]);
  } catch (error) {
    if (error instanceof WebsiteReadError) throw error;
    throw new WebsiteReadError(timedOut ? 504 : 502, timedOut ? 'Website snapshot timed out.' : 'Website snapshot could not be read. Redirects are not followed.');
  } finally {
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    // Cleanup must not extend the total deadline if an underlying source hangs.
    if (reader) retain(reader.cancel().catch(() => {}));
    reader?.releaseLock();
  }
}
