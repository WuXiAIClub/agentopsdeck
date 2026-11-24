import { isRecord } from '../commands/turn-queue.js';

export type OpenClawRecoverySource = {
  connectionId: () => string | undefined;
  query: (runId: string, connectionId: string) => Promise<unknown>;
};

// Installed Gateway wait snapshots distinguish "no result yet" from success.
// Timeout/error/blocked/yielded are not completion proofs. This intentionally
// recovers only an unambiguous normal end, not failure or cross-node recovery.
export function isNormalOpenClawCompletion(value: unknown, runId: string): boolean {
  if (!isRecord(value) || value.runId !== runId || value.status !== 'ok') return false;
  if (typeof value.startedAt !== 'number' || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0
    || typeof value.endedAt !== 'number' || !Number.isSafeInteger(value.endedAt) || value.endedAt < value.startedAt) return false;
  for (const field of ['yielded', 'pendingError', 'aborted']) {
    if (value[field] !== undefined && value[field] !== false) return false;
  }
  for (const field of ['error', 'livenessState', 'timeoutPhase']) {
    if (value[field] !== undefined && value[field] !== '') return false;
  }
  return (value.stopReason === undefined || value.stopReason === 'end_turn')
    && (value.providerStarted === undefined || value.providerStarted === true);
}
