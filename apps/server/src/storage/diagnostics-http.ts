import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readJsonBody } from "../utils/http-body.js";
import type { ownedStorageStats, checkpointOwnedWal } from "./owned-sqlite.js";
import type { HistoryDiagnostics } from "./history-diagnostics.js";
import { asyncVolumeAdmission, type AsyncVolumeAdmission } from "./async-volume-admission.js";
import { performanceDiagnostics, type PerformanceDiagnostics } from "../diagnostics/performance.js";
import type { connectionRecoverySnapshot } from "./connection-recovery.js";
import { ReadRequestError, ReadRequestOwner } from '../lifecycle/read-request-owner.js';
type Awaitable<T> = T | PromiseLike<T>;
type StorageAccess = {
  check: () => Awaitable<void>;
  stats: () => Awaitable<Awaited<ReturnType<typeof ownedStorageStats>>>;
  recovery: () => Awaitable<ReturnType<typeof connectionRecoverySnapshot> | undefined>;
  checkpoint: () => Awaitable<ReturnType<typeof checkpointOwnedWal>>;
};

/** Operator-only, on demand. No health-poll disk I/O, no extra DB connection,
 * paths, SQL, transcript or session identifiers. Recheck authority after awaits. */
export function registerStorageDiagnostics(app: Hono, base: string, deps: ({
  authorize: (context: Context) => () => void;
  stats: () => ReturnType<typeof ownedStorageStats>;
  checkpoint: (check: () => void) => ReturnType<typeof checkpointOwnedWal> | Promise<ReturnType<typeof checkpointOwnedWal>>;
  recovery?: () => ReturnType<typeof connectionRecoverySnapshot>;
} | { access: (context: Context) => Awaitable<StorageAccess> }) & {
  history?: HistoryDiagnostics;
  coordinator?: () => ReturnType<AsyncVolumeAdmission['snapshot']>;
  performance?: () => ReturnType<PerformanceDiagnostics['snapshot']>;
  diagnostics?: PerformanceDiagnostics;
}) {
  const reads = new ReadRequestOwner('system-read-wait', { diagnostics: deps.diagnostics });
  const begin = async (c: Context): Promise<StorageAccess> => {
    if ('access' in deps) return deps.access(c);
    const check = deps.authorize(c);
    return { check, stats: deps.stats, recovery: () => deps.recovery?.(),
      // The native SQL policy hook MUST stay synchronous in the legacy path.
      checkpoint: () => deps.checkpoint(() => { check(); c.req.raw.signal.throwIfAborted(); }) };
  };
  let checkpointAt = -Infinity;
  let checkpointInFlight = false;
  const fail = (c: Context, error: unknown) => {
    let status: HTTPException['status'] = 503;
    const trace = (deps.diagnostics ?? performanceDiagnostics).start('storage-diagnostics-failure');
    // Failure classification is not an authority/result source. Aborts and
    // storage callbacks can reject with revoked proxies or throwing getters.
    // Never coerce their status, emit their message, or report failure as 2xx.
    try {
      if (error instanceof ReadRequestError) {
        // The owner intentionally does not inspect arbitrary abort reasons.
        // Preserve the existing public 503 while exposing safe cancellation.
        if (error.status === 408) trace.add('cancelled', 1);
      } else if (error instanceof HTTPException) {
        const candidate = error.status;
        if (Number.isInteger(candidate) && candidate >= 400 && candidate <= 599) status = candidate;
        else trace.add('classificationUnknown', 1);
      }
    } catch { trace.add('classificationUnknown', 1); }
    trace.finish(true);
    return c.json({ error: 'Storage maintenance unavailable' }, status);
  };
  const route = (handler: (c: Context) => Promise<Response>) => async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    try { return (await reads.run(c.req.raw, () => handler(c))).value; }
    catch (error) { return fail(c, error); }
  };
  // Observation itself needs no storage stat/statfs, SQL or owner repair.
  // Existing authorization still applies and may use its own persistence;
  // neither a blocked identity store nor a blocked JS thread can be bypassed.
  // It is operator-only and no-store, never a cached-authority escape hatch.
  app.get(`${base}/recovery`, route(async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const access = await begin(c), check = access.check;
      const coordinator = (deps.coordinator ?? (() => asyncVolumeAdmission.snapshot()))();
      await check(); c.req.raw.signal.throwIfAborted();
      const performance = (deps.performance ?? (() => performanceDiagnostics.snapshot()))();
      await check(); c.req.raw.signal.throwIfAborted();
      const connection = await access.recovery();
      await check(); c.req.raw.signal.throwIfAborted();
      return c.json({ coordinator, performance, ...(connection ? { connection } : {}) });
    } catch (error) { return fail(c, error); }
  }));
  app.get(base, route(async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const access = await begin(c), check = access.check, stats = await access.stats();
      await check(); c.req.raw.signal.throwIfAborted();
      const coordinator = (deps.coordinator ?? (() => asyncVolumeAdmission.snapshot()))();
      await check(); c.req.raw.signal.throwIfAborted();
      return c.json({ ...stats, coordinator, ...(deps.history ? { history: deps.history.snapshot() } : {}) });
    } catch (error) { return fail(c, error); }
  }));
  app.post(`${base}/checkpoint`, route(async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const access = await begin(c), check = access.check;
      if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) throw new HTTPException(415);
      const body = await readJsonBody(c.req.raw, 256);
      await check(); c.req.raw.signal.throwIfAborted();
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new HTTPException(400);
      const remaining = checkpointAt + 60_000 - Date.now();
      if (remaining > 0 || checkpointInFlight) {
        c.header('Retry-After', String(Math.max(1, Math.ceil(remaining / 1000)))); throw new HTTPException(429);
      }
      // Reserve rate limit before the async admission, recheck authority before
      // SQL and delivery. PASSIVE remains on the sole owning connection.
      checkpointAt = Date.now();
      checkpointInFlight = true;
      try {
        const result = await access.checkpoint();
        await check(); c.req.raw.signal.throwIfAborted(); return c.json(result);
      } finally { checkpointInFlight = false; }
    } catch (error) { return fail(c, error); }
  }));
  return { close: () => reads.close() };
}
