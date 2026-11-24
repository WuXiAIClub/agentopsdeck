import type { ChatMessage } from '@agentopsdeck/shared';
import type { ApplicationTransactionClient, ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import { normalizeSendMessageRequest } from '../messages/send-message.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { executeConnectorOpenClawMessage, validConnectorOpenClawMessageInput, validConnectorOpenClawMessageOutput,
  type OpenClawMessageScope, type OpenClawMessageResult } from './connector-openclaw-message-domain.js';
import { validSdkStatusDisplay } from './connector-sdk-status-domain.js';
import { resolveExecutionActor, EXECUTION_GRANT_HEADER } from './execution-authority.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { sessionStatusText, type SessionStatusDisplay } from './session-status.js';

/** Caller fields are display hints, never execution or permission evidence. */
export type OpenClawStatusDisplay = { gateway: string; connectionId: string | null; session: SessionStatusDisplay | null };
export type OpenClawStatusResult = OpenClawMessageResult & { report: [ChatMessage, ChatMessage] | null };
type Failure = { error: 401 | 403 | 409 | 503 };
export type ConnectorOpenClawStatusCommands = {
  openClawStatus: { input: OpenClawMessageScope & { payloadJson: string; display: OpenClawStatusDisplay; application?: ApplicationTransactionEvidence }; output: Failure | OpenClawStatusResult };
  openClawStatusRead: { input: OpenClawMessageScope; output: Failure | OpenClawStatusResult };
  openClawStatusSendRead: { input: OpenClawMessageScope; output: Failure | OpenClawStatusResult };
};
export type ConnectorOpenClawStatusKind = keyof ConnectorOpenClawStatusCommands;
export const connectorOpenClawStatusSteps = Object.freeze({ openClawStatus: 205, openClawStatusRead: 206, openClawStatusSendRead: 207 });
export const isConnectorOpenClawStatusKind = (kind: string): kind is ConnectorOpenClawStatusKind => Object.hasOwn(connectorOpenClawStatusSteps, kind);
const fields = (v: unknown, names: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
export function validOpenClawStatusDisplay(v: unknown): v is OpenClawStatusDisplay {
  return fields(v, ['gateway', 'connectionId', 'session']) && (v.connectionId === null || typeof v.connectionId === 'string'
    && v.connectionId.length > 0 && Buffer.byteLength(v.connectionId) <= 512 && !/[\u0000-\u001f\u007f]/.test(v.connectionId))
    && (v.session === null || !!v.session && typeof v.session === 'object' && !Array.isArray(v.session))
    && validSdkStatusDisplay({ connected: v.connectionId !== null, gateway: v.gateway, session: v.session ?? {} });
}
export function validConnectorOpenClawStatusInput(kind: ConnectorOpenClawStatusKind, v: unknown): boolean {
  if (kind !== 'openClawStatus') return validConnectorOpenClawMessageInput('openClawMessageReceiptRead', v);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const { display, payloadJson, application, ...scope } = v as Record<string, unknown>;
  return validOpenClawStatusDisplay(display) && Object.hasOwn(v, 'payloadJson')
    && validConnectorOpenClawMessageInput('openClawMessageReceiptRead', scope)
    && validConnectorOpenClawMessageInput('openClawMessageClaim', { ...scope, payloadJson, defaultAgentId: 'main',
      ...(Object.hasOwn(v, 'application') ? { application } : {}) });
}
export function validConnectorOpenClawStatusOutput(_kind: ConnectorOpenClawStatusKind, v: unknown): boolean {
  if (fields(v, ['error'])) return typeof v.error === 'number' && [401, 403, 409, 503].includes(v.error);
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, 'report')) return false;
  const { report, ...result } = v as OpenClawStatusResult;
  if (!validConnectorOpenClawMessageOutput('openClawMessageReceiptRead', result) || result.intent !== null || result.admitted !== false) return false;
  if (report === null) return true;
  const receipt = result.receipt;
  return receipt?.state === 'accepted' && receipt.result?.status === 200 && receipt.result.body.idempotencyKey === receipt.id
    && fields(receipt.result.body, ['status', 'idempotencyKey', 'deliveryMode', 'deliver', 'media'])
    && receipt.result.body.status === 'ok' && receipt.result.body.deliveryMode === 'web-only' && receipt.result.body.deliver === false
    && Array.isArray(receipt.result.body.media) && receipt.result.body.media.length === 0
    && Array.isArray(report) && report.length === 2 && report.every((m, i) => fields(m, ['id', 'sessionKey', 'role', 'text', 'status', 'createdAt'])
      && m.id === (i ? `local-status:${receipt.id}` : receipt.id) && m.sessionKey === result.key && m.role === (i ? 'assistant' : 'user')
      && m.status === 'sent' && typeof m.text === 'string' && m.text.length <= 12_000 && Number.isSafeInteger(m.createdAt) && Number(m.createdAt) >= 0)
    && report[0].text === '/status' && report[0].createdAt === report[1].createdAt;
}
class Denied extends Error {}

/** Local control commits the original receipt and immutable report together.
 * It never changes queues, execution facts or local execution protection. */
