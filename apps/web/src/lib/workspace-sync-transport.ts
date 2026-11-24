import { WORKSPACE_SYNC_VERSION, WORKSPACE_SYNC_MAX_ITEMS, WORKSPACE_SYNC_MAX_FRAME_BYTES, type WorkspaceSyncItem, type WorkspaceSyncFrame } from '@agentopsdeck/shared';

type Context = { group: string; url: string; headers: HeadersInit; signal: AbortSignal; legacy: () => Promise<Response> };
type Job = { item: WorkspaceSyncItem; context: Context; resolve: (response: Response) => void; reject: (error: unknown) => void; abort: () => void; cancelBatch?: () => void; settled: boolean };
export type WorkspaceSyncMetrics = { startedAt: number; batches: number; items: number; errors: number; bytes: number; fallbacks: number;
  cancelled: number; timeouts: number; httpErrors: number; unavailable: number; transportErrors: number };

// A fetch/body can ignore abort, and cancellation cleanup can remain pending.
// Neither is allowed to retain a shared scheduler slot indefinitely.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
const cancelBody = (body: ReadableStream | null) => { void body?.cancel().catch(() => {}); };
const cancelled = () => new DOMException('Workspace read cancelled', 'AbortError');

/** One browser coordinator. Existing per-session snapshot gates still own
 * ordering, event catch-up and retry; this layer only batches read transport. */
