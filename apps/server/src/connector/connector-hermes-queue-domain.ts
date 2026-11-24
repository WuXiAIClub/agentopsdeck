import { MAX_MESSAGE_CHARS, type CommandReceipt, type QueuedMessagePage, type QueuedCommandPage } from '@agentopsdeck/shared';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { resolveExecutionActor } from './execution-authority.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { validSdkQueueReceipt } from './connector-sdk-queue-domain.js';
import { validOwnedQueueReadOutput } from './connector-sdk-queue-read-domain.js';
import { HTTPException } from 'hono/http-exception';
import { editHermesQueued, cancelHermesQueued } from '../hermes/queue-mutations.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence, type ApplicationTransactionClient } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';

type Evidence = { authorization: string; expectedNode?: string; grantRef?: string };
type Scope = Evidence & { runtime: 'hermes'; key: string };
type Target = { messageId: string } | { commandKey: string };
type Address = Scope & { target: Target; mutationKey: string };
type Mutation = Address & { version: string; rejectFresh?: 'runtime_unavailable'; application?: ApplicationTransactionEvidence };
type Failure = { error: 401 | 403 | 404 | 409 | 503 };
type Result = { key: string; targetId: string; receipt: CommandReceipt; changed: boolean };
export type ConnectorHermesQueueCommands = {
  hermesQueuePage: { input: Scope & { after: number }; output: { error: 401 | 403 } | { key: string; page: QueuedMessagePage } };
  hermesQueueCommandPage: { input: Scope & { after: number }; output: { error: 401 | 403 } | { key: string; page: QueuedCommandPage } };
  hermesQueuedEdit: { input: Mutation & { text: string }; output: Failure | Result };
  hermesQueuedCancel: { input: Mutation; output: Failure | Result };
  hermesQueueReceiptRead: { input: Address & { purpose?: 'mutation'; method?: 'PATCH' | 'DELETE' }; output: Failure | { key: string; targetId: string; receipt: CommandReceipt | null } };
};
export type ConnectorHermesQueueKind = keyof ConnectorHermesQueueCommands;
export const connectorHermesQueueSteps = Object.freeze({ hermesQueuePage: 165, hermesQueueCommandPage: 166,
  hermesQueuedEdit: 167, hermesQueuedCancel: 168, hermesQueueReceiptRead: 169 });
export const isConnectorHermesQueueKind = (kind: string): kind is ConnectorHermesQueueKind => Object.hasOwn(connectorHermesQueueSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const key = (v: unknown): v is string => id(v) && v.startsWith('hermes:') && v !== 'hermes:';
const commandKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const header = (v: unknown) => typeof v === 'string' && Buffer.byteLength(v) <= 4096 && !/[\r\n\u0000]/.test(v);
const pageKind = (kind: ConnectorHermesQueueKind) => kind === 'hermesQueuePage' || kind === 'hermesQueueCommandPage';
export function validConnectorHermesQueueInput(kind: ConnectorHermesQueueKind, v: unknown): boolean {
  const page = pageKind(kind), receipt = kind === 'hermesQueueReceiptRead';
  return fields(v, ['runtime', 'key', 'authorization', ...(page ? ['after'] : ['target', 'mutationKey']),
    ...(!page && !receipt ? ['version'] : []), ...(kind === 'hermesQueuedEdit' ? ['text'] : [])],
  ['expectedNode', 'grantRef', ...(receipt ? ['purpose', 'method'] : page ? [] : ['rejectFresh', 'application'])])
    && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application))
    && v.runtime === 'hermes' && key(v.key) && header(v.authorization) && !!(v.authorization as string).trim()
    && (!Object.hasOwn(v, 'expectedNode') || header(v.expectedNode)) && (!Object.hasOwn(v, 'grantRef') || header(v.grantRef))
    && (page ? Number.isSafeInteger(v.after) && Number(v.after) >= 0 : commandKey(v.mutationKey)
      && (fields(v.target, ['messageId']) && id(v.target.messageId) || fields(v.target, ['commandKey']) && commandKey(v.target.commandKey)))
    && (page || receipt || typeof v.version === 'string' && /^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(v.version))
    && (!Object.hasOwn(v, 'rejectFresh') || v.rejectFresh === 'runtime_unavailable')
    && (!Object.hasOwn(v, 'purpose') || v.purpose === 'mutation')
    && (!Object.hasOwn(v, 'method') || v.purpose === 'mutation' && (v.method === 'PATCH' || v.method === 'DELETE'))
    && (kind !== 'hermesQueuedEdit' || typeof v.text === 'string' && !!v.text.trim() && v.text.length <= MAX_MESSAGE_CHARS);
}
export function validConnectorHermesQueueOutput(kind: ConnectorHermesQueueKind, v: unknown): boolean {
  if (pageKind(kind)) return validOwnedQueueReadOutput(kind === 'hermesQueueCommandPage', v, key);
  if (fields(v, ['error'])) return typeof v.error === 'number' && [401, 403, 404, 409, 503].includes(v.error);
  const receipt = kind === 'hermesQueueReceiptRead';
  return fields(v, ['key', 'targetId', 'receipt', ...(!receipt ? ['changed'] : [])]) && key(v.key) && id(v.targetId)
    && (receipt && v.receipt === null || validSdkQueueReceipt(v.receipt))
    && (receipt || typeof v.changed === 'boolean' && (!v.changed || (v.receipt as CommandReceipt).state === 'accepted'));
}
class Denied extends Error {}

