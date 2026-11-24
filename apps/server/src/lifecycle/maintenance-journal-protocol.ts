import { types } from 'node:util';
import { validMaintenanceJob } from './connector-maintenance.js';
import { validUnstartedPreparationProof, validSupersededPreFenceProof, type UnstartedPreparationProof,
  type SupersededPreFenceProof } from './maintenance-reconciliation.js';
import { recoveredReadinessEvidence, validRecoveredReadinessProof, type RecoveredReadinessProof } from './maintenance-recovery-reconciliation.js';

export type MaintenanceJournalKind = 'get' | 'unresolved' | 'enqueue' | 'compareAndSwap' | 'observe' | 'close'
  | 'cancelUnstartedPreparation' | 'cancelSupersededObservation' | 'completeRecoveredReadiness';
export const maintenanceJournalRequestBytes = 128 * 1024;
export const maintenanceJournalPendingBytes = 8 * 1024 * 1024;
export class MaintenanceJournalInputConflict extends Error {
  constructor() { super('Maintenance reconciliation metadata conflict'); }
}

/** Copy only bounded DTO metadata. No arbitrary structuredClone, toJSON, SQL,
 * callback or inherited authority crosses this boundary. Existing enumerable
 * getters are read at most once; the caller must recheck admission afterwards.
 * Budget counts escaped UTF-8 text and structural overhead, not JS heap size. */
export function snapshotMaintenanceJournalRequest(kind: MaintenanceJournalKind, input: unknown[]) {
  let bytes = 0, nodes = 0;
  const active = new WeakSet<object>();
  const fail = () => { throw Error('Maintenance metadata unavailable'); };
  const add = (amount: number) => { bytes += amount; if (bytes > maintenanceJournalRequestBytes) fail(); };
  const text = (value: string) => {
    if (value.length > maintenanceJournalRequestBytes) fail();
    add(Buffer.byteLength(JSON.stringify(value)));
    return value;
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 8192 || depth > 16) fail();
    if (typeof value === 'string') return text(value);
    if (value === null || value === undefined || typeof value === 'boolean') { add(8); return value; }
    if (typeof value === 'number' && Number.isSafeInteger(value)) { add(24); return value; }
    if (!value || typeof value !== 'object' || types.isProxy(value) || active.has(value)) return fail();
    const array = Array.isArray(value);
    if (array && value.length > 64) return fail();
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return fail();
    const keys = Object.keys(value);
    if (Object.getOwnPropertySymbols(value).length || keys.length > (array ? 64 : 32)) return fail();
    add(8); active.add(value);
    try {
      if (array) {
        if (value.length > 64 || keys.length !== value.length
          || keys.some((key, index) => key !== String(index))) return fail();
        return keys.map(key => copy(Reflect.get(value, key), depth + 1));
      }
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        text(key); add(8);
        Object.defineProperty(result, key, { value: copy(Reflect.get(value, key), depth + 1),
          enumerable: true, writable: true, configurable: true });
      }
      return result;
    } finally { active.delete(value); }
  };
  const args = copy(input, 0) as unknown[];
  const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
  let valid = false;
  if (kind === 'get' || kind === 'unresolved') valid = args.length === 1 && identifier(args[0]);
  else if (kind === 'observe' || kind === 'close') valid = args.length === 0;
  else if (kind === 'enqueue') valid = args.length === 1 && validMaintenanceJob(args[0]);
  else if (kind === 'compareAndSwap') valid = args.length === 2 && validMaintenanceJob(args[0]) && validMaintenanceJob(args[1]);
  else if (args.length === 3 && validMaintenanceJob(args[0]) && Number.isSafeInteger(args[2])) {
    const at = args[2] as number;
    if (kind === 'cancelUnstartedPreparation') {
      const proof = args[1] as UnstartedPreparationProof;
      if (!validUnstartedPreparationProof(args[0], proof, at)) throw new MaintenanceJournalInputConflict();
      const { nodeId, observedAt, workerStopped, serviceRunning, serviceStartedAt, serviceInvocationId,
        originalReleaseVerified, preparationDirectoryAbsent, admissionReleased, failedInvocationFenceAbsent } = proof;
      args[1] = { nodeId, observedAt, workerStopped, serviceRunning, serviceStartedAt, serviceInvocationId,
        originalReleaseVerified, preparationDirectoryAbsent, admissionReleased, failedInvocationFenceAbsent,
        originalRelease: { revision: proof.originalRelease.revision, manifestSha256: proof.originalRelease.manifestSha256 } };
      valid = true;
    } else if (kind === 'cancelSupersededObservation') {
      const proof = args[1] as SupersededPreFenceProof;
      if (!validSupersededPreFenceProof(args[0], proof, at)) throw new MaintenanceJournalInputConflict();
      const { nodeId, observedAt, workerStopped, serviceRunning, serviceStartedAt, serviceInvocationId,
        previousReleaseVerified, admissionReleased, failedInvocationFenceAbsent } = proof;
      const release = (p: { revision: string; manifestSha256: string }) => ({ revision: p.revision, manifestSha256: p.manifestSha256 });
      args[1] = { nodeId, observedAt, workerStopped, serviceRunning, serviceStartedAt, serviceInvocationId,
        previousReleaseVerified, admissionReleased, failedInvocationFenceAbsent,
        candidate: release(proof.candidate), currentRelease: release(proof.currentRelease),
        ...(proof.replacementAcceptance ? { replacementAcceptance: { release: release(proof.replacementAcceptance.release),
          deploymentSha256: proof.replacementAcceptance.deploymentSha256, acceptanceSha256: proof.replacementAcceptance.acceptanceSha256 } } : {}) };
      valid = true;
    } else if (kind === 'completeRecoveredReadiness') {
      const proof = args[1] as RecoveredReadinessProof;
      if (!validRecoveredReadinessProof(args[0], proof, at)) throw new MaintenanceJournalInputConflict();
      args[1] = recoveredReadinessEvidence(proof); valid = true;
    }
  }
  if (!valid) fail();
  return { args, bytes };
}
