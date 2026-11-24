import { types } from 'node:util';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';

export type SqlOwnerFailureNotice = {
  kind: 'sql-owner-failure'; owner: 'auth' | 'maintenance'; step: number; sqlErrorCode?: number;
};

/** A numeric observation lane, never a command/ACK, permission, transaction
 * result or exit proof. The original child's failure log remains authoritative
 * and is retained even after this per-original-worker observation budget. */
export function observeSqlOwnerFailure(notice: SqlOwnerFailureNotice, diagnostics: PerformanceDiagnostics): void {
  try {
    const trace = diagnostics.start(notice.owner === 'auth' ? 'auth-sqlite-owner-failure' : 'maintenance-sql-owner-failure');
    trace.add('step', notice.step);
    if (notice.sqlErrorCode === undefined) trace.add('classificationUnknown', 1);
    else trace.add('sqlErrorCode', notice.sqlErrorCode);
    if (notice.owner === 'maintenance' && notice.step === 3) trace.add('unknown', 1);
    trace.finish(true);
  } catch { /* Observation cannot replace an original SQL/cleanup failure. */ }
}

/** Separate receiver per original worker; no private exception text, JSON log
 * parser or RPC ID. Malformed telemetry still goes to normal fail-closed reply
 * validation, not a permissive "ignore unknown message" branch. */
export function createSqlOwnerFailureReceiver(owner: SqlOwnerFailureNotice['owner'], diagnostics: PerformanceDiagnostics) {
  let received = 0;
  return (message: unknown): boolean => {
    if (!message || typeof message !== 'object' || types.isProxy(message) || Array.isArray(message)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(message), keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || !['kind', 'owner', 'step', 'sqlErrorCode'].includes(key)
      || !Object.hasOwn(descriptors[key]!, 'value') || !descriptors[key]!.enumerable)) return false;
    if (descriptors.kind?.value !== 'sql-owner-failure' || descriptors.owner?.value !== owner) return false;
    const step: unknown = descriptors.step?.value, sql: unknown = descriptors.sqlErrorCode?.value;
    const integer = (value: unknown, low: number, high: number) => typeof value === 'number'
      && Number.isInteger(value) && value >= low && value <= high;
    if (!integer(step, owner === 'auth' ? 0 : 1, owner === 'auth' ? 19 : 4)
      || descriptors.sqlErrorCode && !integer(sql, 1, 0xffff)) return false;
    if (received >= 16) return true;
    received++;
    observeSqlOwnerFailure({ kind: 'sql-owner-failure', owner, step: step as number,
      ...(sql === undefined ? {} : { sqlErrorCode: sql as number }) }, diagnostics);
    return true;
  };
}
