import { types } from 'node:util';
import { StorageAdmissionDeferred } from './work-admission.js';

// Transport reasons are fixed codes, not exception messages. Recognizing a
// refusal does not authorize lease release, reconciliation or business replay.
const reasons = new Set([
  'coordinator-unavailable', 'coordinator-capacity', 'coordinator-busy', 'clock', 'corrupt-receipt',
  'estimate', 'insufficient-space', 'missing', 'not-quiescent', 'not-started',
  'outer-transaction', 'persistent-receipt', 'pressure-backoff', 'receipt-capacity',
  'request-reused', 'scope', 'stale-space-sample', 'unsafe-coordinator-directory',
  'unsafe-coordinator-file', 'volume-capacity', 'volume-changed', 'volume-coordinator-unavailable',
]);

export function isVolumeAdmissionReason(value: unknown): value is string {
  return typeof value === 'string' && reasons.has(value);
}

/** Error classification must never execute caller-owned getters, prototype
 * traps or coercion. Failure to classify preserves uncertainty, not a denial. */
export function volumeAdmissionRefusal(error: unknown): string | undefined {
  try {
    if (!error || typeof error !== 'object' || types.isProxy(error)
      || !(error instanceof StorageAdmissionDeferred)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value !== 'coordinator-unavailable'
      && isVolumeAdmissionReason(descriptor.value)
      ? descriptor.value : undefined;
  } catch { return undefined; }
}
