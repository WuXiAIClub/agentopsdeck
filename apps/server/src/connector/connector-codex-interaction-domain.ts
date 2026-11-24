import { randomUUID } from 'node:crypto';
import { readInteractionRequest, readInteractionSubmission, readInteractionView, type InteractionMode, type InteractionScope } from '@agentopsdeck/shared';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { codexAdmissionMatches } from '../codex/dispatch-admission.js';
import { validCodexQueuePayload, type CodexQueuePayload } from './connector-codex-queue-plan-domain.js';
import { createTurnAuthorizer } from './execution-grants.js';
import { validConnectorCodexDispatchInput, type ConnectorCodexDispatchCommands } from './connector-codex-dispatch-domain.js';
import { validStoredInteraction, type SdkInteractionResult } from './connector-sdk-interaction-domain.js';
import { InteractionConflict, type InteractionClosure } from '../commands/agent-interaction.js';
import { continuationFingerprint, InteractionDeliveryConflict, type InteractionContinuation } from '../commands/interaction-continuation.js';
import { interactionView, type InteractionQuestion, type InteractionView } from '../commands/interaction-runtime.js';
import type { StoredInteraction } from '../commands/interaction-store.js';
import { interactionCapabilitiesFor } from './sdk-interaction.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';

export type CodexInteractionRef = { sessionKey: string; commandId: string; connectionId: string; bindingId: string };
export type CodexInteractionBinding = { ref: CodexInteractionRef; scope: Omit<InteractionScope, 'runId'> };
type Bound = CodexInteractionRef & { runId: string };
type Evidence = Bound & { continuation: InteractionContinuation };
type Http = { key: string; authorization: string };
type Submission = NonNullable<ReturnType<typeof readInteractionSubmission>>;
type Result<T> = { output: SdkInteractionResult<T> };
export type ConnectorCodexInteractionCommands = {
  codexInteractionBind: Result<{ mode: 'automatic' } | { mode: 'interactive'; binding: CodexInteractionBinding }> & {
    input: ConnectorCodexDispatchCommands['codexDispatchReady']['input'] };
  codexInteractionCheck: Result<boolean> & { input: CodexInteractionRef };
  codexInteractionRelease: Result<null> & { input: CodexInteractionRef };
  codexInteractionObserve: Result<{ mode: InteractionMode; requests: InteractionView[] }> & { input: Http };
  codexInteractionMode: Result<InteractionMode> & { input: Http & { mode: InteractionMode; nativeReady: true; application?: ApplicationTransactionEvidence } };
  codexInteractionOpen: Result<StoredInteraction> & { input: Evidence & { requestId: string; question: InteractionQuestion; ttlMs: number } };
  codexInteractionAnswer: Result<StoredInteraction> & { input: Http & { requestId: string; submission: Submission; binding?: Evidence; application?: ApplicationTransactionEvidence } };
  codexInteractionClaim: Result<StoredInteraction | null> & { input: Evidence & { authorization: string; requestId: string; expectedRevision: number } };
  codexInteractionDeliverable: Result<boolean> & { input: Evidence & { authorization: string; requestId: string; claimId: string } };
  codexInteractionSettle: Result<StoredInteraction> & { input: Bound & { requestId: string; claimId: string; outcome: 'confirmed' | 'unknown' } };
  codexInteractionClose: Result<null> & { input: Bound & { reason: InteractionClosure; requestId?: string } };
  codexInteractionRetire: Result<null> & { input: Bound & { nativeEnded: true } };
};
export type ConnectorCodexInteractionKind = keyof ConnectorCodexInteractionCommands;
export const connectorCodexInteractionSteps = Object.freeze({ codexInteractionBind: 260, codexInteractionCheck: 261,
  codexInteractionRelease: 262, codexInteractionObserve: 263, codexInteractionMode: 264, codexInteractionOpen: 265,
  codexInteractionAnswer: 266, codexInteractionClaim: 267, codexInteractionDeliverable: 268, codexInteractionSettle: 269,
  codexInteractionClose: 270, codexInteractionRetire: 271 });
