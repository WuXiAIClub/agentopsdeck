import { types } from 'node:util';

/** Local generation/activity proof only. An async guard cannot protect the
 * next synchronous dispatch; reject it without invoking known async bodies. */
export function checkMaintenanceLocal(check: () => void): void {
  if (types.isAsyncFunction(check)) throw Error('Maintenance local guard must be synchronous');
  const value: unknown = check();
  if (value === undefined) return;
  if (types.isPromise(value)) {
    try { void Promise.prototype.then.call(value, () => {}, () => {}); } catch { /* Remain fenced. */ }
  }
  // Do not inspect or assimilate caller-owned then getters.
  throw Error('Maintenance local guard must be synchronous');
}