/** Original Hermes queue authority/CAS/receipt transactions. In particular
 * Hermes remains owner-only: original grant resolution rejects delegation,
 * never downgrading an issuer to its broader token actor. */
export async function executeConnectorHermesQueue<K extends ConnectorHermesQueueKind>(kind: K,
  request: ConnectorHermesQueueCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  transactions?: ApplicationTransactionClient): Promise<ConnectorHermesQueueCommands[K]['output']> {
  if (!tokens || !validConnectorHermesQueueInput(kind, request)) throw Error('connector_storage_unavailable');
  const input = structuredClone(request), principal = tokens.authenticateAuthorization(input.authorization);
  if (!principal) return { error: 401 };
  const isPage = pageKind(kind), receipt = kind === 'hermesQueueReceiptRead', edit = kind === 'hermesQueuedEdit';
  const probe = input as ConnectorHermesQueueCommands['hermesQueueReceiptRead']['input'];
  const write = !isPage && (!receipt || probe.purpose === 'mutation');
  const method = edit ? 'PATCH' : kind === 'hermesQueuedCancel' ? 'DELETE' : probe.method ?? 'PATCH';
  const requestHeaders = new Headers({ authorization: input.authorization });
  if (input.expectedNode !== undefined) requestHeaders.set(EXPECTED_NODE_HEADER, input.expectedNode);
  if (input.grantRef !== undefined) requestHeaders.set('x-agentopsdeck-execution-grant', input.grantRef);
  const evidence = new Request('http://connector.invalid/', { headers: requestHeaders });
  const authorize = () => {
    try {
      const actor = resolveExecutionActor(evidence, { tokens, grants: owner.executionGrants, nodeId: owner.nodeId },
        { runtime: 'hermes', sessionKey: input.key }, write && method === 'PATCH' ? 'messages:send' : undefined);
      if (actor.principal.tokenId !== principal.tokenId || actor.actorId.startsWith('actor_')) throw new Denied();
      const manager = !actor.executionGrant && actor.principal.scopes.includes('queue:manage');
      if (write ? !actor.principal.scopes.includes('messages:send') && !(method === 'DELETE' && manager)
        : !actor.principal.scopes.includes('messages:read') && !manager) throw new Denied();
      return { ...actor, manager };
    } catch (error) {
      if (error instanceof HTTPException && error.status === 403) throw new Denied();
      throw error;
    }
  };
  let actor: ReturnType<typeof authorize>;
  try { actor = authorize(); } catch (error) { if (error instanceof Denied) return { error: 403 }; throw error; }
  let value: unknown;
  if (isPage) {
    const pageInput = input as ConnectorHermesQueueCommands['hermesQueuePage']['input'];
    const raw = owner.turns.summaryPage('hermes', input.key, actor.actorId, kind === 'hermesQueuePage' && actor.manager, pageInput.after);
    const keys = kind === 'hermesQueueCommandPage' ? owner.commands.queueCommandKeys(JSON.stringify([actor.actorId, input.key]), raw.items.map(item => item.id)) : undefined;
    const page = keys ? { items: raw.items.map(({ id: _, ...item }, index) => ({ ...item, commandKey: keys[index]! })), nextCursor: raw.nextCursor } : raw;
    try { const current = authorize(); if (current.actorId !== actor.actorId || actor.manager && !current.manager) throw new Denied(); }
    catch (error) { if (error instanceof Denied) return { error: 403 }; throw error; }
    value = { key: input.key, page };
  } else {
    const v = input as ConnectorHermesQueueCommands['hermesQueuedEdit']['input'];
    const resolveTarget = () => {
      if ('messageId' in v.target) return v.target.messageId;
      const original = owner.commands.get(JSON.stringify([actor.actorId, input.key]), v.target.commandKey);
      if (!original) return { error: 404 as const };
      const target = original.state === 'accepted' ? original.result?.body.idempotencyKey : undefined;
      return id(target) ? target : { error: 409 as const };
    };
    const target = resolveTarget(); if (typeof target !== 'string') return target;
    const scope = JSON.stringify(['queue-mutation-v1', actor.actorId, input.key, target]);
    const check = () => { const current = authorize(); if (current.actorId !== actor.actorId || resolveTarget() !== target) throw new Denied(); actor = current; };
    if (receipt) value = { key: input.key, targetId: target, receipt: owner.commands.get(scope, v.mutationKey) ?? null };
    else {
      const text = edit ? v.text.trim() : '';
      try {
        const payload = { method, version: v.version, text };
        const control = applicationControlTransaction('hermes', { key: input.key, commandKey: v.mutationKey,
          payloadJson: JSON.stringify(payload), ...(Object.hasOwn(v, 'application') ? { application: v.application } : {}) }, transactions);
        const claimed = await owner.commands.claimAsync(scope, v.mutationKey, payload,
          false, undefined, undefined, undefined, false, check, check, control?.claim);
        let outcome: { receipt: CommandReceipt; changed: boolean };
        if (!claimed.fresh) outcome = { receipt: claimed.receipt, changed: false };
        else {
          const mutate = () => {
          let changed = false, result: CommandReceipt;
          const available = () => owner.sdkCommandAdmissionOpen && !!owner.hermesJournal.session(input.key)
            && !owner.hermesJournal.deletion(input.key) && !owner.commands.sessionDeletion(input.key) && !owner.commands.sessionSettingsPending(input.key);
          const reject = (status: number) => owner.commands.settle(scope, v.mutationKey, { status, body: { error: 'Queue mutation rejected' } });
          check();
          const row = owner.turns.ownedEntry('hermes', input.key, target, actor.actorId, !edit && actor.manager);
          if (v.rejectFresh || !available()) result = reject(409);
          else if (!row) result = reject(404);
          else if (owner.turns.version('hermes', input.key, target) !== v.version) result = reject(412);
          else if (row.state !== 'queued' && (edit || row.state !== 'blocked')) result = reject(409);
          else {
            const receiptCommit = owner.commands.queueCommit(scope, v.mutationKey, { status: 200, body: { ok: true } });
            const commit: typeof receiptCommit = (db, admission) => {
              check(); if (!available()) throw new Denied();
              receiptCommit(db, admission);
              owner.events.appendInTransaction(db, { id: '', ts: Date.now(), type: edit ? 'queued_message.created' : 'queued_message.failed',
                payload: { sessionKey: input.key, idempotencyKey: target, ...(edit ? { edited: true } : { canceled: true }) } });
            };
            try {
              changed = edit ? editHermesQueued(owner.turns, input.key, target, text, v.version, commit)
                : cancelHermesQueued(owner.turns, input.key, target, v.version, commit);
              result = changed ? owner.commands.get(scope, v.mutationKey)! : reject(409);
            } catch (error) {
              const saved = owner.commands.get(scope, v.mutationKey);
              if (saved?.state === 'accepted') { result = saved; changed = true; }
              else if (error instanceof Denied) result = reject(403);
              else throw error;
            }
            if (changed) { try { owner.events.changes.notify(); } catch { /* committed fact survives publication failure */ } }
          }
          return { receipt: result, changed };
          };
          outcome = control ? await control.ready(mutate) : mutate();
        }
        value = { key: input.key, targetId: target, ...outcome };
      } catch (error) {
        if (error instanceof Denied) value = { error: 403 };
        else if (error instanceof CommandConflict) value = { error: 409 };
        else if (error instanceof CommandCapacity) value = { error: 503 };
        else throw error;
      }
    }
  }
  if (!validConnectorHermesQueueOutput(kind, value)) throw Error('connector_storage_unavailable');
  return value as ConnectorHermesQueueCommands[K]['output'];
}
