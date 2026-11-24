import type { ChatMessage, CommandReceipt } from '@agentopsdeck/shared';
import type { ApplicationTransactionClient, ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import { hermesSessionView } from '../hermes/session-view.js';
import { normalizeSendMessageRequest } from '../messages/send-message.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validConnectorHermesMessageInput, validConnectorHermesMessageOutput,
  type ConnectorHermesMessageCommands } from './connector-hermes-message-domain.js';
import { validSdkStatusDisplay, type SdkStatusDisplay } from './connector-sdk-status-domain.js';
import { sessionStatusText } from './session-status.js';

type Scope = ConnectorHermesMessageCommands['hermesMessageSendReceiptRead']['input'];
export type HermesLocalControlRequest = Scope & { payloadJson: string; display: SdkStatusDisplay; application?: ApplicationTransactionEvidence };
export type HermesLocalControlResult = { runtime: 'hermes'; key: string; commandKey: string;
  receipt: CommandReceipt | null; queue: { presence: 'absent' }; report: [ChatMessage, ChatMessage] | null };
type Failure = { error: 401 | 403 | 409 | 503 };
export type ConnectorHermesLocalControlCommands = {
  hermesLocalControl: { input: HermesLocalControlRequest; output: Failure | HermesLocalControlResult };
  hermesLocalControlRead: { input: Scope; output: Failure | HermesLocalControlResult };
};
export type ConnectorHermesLocalControlKind = keyof ConnectorHermesLocalControlCommands;
export const connectorHermesLocalControlSteps = Object.freeze({ hermesLocalControl: 184, hermesLocalControlRead: 185 });
export const isConnectorHermesLocalControlKind = (kind: string): kind is ConnectorHermesLocalControlKind => Object.hasOwn(connectorHermesLocalControlSteps, kind);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, fields: string[]) => object(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
export function validConnectorHermesLocalControlInput(kind: ConnectorHermesLocalControlKind, v: unknown): boolean {
  if (!object(v)) return false;
  if (kind === 'hermesLocalControlRead') return validConnectorHermesMessageInput('hermesMessageSendReceiptRead', v);
  const { display, ...request } = v;
  return validSdkStatusDisplay(display) && !Object.hasOwn(request, 'rejectFresh') && validConnectorHermesMessageInput('hermesMessageSend', request);
}
export function validConnectorHermesLocalControlOutput(_kind: ConnectorHermesLocalControlKind, v: unknown): boolean {
  if (!object(v)) return false;
  if (exact(v, ['error'])) return typeof v.error === 'number' && [401, 403, 409, 503].includes(v.error);
  const { report, ...message } = v;
  if (!validConnectorHermesMessageOutput('hermesMessageSendReceiptRead', message) || !exact(v.queue, ['presence'])
    || (v.queue as { presence: unknown }).presence !== 'absent') return false;
  if (report === null) return true;
  const receipt = v.receipt as CommandReceipt | null;
  if (!receipt || receipt.state !== 'accepted' || receipt.result?.status !== 200 || receipt.result.body.status !== 'ok'
    || receipt.result.body.idempotencyKey !== receipt.id || !Array.isArray(report) || report.length !== 2) return false;
  return report.every((m: unknown, i) => object(m) && exact(m, ['id', 'sessionKey', 'role', 'text', 'status', 'createdAt'])
    && m.id === (i ? `local-status:${receipt.id}` : receipt.id) && m.sessionKey === v.key && m.role === (i ? 'assistant' : 'user')
    && m.status === 'sent' && typeof m.text === 'string' && m.text.length <= 6000
    && Number.isSafeInteger(m.createdAt) && Number(m.createdAt) >= 0)
    && report[0].text === '/status' && report[0].createdAt === report[1].createdAt;
}
class Denied extends Error {}

/** Immutable original local report, never native history or execution proof.
 * Its receipt and report share the original command admission transaction. */
export async function executeConnectorHermesLocalControl<K extends ConnectorHermesLocalControlKind>(kind: K,
  input: ConnectorHermesLocalControlCommands[K]['input'], owner: ConnectorUserStore,
  tokens?: ConnectorTokenStore, applicationTransactions?: ApplicationTransactionClient): Promise<ConnectorHermesLocalControlCommands[K]['output']> {
  if (!validConnectorHermesLocalControlInput(kind, input)) throw Error('connector_storage_unavailable');
  const p = structuredClone(input), actor = tokens?.authenticateAuthorization(p.authorization);
  if (!actor) return { error: 401 };
  const allowed = (read = false) => {
    const fresh = tokens?.authenticateAuthorization(p.authorization);
    return !!fresh && fresh.tokenId === actor.tokenId && !fresh.tokenId.startsWith('actor_')
      && !fresh.scopes.includes('execution:delegate') && fresh.scopes.includes('messages:send')
      && (!read || fresh.scopes.includes('messages:read'));
  };
  if (!allowed()) return { error: 403 };
  const scope = JSON.stringify([actor.tokenId, p.key]);
  const check = () => { if (!allowed()) throw new Denied(); };
  try {
    if (kind === 'hermesLocalControl') {
      const request = p as HermesLocalControlRequest, payload = JSON.parse(request.payloadJson);
      const transaction = applicationControlTransaction('hermes', request, applicationTransactions);
      const normalized = normalizeSendMessageRequest(payload);
      const wantsReport = !('error' in normalized) && normalized.message === '/status';
      const checkRequest = () => { if (!allowed(wantsReport)) throw new Denied(); };
      checkRequest();
      await owner.commands.claimAsync(scope, p.commandKey, payload, false, undefined, undefined, receiptId => {
        checkRequest();
        const reject = (status: number) => ({ metadata: { domain: 'hermes-local-control-rejected' }, complete: { status, body: { error: 'Command rejected' } } });
        if ('error' in normalized || !['/status', '/compact'].includes(normalized.message)) return reject(400);
        if (normalized.media.length || normalized.deliveryMode === 'mirror') return reject(409);
        const journal = owner.hermesJournal;
        if (journal.deletion(p.key) || owner.commands.sessionDeletion(p.key)) return reject(409);
        const session = journal.historySnapshot(p.key);
        if (!session) return reject(404);
        if (normalized.message === '/compact') return reject(409);
        const execution = journal.current(p.key);
        const view = hermesSessionView(p.key, session.title, execution, request.display.connected, session.unknown);
        const protection = journal.interruptPending(p.key)
          ? '\n- Execution protection: unresolved interrupt; successor dispatch remains blocked' : '';
        const now = Date.now();
        const report: [ChatMessage, ChatMessage] = [
          { id: receiptId, sessionKey: p.key, role: 'user', text: '/status', status: 'sent', createdAt: now },
          { id: `local-status:${receiptId}`, sessionKey: p.key, role: 'assistant', status: 'sent', createdAt: now,
            text: sessionStatusText(p.key, view, request.display.session, '') + protection },
        ];
        return { metadata: { domain: 'hermes-local-control', actorId: actor.tokenId, receiptId, report },
          complete: { status: 200, body: { status: 'ok', idempotencyKey: receiptId, deliveryMode: 'web-only', deliver: false, media: [] } } };
      }, false, checkRequest, checkRequest, transaction?.claim);
    }
    check();
    const receipt = owner.commands.get(scope, p.commandKey) ?? null, saved = owner.commands.binding(scope, p.commandKey);
    const report = saved?.domain === 'hermes-local-control' && saved.actorId === actor.tokenId && saved.receiptId === receipt?.id
      ? saved.report as [ChatMessage, ChatMessage] : null;
    if (report && !allowed(true)) return { error: 403 };
    const result: HermesLocalControlResult = { runtime: 'hermes', key: p.key, commandKey: p.commandKey, receipt, queue: { presence: 'absent' }, report };
    if (!validConnectorHermesLocalControlOutput(kind, result)) throw Error('connector_storage_unavailable');
    return result;
  } catch (error) {
    if (error instanceof Denied) return { error: 403 };
    if (error instanceof CommandConflict) return { error: 409 };
    if (error instanceof CommandCapacity) return { error: 503 };
    throw error;
  }
}
