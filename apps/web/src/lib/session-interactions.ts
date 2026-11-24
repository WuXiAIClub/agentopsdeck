import type { InteractionSnapshot } from '@agentopsdeck/shared';

export type InteractionRead = { data?: InteractionSnapshot; loading: boolean; failed: boolean; unavailable?: 'unsupported' | 'missing' };
type Entry = { scope: string; key: string; value: InteractionRead; listeners: Set<() => void>;
  capabilityUntil: number;
  controller?: AbortController | undefined; dirty: boolean; failures: number; retryAt: number; timer?: ReturnType<typeof setTimeout> | undefined };
const empty: InteractionRead = { loading: true, failed: false };
/** One bounded read per mounted session, shared by desktop/mobile surfaces.
 * No intervals or transcript invalidations. Event bursts coalesce; late reads
 * from a closed panel/account cannot repopulate the cache. Transport must settle
 * after abort/timeout (the API already does); slots track actual work, not races.
 * This queue is independent of history reads and NEVER queues answer writes. */
export function createInteractionReads(load: (key: string, signal: AbortSignal) => Promise<InteractionSnapshot>, concurrency = 4, now = Date.now,
  capability?: (key: string, signal: AbortSignal) => Promise<boolean | undefined>) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Invalid interaction read concurrency');
  const entries = new Map<string, Entry>();
  const queued = new Set<Entry>();
  let active = 0, dispatch: ReturnType<typeof setTimeout> | undefined;
  let acquire: (() => { close(): void } | undefined) | undefined, stream: { close(): void } | undefined;
  const id = (scope: string, key: string) => JSON.stringify([scope, key]);
  const publish = (e: Entry, value: InteractionRead) => { e.value = value; for (const notify of e.listeners) notify(); };
  const current = (e: Entry) => entries.get(id(e.scope, e.key)) === e;
  const pump = () => {
    if (dispatch !== undefined || !queued.size || active >= concurrency) return;
    // Yield between batches of cached results; FIFO prevents a noisy session
    // from starving the remaining sessions during reconnect/event storms.
    dispatch = setTimeout(() => {
      dispatch = undefined;
      for (const e of queued) {
        if (active >= concurrency) break;
        queued.delete(e);
        if (current(e)) void read(e);
      }
    }, 0);
  };
  const read = async (e: Entry) => {
    if (!current(e) || now() < e.retryAt) return;
    if (e.controller) { e.dirty = true; return; }
    const controller = new AbortController(); e.controller = controller; e.dirty = false;
    active++;
    try {
      publish(e, { ...e.value, loading: true });
      if (!current(e) || controller.signal.aborted) return;
      if (capability && now() >= e.capabilityUntil) {
        const available = await capability(e.key, controller.signal);
        if (!current(e) || controller.signal.aborted) return;
        if (available === false) {
          e.retryAt = now() + 300_000; e.dirty = false;
          publish(e, { loading: false, failed: false, unavailable: 'unsupported' });
          return;
        }
        // Only a mounted, actor-scoped entry retains this advisory result.
        // No new poll/timer; reconnect/events recheck after the bounded TTL.
        e.capabilityUntil = now() + 300_000;
      }
      const data = await load(e.key, controller.signal);
      if (current(e) && !controller.signal.aborted) {
        e.failures = 0; e.retryAt = 0;
        publish(e, { data, loading: false, failed: false });
      }
    } catch (error) {
      if (current(e) && !controller.signal.aborted) {
        e.failures = Math.min(e.failures + 1, 6);
        const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
        const retryAfter = error && typeof error === 'object' && 'retryAfterMs' in error ? error.retryAfterMs : undefined;
        const delay = status === 404 ? Infinity : status === 403 || status === 401 ? 300_000 : Math.min(300_000, 15_000 * 2 ** (e.failures - 1));
        e.retryAt = now() + Math.max(delay, typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 0);
        // Do not immediately replay event invalidations accumulated during a
        // failed request. Manual refresh may retry; SSE reconnects must wait.
        e.dirty = false;
        // A 404 may mean missing route OR missing session. Do not guess which,
        // preserve stale approvals, or keep probing it on SSE reconnects.
        publish(e, status === 404 ? { loading: false, failed: true, unavailable: 'missing' }
          : { ...(e.value.data ? { data: e.value.data } : {}), loading: false, failed: true });
      }
    } finally {
      active--;
      if (e.controller === controller) e.controller = undefined;
      if (current(e) && e.dirty) schedule(e);
      pump();
    }
  };
  const schedule = (e: Entry) => {
    if (now() < e.retryAt) return;
    if (e.controller) { e.dirty = true; return; }
    if (e.timer !== undefined || queued.has(e)) return;
    e.timer = setTimeout(() => { e.timer = undefined; if (current(e)) { queued.add(e); pump(); } }, 100);
  };
  return {
    configure(start: typeof acquire) { acquire = start; },
    snapshot(scope: string, key: string): InteractionRead { return entries.get(id(scope, key))?.value ?? empty; },
    subscribe(scope: string, key: string, notify: () => void) {
      const address = id(scope, key);
      let e = entries.get(address);
      if (!e) { e = { scope, key, value: empty, listeners: new Set(), capabilityUntil: 0, dirty: false, failures: 0, retryAt: 0 }; entries.set(address, e); schedule(e); }
      // Subscription ownership is per call, not per callback identity.
      const listener = () => notify();
      e.listeners.add(listener);
      if (!stream) stream = acquire?.();
      const entry = e;
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        entry.listeners.delete(listener);
        if (!entry.listeners.size) {
          clearTimeout(entry.timer); queued.delete(entry); entry.controller?.abort();
          if (current(entry)) entries.delete(address);
        }
        if (!queued.size) { clearTimeout(dispatch); dispatch = undefined; }
        if (!entries.size) { stream?.close(); stream = undefined; }
      };
    },
    refresh(scope: string, key: string) { const e = entries.get(id(scope, key)); if (e) { e.retryAt = 0; e.capabilityUntil = 0; schedule(e); } },
    connected(scope: string) { for (const e of entries.values()) if (e.scope === scope) schedule(e); },
    receive(scope: string, event: { type?: unknown; sessionKey?: unknown }) {
      if (event.type === 'interaction.updated' && typeof event.sessionKey === 'string') {
        const e = entries.get(id(scope, event.sessionKey)); if (e) schedule(e);
      }
    },
  };
}

