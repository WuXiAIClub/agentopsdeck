import { createHash } from 'node:crypto';
import { MAX_MESSAGE_CHARS, sessionRuntimeId } from '@agentopsdeck/shared';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { createTurnAuthorizer } from './execution-grants.js';
import type { OpenClawQueuedTurn, OpenClawQueuedPayload } from '../openclaw/turn-queue.js';
import type { OpenClawExecution } from '../openclaw/executions.js';
import { validConnectorExecutionOutput } from './connector-execution-domain.js';

export type OpenClawDispatchPlan = { turn: OpenClawQueuedTurn; digest: string };
export type OpenClawDispatchClaim = OpenClawDispatchPlan & { execution: OpenClawExecution };
export type OpenClawDispatchRef = { key: string; id: string; revision: number; digest: string };
export type ConnectorOpenClawDispatchCommands = {
  openClawDispatchPlan: { input: { key: string }; output: OpenClawDispatchPlan | 'blocked' | null };
  openClawDispatchClaim: { input: { key: string; id: string; digest: string; connectionId: string }; output: OpenClawDispatchClaim | null };
  openClawDispatchReady: { input: OpenClawDispatchRef; output: boolean };
  openClawDispatchCli: { input: OpenClawDispatchRef; output: OpenClawDispatchClaim | null };
  openClawDispatchAbandon: { input: OpenClawDispatchRef; output: boolean };
  openClawDispatchUnknown: { input: { key: string; id: string }; output: boolean };
};
export type ConnectorOpenClawDispatchKind = keyof ConnectorOpenClawDispatchCommands;
export const connectorOpenClawDispatchSteps = Object.freeze({ openClawDispatchPlan: 188, openClawDispatchClaim: 189,
  openClawDispatchReady: 190, openClawDispatchCli: 191, openClawDispatchAbandon: 192, openClawDispatchUnknown: 193 });
