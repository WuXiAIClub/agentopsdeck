import type { DatabaseSync } from 'node:sqlite';
import { addSqlFailure } from './sql-failure-diagnostics.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

export class StorageConnectionUnavailable extends Error {
  constructor() { super('Storage connection recovery required'); }
}
type State = {
  mark: (nested: boolean) => void;
  retire: () => void;
  ready: () => void;
  snapshot: () => { state: 'ready' | 'owner-rollback-required' | 'parent-rollback-required' | 'close-required' | 'closed'; attempts: number };
};
const owners = new WeakMap<DatabaseSync, State>();
const wrappedHandles = new WeakSet<DatabaseSync>();

/** Call only after cleanup failed. The original request remains failed/unknown.
 * Raw fixture connections are not recoverable owners; never take their locks. */
export function markConnectionCleanupFault(db: DatabaseSync, nested: boolean) {
  owners.get(db)?.mark(nested);
}
export function connectionRecoverySnapshot(db: DatabaseSync) {
  return owners.get(db)?.snapshot() ?? { state: 'ready' as const, attempts: 0 };
}
export function requireConnectionReady(db: DatabaseSync) { owners.get(db)?.ready(); }

/** An escaped async callback is not a synchronous transaction owner. Rollback
 * alone cannot prove that its continuation has stopped. Permanently retire the
 * old facade: only explicit native close may follow, not recovery/replay/reopen.
 * Cached statements and iterators remain fenced even after its Promise settles.
 */
export function retireConnectionForAsyncWork(db: DatabaseSync) { retireConnection(db); }

/** Freeze SQL before consulting fallible cleanup observations. Retains the
 * exact owner for explicit close only; neither retirement nor a clock sample
 * proves native closure or permits a replacement connection. */
export function retireConnection(db: DatabaseSync) { owners.get(db)?.retire(); }

/** Sole-owner facade; the raw handle must not escape the constructing owner.
 * Cached statements and iterators are fenced too. After failed cleanup only a
 * full ROLLBACK may run: never COMMIT, callback replay, nested-parent takeover,
 * or a new transaction on top of abandoned writes. A standalone owner can try
 * rollback on the next access, at most once per second. Nested faults wait for
 * the synchronous outer owner's rollback. No timer, await or replacement DB.
 * Explicit owner close ends SQL admission before the native call. Failure
 * retains the original handle for close retry only, never rollback or reopen.
 */