export function createWorkspaceSyncTransport(options: {
  enabled: () => boolean; unsupported: () => void; fetch: typeof fetch;
  intervalMs?: number; collectMs?: number; maxBatches?: number; timeoutMs?: number;
}) {
  const queued: Job[] = [], active = new Set<AbortController>(), all = new Set<Job>();
  let timer: ReturnType<typeof setTimeout> | undefined, lastStart = -Infinity, generation = 0;
  const metrics: WorkspaceSyncMetrics = { startedAt: Date.now(), batches: 0, items: 0, errors: 0, bytes: 0, fallbacks: 0,
    cancelled: 0, timeouts: 0, httpErrors: 0, unavailable: 0, transportErrors: 0 };
  function settle(job: Job, response?: Response, error?: unknown) {
    if (job.settled) return;
    job.settled = true; all.delete(job); job.context.signal.removeEventListener('abort', job.abort);
    const index = queued.indexOf(job); if (index >= 0) queued.splice(index, 1);
    if (error !== undefined) {
      if (error instanceof Error && error.name === 'AbortError') metrics.cancelled++;
      else { metrics.errors++; if (error instanceof Error && error.name === 'TimeoutError') metrics.timeouts++; else metrics.transportErrors++; }
      job.reject(error);
    } else {
      if (response!.status >= 400) { metrics.errors++; metrics.httpErrors++; if (response!.status === 503) metrics.unavailable++; }
      job.resolve(response!);
    }
  }
  function arm() {
    if (timer || !queued.length || active.size >= (options.maxBatches ?? 2)) return;
    timer = setTimeout(() => { timer = undefined; flush(); }, Math.max(options.collectMs ?? 250, lastStart + (options.intervalMs ?? 1500) - Date.now()));
  }
  function flush() {
    if (!queued.length || active.size >= (options.maxBatches ?? 2)) return;
    const group = queued[0]!.context.group, sessions = new Set<string>(), jobs: Job[] = [];
    const candidates = queued
      .map((job, index) => ({ job, index }))
      .filter(({ job }) => job.context.group === group)
      .sort((a, b) => (a.job.item.priority ?? 0) - (b.job.item.priority ?? 0) || a.index - b.index);
    for (const { job } of candidates) {
      if (job.context.group !== group || sessions.has(job.item.sessionKey)) continue;
      sessions.add(job.item.sessionKey); queued.splice(queued.indexOf(job), 1); jobs.push(job);
      if (jobs.length === WORKSPACE_SYNC_MAX_ITEMS) break;
    }
    const controller = new AbortController(), epoch = generation; active.add(controller); lastStart = Date.now();
    for (const job of jobs) job.cancelBatch = () => { if (jobs.every(item => item.settled)) controller.abort(); };
    const run = async () => {
      if (!options.enabled()) return legacy(jobs);
      metrics.batches++; metrics.items += jobs.length;
      const timeout = setTimeout(() => controller.abort(new DOMException('Workspace sync timed out', 'TimeoutError')), options.timeoutMs ?? 30_000);
      try {
        const pendingResponse = options.fetch(jobs[0]!.context.url, { method: 'POST', credentials: 'include', signal: controller.signal,
          headers: { ...Object.fromEntries(new Headers(jobs[0]!.context.headers)), 'content-type': 'application/json' },
          body: JSON.stringify({ version: WORKSPACE_SYNC_VERSION, items: jobs.map(job => job.item) }) });
        void pendingResponse.then(response => { if (epoch !== generation || controller.signal.aborted) cancelBody(response.body); }, () => {});
        const response = await abortable(pendingResponse, controller.signal);
        if (epoch !== generation || controller.signal.aborted) { cancelBody(response.body); controller.signal.throwIfAborted(); return; }
        if ([404, 405, 501].includes(response.status)) { cancelBody(response.body); options.unsupported(); return legacy(jobs); }
        if (!response.ok) {
          // Outer auth/fence failures are not evidence that Preview is unsupported.
          // This route uses 409 only for the authenticated Hub/account fence.
          // Preserve its canonical error so the API triggers re-authentication.
          const error = response.status === 409 ? 'Authenticated account or Hub changed; reload before continuing' : `Workspace sync failed: HTTP ${response.status}`;
          for (const job of jobs) settle(job, Response.json({ error }, { status: response.status }));
          cancelBody(response.body); return;
        }
        if (!response.headers.get('content-type')?.startsWith('application/x-ndjson') || response.headers.get('x-agentopsdeck-workspace-sync') !== '1'
          || !response.body) { cancelBody(response.body); throw new Error('Invalid workspace sync response'); }
        const reader = response.body.getReader(), decoder = new TextDecoder(), seen = new Set<string>();
        let pending = '', bytes = 0;
        const consume = (line: string) => {
          if (new TextEncoder().encode(line).byteLength > WORKSPACE_SYNC_MAX_FRAME_BYTES) throw new Error('Workspace sync frame too large');
          const frame = JSON.parse(line) as WorkspaceSyncFrame;
          const job = jobs.find(job => job.item.sessionKey === frame?.sessionKey);
          if (!job || seen.has(frame.sessionKey) || !Number.isInteger(frame.status)
            || !([200, 202, 304].includes(frame.status) || (frame.status >= 400 && frame.status <= 599))) throw new Error('Invalid workspace sync item');
          const headers = new Headers({ 'content-type': 'application/json' });
          for (const key of ['etag', 'x-agentopsdeck-history-meta', 'x-agentopsdeck-history-delta', 'x-agentopsdeck-history-check']) {
            const value = frame.headers?.[key];
            if (value !== undefined) { if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid workspace sync metadata'); headers.set(key, value); }
          }
          if (frame.status === 200 && (!frame.body || typeof frame.body !== 'object')) throw new Error('Invalid workspace history');
          seen.add(frame.sessionKey);
          settle(job, new Response(frame.status === 304 ? null : JSON.stringify(frame.body ?? {}), { status: frame.status, headers }));
        };
        try {
          while (seen.size < jobs.length) {
            const chunk = await abortable(reader.read(), controller.signal);
            if (epoch !== generation || controller.signal.aborted) { controller.signal.throwIfAborted(); return; }
            if (chunk.done) { pending += decoder.decode(); break; }
            bytes += chunk.value.byteLength; metrics.bytes += chunk.value.byteLength;
            if (bytes > 33 * 1024 * 1024) throw new Error('Workspace sync response too large');
            pending += decoder.decode(chunk.value, { stream: true });
            let newline;
            while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); if (line) consume(line); }
            if (pending.length > WORKSPACE_SYNC_MAX_FRAME_BYTES) throw new Error('Workspace sync frame too large');
          }
          if (pending.trim()) consume(pending);
          if (seen.size !== jobs.length) throw new Error('Workspace sync interrupted before all sessions returned');
        } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      } finally { clearTimeout(timeout); controller.abort(); }
    };
    void run().catch(error => { for (const job of jobs) settle(job, undefined, error); }).finally(() => { active.delete(controller); arm(); });
    arm();
  }
  async function legacy(jobs: Job[]) {
    // Fallback also bounded; never retry a message send or turn a 503 into success.
    for (const job of jobs) {
      if (job.settled) continue;
      metrics.fallbacks++;
      try { settle(job, await abortable(job.context.legacy(), job.context.signal)); } catch (error) { settle(job, undefined, error); }
    }
  }
  return {
    read(item: WorkspaceSyncItem, context: Context): Promise<Response> {
      if (context.signal.aborted) return Promise.reject(context.signal.reason?.name === 'TimeoutError' ? context.signal.reason : cancelled());
      if (all.size >= 32) return Promise.reject(new Error('Workspace read capacity exceeded'));
      return new Promise((resolve, reject) => {
        const job: Job = { item, context, resolve, reject, settled: false, abort: () => {
          settle(job, undefined, context.signal.reason?.name === 'TimeoutError' ? context.signal.reason : cancelled()); job.cancelBatch?.();
        } };
        all.add(job); queued.push(job); context.signal.addEventListener('abort', job.abort, { once: true }); arm();
      });
    },
    reset(clearMetrics = true) {
      generation++;
      clearTimeout(timer); timer = undefined; lastStart = -Infinity;
      for (const job of [...all]) settle(job, undefined, new DOMException('Workspace sync scope changed', 'AbortError'));
      for (const controller of active) controller.abort();
      if (clearMetrics) {
        for (const key of Object.keys(metrics) as Array<keyof WorkspaceSyncMetrics>) metrics[key] = 0;
        metrics.startedAt = Date.now();
      }
    },
    metrics: () => ({ ...metrics }),
  };
}