export const isConnectorOpenClawDispatchKind = (kind: string): kind is ConnectorOpenClawDispatchKind => Object.hasOwn(connectorOpenClawDispatchSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => id(v, 4096) && sessionRuntimeId(v) === 'openclaw';
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function payload(v: unknown): v is OpenClawQueuedPayload {
  return fields(v, ['message', 'deliveryMode', 'media'], ['actorId', 'executionGrant', 'explicitRoute'])
    && typeof v.message === 'string' && v.message.length <= MAX_MESSAGE_CHARS
    && (!!v.message.trim() || Array.isArray(v.media) && v.media.length > 0)
    && (v.actorId === undefined || id(v.actorId))
    && (v.deliveryMode === 'web-only' || v.deliveryMode === 'mirror')
    && (v.executionGrant === undefined || fields(v.executionGrant, ['id', 'actorId', 'issuerTokenId'])
      && id(v.executionGrant.id) && id(v.executionGrant.actorId) && id(v.executionGrant.issuerTokenId))
    && (v.explicitRoute === undefined || fields(v.explicitRoute, ['originatingChannel', 'originatingTo', 'outboundTarget'], ['originatingAccountId'])
      && id(v.explicitRoute.originatingChannel) && id(v.explicitRoute.originatingTo, 4096) && id(v.explicitRoute.outboundTarget, 4096)
      && (v.explicitRoute.originatingAccountId === undefined || id(v.explicitRoute.originatingAccountId)))
    && (v.deliveryMode !== 'mirror' || v.explicitRoute !== undefined)
    && Array.isArray(v.media) && v.media.length <= 8 && v.media.every(item => fields(item, ['media'], ['filePath', 'gatewayAttachment'])
      && item.media !== null && typeof item.media === 'object' && !Array.isArray(item.media)
      && (item.filePath === undefined || id(item.filePath, 4096)));
}
function validPlan(v: unknown): v is OpenClawDispatchPlan & { execution?: unknown } {
  return fields(v, ['turn', 'digest'], ['execution']) && digest(v.digest)
    && fields(v.turn, ['id', 'sessionKey', 'createdAt', 'state', 'payload']) && id(v.turn.id) && key(v.turn.sessionKey)
    && Number.isSafeInteger(v.turn.createdAt) && Number(v.turn.createdAt) >= 0
    && (v.turn.state === 'queued' || v.turn.state === 'dispatching') && payload(v.turn.payload);
}
export function validConnectorOpenClawDispatchInput(kind: ConnectorOpenClawDispatchKind, v: unknown): boolean {
  if (kind === 'openClawDispatchPlan') return fields(v, ['key']) && key(v.key);
  if (kind === 'openClawDispatchUnknown') return fields(v, ['key', 'id']) && key(v.key) && id(v.id);
  if (kind === 'openClawDispatchClaim') return fields(v, ['key', 'id', 'digest', 'connectionId']) && key(v.key) && id(v.id)
    && digest(v.digest) && id(v.connectionId);
  return fields(v, ['key', 'id', 'revision', 'digest']) && key(v.key) && id(v.id) && digest(v.digest)
    && Number.isSafeInteger(v.revision) && Number(v.revision) > 0;
}
export function validConnectorOpenClawDispatchOutput(kind: ConnectorOpenClawDispatchKind, v: unknown): boolean {
  if (kind === 'openClawDispatchReady' || kind === 'openClawDispatchAbandon' || kind === 'openClawDispatchUnknown') return typeof v === 'boolean';
  if (v === null) return true;
  if (kind === 'openClawDispatchPlan') return v === 'blocked' || validPlan(v) && !Object.hasOwn(v, 'execution') && v.turn.state === 'queued';
  return validPlan(v) && v.turn.state === 'dispatching' && Object.hasOwn(v, 'execution')
    && validConnectorExecutionOutput('openClawExecutionRead', v.execution)
    && (v.execution as OpenClawExecution).commandId === v.turn.id && (v.execution as OpenClawExecution).sessionKey === v.turn.sessionKey
    && (v.execution as OpenClawExecution).phase === 'starting' && !(v.execution as OpenClawExecution).reason
    && !(v.execution as OpenClawExecution).runId && Number.isSafeInteger((v.execution as OpenClawExecution).revision)
    && Number((v.execution as OpenClawExecution).revision) > 0
    && id((v.execution as OpenClawExecution).gatewayConnectionId)
    && (v.execution as OpenClawExecution).origin === (kind === 'openClawDispatchCli' ? 'cli' : 'gateway');
}

/** Internal worker lane. All identities, text, attachments and mirror routing
 * originate in the original saved queue, never a caller-provided capability. */
export function executeConnectorOpenClawDispatch<K extends ConnectorOpenClawDispatchKind>(kind: K,
  input: ConnectorOpenClawDispatchCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore): ConnectorOpenClawDispatchCommands[K]['output'] {
  if (!validConnectorOpenClawDispatchInput(kind, input) || !tokens) throw Error('connector_storage_unavailable');
  const authorize = createTurnAuthorizer(owner.executionGrants, (actor, scope) => tokens.hasScope(actor, scope));
  const allowed = (turn: OpenClawQueuedTurn) => owner.sdkCommandAdmissionOpen === true && payload(turn.payload)
    && authorize(turn.payload.actorId, { runtime: 'openclaw', sessionKey: turn.sessionKey }, 'messages:send', turn.payload.executionGrant)
    && (turn.payload.deliveryMode !== 'mirror' || authorize(turn.payload.actorId,
      { runtime: 'openclaw', sessionKey: turn.sessionKey }, 'messages:mirror', turn.payload.executionGrant));
  const head = () => owner.turns.dispatchPrefix<OpenClawQueuedPayload>('openclaw', input.key)[0];
  const snapshot = (turn: OpenClawQueuedTurn): OpenClawDispatchPlan => ({ turn,
    digest: createHash('sha256').update(JSON.stringify({ turn, version: owner.turns.version('openclaw', turn.sessionKey, turn.id) })).digest('hex') });
  const plan = (block = false): OpenClawDispatchPlan | 'blocked' | null => {
    if (owner.sdkCommandAdmissionOpen !== true) return null;
    const turn = head(), fact = owner.openClawExecutions.get(input.key);
    if (!turn || turn.state !== 'queued' || fact && (fact.commandId === turn.id || fact.reason || !['completed', 'failed'].includes(fact.phase))) return null;
    if (!allowed(turn)) { if (block) owner.turns.block('openclaw', turn.id); return 'blocked'; }
    return snapshot(turn);
  };
  const current = (ref: OpenClawDispatchRef): OpenClawDispatchClaim | null => {
    const turn = head(), execution = owner.openClawExecutions.get(ref.key);
    if (!turn || turn.id !== ref.id || turn.state !== 'dispatching' || !allowed(turn) || !execution
      || execution.commandId !== ref.id || execution.revision !== ref.revision || execution.phase !== 'starting'
      || execution.reason || execution.runId || execution.origin !== 'gateway') return null;
    const saved = snapshot(turn);
    return saved.digest === ref.digest ? { ...saved, execution } : null;
  };
  let value: unknown;
  if (kind === 'openClawDispatchPlan') value = plan(true);
  else if (kind === 'openClawDispatchClaim') {
    const v = input as ConnectorOpenClawDispatchCommands['openClawDispatchClaim']['input'];
    const selected = plan(); value = null;
    if (selected && selected !== 'blocked' && selected.turn.id === v.id && selected.digest === v.digest
      && owner.openClawExecutions.begin(v.key, v.id, db => {
        if (!allowed(selected.turn) || !owner.turns.startBatchInTransaction(db, 'openclaw', v.key, [v.id])) throw Error('connector_storage_unavailable');
      }, v.connectionId)) {
      const turn = head()!; value = { ...snapshot(turn), execution: owner.openClawExecutions.get(v.key)! };
    }
  } else if (kind === 'openClawDispatchUnknown') {
    const v = input as { key: string; id: string };
    value = owner.openClawExecutions.uncertain(v.key, v.id, () => { owner.turns.uncertain('openclaw', v.id); });
  } else {
    const v = input as OpenClawDispatchRef, claimed = current(v);
    if (kind === 'openClawDispatchReady') value = !!claimed;
    else if (kind === 'openClawDispatchCli') {
      value = claimed && claimed.turn.payload.media.length === 0 && owner.openClawExecutions.useCli(v.key, v.id)
        ? { ...snapshot(claimed.turn), execution: owner.openClawExecutions.get(v.key)! } : null;
    } else {
      // The local owner has proved it never entered a native invocation. This
      // retires only this exact starting intent; it never requeues for retry.
      const execution = owner.openClawExecutions.get(v.key), turn = head();
      value = !!turn && turn.id === v.id && turn.state === 'dispatching' && snapshot(turn).digest === v.digest
        && execution?.commandId === v.id && execution.revision === v.revision
        && execution.phase === 'starting' && !execution.reason && !execution.runId
        && owner.openClawExecutions.rejectBeforeRun(v.key, v.id, () => { owner.turns.block('openclaw', v.id); });
    }
  }
  if (!validConnectorOpenClawDispatchOutput(kind, value)) throw Error('connector_storage_unavailable');
  return value as ConnectorOpenClawDispatchCommands[K]['output'];
}