export const isConnectorCodexInteractionKind = (kind: string): kind is ConnectorCodexInteractionKind => Object.hasOwn(connectorCodexInteractionSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, any> => !!v && typeof v === 'object'
  && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => id(v) && v.startsWith('codex:') && v.length > 6;
const auth = (v: unknown) => typeof v === 'string' && v.length <= 4096;
const refKeys = ['sessionKey', 'commandId', 'connectionId', 'bindingId'];
const ref = (v: unknown): v is CodexInteractionRef => fields(v, refKeys) && key(v.sessionKey)
  && refKeys.slice(1).every(k => id(v[k]));
const hasRef = (v: Record<string, any>) => ref(Object.fromEntries(refKeys.map(k => [k, v[k]])));
const boundKeys = [...refKeys, 'runId'];
const evidenceKeys = [...boundKeys, 'continuation'];
const evidence = (v: unknown): v is Evidence => {
  if (!fields(v, evidenceKeys) || !hasRef(v) || !id(v.runId) || !fields(v.continuation, ['connectionId', 'goal'])
    || !fields(v.continuation.goal, ['status', 'version']) || v.continuation.connectionId !== v.connectionId) return false;
  try { continuationFingerprint(v.continuation as InteractionContinuation); return true; } catch { return false; }
};
const hasEvidence = (v: Record<string, any>) => evidence(Object.fromEntries(evidenceKeys.map(k => [k, v[k]])));
const http = (v: Record<string, any>) => key(v.key) && auth(v.authorization);
export function validConnectorCodexInteractionInput(kind: ConnectorCodexInteractionKind, v: unknown): boolean {
  if (kind === 'codexInteractionBind') return validConnectorCodexDispatchInput('codexDispatchReady', v);
  if (kind === 'codexInteractionCheck' || kind === 'codexInteractionRelease') return ref(v);
  if (kind === 'codexInteractionObserve') return fields(v, ['key', 'authorization']) && http(v);
  if (kind === 'codexInteractionMode') return fields(v, ['key', 'authorization', 'mode', 'nativeReady'], ['application']) && http(v)
    && ['automatic', 'interactive'].includes(v.mode) && v.nativeReady === true && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application));
  if (kind === 'codexInteractionAnswer') return fields(v, ['key', 'authorization', 'requestId', 'submission'], ['binding', 'application']) && http(v)
    && id(v.requestId) && !!readInteractionSubmission(v.submission) && (!Object.hasOwn(v, 'binding') || evidence(v.binding))
    && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application));
  if (kind === 'codexInteractionOpen') return fields(v, [...evidenceKeys, 'requestId', 'question', 'ttlMs']) && hasEvidence(v)
    && id(v.requestId) && Number.isSafeInteger(v.ttlMs) && v.ttlMs > 0 && v.ttlMs <= 600_000
    && fields(v.question, ['kind', 'prompt'], ['options', 'allowFreeform']) && !!readInteractionRequest({ ...v.question,
      version: 1, ownerId: 'o', nodeId: 'n', sessionKey: 's', runId: 'r', requestId: v.requestId, createdAt: 0, expiresAt: 1 });
  if (kind === 'codexInteractionClaim') return fields(v, [...evidenceKeys, 'authorization', 'requestId', 'expectedRevision']) && hasEvidence(v)
    && auth(v.authorization) && id(v.requestId) && Number.isSafeInteger(v.expectedRevision) && v.expectedRevision > 0;
  if (kind === 'codexInteractionDeliverable') return fields(v, [...evidenceKeys, 'authorization', 'requestId', 'claimId']) && hasEvidence(v)
    && auth(v.authorization) && id(v.requestId) && id(v.claimId);
  if (!fields(v, [...boundKeys, ...(kind === 'codexInteractionSettle' ? ['requestId', 'claimId', 'outcome']
    : kind === 'codexInteractionRetire' ? ['nativeEnded'] : ['reason'])], kind === 'codexInteractionClose' ? ['requestId'] : [])
    || !hasRef(v) || !id(v.runId)) return false;
  if (kind === 'codexInteractionSettle') return id(v.requestId) && id(v.claimId) && ['confirmed', 'unknown'].includes(v.outcome);
  if (kind === 'codexInteractionRetire') return v.nativeEnded === true;
  return ['expired', 'stopped', 'disconnected', 'revoked', 'restarted'].includes(v.reason) && (v.requestId === undefined || id(v.requestId));
}
export function validConnectorCodexInteractionOutput(kind: ConnectorCodexInteractionKind, v: unknown): boolean {
  if (fields(v, ['ok', 'error'])) return v.ok === false && [401, 403, 404, 409, 503].includes(v.error);
  if (!fields(v, ['ok', 'value']) || v.ok !== true) return false;
  if (kind === 'codexInteractionBind') return fields(v.value, ['mode']) && v.value.mode === 'automatic'
    || fields(v.value, ['mode', 'binding']) && v.value.mode === 'interactive' && fields(v.value.binding, ['ref', 'scope'])
    && ref(v.value.binding.ref) && fields(v.value.binding.scope, ['ownerId', 'nodeId', 'sessionKey'])
    && Object.values(v.value.binding.scope).every(id) && v.value.binding.scope.sessionKey === v.value.binding.ref.sessionKey;
  if (kind === 'codexInteractionCheck' || kind === 'codexInteractionDeliverable') return typeof v.value === 'boolean';
  if (kind === 'codexInteractionMode') return v.value === 'automatic' || v.value === 'interactive';
  if (kind === 'codexInteractionObserve') return fields(v.value, ['mode', 'requests']) && ['automatic', 'interactive'].includes(v.value.mode)
    && Array.isArray(v.value.requests) && v.value.requests.length <= 64 && v.value.requests.every((r: unknown) => !!readInteractionView(r));
  if (['codexInteractionRelease', 'codexInteractionClose', 'codexInteractionRetire'].includes(kind)) return v.value === null;
  return kind === 'codexInteractionClaim' && v.value === null || validStoredInteraction(v.value);
}
class Reject extends Error { constructor(readonly status: 401 | 403 | 404 | 409 | 503) { super('Original Codex interaction unavailable'); } }
type Original = { binding: CodexInteractionBinding; startedAt: number };
/** Random capabilities exist in this physical worker only. Native Goal evidence
 * enters from the original in-process bridge, never from an HTTP submission. */
