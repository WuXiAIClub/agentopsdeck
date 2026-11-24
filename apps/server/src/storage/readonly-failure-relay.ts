import { types } from 'node:util';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';

export type ReadonlySqlFailureNotice = {
  kind: 'readonly-owner-failure'; step: number; sqlErrorCode?: number; ownerFailureCode?: number;
};

/** Numeric observation only, from an existing original readonly worker. Never
 * consumes an RPC id or supplies permission, exit proof, release or replay.
 * Keep the original child's log as well; parent log budgets are independent. */
export function observeReadonlySqlFailure(notice: ReadonlySqlFailureNotice, diagnostics: PerformanceDiagnostics): void {
  try {
    const trace = diagnostics.start('readonly-sql-owner-failure');
    trace.add('step', notice.step);
    if (notice.sqlErrorCode === undefined) trace.add('classificationUnknown', 1);
    else trace.add('sqlErrorCode', notice.sqlErrorCode);
    if (notice.ownerFailureCode !== undefined) trace.add('ownerFailureCode', notice.ownerFailureCode);
    if (notice.step === 3 || notice.step === 6) trace.add('unknown', 1);
    trace.finish(true);
  } catch { /* Observation failure cannot affect the original owner. */ }
}

/** A private typed lane, not a generic worker-log parser. Malformed notices are
 * NOT recognized as telemetry and remain subject to normal protocol refusal.
 * Descriptor validation also makes injected test transports non-executable. */
export function createReadonlyFailureReceiver(owner: 'auth' | 'hub', diagnostics: PerformanceDiagnostics) {
  let received = 0;
  return (message: unknown): boolean => {
    if (!message || typeof message !== 'object' || types.isProxy(message) || Array.isArray(message)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(message);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || !['kind', 'step', 'sqlErrorCode', 'ownerFailureCode'].includes(key)
      || !Object.hasOwn(descriptors[key]!, 'value') || !descriptors[key]!.enumerable)) return false;
    if (descriptors.kind?.value !== 'readonly-owner-failure') return false;
    const step: unknown = descriptors.step?.value, sql: unknown = descriptors.sqlErrorCode?.value,
      point: unknown = descriptors.ownerFailureCode?.value;
    const integer = (value: unknown, low: number, high: number) => typeof value === 'number'
      && Number.isInteger(value) && value >= low && value <= high;
    if (!integer(step, owner === 'auth' ? 1 : 4, owner === 'auth' ? 3 : 6)
      || descriptors.sqlErrorCode && !integer(sql, 1, 0xffff)
      || descriptors.ownerFailureCode && !integer(point, 1, 9)) return false;
    // Bound diagnostic amplification without converting log pressure into a
    // business failure. Failed original workers normally emit at most two.
    if (received >= 16) return true;
    received++;
    observeReadonlySqlFailure({ kind: 'readonly-owner-failure', step: step as number,
      ...(sql === undefined ? {} : { sqlErrorCode: sql as number }),
      ...(point === undefined ? {} : { ownerFailureCode: point as number }) }, diagnostics);
    return true;
  };
}
