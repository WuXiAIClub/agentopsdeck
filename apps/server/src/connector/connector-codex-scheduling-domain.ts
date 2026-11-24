import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { CodexExecution } from '../codex/executions.js';
import type { TurnState } from '../commands/turn-queue.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { createTurnAuthorizer, createTurnObserver } from './execution-grants.js';
import { validCodexQueuePayload } from './connector-codex-queue-plan-domain.js';
import { validConnectorExecutionOutput } from './connector-execution-domain.js';

export type CodexSchedulingObservation = {
  sessionKey: string;
  execution: CodexExecution | null;
  deleted: boolean;
  outcomeUnknown: boolean;
  admissionOpen: boolean;
  head: { id: string; version: string; state: TurnState; authorized: boolean } | null;
};
export type CodexSchedulingRecheck = {
  sessionKey: string; executionRevision: number | null; headId: string; headVersion: string;
};
export type ConnectorCodexSchedulingCommands = {
  codexSchedulingObservation: { input: { sessionKey: string }; output: CodexSchedulingObservation };
  codexSchedulingRecheck: { input: CodexSchedulingRecheck; output: boolean };
  codexSchedulingRejectHead: { input: CodexSchedulingRecheck; output: boolean };
};
export type ConnectorCodexSchedulingKind = keyof ConnectorCodexSchedulingCommands;
export const connectorCodexSchedulingSteps = Object.freeze({ codexSchedulingObservation: 250, codexSchedulingRecheck: 251,
  codexSchedulingRejectHead: 259 });
export const isConnectorCodexSchedulingKind = (kind: string): kind is ConnectorCodexSchedulingKind =>
  Object.hasOwn(connectorCodexSchedulingSteps, kind);
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const id = (v: unknown, maximum = 512): v is string => typeof v === 'string' && !!v.trim()
  && Buffer.byteLength(JSON.stringify(v)) <= maximum && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => id(v, 4096) && v.startsWith('codex:') && v.length > 6;
const version = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}:(0|[1-9][0-9]{0,18})$/.test(v)
  && v.split(':').every(n => BigInt(n) <= 9223372036854775807n);
const revision = (v: unknown) => v === null || typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export function validConnectorCodexSchedulingInput(kind: ConnectorCodexSchedulingKind, v: unknown): boolean {
  return kind === 'codexSchedulingObservation' ? fields(v, ['sessionKey']) && key(v.sessionKey)
    : fields(v, ['sessionKey', 'executionRevision', 'headId', 'headVersion']) && key(v.sessionKey)
      && revision(v.executionRevision) && id(v.headId) && version(v.headVersion);
}
export function validConnectorCodexSchedulingOutput(kind: ConnectorCodexSchedulingKind, v: unknown): boolean {
  if (kind !== 'codexSchedulingObservation') return typeof v === 'boolean';
  if (!fields(v, ['sessionKey', 'execution', 'deleted', 'outcomeUnknown', 'admissionOpen', 'head']) || !key(v.sessionKey)
    || !validConnectorExecutionOutput('codexExecutionRead', v.execution)
    || v.execution !== null && (v.execution as CodexExecution).sessionKey !== v.sessionKey
    || typeof v.deleted !== 'boolean' || typeof v.outcomeUnknown !== 'boolean' || typeof v.admissionOpen !== 'boolean') return false;
  if (v.head === null) return true;
  return fields(v.head, ['id', 'version', 'state', 'authorized']) && id(v.head.id) && version(v.head.version)
    && ['queued', 'dispatching', 'outcome_unknown', 'blocked'].includes(String(v.head.state)) && typeof v.head.authorized === 'boolean'
    && (v.head.state !== 'outcome_unknown' || v.outcomeUnknown === true)
    && (!v.head.authorized || v.head.state === 'queued' && v.admissionOpen && !v.deleted && !v.outcomeUnknown);
}

/** Same physical owner, no await between FIFO/version/current identity reads.
 * Neither a positive observation nor recheck claims a turn or grants a native
 * effect lease. Read-only predecessor recovery must not depend on head rights.
 * Native resume needs its own durable intent before enabling the consumer. */
export function executeConnectorCodexScheduling<K extends ConnectorCodexSchedulingKind>(kind: K,
  input: ConnectorCodexSchedulingCommands[K]['input'], owner: ConnectorUserStore,
  tokens?: ConnectorTokenStore): ConnectorCodexSchedulingCommands[K]['output'] {
  if (!validConnectorCodexSchedulingInput(kind, input)) throw Error('connector_storage_unavailable');
  if (kind === 'codexSchedulingRejectHead') {
    const expected = input as CodexSchedulingRecheck;
    const changed = owner.turns.blockQueuedHead('codex', expected.sessionKey, expected.headId, expected.headVersion, () => {
      const execution = owner.codexExecutions.get(expected.sessionKey);
      if ((execution?.revision ?? null) !== expected.executionRevision || execution?.phase === 'unknown'
        || !owner.sdkCommandAdmissionOpen || owner.commands.sessionDeletion(expected.sessionKey)
        || owner.codexExecutions.isDeletedTerminal(expected.sessionKey)
        || owner.codexExecutions.nativeResumes.pending(expected.sessionKey)) return false;
      const entry = owner.turns.head<unknown>('codex', expected.sessionKey)!;
      // This is a mutation command, not the pure-read observation above. In
      // particular, expired delegated authority must retain sticky revocation.
      const authorize = createTurnAuthorizer(owner.executionGrants, (actor, scope) => tokens?.hasScope(actor, scope) === true);
      return !validCodexQueuePayload(entry.payload)
        || !authorize(entry.payload.actorId, { runtime: 'codex', sessionKey: expected.sessionKey }, 'messages:send', entry.payload.executionGrant);
    });
    return changed as ConnectorCodexSchedulingCommands[K]['output'];
  }
  const { sessionKey } = input, execution = owner.codexExecutions.get(sessionKey) ?? null;
  const deleted = !!owner.commands.sessionDeletion(sessionKey) || owner.codexExecutions.isDeletedTerminal(sessionKey);
  const admissionOpen = owner.sdkCommandAdmissionOpen === true;
  const entry = owner.turns.head<unknown>('codex', sessionKey);
  const outcomeUnknown = entry?.state === 'outcome_unknown' || owner.codexExecutions.nativeResumes.pending(sessionKey);
  const authorize = createTurnObserver(owner.executionGrants, (actor, scope) => tokens?.hasScope(actor, scope) === true);
  const head = entry ? { id: entry.id, version: owner.turns.version('codex', sessionKey, entry.id)!, state: entry.state,
    authorized: !deleted && !outcomeUnknown && admissionOpen && entry.state === 'queued' && validCodexQueuePayload(entry.payload)
      && authorize(entry.payload.actorId, { runtime: 'codex', sessionKey }, 'messages:send', entry.payload.executionGrant) } : null;
  const observation: CodexSchedulingObservation = { sessionKey, execution, deleted, admissionOpen,
    outcomeUnknown, head };
  if (!validConnectorCodexSchedulingOutput('codexSchedulingObservation', observation)) throw Error('connector_storage_unavailable');
  if (kind === 'codexSchedulingObservation') return observation as ConnectorCodexSchedulingCommands[K]['output'];
  const expected = input as CodexSchedulingRecheck;
  return (!!head?.authorized && (execution?.revision ?? null) === expected.executionRevision
    && head.id === expected.headId && head.version === expected.headVersion) as ConnectorCodexSchedulingCommands[K]['output'];
}
