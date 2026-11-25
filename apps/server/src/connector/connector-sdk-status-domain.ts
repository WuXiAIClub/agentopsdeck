import type { ChatMessage, CommandReceipt } from '@agentopsdeck/shared';
import type { ApplicationTransactionClient, ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import { normalizeSendMessageRequest } from '../messages/send-message.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validConnectorSdkMessageInput, validConnectorSdkMessageOutput, type ConnectorSdkMessageCommands } from './connector-sdk-message-domain.js';
import { validSdkJournalSnapshot } from './connector-sdk-journal-domain.js';
import { sdkSessionView } from './sdk-session-view.js';
import { sessionStatusText, type SessionStatusDisplay } from './session-status.js';

type Scope = ConnectorSdkMessageCommands['sdkMessageSendReceiptRead']['input'];
export type SdkStatusDisplay = { connected: boolean; gateway: string; session: SessionStatusDisplay };
export type SdkStatusRequest = Scope & { payloadJson: string; display: SdkStatusDisplay; application?: ApplicationTransactionEvidence };
export type SdkStatusResult = { runtime: Scope['runtime']; key: string; commandKey: string;
  receipt: CommandReceipt | null; queue: { presence: 'absent' }; report: [ChatMessage, ChatMessage] | null };
type Failure = { error: 401 | 403 | 409 | 503 };
export type ConnectorSdkStatusCommands = {
  sdkMessageStatus: { input: SdkStatusRequest; output: Failure | SdkStatusResult };
  sdkMessageStatusRead: { input: Scope; output: Failure | SdkStatusResult };
};
export type ConnectorSdkStatusKind = keyof ConnectorSdkStatusCommands;
export const connectorSdkStatusSteps = Object.freeze({ sdkMessageStatus: 115, sdkMessageStatusRead: 116 });
export const isConnectorSdkStatusKind = (k: string): k is ConnectorSdkStatusKind => Object.hasOwn(connectorSdkStatusSteps, k);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const metrics = ['inputTokens', 'outputTokens', 'totalTokens', 'contextTokens', 'compactionCount'];
export function validSdkStatusDisplay(v: unknown): v is SdkStatusDisplay {
  return object(v) && exact(v, ['connected', 'gateway', 'session']) && typeof v.connected === 'boolean' && text(v.gateway, 128)
    && object(v.session) && Object.entries(v.session).every(([k, value]) => ['modelProvider', 'model'].includes(k)
      ? text(value, 256) : metrics.includes(k) && Number.isSafeInteger(value) && Number(value) >= 0);
}
export function validConnectorSdkStatusInput(k: ConnectorSdkStatusKind, v: unknown): boolean {
  if (!object(v)) return false;
  if (k === 'sdkMessageStatusRead') return validConnectorSdkMessageInput('sdkMessageSendReceiptRead', v);
  const { display, ...message } = v;
  return validSdkStatusDisplay(display) && !Object.hasOwn(message, 'rejectFresh') && validConnectorSdkMessageInput('sdkMessageSend', message);
}
export function validConnectorSdkStatusOutput(_k: ConnectorSdkStatusKind, v: unknown): boolean {
  if (!object(v)) return false;
  if (exact(v, ['error'])) return [401, 403, 409, 503].includes(Number(v.error)) && typeof v.error === 'number';
  const { report, ...message } = v;
  if (!validConnectorSdkMessageOutput('sdkMessageSendReceiptRead', message) || !exact(v.queue, ['presence'])
    || (v.queue as { presence: unknown }).presence !== 'absent') return false;
  if (report === null) return true;
  const receipt = v.receipt as CommandReceipt | null;
  if (!receipt || receipt.state !== 'accepted' || receipt.result?.status !== 200 || !Array.isArray(report) || report.length !== 2
    || receipt.result.body.idempotencyKey !== receipt.id) return false;
  return report.every((m: unknown, i) => object(m) && exact(m, ['id', 'sessionKey', 'role', 'text', 'status', 'createdAt'])
    && m.id === (i ? `local-status:${receipt.id}` : receipt.id) && m.sessionKey === v.key && m.role === (i ? 'assistant' : 'user')
    && m.status === 'sent' && typeof m.text === 'string' && m.text.length <= 6000
    && Number.isSafeInteger(m.createdAt) && Number(m.createdAt) >= 0)
    && report[0].text === '/status' && report[0].createdAt === report[1].createdAt;
}
class Denied extends Error {}

/** Local-only report. Original receipt, immutable report and result commit in
 * one worker transaction. Neither native queue nor execution fence is touched. */
export async function executeConnectorSdkStatus<K extends ConnectorSdkStatusKind>(kind: K,
  input: ConnectorSdkStatusCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  applicationTransactions?: ApplicationTransactionClient): Promise<ConnectorSdkStatusCommands[K]['output']> {
  if (!validConnectorSdkStatusInput(kind, input)) throw Error('connector_storage_unavailable');
  const p = structuredClone(input);
  const authorized = (originalId?: string) => {
    const actor = tokens?.authenticateAuthorization(p.authorization);
    return actor && (!originalId || actor.tokenId === originalId) && !actor.tokenId.startsWith('actor_')
      && !actor.scopes.includes('execution:delegate') && actor.scopes.includes('messages:send') && actor.scopes.includes('messages:read') ? actor : undefined;
  };
  const actor = tokens?.authenticateAuthorization(p.authorization);
  if (!actor) return { error: 401 };
  if (!authorized()) return { error: 403 };
  const scope = JSON.stringify([actor.tokenId, p.key]);
  const check = () => { if (!authorized(actor.tokenId)) throw new Denied(); };
  try {
    if (kind === 'sdkMessageStatus') {
      const request = p as SdkStatusRequest, payload = JSON.parse(request.payloadJson);
      const transaction = applicationControlTransaction(p.runtime, request, applicationTransactions);
      await owner.commands.claimAsync(scope, p.commandKey, payload, false, undefined, undefined, receiptId => {
        check();
        const normalized = normalizeSendMessageRequest(payload);
        const reject = (status: number) => ({ metadata: { domain: 'sdk-message-status-rejected' },
          complete: { status, body: { error: 'Command rejected' } } });
        if ('error' in normalized || normalized.message !== '/status' || normalized.media.length) return reject(400);
        if (normalized.deliveryMode === 'mirror') return reject(409);
        const journal = p.runtime === 'claude-code' ? owner.claudeJournal : p.runtime === 'ghcp' ? owner.copilotJournal : owner.antigravityJournal;
        const snapshot = journal.readSnapshot(p.key);
        if (!validSdkJournalSnapshot(snapshot)) throw Error('connector_storage_unavailable');
        if (!snapshot.session) return reject(404);
        if (snapshot.deletion || owner.commands.sessionDeletion(p.key)) return reject(409);
        const view = sdkSessionView(p.runtime, snapshot.session, snapshot.execution ?? undefined, request.display.connected);
        const now = Date.now();
        const report: [ChatMessage, ChatMessage] = [
          { id: receiptId, sessionKey: p.key, role: 'user', text: normalized.message, status: 'sent', createdAt: now },
          { id: `local-status:${receiptId}`, sessionKey: p.key, role: 'assistant', status: 'sent', createdAt: now,
            text: sessionStatusText(p.key, view, request.display.session, request.display.gateway) },
        ];
        return { metadata: { domain: 'sdk-message-status', actorId: actor.tokenId, receiptId, report },
          complete: { status: 200, body: { status: 'ok', idempotencyKey: receiptId, deliveryMode: 'web-only', deliver: false, media: [] } } };
      }, false, check, check, transaction?.claim);
    }
    check();
    const receipt = owner.commands.get(scope, p.commandKey) ?? null, saved = owner.commands.binding(scope, p.commandKey);
    const report = saved?.domain === 'sdk-message-status' && saved.actorId === actor.tokenId && saved.receiptId === receipt?.id
      ? saved.report as [ChatMessage, ChatMessage] : null;
    const result: SdkStatusResult = { runtime: p.runtime, key: p.key, commandKey: p.commandKey, receipt, queue: { presence: 'absent' }, report };
    if (!validConnectorSdkStatusOutput(kind, result)) throw Error('connector_storage_unavailable');
    return result;
  } catch (error) {
    if (error instanceof Denied) return { error: 403 };
    if (error instanceof CommandCapacity) return { error: 503 };
    if (error instanceof CommandConflict) return { error: 409 };
    throw error;
  }
}
