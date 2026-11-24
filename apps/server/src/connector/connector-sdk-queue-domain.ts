import { sessionRuntimeId, MAX_MESSAGE_CHARS, type CommandReceipt } from '@agentopsdeck/shared';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import type { SdkTextInput } from './sdk-dispatch.js';
import { isSdkCompactCommand } from './sdk-text-command.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence, type ApplicationTransactionClient } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';

type Target = { messageId: string } | { commandKey: string };
type Scope = { runtime: SdkAgentId; key: string; target: Target; mutationKey: string; authorization: string };
type Mutation = Scope & { version: string; rejectFresh?: 'runtime_unavailable'; application?: ApplicationTransactionEvidence };
type Failure = { error: 401 | 403 | 404 | 409 | 503 };
export type ConnectorSdkQueueCommands = {
  sdkQueuedCancel: { input: Mutation; output: Failure | { key: string; targetId: string; receipt: CommandReceipt; changed: boolean } };
  sdkQueueReceiptRead: { input: Scope & { purpose?: 'mutation' }; output: Failure | { key: string; targetId: string; receipt: CommandReceipt | null } };
  sdkQueuedEdit: { input: Mutation & { text: string }; output: ConnectorSdkQueueCommands['sdkQueuedCancel']['output'] };
};
export type ConnectorSdkQueueKind = keyof ConnectorSdkQueueCommands;
export const connectorSdkQueueSteps = Object.freeze({ sdkQueuedCancel: 79, sdkQueueReceiptRead: 80, sdkQueuedEdit: 81 });
export const isConnectorSdkQueueKind = (kind: string): kind is ConnectorSdkQueueKind => Object.hasOwn(connectorSdkQueueSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const commandKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const sdkRuntime = (v: unknown): v is SdkAgentId => v === 'claude-code' || v === 'ghcp';
export function validConnectorSdkQueueInput(kind: ConnectorSdkQueueKind, v: unknown): boolean {
  return fields(v, ['runtime', 'key', 'target', 'mutationKey', 'authorization', ...(kind !== 'sdkQueueReceiptRead' ? ['version'] : []),
    ...(kind === 'sdkQueuedEdit' ? ['text'] : [])], kind === 'sdkQueueReceiptRead' ? ['purpose'] : ['rejectFresh', 'application'])
    && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application))
    && (!Object.hasOwn(v, 'rejectFresh') || v.rejectFresh === 'runtime_unavailable')
    && (!Object.hasOwn(v, 'purpose') || v.purpose === 'mutation')
    && sdkRuntime(v.runtime) && id(v.key) && v.key !== `${v.runtime}:` && sessionRuntimeId(v.key) === v.runtime
    && commandKey(v.mutationKey) && typeof v.authorization === 'string' && !!v.authorization.trim()
    && Buffer.byteLength(v.authorization) <= 4096 && !/[\r\n\u0000]/.test(v.authorization)
    && (fields(v.target, ['messageId']) && id(v.target.messageId) || fields(v.target, ['commandKey']) && commandKey(v.target.commandKey))
    && (kind === 'sdkQueueReceiptRead' || typeof v.version === 'string' && /^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(v.version))
    && (kind !== 'sdkQueuedEdit' || typeof v.text === 'string' && !!v.text.trim() && v.text.length <= MAX_MESSAGE_CHARS);
}
export function validSdkQueueReceipt(v: unknown): v is CommandReceipt {
  return fields(v, ['id', 'key', 'state', 'createdAt', 'updatedAt'], ['result']) && id(v.id) && commandKey(v.key)
    && ['outcome_unknown', 'accepted', 'rejected'].includes(String(v.state))
    && Number.isSafeInteger(v.createdAt) && Number(v.createdAt) >= 0 && Number.isSafeInteger(v.updatedAt) && Number(v.updatedAt) >= 0
    && (v.state === 'outcome_unknown' ? !Object.hasOwn(v, 'result') : fields(v.result, ['status', 'body'])
      && Number.isInteger(v.result.status) && (v.state === 'accepted'
        ? v.result.status === 200 && fields(v.result.body, ['ok']) && v.result.body.ok === true
        : Number(v.result.status) >= 400 && Number(v.result.status) < 500
          && fields(v.result.body, ['error']) && v.result.body.error === 'Command rejected'));
}
export function validConnectorSdkQueueOutput(kind: ConnectorSdkQueueKind, v: unknown): boolean {
  return fields(v, ['error']) && typeof v.error === 'number' && [401, 403, 404, 409, 503].includes(v.error)
    || fields(v, ['key', 'targetId', 'receipt', ...(kind !== 'sdkQueueReceiptRead' ? ['changed'] : [])]) && id(v.key)
    && sdkRuntime(sessionRuntimeId(v.key)) && id(v.targetId)
    && (kind !== 'sdkQueueReceiptRead' ? typeof v.changed === 'boolean' && validSdkQueueReceipt(v.receipt)
      && (!v.changed || v.receipt.state === 'accepted') : v.receipt === null || validSdkQueueReceipt(v.receipt));
}
class QueueAuthorityDenied extends Error {}