export async function executeConnectorOpenClawStatus<K extends ConnectorOpenClawStatusKind>(kind: K,
  request: ConnectorOpenClawStatusCommands[K]['input'], owner: ConnectorUserStore,
  tokens?: ConnectorTokenStore, applicationTransactions?: ApplicationTransactionClient): Promise<ConnectorOpenClawStatusCommands[K]['output']> {
  if (!validConnectorOpenClawStatusInput(kind, request)) throw Error('connector_storage_unavailable');
  const input = structuredClone(request), readOnly = kind === 'openClawStatusRead';
  if (!tokens?.authenticateAuthorization(input.authorization)) return { error: 401 };
  const actor = () => {
    if (input.expectedNode !== undefined && input.expectedNode !== owner.nodeId) throw new Denied();
    const headers = new Headers({ authorization: input.authorization });
    if (input.grantId !== undefined) headers.set(EXECUTION_GRANT_HEADER, input.grantId);
    if (input.expectedNode !== undefined) headers.set(EXPECTED_NODE_HEADER, input.expectedNode);
    try {
      const a = resolveExecutionActor(new Request('http://connector.invalid', { headers }), { tokens, grants: owner.executionGrants, nodeId: owner.nodeId },
        { runtime: 'openclaw', sessionKey: input.key }, readOnly ? undefined : 'messages:send');
      if (!a.principal.scopes.includes('messages:read') || !readOnly && !a.principal.scopes.includes('messages:send')) throw new Denied();
      return a;
    } catch { throw new Denied(); }
  };
  try {
    const original = actor(), scope = JSON.stringify([original.actorId, input.key]);
    const check = () => { const a = actor(); if (a.actorId !== original.actorId || a.principal.tokenId !== original.principal.tokenId) throw new Denied(); };
    if (kind === 'openClawStatus') {
      const p = input as ConnectorOpenClawStatusCommands['openClawStatus']['input'], body = JSON.parse(p.payloadJson);
      const transaction = applicationControlTransaction('openclaw', p, applicationTransactions);
      await owner.commands.claimAsync(scope, p.commandKey, body, false, undefined, undefined, receiptId => {
        check();
        const normalized = normalizeSendMessageRequest(body);
        const reject = (status: 400 | 404 | 409) => ({ metadata: { domain: 'openclaw-status-rejected' }, complete: { status, body: { error: 'Command rejected' } } });
        if ('error' in normalized || normalized.message !== '/status' || normalized.media.length) return reject(400);
        if (normalized.deliveryMode === 'mirror' || original.executionGrant) return reject(409);
        if (owner.commands.sessionDeletion(input.key)) return reject(409);
        if (p.display.session === null) return reject(404);
        const fact = owner.openClawExecutions.get(input.key);
        const unconfirmed = fact?.origin === 'gateway' && !['completed', 'failed'].includes(fact.phase)
          && (!p.display.connectionId || !!fact.gatewayConnectionId && fact.gatewayConnectionId !== p.display.connectionId);
        const phase = unconfirmed ? 'unknown' : fact?.phase;
        const state: Parameters<typeof sessionStatusText>[1] = { status: phase === 'starting' ? 'running' : phase === 'completed' ? 'idle' : phase ?? 'unknown',
          ...(fact ? { hasActiveRun: phase === 'starting' || phase === 'running' } : {}),
          ...(fact?.origin === 'gateway' ? { runtime: { turnId: fact.commandId, operation: 'message', phase: phase!,
            connection: p.display.connectionId ? 'connected' : 'disconnected', sync: fact.historySync?.state === 'pending' ? 'syncing'
              : fact.historySync?.state === 'error' ? 'error' : 'current', lastEventAt: fact.updatedAt } } : {}) };
        const now = Date.now(), report: [ChatMessage, ChatMessage] = [
          { id: receiptId, sessionKey: input.key, role: 'user', text: normalized.message, status: 'sent', createdAt: now },
          { id: `local-status:${receiptId}`, sessionKey: input.key, role: 'assistant', status: 'sent', createdAt: now,
            text: sessionStatusText(input.key, state, p.display.session, p.display.gateway) },
        ];
        return { metadata: { domain: 'openclaw-status', actorId: original.actorId, receiptId, report },
          complete: { status: 200, body: { status: 'ok', idempotencyKey: receiptId, deliveryMode: 'web-only', deliver: false, media: [] } } };
      }, false, check, check, transaction?.claim);
    }
    check();
    // Reuse the ordinary receipt reader for original queue/recovery semantics.
    const { key, commandKey, authorization, grantId, expectedNode } = input;
    const result = await executeConnectorOpenClawMessage(readOnly ? 'openClawMessageReceiptRead' : 'openClawMessageSendReceiptRead',
      { key, commandKey, authorization, ...(grantId !== undefined ? { grantId } : {}), ...(expectedNode !== undefined ? { expectedNode } : {}) }, owner, tokens);
    check();
    if ('error' in result) return result;
    const binding = owner.commands.binding(scope, input.commandKey);
    const report = binding?.domain === 'openclaw-status' && binding.actorId === original.actorId && binding.receiptId === result.receipt?.id
      ? binding.report as [ChatMessage, ChatMessage] : null;
    const value: OpenClawStatusResult = { ...result, report };
    if (!validConnectorOpenClawStatusOutput(kind, value)) throw Error('connector_storage_unavailable');
    return value;
  } catch (error) {
    if (error instanceof Denied) return { error: 403 };
    if (error instanceof CommandCapacity) return { error: 503 };
    if (error instanceof CommandConflict) return { error: 409 };
    throw error;
  }
}
