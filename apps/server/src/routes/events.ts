import type { Hono } from 'hono';
import type { DeckEvent } from '@agentopsdeck/shared';
import { streamSSE } from 'hono/streaming';
import type { DeckStore } from '../projection/deck-store.js';
import { AwaitedRequestAuthorization, type RequestAuthorization } from '../auth/awaited-request-authorization.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ReadRequestOwner } from '../lifecycle/read-request-owner.js';

export type EventReplayPage = { cursor: string | undefined; known: boolean; events: DeckEvent[] };
export type EventReplayRead = (after: string | null) => EventReplayPage | Promise<EventReplayPage>;
export type EventSnapshotRead = <T>(capture: (cursor: string | undefined) => T) => T | Promise<T>;

// Reject a broken adapter once instead of spinning, skipping unseen events or
// sending a mixed reset/replay. Validation does not repair/retry owner work.
export function assertEventReplayPage(page: EventReplayPage, after: string | null): void {
  if (!page || typeof page.known !== 'boolean' || page.cursor !== undefined && (typeof page.cursor !== 'string' || !page.cursor)
    || !Array.isArray(page.events) || page.events.length > 64
    || (!page.known || after === null) && page.events.length
    || page.known && after !== null && after !== (page.cursor ?? null) && !page.events.length)
    throw Error('event_replay_unavailable');
  const ids = new Set<string>();
  for (const event of page.events) {
    if (!event || typeof event.id !== 'string' || !event.id || event.id === after || ids.has(event.id))
      throw Error('event_replay_unavailable');
    ids.add(event.id);
  }
  if (page.events.length && (!page.cursor || after === page.cursor)) throw Error('event_replay_unavailable');
}

// The compatibility store owns one synchronous observation. Keep its head,
// retention check and rows together, with no await between them. An async
// owner must supply one equivalent command, never three independently awaited
// reads of a changing journal. Fresh streams observe a tail, not old messages.
export function replayStoreEvents(store: DeckStore, after: string | null): EventReplayPage {
  const cursor = store.latestEventId();
  const known = after === null || store.hasEvent(after);
  return { cursor, known, events: known && after ? store.getEventsSince(after).slice(0, 64) : [] };
}

