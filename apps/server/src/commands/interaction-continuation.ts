import { createHash } from 'node:crypto';

/** Internal evidence from the current runtime, never a client-supplied claim.
 * Goal authority remains native: this module cannot set, clear or resume goals. */
export type InteractionContinuation = {
  connectionId: string;
  goal: { status: 'absent' | 'active' | 'blocked' | 'paused' | 'usageLimited' | 'budgetLimited' | 'complete' | 'unknown'; version: string };
};
export class InteractionDeliveryConflict extends Error {
  constructor(readonly code: 'continuation' | 'revision' | 'capacity' | 'delivery' | 'missing') {
    super(`Interaction delivery rejected: ${code}`);
  }
}

/** A blocked goal may accept an explicit answer to its STILL LIVE native request.
 * This is not permission to start a new turn or to resume a cold thread.
 * Legacy/unsupported goal queries must use unknown, not invent absent evidence. */
export function continuationFingerprint(value: InteractionContinuation): string {
  if (!value || typeof value.connectionId !== 'string' || !value.connectionId.trim()
    || value.connectionId.length > 256 || /[\x00-\x1f\x7f]/.test(value.connectionId)
    || !value.goal || !['absent', 'active', 'blocked', 'complete'].includes(value.goal.status)
    || typeof value.goal.version !== 'string' || !value.goal.version.trim() || value.goal.version.length > 1024) {
    throw new InteractionDeliveryConflict('continuation');
  }
  const phase = ['active', 'blocked'].includes(value.goal.status) ? 'continuing' : value.goal.status;
  return createHash('sha256').update(JSON.stringify([value.connectionId, phase, value.goal.version])).digest('hex');
}
