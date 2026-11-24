import { sessionRuntimeId, readInteractionRequest, readInteractionSubmission, readInteractionView, readInteractionAnswer, type InteractionMode } from '@agentopsdeck/shared';
import { InteractionConflict, type InteractionClosure } from '../commands/agent-interaction.js';
import { InteractionDeliveryConflict } from '../commands/interaction-continuation.js';
import { interactionView, type InteractionQuestion, type InteractionView } from '../commands/interaction-runtime.js';
import type { StoredInteraction } from '../commands/interaction-store.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { executeConnectorSdkDispatch, originalSdkInteractionBinding } from './connector-sdk-dispatch-domain.js';
import type { SdkAgentId, SdkCompactRef } from './sdk-execution-journal.js';
import { interactionCapabilitiesFor } from './sdk-interaction.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';

type Bound = { runtime: SdkAgentId; ref: SdkCompactRef; bindingId: string };
type Http = { runtime: SdkAgentId; key: string; authorization: string };
type Submission = NonNullable<ReturnType<typeof readInteractionSubmission>>;
export type SdkInteractionResult<T> = { ok: true; value: T } | { ok: false; error: 401 | 403 | 404 | 409 | 503 };
type Result<T> = { output: SdkInteractionResult<T> };
export type ConnectorSdkInteractionCommands = {
  sdkInteractionOpen: Result<StoredInteraction> & { input: Bound & { requestId: string; question: InteractionQuestion; ttlMs: number } };
  sdkInteractionObserve: Result<{ mode: InteractionMode; requests: InteractionView[] }> & { input: Http };
  sdkInteractionMode: Result<InteractionMode> & { input: Http & { mode: InteractionMode; nativeReady: true; application?: ApplicationTransactionEvidence } };
  sdkInteractionAnswer: Result<StoredInteraction> & { input: Http & { requestId: string; submission: Submission; binding?: Bound; application?: ApplicationTransactionEvidence } };
  sdkInteractionClaim: Result<StoredInteraction | null> & { input: Bound & { authorization: string; requestId: string; expectedRevision: number } };
  sdkInteractionDeliverable: Result<boolean> & { input: Bound & { authorization: string; requestId: string; claimId: string } };
  sdkInteractionSettle: Result<StoredInteraction> & { input: Bound & { requestId: string; claimId: string; outcome: 'confirmed' | 'unknown' } };
  sdkInteractionClose: Result<null> & { input: Bound & { reason: InteractionClosure; requestId?: string } };
  sdkInteractionRetire: Result<null> & { input: Bound & { nativeEnded: true } };
};
export type ConnectorSdkInteractionKind = keyof ConnectorSdkInteractionCommands;
export const connectorSdkInteractionSteps = Object.freeze({ sdkInteractionOpen: 117, sdkInteractionObserve: 118,
  sdkInteractionMode: 119, sdkInteractionAnswer: 120, sdkInteractionClaim: 121, sdkInteractionDeliverable: 122,
  sdkInteractionSettle: 123, sdkInteractionClose: 124, sdkInteractionRetire: 125 });