export function createConnectorCodexInteractionCommands(owner: ConnectorUserStore, tokens?: ConnectorTokenStore) {
  const bindings = new Map<string, Original>();
  const allowed = (actor: string) => tokens?.hasScope(actor, 'messages:send') === true;
  const authorizeTurn = createTurnAuthorizer(owner.executionGrants, (actor, scope) => tokens?.hasScope(actor, scope) === true);
  const original = (v: CodexInteractionRef, current = false) => {
    const b = bindings.get(v.bindingId);
    if (!b || refKeys.some(k => b.binding.ref[k as keyof CodexInteractionRef] !== v[k as keyof CodexInteractionRef])) throw new Reject(409);
    if (current) {
      const f = owner.codexExecutions.get(v.sessionKey);
      if (!owner.sdkCommandAdmissionOpen || owner.commands.sessionDeletion(v.sessionKey) || owner.codexExecutions.isDeletedTerminal(v.sessionKey)
        || !allowed(b.binding.scope.ownerId) || !f || f.commandId !== v.commandId || f.connectionId !== v.connectionId
        || f.startedAt !== b.startedAt || !['running', 'completed'].includes(f.phase) || f.reason || f.preparation) throw new Reject(409);
    }
    return b;
  };
  const authorize = (authorization: string, write: boolean, ownerId?: string) => {
    const actor = tokens?.authenticateAuthorization(authorization);
    if (!actor) throw new Reject(401);
    if (actor.tokenId.startsWith('actor_') || actor.scopes.includes('execution:delegate') || !actor.scopes.includes('messages:read')
      || write && !actor.scopes.includes('messages:send') || ownerId && actor.tokenId !== ownerId) throw new Reject(403);
    return actor.tokenId;
  };
  const execute = <K extends ConnectorCodexInteractionKind>(kind: K, input: ConnectorCodexInteractionCommands[K]['input']): ConnectorCodexInteractionCommands[K]['output'] => {
    if (!validConnectorCodexInteractionInput(kind, input) || !tokens) throw Error('connector_storage_unavailable');
    const v = input as any, now = Date.now(); let value: unknown;
    try {
      if (kind === 'codexInteractionBind') {
        const f = owner.codexExecutions.get(v.sessionKey);
        const entries = codexAdmissionMatches<CodexQueuePayload>(owner.turns, v.sessionKey, v.proof,
          e => validCodexQueuePayload(e.payload) && !!authorizeTurn(e.payload.actorId, { runtime: 'codex', sessionKey: e.sessionKey }, 'messages:send', e.payload.executionGrant), 'dispatching');
        const members = f?.batch?.members.map(m => m.id) ?? [v.commandId];
        if (!owner.sdkCommandAdmissionOpen || owner.commands.sessionDeletion(v.sessionKey) || owner.codexExecutions.isDeletedTerminal(v.sessionKey)
          || !f || f.commandId !== v.commandId || f.connectionId !== v.connectionId || f.phase !== 'starting'
          || f.runId || f.reason || f.preparation || !entries || entries[0]?.id !== v.commandId
          || JSON.stringify(entries.map(e => e.id)) !== JSON.stringify(members)) throw new Reject(409);
        const payload = entries[0]!.payload, scope = { ownerId: payload.actorId ?? '', nodeId: owner.nodeId, sessionKey: v.sessionKey };
        const mode = payload.actorId ? owner.interactions.mode(scope) : 'automatic';
        if (mode === 'automatic') value = { mode };
        else {
          if (payload.executionGrant || !payload.actorId || bindings.size >= 128 || [...bindings.values()].some(b => b.binding.ref.sessionKey === v.sessionKey)) throw new Reject(409);
          const binding: CodexInteractionBinding = { ref: { sessionKey: v.sessionKey, commandId: v.commandId, connectionId: v.connectionId, bindingId: randomUUID() }, scope };
          bindings.set(binding.ref.bindingId, { binding, startedAt: f.startedAt }); value = { mode, binding: structuredClone(binding) };
        }
      } else if ('key' in v) {
        const ownerId = authorize(v.authorization, kind !== 'codexInteractionObserve');
        if (owner.commands.sessionDeletion(v.key) || owner.codexExecutions.isDeletedTerminal(v.key)) throw new Reject(404);
        const scope = { ownerId, nodeId: owner.nodeId, sessionKey: v.key };
        if (kind === 'codexInteractionObserve') value = { mode: owner.interactions.mode(scope), requests: owner.interactions.list(scope).map(interactionView) };
        else if (kind === 'codexInteractionMode') {
          if (!owner.sdkCommandAdmissionOpen) throw new Reject(503);
          owner.interactions.setMode(scope, v.mode); value = v.mode;
        } else {
          const requestScope = { ...scope, runId: v.submission.runId }, prior = owner.interactions.get(requestScope, v.requestId);
          if (!prior) throw new Reject(404);
          if (prior.state.status !== 'answered') {
            if (!v.binding) throw new Reject(409);
            const b = original(v.binding, true);
            if (b.binding.scope.ownerId !== ownerId || v.binding.sessionKey !== v.key || v.binding.runId !== v.submission.runId) throw new Reject(403);
          }
          value = owner.interactions.answer({ ...v.submission, scope: requestScope, requestId: v.requestId,
            continuation: v.binding?.continuation ?? { connectionId: '', goal: { status: 'unknown', version: '' } }, permissionAllowed: true, now });
        }
      } else {
        const b = original(v, ['codexInteractionCheck', 'codexInteractionOpen', 'codexInteractionClaim', 'codexInteractionDeliverable'].includes(kind));
        if (kind === 'codexInteractionCheck') value = true;
        else if (kind === 'codexInteractionRelease') { bindings.delete(v.bindingId); value = null; }
        else {
          const scope = { ...b.binding.scope, runId: v.runId };
          if ('authorization' in v) authorize(v.authorization, true, scope.ownerId);
          if (kind === 'codexInteractionOpen') value = owner.interactions.create({ ...v.question, ...scope, version: 1,
            requestId: v.requestId, createdAt: now, expiresAt: now + v.ttlMs }, interactionCapabilitiesFor('codex'), scope, v.continuation, now);
          else if (kind === 'codexInteractionClaim') value = owner.interactions.claim({ scope, requestId: v.requestId,
            expectedRevision: v.expectedRevision, continuation: v.continuation, permissionAllowed: true, now }) ?? null;
          else if (kind === 'codexInteractionDeliverable') {
            const prior = owner.interactions.get(scope, v.requestId);
            value = !!prior && prior.claimId === v.claimId && prior.delivery === 'claimed' && now < prior.state.request.expiresAt
              && prior.continuationHash === continuationFingerprint(v.continuation);
          } else if (kind === 'codexInteractionSettle') {
            const prior = owner.interactions.get(scope, v.requestId);
            if (!prior || prior.claimId !== v.claimId) throw new Reject(409);
            value = prior.delivery === 'claimed' ? owner.interactions.settle(scope, v.requestId, v.claimId, v.outcome, now) : prior;
          } else if (kind === 'codexInteractionRetire') { owner.interactions.closeRun(scope, 'stopped', now); owner.interactions.retireRun(scope, now); value = null; }
          else { if (v.requestId) owner.interactions.closeRequest(scope, v.requestId, v.reason, now); else owner.interactions.closeRun(scope, v.reason, now); value = null; }
        }
      }
      const result = { ok: true as const, value };
      if (!validConnectorCodexInteractionOutput(kind, result)) throw Error('connector_storage_unavailable');
      return result as ConnectorCodexInteractionCommands[K]['output'];
    } catch (error) {
      if (error instanceof Reject) return { ok: false, error: error.status };
      if (error instanceof InteractionConflict || error instanceof InteractionDeliveryConflict) return { ok: false, error: error.code === 'permission' ? 403 : 409 };
      throw error;
    }
  };
  return Object.assign(execute, { dispose() { bindings.clear(); } });
}