/** An uncertain answer is not a draft. Remember its identity before sending;
 * reopening/reloading must not create a second answer. Never store answer text.
 * Expired native requests cannot be answered and can safely leave this ledger. */
export function interactionSubmissionLedger(storage: Pick<Storage, 'getItem' | 'setItem'>, now = Date.now) {
  const key = 'agentopsdeck.interaction-submissions.v1';
  type Row = { scope: string; session: string; request: string; response: string; expires: number };
  function rows(): Row[] {
    const value: unknown = JSON.parse(storage.getItem(key) ?? '[]');
    if (!Array.isArray(value) || value.length > 512 || value.some(r => !r || typeof r !== 'object'
      || !['scope', 'session', 'request', 'response'].every(k => typeof r[k] === 'string' && r[k].length <= 1024)
      || !Number.isSafeInteger(r.expires))) throw new Error('Invalid interaction receipts');
    return value.filter(r => r.expires > now());
  }
  return {
    has(scope: string, session: string, request: string) { return rows().some(r => r.scope === scope && r.session === session && r.request === request); },
    begin(scope: string, session: string, request: string, expires: number, response: string) {
      const saved = rows();
      if (saved.some(r => r.scope === scope && r.session === session && r.request === request) || saved.length >= 512) throw new Error('Answer already submitted or receipts unavailable');
      saved.push({ scope, session, request, expires, response }); storage.setItem(key, JSON.stringify(saved));
    },
  };
}