export function recoverableConnection(raw: DatabaseSync,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics,
  clock: () => number = () => performance.now()): DatabaseSync {
  if (owners.has(raw) || wrappedHandles.has(raw)) throw Error('Storage connection already wrapped');
  let fault: 'owner' | 'parent' | undefined, attempts = 0, nextAttempt = -Infinity;
  let lifetime: 'open' | 'close-required' | 'closed' = 'open';
  let faultEpoch = 0;
  const originalExec = raw.exec.bind(raw);
  let overrideExec: ((sql: string) => void) | undefined;
  let recovering = false, closing = false, forwardingRollback = false;
  // Diagnostic callbacks may throw or re-enter. They cannot decide whether
  // the original handle has rolled back, nor replace its admission error.
  const observe = (action: () => void) => { try { action(); } catch { /* Observation only. */ } };
  const fullRollback = (sql: string) => /^\s*ROLLBACK(?:\s+TRANSACTION)?\s*;?\s*$/i.test(sql);
  const cleanup = (sql: string) => /^\s*ROLLBACK\b/i.test(sql);
  const mark = (nested: boolean) => {
    if (!raw.isTransaction) return;
    if (!fault) { faultEpoch++; fault = nested ? 'parent' : 'owner'; nextAttempt = -Infinity; }
    else if (!nested) fault = 'owner';
  };
  const clear = () => { fault = undefined; nextAttempt = -Infinity; };
  const guardLifetime = () => { if (lifetime !== 'open') throw new StorageConnectionUnavailable(); };
  const guard = () => {
    guardLifetime();
    if (recovering) throw new StorageConnectionUnavailable();
    if (!fault) return;
    if (fault === 'parent') throw new StorageConnectionUnavailable();
    // Publish ownership before either diagnostic or admission clocks. They are
    // observations, not authority to re-enter this original cleanup attempt.
    recovering = true;
    try {
      // A broken observer clock must not authorize cleanup or erase the last
      // deadline. Do not coerce returned objects or expose clock exceptions.
      let now: unknown;
      try { now = clock(); } catch { /* Invalid observation; original fence remains. */ }
      if (typeof now !== 'number' || !Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 1000) {
        let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
        observe(() => { trace = diagnostics.start('storage-connection-recovery'); });
        observe(() => trace?.add('deferred', 1));
        observe(() => trace?.add('classificationUnknown', 1));
        observe(() => trace?.add('unknown', 1));
        observe(() => trace?.finish(true));
        throw new StorageConnectionUnavailable();
      }
      if (now < nextAttempt) throw new StorageConnectionUnavailable();
      // All SQL has been fenced since mark(); no unrelated transaction can have
      // replaced this one through the owner facade. Recover only its rollback.
      let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
      let failed = true;
      attempts++; nextAttempt = now + 1000;
      observe(() => { trace = diagnostics.start('storage-connection-recovery'); });
      try {
        guardLifetime();
        if (raw.isTransaction) {
          forwardingRollback = true;
          try { (overrideExec ?? originalExec)('ROLLBACK'); }
          finally { forwardingRollback = false; }
        }
        if (raw.isTransaction) throw new StorageConnectionUnavailable();
        clear(); failed = false; observe(() => trace?.add('recovered', 1));
      } catch (error) {
        observe(() => trace?.add('rollbackFailed', 1));
        observe(() => trace?.add('unknown', 1));
        observe(() => { if (trace) addSqlFailure(trace, error, 'rollbackErrorCode'); });
      }
      finally { observe(() => trace?.finish(failed)); }
    } finally { recovering = false; }
    // The triggering caller may have already branched on isTransaction or read
    // other state. Even successful recovery must abort that request; only a
    // distinct later access may proceed from the clean connection boundary.
    throw new StorageConnectionUnavailable();
  };
  const exec = (sql: string) => {
    guardLifetime();
    if (recovering) throw new StorageConnectionUnavailable();
    if (fault && fullRollback(sql)) {
      try { return (overrideExec ?? originalExec)(sql); }
      catch (error) { mark(false); throw error; }
      finally { if (!raw.isTransaction) clear(); }
    }
    guard();
    try { return (overrideExec ?? originalExec)(sql); }
    catch (error) { if (cleanup(sql)) mark(!fullRollback(sql)); throw error; }
  };
  // The original wrapped exec can be saved/restored by fixture injection. It
  // always calls the native method, avoiding override -> saved exec recursion.
  const nativeExec = (sql: string) => {
    guardLifetime();
    // Saved native exec may be forwarded by a fixture override during our own
    // rollback, but observation callbacks cannot start another cleanup.
    if (recovering && !(forwardingRollback && fullRollback(sql))) throw new StorageConnectionUnavailable();
    if (!(fault && fullRollback(sql))) guard();
    try { return originalExec(sql); }
    catch (error) { if (cleanup(sql)) mark(!fullRollback(sql)); throw error; }
    finally { if (fault && fullRollback(sql) && !raw.isTransaction) clear(); }
  };
  const close = () => {
    if (closing || recovering) throw new StorageConnectionUnavailable();
    if (lifetime === 'closed') return;
    const retry = lifetime === 'close-required';
    lifetime = 'close-required';
    closing = true;
    let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
    observe(() => { trace = diagnostics.start('storage-connection-close'); });
    let failed = true;
    try {
      raw.close();
      lifetime = 'closed'; clear();
      failed = false; observe(() => trace?.add(retry ? 'recovered' : 'settled', 1));
    } catch (error) {
      observe(() => { if (trace) addSqlFailure(trace, error); });
      // Only this exact private handle can prove a lost close ACK. Older
      // backends without a state probe remain fenced until close succeeds.
      try {
        if (raw.isOpen === false) { lifetime = 'closed'; clear(); observe(() => trace?.add('recovered', 1)); }
        else observe(() => trace?.add('unknown', 1));
      } catch { observe(() => trace?.add('unknown', 1)); }
      throw error;
    } finally { observe(() => trace?.finish(failed)); closing = false; }
  };
  const statements = new WeakMap<object, object>();
  const wrapStatement = (statement: ReturnType<DatabaseSync['prepare']>) => {
    const existing = statements.get(statement); if (existing) return existing;
    const wrapped = new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        guard(); const result = Reflect.apply(value, target, args);
        if (key !== 'iterate') return result;
        const epoch = faultEpoch;
        const iteratorProxy: object = new Proxy(result as object, { get(iterator, method) {
          if (method === Symbol.iterator) return () => iteratorProxy;
          const member = Reflect.get(iterator, method, iterator);
          return typeof member === 'function' ? (...params: unknown[]) => {
            // Disposal releases a reader; it cannot publish an abandoned row.
            if (method !== 'return') {
              guard(); if (epoch !== faultEpoch) throw new StorageConnectionUnavailable();
            }
            return Reflect.apply(member, iterator, params);
          } : member;
        } });
        return iteratorProxy;
      };
    } });
    statements.set(statement, wrapped); return wrapped;
  };
  const db = new Proxy(raw, {
    get(target, key) {
      if (key === 'close') return close;
      if (key === 'exec') return overrideExec ? exec : nativeExec;
      if (key === 'prepare') return (sql: string) => { guard(); return wrapStatement(target.prepare(sql)); };
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { guard(); return Reflect.apply(value, target, args); };
    },
    set(target, key, value) {
      if (key === 'exec') { overrideExec = value === nativeExec || value === exec ? undefined : value; return true; }
      return Reflect.set(target, key, value, target);
    },
  });
  owners.set(db, {
    ready: guard,
    mark,
    retire: () => { if (lifetime === 'open') { lifetime = 'close-required'; faultEpoch++; } },
    snapshot: () => ({ state: lifetime !== 'open' ? lifetime : fault === 'owner' ? 'owner-rollback-required' : fault === 'parent' ? 'parent-rollback-required' : 'ready', attempts }),
  });
  wrappedHandles.add(raw);
  return db;
}