/** Candidate whole-owner commands, not enabled by queue-http.ts. Scope and actor
 * are derived from the original token authority, never caller-owned booleans.
 * Original receipt identity, opaque version and shared SQL transaction survive.
 * Only provably unsent work can be removed; no native stop, retry or replay. */
export async function executeConnectorSdkQueue<K extends ConnectorSdkQueueKind>(kind: K,
  request: ConnectorSdkQueueCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  transactions?: ApplicationTransactionClient): Promise<ConnectorSdkQueueCommands[K]['output']> {
  if (!tokens || !validConnectorSdkQueueInput(kind, request)) throw Error('connector_storage_unavailable');
  // Fix all identity fields before the admission await, including local callers.
  const input = { runtime: request.runtime, key: request.key, authorization: request.authorization,
    mutationKey: request.mutationKey, target: 'messageId' in request.target ? { messageId: request.target.messageId } : { commandKey: request.target.commandKey },
    ...(kind === 'sdkQueueReceiptRead' ? { purpose: (request as ConnectorSdkQueueCommands['sdkQueueReceiptRead']['input']).purpose } : {}),
    ...(kind !== 'sdkQueueReceiptRead' ? { version: (request as Mutation).version,
      rejectFresh: (request as Mutation).rejectFresh } : {}),
    ...(Object.hasOwn(request, 'application') ? { application: structuredClone((request as Mutation).application) } : {}),
    ...(kind === 'sdkQueuedEdit' ? { text: (request as ConnectorSdkQueueCommands['sdkQueuedEdit']['input']).text.trim() } : {}) };
  const principal = tokens.authenticateAuthorization(input.authorization);
  let result: Failure | { receipt: CommandReceipt | null; changed?: boolean };
  let resolvedTarget: string | undefined;
  if (!principal) result = { error: 401 };
  else {
    const actorId = principal.tokenId;
    const permitted = (read: boolean) => {
      const fresh = tokens.authenticateAuthorization(input.authorization);
      return !!fresh && fresh.tokenId === actorId && !actorId.startsWith('actor_')
        && (read ? fresh.scopes.includes('messages:read') || fresh.scopes.includes('queue:manage') : fresh.scopes.includes('messages:send'));
    };
    const check = () => {
      if (!permitted(false)) throw new QueueAuthorityDenied();
      if (resolvedTarget !== undefined && 'commandKey' in input.target) {
        const original = owner.commands.get(JSON.stringify([actorId, input.key]), input.target.commandKey);
        if (original?.state !== 'accepted' || original.result?.body.idempotencyKey !== resolvedTarget) throw new QueueAuthorityDenied();
      }
    };
    if (!permitted(kind === 'sdkQueueReceiptRead' && input.purpose !== 'mutation')) result = { error: 403 };
    else {
      // Command-addressed routes resolve the same actor-owned admission as
      // 2.3.7. The mutation scope always contains its original raw target ID.
      let targetId: string;
      if ('messageId' in input.target) targetId = input.target.messageId;
      else {
        const original = owner.commands.get(JSON.stringify([actorId, input.key]), input.target.commandKey);
        if (!original) return { error: 404 } as ConnectorSdkQueueCommands[K]['output'];
        const value = original.state === 'accepted' ? original.result?.body.idempotencyKey : undefined;
        if (!id(value)) return { error: 409 } as ConnectorSdkQueueCommands[K]['output'];
        targetId = value;
      }
      const scope = JSON.stringify(['queue-mutation-v1', actorId, input.key, targetId]);
      resolvedTarget = targetId;
      if (kind === 'sdkQueueReceiptRead') result = { receipt: owner.commands.get(scope, input.mutationKey) ?? null };
      else {
        const version = input.version!;
        try {
          const edit = kind === 'sdkQueuedEdit';
          const payload = { method: edit ? 'PATCH' : 'DELETE', version, text: input.text ?? '' };
          const control = applicationControlTransaction(input.runtime, { key: input.key, commandKey: input.mutationKey,
            payloadJson: JSON.stringify(payload), ...(Object.hasOwn(input, 'application') ? { application: input.application } : {}) }, transactions);
          const claimed = await owner.commands.claimAsync(scope, input.mutationKey, payload,
            false, undefined, undefined, undefined, false, check, check, control?.claim);
          if (!claimed.fresh) result = { receipt: claimed.receipt, changed: false };
          else {
            const mutate = () => {
            check();
            const reject = (status: number) => ({ receipt: owner.commands.settle(scope, input.mutationKey,
              { status, body: { error: 'Queue mutation rejected' } }), changed: false });
            const journal = input.runtime === 'claude-code' ? owner.claudeJournal : owner.copilotJournal;
            const available = () => owner.sdkCommandAdmissionOpen && !!journal.session(input.key)
              && !owner.commands.sessionDeletion(input.key) && !journal.deletion(input.key) && !owner.commands.sessionSettingsPending(input.key);
            const row = owner.turns.ownedEntry(input.runtime, input.key, targetId, actorId);
            if (input.rejectFresh === 'runtime_unavailable' || !available()) return reject(409);
            else if (edit && isSdkCompactCommand(input.text!)) return reject(409);
            else if (!row) return reject(404);
            else if (owner.turns.version(input.runtime, input.key, targetId) !== version) return reject(412);
            else if (row.state !== 'queued' && (edit || row.state !== 'blocked')) return reject(409);
            else {
              const receiptCommit = owner.commands.queueCommit(scope, input.mutationKey, { status: 200, body: { ok: true } });
              const commit: typeof receiptCommit = (db, admission) => {
                receiptCommit(db, admission);
                owner.events.appendInTransaction(db, { id: '', ts: Date.now(),
                  type: edit ? 'queued_message.created' : 'queued_message.failed',
                  payload: { sessionKey: input.key, idempotencyKey: targetId, ...(edit ? { edited: true } : { canceled: true }) } });
              };
              try {
                const authorizePayload = (payload: SdkTextInput) => {
                  check();
                  if (payload.actorId !== actorId || payload.executionGrant) throw new QueueAuthorityDenied();
                  if (!available()) throw new QueueAuthorityDenied();
                };
                const changed = edit ? owner.turns.edit<SdkTextInput>(input.runtime, input.key, targetId, payload => {
                  authorizePayload(payload); return { ...payload, text: input.text! };
                }, version, commit) : owner.turns.cancel<SdkTextInput>(input.runtime, input.key, targetId, version, (db, admission) => {
                  owner.sdkAttachments.remove(input.key, targetId); commit(db, admission);
                }, (_db, payload) => authorizePayload(payload));
                if (changed) { try { owner.events.changes.notify(); } catch { /* Committed fact remains authoritative. */ } }
                return changed ? { receipt: owner.commands.get(scope, input.mutationKey)!, changed: true } : reject(409);
              } catch (error) {
                // Notification failure after COMMIT cannot turn an accepted
                // cancellation into a replay or rejected command.
                const saved = owner.commands.get(scope, input.mutationKey);
                if (saved?.state === 'accepted') return { receipt: saved, changed: true };
                else if (error instanceof QueueAuthorityDenied) return reject(403);
                else throw error;
              }
            }
            };
            result = control ? await control.ready(mutate) : mutate();
          }
        } catch (error) {
          if (error instanceof QueueAuthorityDenied) result = { error: 403 };
          else if (error instanceof CommandConflict) result = { error: 409 };
          else if (error instanceof CommandCapacity) result = { error: 503 };
          else throw error; // uncertain storage outcome never becomes rejection
        }
      }
    }
  }
  const reply = 'receipt' in result ? { ...result, key: input.key, targetId: resolvedTarget! } : result;
  if (!validConnectorSdkQueueOutput(kind, reply)) throw Error('connector_storage_unavailable');
  return reply as ConnectorSdkQueueCommands[K]['output'];
}