export function registerEventRoutes(app: Hono, store: DeckStore, isAuthorizedRequest: RequestAuthorization,
  authority = new AwaitedRequestAuthorization(), replay?: EventReplayRead,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, readOptions: {
    waitMs?: number;
    /** Explicit application read identity for the legacy attention projection. */
    attention?: (request: Request, capture: () => Response) => Response | Promise<Response>;
  } = {}) {
  if (store.requiresAsyncEvents && typeof replay !== 'function') throw new Error('Async Deck requires an awaited event replay port');
  const readReplay: EventReplayRead = replay ?? (after => replayStoreEvents(store, after));
  const replayReads = new ReadRequestOwner('connector-event-stream', { diagnostics, waitMs: readOptions.waitMs, limit: 128 });
  let closed = false, closing: Promise<void> | undefined;
  const streams = new Set<Promise<void>>(), abortStreams = new Set<() => void>();
  const close = () => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    closed = true;
    const accepted = [...streams];
    // Freeze authority before signalling streams, but wait for original SQL,
    // not the cancellation response. Independent of response-body consumption.
    const original = authority.close(), replayOriginals = replayReads.close();
    for (const abort of abortStreams) abort();
    void Promise.all([original, replayOriginals, ...accepted]).then(() => resolve(), reject);
    return closing;
  };
  app.get('/api/events/stream', async (c) => {
    const authorized = (signal?: AbortSignal) => authority.check(c.req.raw, isAuthorizedRequest, signal);
    c.header('Cache-Control', 'no-store');
    if (closed) return c.json({ error: 'server_draining' }, 503);
    const admission = await authorized();
    if (closed) return c.json({ error: 'server_draining' }, 503);
    if (admission === 'cancelled') return c.json({ error: 'request_cancelled' }, 408);
    if (admission === 'unavailable') return c.json({ error: 'auth_persistence_failed' }, 503);
    if (admission !== 'authorized') return c.json({ error: 'unauthorized' }, 401);
    if (c.req.raw.signal.aborted) return c.json({ error: 'request_cancelled' }, 408);
    c.header('X-Accel-Buffering', 'no');
    const response = streamSSE(c, async (stream) => {
      if (closed) { stream.abort(); return; }
      let finish!: () => void;
      const stopped = new Promise<void>(resolve => { finish = resolve; });
      streams.add(stopped);
      const controller = new AbortController();
      const abort = () => { controller.abort(); stream.abort(); };
      abortStreams.add(abort);
      c.req.raw.signal.addEventListener('abort', abort, { once: true });
      stream.onAbort(() => controller.abort());
      const write = async (event: Parameters<typeof stream.writeSSE>[0]) => {
        if (controller.signal.aborted || await authorized(controller.signal) !== 'authorized' || controller.signal.aborted) { abort(); return; }
        const timer = setTimeout(abort, 10_000);
        try { await stream.writeSSE(event); } finally { clearTimeout(timer); }
      };
      let heartbeatAt = 0;
      // Fresh clients already load state via REST before opening SSE, so start at
      // the current tail. Replaying the latest 50 events on every new stream can
      // fan out into redundant session/message refreshes across desktop/mobile.
      try {
        let lastId: string | null = c.req.header('last-event-id') ?? c.req.query('lastEventId') ?? null;
        if (c.req.raw.signal.aborted) { abort(); return; }
        while (!controller.signal.aborted) {
          if (await authorized(controller.signal) !== 'authorized' || controller.signal.aborted || closed) { abort(); break; }
          const revision = store.changes.revision;
          const after = lastId;
          const { value: page } = await replayReads.run(new Request(c.req.raw, { signal: controller.signal }), async context => {
            const { value } = await context.stage(2, () => readReplay(after));
            // A non-progressing page must not become an unbounded hot retry
            // loop. The original owner protocol already enforces this; retain
            // a caller fence for compatibility adapters and future changes.
            assertEventReplayPage(value, after); return value;
          });
          if (controller.signal.aborted || closed) { abort(); break; }
          if (Date.now() >= heartbeatAt) {
            await write({ event: 'heartbeat', data: '' });
            heartbeatAt = Date.now() + 10_000;
          }
          if (lastId === null) lastId = page.cursor ?? null;
          if (!page.known) {
            lastId = page.cursor ?? null;
            await write({ ...(lastId ? { id: lastId } : {}), event: 'stream.reset', data: JSON.stringify({ type: 'stream.reset', ts: Date.now(), payload: { reason: 'cursor_expired' } }) });
          }
          for (const event of page.events) {
            if (controller.signal.aborted) break;
            await write({ id: event.id, event: event.type, data: JSON.stringify(event) });
            lastId = event.id;
          }
          if (controller.signal.aborted) break;
          if (lastId !== (page.cursor ?? null)) continue;
          // Event hints wake immediately; idle connections still recheck authority
          // within two seconds. Cancellation releases the waiter without polling.
          await store.changes.wait(revision, controller.signal, 2_000);
        }
      } catch { abort(); }
      finally {
        controller.abort(); c.req.raw.signal.removeEventListener('abort', abort);
        abortStreams.delete(abort); streams.delete(stopped); finish();
      }
    });
    // streamSSE supplies its own cache header; override after construction.
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });

  app.get('/api/attention', (c) => {
    if (closed) return c.json({ error: 'server_draining' }, 503, { 'Cache-Control': 'no-store' });
    const capture = () => c.json(store.getAttention());
    return readOptions.attention ? readOptions.attention(c.req.raw, capture) : capture();
  });
  return { close };
}
