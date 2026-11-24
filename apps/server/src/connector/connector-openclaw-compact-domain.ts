import { randomUUID } from 'node:crypto';
import { validApplicationTransactionEvidence, type OriginalTransactionWrite, type ApplicationTransactionClient, type ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import { RunControlConflict } from '../commands/run-control.js';
import { normalizeSendMessageRequest } from '../messages/send-message.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { resolveExecutionActor, EXECUTION_GRANT_HEADER } from './execution-authority.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { validConnectorOpenClawMessageInput, validConnectorOpenClawMessageOutput,
  type OpenClawMessageScope, type OpenClawMessageResult } from './connector-openclaw-message-domain.js';

type Operation = 'message' | 'compact';
type Scope = OpenClawMessageScope & { operation: Operation };
export type OpenClawCompactDisplay = { totalTokens: number | null; contextTokens: number | null };
export type OpenClawCompactIntent = { id: string; receiptId: string; key: string; commandKey: string;
  commandId: string; connectionId: string; revision: number; operation: Operation };
export type OpenClawCompactResult = OpenClawMessageResult & { projection: {
  id: string; text: string; createdAt: number; operation: Operation } | null };
type Failure = { error: 401 | 403 | 409 | 503 };
export type ConnectorOpenClawCompactCommands = {
  openClawCompactClaim: { input: Scope & { payloadJson: string; connectionId: string | null;
    veto: 'runtime_unavailable' | 'session_missing' | 'session_busy' | null; display: OpenClawCompactDisplay; application?: ApplicationTransactionEvidence };
    output: Failure | { result: OpenClawCompactResult; intent: OpenClawCompactIntent | null } };
  openClawCompactReady: { input: Scope & { intent: OpenClawCompactIntent }; output: boolean };
  openClawCompactSettle: { input: { intent: OpenClawCompactIntent; outcome: 'acknowledged' | 'not_dispatched' | 'unknown';
    runId: string | null; status: string | null }; output: OpenClawCompactResult | false };
  openClawCompactRelease: { input: { intent: OpenClawCompactIntent }; output: boolean };
  openClawCompactReceiptRead: { input: Scope & { purpose: 'read' | 'send' }; output: Failure | OpenClawCompactResult };
};
export type ConnectorOpenClawCompactKind = keyof ConnectorOpenClawCompactCommands;
export const connectorOpenClawCompactSteps = Object.freeze({ openClawCompactClaim: 208, openClawCompactReady: 209,
  openClawCompactSettle: 210, openClawCompactRelease: 211, openClawCompactReceiptRead: 212 });
export const isConnectorOpenClawCompactKind = (kind: string): kind is ConnectorOpenClawCompactKind => Object.hasOwn(connectorOpenClawCompactSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const operation = (v: unknown): v is Operation => v === 'message' || v === 'compact';
export const validOpenClawCompactIntent = (v: unknown): v is OpenClawCompactIntent => fields(v,
  ['id', 'receiptId', 'key', 'commandKey', 'commandId', 'connectionId', 'revision', 'operation'])
  && ['id', 'receiptId', 'commandId', 'connectionId'].every(k => id(v[k])) && operation(v.operation)
  && Number.isSafeInteger(v.revision) && Number(v.revision) > 0
  && validConnectorOpenClawMessageInput('openClawMessageReceiptRead', { key: v.key, commandKey: v.commandKey, authorization: 'intent-validation' });
export function validConnectorOpenClawCompactInput(kind: ConnectorOpenClawCompactKind, v: unknown): boolean {
  if (kind === 'openClawCompactRelease') return fields(v, ['intent']) && validOpenClawCompactIntent(v.intent);
  if (kind === 'openClawCompactSettle') return fields(v, ['intent', 'outcome', 'runId', 'status']) && validOpenClawCompactIntent(v.intent)
    && (v.outcome === 'acknowledged' ? id(v.runId) && (v.status === null || id(v.status, 128))
      : (v.outcome === 'unknown' || v.outcome === 'not_dispatched') && v.runId === null && v.status === null);
  const extra = kind === 'openClawCompactClaim' ? ['payloadJson', 'connectionId', 'veto', 'display']
    : kind === 'openClawCompactReady' ? ['intent'] : ['purpose'];
  if (!fields(v, ['key', 'authorization', 'commandKey', 'operation', ...extra], ['grantId', 'expectedNode',
    ...(kind === 'openClawCompactClaim' ? ['application'] : [])]) || !operation(v.operation)) return false;
  if (Object.hasOwn(v, 'application') && !validApplicationTransactionEvidence(v.application)) return false;
  const { operation: _operation, payloadJson, connectionId, veto, display, intent, purpose, application: _application, ...scope } = v;
  if (!validConnectorOpenClawMessageInput('openClawMessageReceiptRead', scope)) return false;
  if (kind === 'openClawCompactReady') return validOpenClawCompactIntent(intent) && intent.key === v.key
    && intent.commandKey === v.commandKey && intent.operation === v.operation;
  if (kind === 'openClawCompactReceiptRead') return purpose === 'read' || purpose === 'send';
  return validConnectorOpenClawMessageInput('openClawMessageClaim', { ...scope, payloadJson, defaultAgentId: 'main' })
    && (connectionId === null || id(connectionId)) && (veto === null || ['runtime_unavailable', 'session_missing', 'session_busy'].includes(String(veto)))
    && fields(display, ['totalTokens', 'contextTokens']) && Object.values(display).every(n => n === null || typeof n === 'number' && Number.isFinite(n) && n >= 0);
}
function validResult(v: unknown): v is OpenClawCompactResult {
  if (!v || typeof v !== 'object' || !Object.hasOwn(v, 'projection')) return false;
  const { projection, ...base } = v as OpenClawCompactResult;
  return validConnectorOpenClawMessageOutput('openClawMessageReceiptRead', base) && !('error' in base)
    && (projection === null || fields(projection, ['id', 'text', 'createdAt', 'operation']) && projection.id === base.receipt?.id
      && base.receipt?.state === 'accepted' && typeof projection.text === 'string' && Buffer.byteLength(projection.text) <= 1024
      && Number.isSafeInteger(projection.createdAt) && projection.createdAt >= 0 && operation(projection.operation));
}
export function validConnectorOpenClawCompactOutput(kind: ConnectorOpenClawCompactKind, v: unknown): boolean {
  if (kind === 'openClawCompactReady' || kind === 'openClawCompactRelease') return typeof v === 'boolean';
  if (kind === 'openClawCompactSettle') return v === false || validResult(v);
  if (fields(v, ['error'])) return typeof v.error === 'number' && [401, 403, 409, 503].includes(v.error);
  if (kind === 'openClawCompactReceiptRead') return validResult(v);
  return fields(v, ['result', 'intent']) && validResult(v.result) && (v.intent === null || validOpenClawCompactIntent(v.intent)
    && (v.result as OpenClawMessageResult).receipt?.id === v.intent.receiptId
    && (v.result as OpenClawMessageResult).receipt?.state === 'outcome_unknown'
    && (v.result as OpenClawMessageResult).key === v.intent.key && (v.result as OpenClawMessageResult).commandKey === v.intent.commandKey);
}
type Binding = { intent: OpenClawCompactIntent; scope: string; actor: string; token: string; dispatched: boolean; estimatedSkipReason?: string; applicationReady?: OriginalTransactionWrite };
const active = new WeakMap<ConnectorUserStore, Map<string, Binding>>();
export function disposeOpenClawCompactIntents(owner: ConnectorUserStore) { active.delete(owner); }
function currentActor(p: Scope, owner: ConnectorUserStore, tokens: ConnectorTokenStore, read = false) {
  const headers = new Headers({ authorization: p.authorization });
  if (p.grantId !== undefined) headers.set(EXECUTION_GRANT_HEADER, p.grantId);
  if (p.expectedNode !== undefined) {
    if (p.expectedNode !== owner.nodeId) throw new RunControlConflict();
    headers.set(EXPECTED_NODE_HEADER, p.expectedNode);
  }
  const a = resolveExecutionActor(new Request('http://connector.invalid', { headers }), { tokens, grants: owner.executionGrants, nodeId: owner.nodeId },
    { runtime: 'openclaw', sessionKey: p.key }, read ? undefined : 'messages:send');
  if (!a.principal.scopes.includes(read ? 'messages:read' : 'messages:send')) throw new RunControlConflict();
  return a;
}
const scopeFor = (p: Scope, actor: string) => p.operation === 'compact'
  ? JSON.stringify(['compact', JSON.stringify([actor, p.key])]) : JSON.stringify([actor, p.key]);
export async function executeConnectorOpenClawCompact<K extends ConnectorOpenClawCompactKind>(kind: K,
  request: ConnectorOpenClawCompactCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  applicationTransactions?: ApplicationTransactionClient): Promise<ConnectorOpenClawCompactCommands[K]['output']> {
  if (!validConnectorOpenClawCompactInput(kind, request)) throw Error('connector_storage_unavailable');
  const bindings = active.get(owner) ?? new Map<string, Binding>(); active.set(owner, bindings);
  const input = structuredClone(request);
  const result = (scope: string, key: string, commandKey: string): OpenClawCompactResult => {
    const receipt = owner.commands.get(scope, commandKey) ?? null, meta = owner.commands.binding(scope, commandKey);
    const projection = receipt?.state === 'accepted' && meta?.domain === 'openclaw-compact' && meta.commandId === receipt.id
      ? { id: receipt.id, text: meta.message as string, createdAt: meta.createdAt as number, operation: meta.operation as Operation } : null;
    return { key, commandKey, receipt, queue: { presence: 'unknown' }, intent: null, admitted: false, projection };
  };
  let value: unknown;
  if (kind === 'openClawCompactClaim' || kind === 'openClawCompactReceiptRead') {
    const p = input as ConnectorOpenClawCompactCommands['openClawCompactClaim']['input'] & { purpose?: 'read' | 'send' };
    if (!tokens?.authenticateAuthorization(p.authorization)) return { error: 401 } as ConnectorOpenClawCompactCommands[K]['output'];
    let actor: ReturnType<typeof currentActor>;
    try { actor = currentActor(p, owner, tokens, p.purpose === 'read'); } catch { return { error: 403 } as ConnectorOpenClawCompactCommands[K]['output']; }
    const scope = scopeFor(p, actor.actorId);
    if (kind === 'openClawCompactReceiptRead') value = result(scope, p.key, p.commandKey);
    else {
      const check = () => {
        try { const a = currentActor(p, owner, tokens); if (a.actorId === actor.actorId && a.principal.tokenId === actor.principal.tokenId
          && a.executionGrant?.id === actor.executionGrant?.id) return; } catch { /* current authority denied */ }
        throw new RunControlConflict();
      };
      let created: Binding | undefined;
      try {
        const transaction = applicationControlTransaction('openclaw', p, applicationTransactions);
        const body = JSON.parse(p.payloadJson);
        const claimed = await owner.commands.claimAsync(scope, p.commandKey, body, false, undefined,
          () => owner.sdkCommandAdmissionOpen && bindings.size < 128, receiptId => {
            const reject = (status: 400 | 404 | 409) => ({ metadata: { domain: 'openclaw-compact' }, complete: { status, body: { error: 'Command rejected' } } });
            const normalized = p.operation === 'message' ? normalizeSendMessageRequest(body)
              : Object.keys(body).length ? null : normalizeSendMessageRequest({ message: '/compact' });
            if (!normalized || 'error' in normalized) return reject(400);
            if (normalized.message.trim() !== '/compact' || normalized.deliveryMode === 'mirror' || actor.executionGrant) return reject(409);
            if (normalized.media.length) return reject(400);
            if (p.veto || !p.connectionId) return reject(p.veto === 'session_missing' ? 404 : 409);
            const previous = owner.openClawExecutions.get(p.key);
            if (owner.commands.sessionDeletion(p.key) || owner.commands.sessionSettingsPending(p.key)
              || owner.turns.hasPending('openclaw', p.key) || previous && (previous.reason || !['completed', 'failed'].includes(previous.phase))) return reject(409);
            if (!owner.openClawExecutions.beginInTransaction(p.key, receiptId, p.connectionId)) return reject(409);
            const { totalTokens: used, contextTokens: limit } = p.display;
            const estimatedSkipReason = used && limit && used / limit < 0.5
              ? `estimated context is below the compaction threshold (${Math.max(1, Math.round(used / limit * 100))}% used)` : undefined;
            created = { scope, actor: actor.actorId, token: actor.principal.tokenId, dispatched: false,
              ...(transaction ? { applicationReady: transaction.ready } : {}),
              ...(estimatedSkipReason ? { estimatedSkipReason } : {}),
              intent: { id: randomUUID(), receiptId, key: p.key, commandKey: p.commandKey, commandId: receiptId,
                connectionId: p.connectionId, revision: owner.openClawExecutions.get(p.key)!.revision!, operation: p.operation } };
            return { metadata: { domain: 'openclaw-compact', commandId: receiptId, message: '/compact', createdAt: Date.now(), operation: p.operation } };
          }, false, check, check, transaction?.claim);
        // The journal append shared the receipt transaction. Never publish an
        // uncommitted execution or reconstruct a capability from its SQL fact.
        if (created) owner.events.changes.notify();
        check();
        if (claimed.fresh && created && claimed.receipt.id === created.intent.receiptId && claimed.receipt.state === 'outcome_unknown') bindings.set(created.intent.receiptId, created);
        value = { result: result(scope, p.key, p.commandKey), intent: claimed.fresh && created && bindings.has(created.intent.receiptId) ? created.intent : null };
      } catch (error) {
        if (error instanceof CommandConflict) value = { error: 409 };
        else if (error instanceof CommandCapacity) value = { error: 503 };
        else if (error instanceof RunControlConflict) value = { error: 403 };
        else throw error;
      }
    }
  } else {
    const p = input as { intent: OpenClawCompactIntent; outcome?: 'acknowledged' | 'not_dispatched' | 'unknown'; runId?: string | null; status?: string | null } & Scope;
    const b = bindings.get(p.intent.receiptId);
    const matches = b && (Object.keys(b.intent) as (keyof OpenClawCompactIntent)[]).every(k => b.intent[k] === p.intent[k]);
    if (kind === 'openClawCompactRelease') value = !!matches && bindings.delete(p.intent.receiptId);
    else if (!matches || owner.commands.get(b.scope, b.intent.commandKey)?.id !== p.intent.receiptId
      || owner.commands.get(b.scope, b.intent.commandKey)?.state !== 'outcome_unknown') value = false;
    else {
      const fact = owner.openClawExecutions.get(b.intent.key);
      const original = fact?.commandId === b.intent.commandId && fact.gatewayConnectionId === b.intent.connectionId && fact.reason !== 'restarted';
      if (kind === 'openClawCompactReady') {
        const ready = () => {
          const fact = owner.openClawExecutions.get(b.intent.key);
          const original = fact?.commandId === b.intent.commandId && fact.gatewayConnectionId === b.intent.connectionId && fact.reason !== 'restarted';
          let permitted = false;
          try { if (tokens) { const a = currentActor(p, owner, tokens); permitted = a.actorId === b.actor && a.principal.tokenId === b.token && !a.executionGrant; } } catch { /* veto */ }
          const allowed = !b.dispatched && permitted && owner.sdkCommandAdmissionOpen && original && fact.revision === b.intent.revision
            && fact.phase === 'starting' && !fact.reason && !fact.runId && !owner.commands.sessionDeletion(p.key)
            && !owner.commands.sessionSettingsPending(p.key) && !owner.turns.hasPending('openclaw', p.key);
          if (allowed) b.dispatched = true;
          return allowed;
        };
        value = b.applicationReady ? await b.applicationReady(ready) : ready();
      } else if (!original || p.outcome === 'acknowledged' && !b.dispatched) value = false;
      else {
        if (p.outcome === 'acknowledged') {
          const body = { runId: p.runId!, status: p.status ?? 'started', idempotencyKey: b.intent.commandId,
            deliveryMode: 'web-only', deliver: false, ...(b.intent.operation === 'message' ? { explicitRoute: undefined } : {}), media: [],
            ...(b.intent.operation === 'compact' ? { message: b.estimatedSkipReason
              ? `Compact requested. This session may be skipped because ${b.estimatedSkipReason}; Gateway will write the final result into the transcript.`
              : 'Compact requested. Gateway will write the final result into the transcript.',
              ...(b.estimatedSkipReason ? { estimatedSkipReason: b.estimatedSkipReason } : {}) } : {}) };
          if (!owner.openClawExecutions.acknowledge(b.intent.key, b.intent.commandId, p.runId,
            owner.commands.queueCommit(b.scope, b.intent.commandKey, { status: 200, body }))) throw Error('connector_storage_unavailable');
        } else if (p.outcome === 'not_dispatched') {
          if (!owner.openClawExecutions.rejectBeforeRun(b.intent.key, b.intent.commandId, () => {
            if (owner.commands.settle(b.scope, b.intent.commandKey, { status: 409, body: { error: 'Command rejected' } }).state !== 'rejected') throw Error('connector_storage_unavailable');
          })) value = false;
        } else owner.openClawExecutions.uncertain(b.intent.key, b.intent.commandId);
        if (value !== false) { bindings.delete(b.intent.receiptId); value = result(b.scope, b.intent.key, b.intent.commandKey); }
      }
    }
  }
  if (!validConnectorOpenClawCompactOutput(kind, value)) throw Error('connector_storage_unavailable');
  return value as ConnectorOpenClawCompactCommands[K]['output'];
}