export const isConnectorSdkInteractionKind = (kind: string): kind is ConnectorSdkInteractionKind => Object.hasOwn(connectorSdkInteractionSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const sdk = (v: unknown): v is SdkAgentId => v === 'claude-code' || v === 'ghcp';
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 1;
const http = (v: Record<string, unknown>) => sdk(v.runtime) && id(v.key) && sessionRuntimeId(v.key) === v.runtime
  && typeof v.authorization === 'string' && v.authorization.length <= 4096;
const bound = (v: unknown): v is Bound => fields(v, ['runtime', 'ref', 'bindingId']) && sdk(v.runtime) && id(v.bindingId)
  && fields(v.ref, ['key', 'id', 'epoch', 'nativeSessionId']) && Object.values(v.ref).every(id)
  && sessionRuntimeId(v.ref.key as string) === v.runtime;
const hasBound = (v: Record<string, unknown>) => bound({ runtime: v.runtime, ref: v.ref, bindingId: v.bindingId });
const closure = (v: unknown) => ['expired', 'stopped', 'disconnected', 'revoked', 'restarted'].includes(String(v));
export function validConnectorSdkInteractionInput(kind: ConnectorSdkInteractionKind, v: unknown): boolean {
  if (kind === 'sdkInteractionObserve') return fields(v, ['runtime', 'key', 'authorization']) && http(v);
  if (kind === 'sdkInteractionMode') return fields(v, ['runtime', 'key', 'authorization', 'mode', 'nativeReady'], ['application']) && http(v)
    && (v.mode === 'automatic' || v.mode === 'interactive') && v.nativeReady === true && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application));
  if (kind === 'sdkInteractionAnswer') return fields(v, ['runtime', 'key', 'authorization', 'requestId', 'submission'], ['binding', 'application']) && http(v)
    && id(v.requestId) && !!readInteractionSubmission(v.submission) && (!Object.hasOwn(v, 'binding') || bound(v.binding))
    && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application));
  const keys = ['runtime', 'ref', 'bindingId'];
  if (kind === 'sdkInteractionOpen') return fields(v, [...keys, 'requestId', 'question', 'ttlMs']) && hasBound(v) && id(v.requestId)
    && integer(v.ttlMs) && Number(v.ttlMs) <= 600_000 && fields(v.question, ['kind', 'prompt'], ['options', 'allowFreeform'])
    && !!readInteractionRequest({ ...v.question, version: 1, ownerId: 'owner', nodeId: 'node', sessionKey: 'session', runId: 'run',
      requestId: v.requestId, createdAt: 0, expiresAt: 1 });
  if (kind === 'sdkInteractionClose') return fields(v, [...keys, 'reason'], ['requestId']) && hasBound(v) && closure(v.reason)
    && (!Object.hasOwn(v, 'requestId') || id(v.requestId));
  if (kind === 'sdkInteractionRetire') return fields(v, [...keys, 'nativeEnded']) && hasBound(v) && v.nativeEnded === true;
  if (kind === 'sdkInteractionClaim') return fields(v, [...keys, 'authorization', 'requestId', 'expectedRevision']) && hasBound(v)
    && typeof v.authorization === 'string' && v.authorization.length <= 4096 && id(v.requestId) && integer(v.expectedRevision);
  if (kind === 'sdkInteractionDeliverable') return fields(v, [...keys, 'authorization', 'requestId', 'claimId']) && hasBound(v)
    && typeof v.authorization === 'string' && v.authorization.length <= 4096 && id(v.requestId) && id(v.claimId);
  return fields(v, [...keys, 'requestId', 'claimId', 'outcome']) && hasBound(v) && id(v.requestId) && id(v.claimId)
    && (v.outcome === 'confirmed' || v.outcome === 'unknown');
}
const fact = (v: unknown): v is StoredInteraction => fields(v, ['revision', 'state', 'delivery', 'continuationHash', 'updatedAt'], ['claimId', 'retiredAt'])
  && integer(v.revision) && typeof v.continuationHash === 'string' && /^[a-f0-9]{64}$/.test(v.continuationHash)
  && fields(v.state, ['status', 'request'], ['answer', 'responseId', 'answeredAt', 'reason', 'closedAt']) && !!readInteractionRequest(v.state.request)
  && ['pending', 'answered', 'closed'].includes(String(v.state.status))
  && ['none', 'queued', 'claimed', 'confirmed', 'unknown', 'cancelled'].includes(String(v.delivery))
  && Number.isSafeInteger(v.updatedAt) && Number(v.updatedAt) >= 0 && (!Object.hasOwn(v, 'claimId') || id(v.claimId))
  && (!Object.hasOwn(v, 'retiredAt') || Number.isSafeInteger(v.retiredAt) && Number(v.retiredAt) >= 0)
  && !!readInteractionView({ request: v.state.request, revision: v.revision, status: v.state.status, delivery: v.delivery,
    ...(v.state.status === 'closed' ? { reason: v.state.reason } : {}) })
  && (v.state.status !== 'answered' || !!readInteractionAnswer(readInteractionRequest(v.state.request)!, v.state.answer)
    && id(v.state.responseId) && Number.isSafeInteger(v.state.answeredAt))
  && (v.state.status !== 'closed' || Number.isSafeInteger(v.state.closedAt))
  && (!['claimed', 'confirmed', 'unknown'].includes(String(v.delivery)) || id(v.claimId));
export { fact as validStoredInteraction };
export function validConnectorSdkInteractionOutput(kind: ConnectorSdkInteractionKind, v: unknown): boolean {
  if (fields(v, ['ok', 'error'])) return v.ok === false && [401, 403, 404, 409, 503].includes(Number(v.error));
  if (!fields(v, ['ok', 'value']) || v.ok !== true) return false;
  if (kind === 'sdkInteractionObserve') return fields(v.value, ['mode', 'requests']) && ['automatic', 'interactive'].includes(String(v.value.mode))
    && Array.isArray(v.value.requests) && v.value.requests.length <= 64 && v.value.requests.every(item => !!readInteractionView(item));
  if (kind === 'sdkInteractionMode') return v.value === 'automatic' || v.value === 'interactive';
  if (kind === 'sdkInteractionDeliverable') return typeof v.value === 'boolean';
  if (kind === 'sdkInteractionClose' || kind === 'sdkInteractionRetire') return v.value === null;
  return kind === 'sdkInteractionClaim' && v.value === null || fact(v.value);
}
class Reject extends Error { constructor(readonly status: 401 | 403 | 404 | 409 | 503) { super(); } }

/** Every SQL operation stays in the owner worker. No native/HTTP callback enters
 * a transaction; a claim is durable before any original handle can be invoked. */
