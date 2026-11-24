import {
  readInteractionAnswer, readInteractionCapabilities, readInteractionRequest,
  type InteractionAnswer, type InteractionRequest, type InteractionScope,
} from '@agentopsdeck/shared';

export type InteractionClosure = 'expired' | 'stopped' | 'disconnected' | 'revoked' | 'restarted';
export type InteractionState =
  | { status: 'pending'; request: InteractionRequest }
  | { status: 'answered'; request: InteractionRequest; answer: InteractionAnswer; responseId: string; answeredAt: number }
  | { status: 'closed'; request: InteractionRequest; reason: InteractionClosure; closedAt: number };

export class InteractionConflict extends Error {
  constructor(readonly code: 'invalid' | 'unsupported' | 'scope' | 'permission' | 'closed' | 'answered') {
    super(`Interaction request rejected: ${code}`);
  }
}
function clock(now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new InteractionConflict('invalid');
}
function sameScope(a: InteractionScope, b: InteractionScope) {
  return a.ownerId === b.ownerId && a.nodeId === b.nodeId && a.sessionKey === b.sessionKey && a.runId === b.runId;
}

/** Pure lifecycle only. The caller must persist with CAS before any native delivery.
 * An answered record means accepted human input, NOT successful tool execution.
 * Restart/disconnect must close pending records unless native continuation is proven. */
export function createInteraction(value: unknown, capabilities: unknown, scope: InteractionScope, now: number): InteractionState {
  clock(now);
  const request = readInteractionRequest(value);
  if (!request || request.createdAt > now || request.expiresAt <= now) throw new InteractionConflict('invalid');
  if (!sameScope(request, scope)) throw new InteractionConflict('scope');
  const supported = readInteractionCapabilities(capabilities);
  if (!supported.modes.includes('interactive') || !supported.kinds.includes(request.kind)) throw new InteractionConflict('unsupported');
  return { status: 'pending', request };
}

/** scope and permissionAllowed must come from authenticated server context, never request JSON.
 * Permission must include current ownership/grant AND Connector hard policy revalidation. */
export function answerInteraction(state: InteractionState, input: {
  scope: InteractionScope; requestId: string; responseId: string; answer: unknown;
  permissionAllowed: boolean; now: number;
}): { state: InteractionState; changed: boolean } {
  clock(input.now);
  if (!sameScope(state.request, input.scope) || input.requestId !== state.request.requestId) throw new InteractionConflict('scope');
  if (!input.permissionAllowed) throw new InteractionConflict('permission');
  if (typeof input.responseId !== 'string' || !input.responseId.trim() || input.responseId.length > 256
    || /[\x00-\x1f\x7f]/.test(input.responseId) || input.now < state.request.createdAt) throw new InteractionConflict('invalid');
  const answer = readInteractionAnswer(state.request, input.answer);
  if (!answer) throw new InteractionConflict('invalid');
  if (state.status === 'answered') {
    if (state.responseId === input.responseId && JSON.stringify(state.answer) === JSON.stringify(answer)) return { state, changed: false };
    throw new InteractionConflict('answered');
  }
  if (state.status === 'closed') throw new InteractionConflict('closed');
  if (input.now >= state.request.expiresAt) return { state: closeInteraction(state, 'expired', input.now), changed: true };
  return { state: { status: 'answered', request: state.request, answer, responseId: input.responseId, answeredAt: input.now }, changed: true };
}

export function closeInteraction(state: InteractionState, reason: InteractionClosure, now: number): InteractionState {
  clock(now);
  if (now < state.request.createdAt || !['expired', 'stopped', 'disconnected', 'revoked', 'restarted'].includes(reason)
    || (reason === 'expired' && now < state.request.expiresAt)) throw new InteractionConflict('invalid');
  return state.status === 'pending' ? { status: 'closed', request: state.request, reason, closedAt: now } : state;
}
