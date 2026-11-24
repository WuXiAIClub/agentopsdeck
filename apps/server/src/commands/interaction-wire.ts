import { readInteractionAnswer, readInteractionRequest, type InteractionAnswer } from '@agentopsdeck/shared';
import type { InteractionQuestion } from './interaction-runtime.js';

export type InteractionWireIdentity = { executionId: string; epoch: string; requestId: string };
export type InteractionWorkerFrame = InteractionWireIdentity & (
  | { kind: 'interaction-request'; question: InteractionQuestion }
  | { kind: 'interaction-ack' }
  | { kind: 'interaction-cancelled' }
);
export type InteractionParentFrame = InteractionWireIdentity & (
  | { kind: 'interaction-answer'; answer: InteractionAnswer }
  | { kind: 'interaction-cancel' }
);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v);
export function validInteractionQuestion(value: unknown): value is InteractionQuestion {
  if (!record(value) || Object.keys(value).some(k => !['kind', 'prompt', 'options', 'allowFreeform'].includes(k))) return false;
  return !!readInteractionRequest({ ...value, version: 1, ownerId: 'owner', nodeId: 'node', sessionKey: 'session', runId: 'run',
    requestId: 'request', createdAt: 0, expiresAt: 1 });
}
export function wireAnswer(question: InteractionQuestion, value: unknown) {
  const request = readInteractionRequest({ ...question, version: 1, ownerId: 'owner', nodeId: 'node', sessionKey: 'session', runId: 'run',
    requestId: 'request', createdAt: 0, expiresAt: 1 });
  return request ? readInteractionAnswer(request, value) : undefined;
}
export function readInteractionFrame(value: unknown, direction: 'worker'): InteractionWorkerFrame | undefined;
export function readInteractionFrame(value: unknown, direction: 'parent'): InteractionParentFrame | undefined;
export function readInteractionFrame(value: unknown, direction: 'worker' | 'parent'): InteractionWorkerFrame | InteractionParentFrame | undefined {
  if (!record(value) || !id(value.executionId) || !id(value.epoch) || !id(value.requestId)) return;
  const extra = value.kind === 'interaction-request' ? 'question' : value.kind === 'interaction-answer' ? 'answer' : undefined;
  if (Object.keys(value).some(k => !['kind', 'executionId', 'epoch', 'requestId', extra].includes(k))) return;
  if (direction === 'worker' && (value.kind === 'interaction-ack' || value.kind === 'interaction-cancelled'
    || value.kind === 'interaction-request' && validInteractionQuestion(value.question))) return structuredClone(value) as InteractionWorkerFrame;
  if (direction === 'parent' && (value.kind === 'interaction-cancel' || value.kind === 'interaction-answer' && record(value.answer))) {
    // Full answer validation requires the private pending request; do not trust this cast.
    return structuredClone(value) as InteractionParentFrame;
  }
}