export function executeConnectorSdkInteraction<K extends ConnectorSdkInteractionKind>(kind: K,
  input: ConnectorSdkInteractionCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore): ConnectorSdkInteractionCommands[K]['output'] {
  if (!validConnectorSdkInteractionInput(kind, input)) throw Error('connector_storage_unavailable');
  const v = input as ConnectorSdkInteractionCommands[ConnectorSdkInteractionKind]['input'];
  const authorize = (authorization: string, write: boolean, ownerId?: string) => {
    const actor = tokens?.authenticateAuthorization(authorization);
    if (!actor) throw new Reject(401);
    if (actor.tokenId.startsWith('actor_') || actor.scopes.includes('execution:delegate') || !actor.scopes.includes('messages:read')
      || write && !actor.scopes.includes('messages:send') || ownerId && actor.tokenId !== ownerId) throw new Reject(403);
    return actor.tokenId;
  };
  const binding = (b: Bound, current = false) => {
    const original = originalSdkInteractionBinding(owner, b.runtime, b.ref, b.bindingId);
    if (!original || current && executeConnectorSdkDispatch('sdkInteractionCheck', {
      runtime: b.runtime, ref: b.ref, bindingId: b.bindingId,
    }, owner, tokens) !== true) throw new Reject(409);
    return original;
  };
  const continuation = (b: Bound) => ({ connectionId: b.ref.epoch, goal: { status: 'absent' as const, version: `${b.runtime}:no-native-goal:v1` } });
  const now = Date.now();
  try {
    let result: unknown;
    if ('key' in v) {
      const write = kind !== 'sdkInteractionObserve', ownerId = authorize(v.authorization, write);
      const journal = v.runtime === 'claude-code' ? owner.claudeJournal : owner.copilotJournal;
      if (!journal.session(v.key) || journal.deletion(v.key) || owner.commands.sessionDeletion(v.key)) throw new Reject(404);
      const scope = { ownerId, nodeId: owner.nodeId, sessionKey: v.key };
      if (kind === 'sdkInteractionObserve') result = { mode: owner.interactions.mode(scope), requests: owner.interactions.list(scope).map(interactionView) };
      else if ('mode' in v) {
        if (!owner.sdkCommandAdmissionOpen) throw new Reject(503);
        owner.interactions.setMode(scope, v.mode); result = v.mode;
      } else if ('submission' in v) {
        const requestScope = { ...scope, runId: v.submission.runId }, prior = owner.interactions.get(requestScope, v.requestId);
        if (!prior) throw new Reject(404);
        if (prior.state.status !== 'answered') {
          if (!v.binding) throw new Reject(409);
          const original = binding(v.binding, true);
          if (original.scope.ownerId !== ownerId || original.scope.sessionKey !== v.key || original.scope.runId !== v.submission.runId
            || v.binding.runtime !== v.runtime) throw new Reject(403);
        }
        result = owner.interactions.answer({ ...v.submission, scope: requestScope, requestId: v.requestId,
          continuation: v.binding ? continuation(v.binding) : { connectionId: '', goal: { status: 'unknown', version: '' } },
          permissionAllowed: true, now });
      }
    } else {
      const active = kind === 'sdkInteractionOpen' || kind === 'sdkInteractionClaim' || kind === 'sdkInteractionDeliverable';
      const original = binding(v, active), scope = original.scope;
      if ('authorization' in v) authorize(v.authorization, true, scope.ownerId);
      if (kind === 'sdkInteractionOpen' && 'question' in v) result = owner.interactions.create({ ...v.question, ...scope,
        requestId: v.requestId, version: 1, createdAt: now, expiresAt: now + v.ttlMs }, interactionCapabilitiesFor(v.runtime), scope, continuation(v), now);
      else if (kind === 'sdkInteractionClaim' && 'expectedRevision' in v) result = owner.interactions.claim({ scope, requestId: v.requestId,
        expectedRevision: v.expectedRevision, continuation: continuation(v), permissionAllowed: true, now }) ?? null;
      else if (kind === 'sdkInteractionDeliverable' && 'claimId' in v) {
        const prior = owner.interactions.get(scope, v.requestId);
        result = prior?.claimId === v.claimId && prior.delivery === 'claimed' && now < prior.state.request.expiresAt;
      } else if (kind === 'sdkInteractionSettle' && 'outcome' in v) {
        const prior = owner.interactions.get(scope, v.requestId);
        if (!prior || prior.claimId !== v.claimId) throw new Reject(409);
        // Stop/restart won the race: return original uncertainty, never revive.
        result = prior.delivery === 'claimed' ? owner.interactions.settle(scope, v.requestId, v.claimId, v.outcome, now) : prior;
      } else if ('reason' in v) {
        if (v.requestId) owner.interactions.closeRequest(scope, v.requestId, v.reason, now);
        else owner.interactions.closeRun(scope, v.reason, now);
        result = null;
      } else if ('nativeEnded' in v) {
        owner.interactions.closeRun(scope, 'stopped', now); owner.interactions.retireRun(scope, now); result = null;
      }
    }
    const output = { ok: true, value: result };
    if (!validConnectorSdkInteractionOutput(kind, output)) throw Error('connector_storage_unavailable');
    return output as ConnectorSdkInteractionCommands[K]['output'];
  } catch (error) {
    if (error instanceof Reject) return { ok: false, error: error.status };
    if (error instanceof InteractionConflict || error instanceof InteractionDeliveryConflict) return { ok: false, error: error.code === 'permission' ? 403 : 409 };
    throw error;
  }
}
