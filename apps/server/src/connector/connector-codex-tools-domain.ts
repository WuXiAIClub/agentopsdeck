import { randomUUID } from 'node:crypto';
import { validBoardUuid } from '@agentopsdeck/shared';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { createTurnAuthorizer, type ExecutionGrantAuthority } from './execution-grants.js';
import { codexAdmissionMatches } from '../codex/dispatch-admission.js';
import { validCodexQueuePayload, type CodexQueuePayload } from './connector-codex-queue-plan-domain.js';
import { validConnectorCodexDispatchInput, type ConnectorCodexDispatchCommands } from './connector-codex-dispatch-domain.js';

type DispatchRef = ConnectorCodexDispatchCommands['codexDispatchReady']['input'];
export type CodexToolsRef = { sessionKey: string; commandId: string; connectionId: string; bindingId: string };
export type CodexToolsBinding = { enabled: false } | { enabled: true; ref: CodexToolsRef };
export type ConnectorCodexToolsCommands = {
  codexToolsBind: { input: DispatchRef; output: CodexToolsBinding | null };
  codexToolsCheck: { input: CodexToolsRef & { runId: string }; output: boolean };
  codexToolsRelease: { input: CodexToolsRef; output: boolean };
};
export type ConnectorCodexToolsKind = keyof ConnectorCodexToolsCommands;
export const connectorCodexToolsSteps = Object.freeze({ codexToolsBind: 255, codexToolsCheck: 256, codexToolsRelease: 257 });
export const isConnectorCodexToolsKind = (kind: string): kind is ConnectorCodexToolsKind => Object.hasOwn(connectorCodexToolsSteps, kind);
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const id = (v: unknown, maximum = 512): v is string => typeof v === 'string' && !!v.trim()
  && Buffer.byteLength(JSON.stringify(v)) <= maximum && !/[\x00-\x1f\x7f]/.test(v);
const validRef = (v: unknown): v is CodexToolsRef => fields(v, ['sessionKey', 'commandId', 'connectionId', 'bindingId'])
  && id(v.sessionKey, 4096) && v.sessionKey.startsWith('codex:') && v.sessionKey.length > 6
  && id(v.commandId) && id(v.connectionId) && validBoardUuid(v.bindingId);
export function validConnectorCodexToolsInput(kind: ConnectorCodexToolsKind, v: unknown): boolean {
  if (kind === 'codexToolsBind') return validConnectorCodexDispatchInput('codexDispatchReady', v);
  if (kind === 'codexToolsRelease') return validRef(v);
  if (!fields(v, ['sessionKey', 'commandId', 'connectionId', 'bindingId', 'runId']) || !id(v.runId)) return false;
  const { runId: _, ...ref } = v;
  return validRef(ref);
}
export function validConnectorCodexToolsOutput(kind: ConnectorCodexToolsKind, v: unknown): boolean {
  if (kind !== 'codexToolsBind') return typeof v === 'boolean';
  return v === null || fields(v, ['enabled']) && v.enabled === false
    || fields(v, ['enabled', 'ref']) && v.enabled === true && validRef(v.ref);
}
type Binding = { ref: CodexToolsRef; startedAt: number; actorId: string | undefined; grant?: ExecutionGrantAuthority };

/** The claimed original FIFO row, not a later HTTP caller, supplies authority.
 * Bind before native dispatch consumes that row. This physical owner's private
 * bindings have no TTL/eviction and are never reconstructed after a restart.
 * Releasing a tool capability does not settle/unlock/replay an execution. */
export function createConnectorCodexToolsCommands(owner: ConnectorUserStore, tokens?: ConnectorTokenStore) {
  const bindings = new Map<string, Binding>();
  const authorize = createTurnAuthorizer(owner.executionGrants, (actor, scope) => tokens?.hasScope(actor, scope) === true);
  const allowed = (sessionKey: string, actorId: string | undefined, grant?: ExecutionGrantAuthority) => owner.sdkCommandAdmissionOpen
    && !owner.commands.sessionDeletion(sessionKey) && !owner.codexExecutions.isDeletedTerminal(sessionKey)
    && authorize(actorId, { runtime: 'codex', sessionKey }, 'messages:send', grant);
  const same = (a: CodexToolsRef, b: CodexToolsRef) => a.sessionKey === b.sessionKey && a.commandId === b.commandId
    && a.connectionId === b.connectionId && a.bindingId === b.bindingId;
  const execute = <K extends ConnectorCodexToolsKind>(kind: K, input: ConnectorCodexToolsCommands[K]['input']): ConnectorCodexToolsCommands[K]['output'] => {
    if (!validConnectorCodexToolsInput(kind, input) || !tokens) throw Error('connector_storage_unavailable');
    let value: unknown;
    if (kind === 'codexToolsBind') {
      const v = input as DispatchRef, fact = owner.codexExecutions.get(v.sessionKey);
      const entries = codexAdmissionMatches<CodexQueuePayload>(owner.turns, v.sessionKey, v.proof,
        entry => validCodexQueuePayload(entry.payload) && !!allowed(entry.sessionKey, entry.payload.actorId, entry.payload.executionGrant), 'dispatching');
      const members = fact?.batch?.members.map(m => m.id) ?? [v.commandId];
      if (!fact || fact.commandId !== v.commandId || fact.connectionId !== v.connectionId || fact.phase !== 'starting'
        // Public facts omit the private fence; fencing always sets phase=unknown
        // and a reason, so the exact starting/running gates reject fenced facts.
        || fact.runId || fact.reason || fact.preparation || !entries || entries[0]?.id !== v.commandId
        || JSON.stringify(entries.map(e => e.id)) !== JSON.stringify(members)) value = null;
      else if (!owner.codexExecutions.hasBoardTools(v.sessionKey.slice(6))) value = { enabled: false };
      else if (bindings.size >= 128 || [...bindings.values()].some(b => b.ref.sessionKey === v.sessionKey)) value = null;
      else {
        const ref: CodexToolsRef = { sessionKey: v.sessionKey, commandId: v.commandId, connectionId: v.connectionId, bindingId: randomUUID() };
        const head = entries[0]!.payload;
        bindings.set(ref.bindingId, { ref, startedAt: fact.startedAt, actorId: head.actorId,
          ...(head.executionGrant ? { grant: structuredClone(head.executionGrant) } : {}) });
        value = { enabled: true, ref: { ...ref } };
      }
    } else {
      const v = input as CodexToolsRef & { runId?: string }, b = bindings.get(v.bindingId);
      if (!b || !same(b.ref, v)) value = false;
      else if (kind === 'codexToolsRelease') { bindings.delete(v.bindingId); value = true; }
      else {
        const fact = owner.codexExecutions.get(v.sessionKey);
        value = !!fact && fact.commandId === b.ref.commandId && fact.connectionId === b.ref.connectionId
          && fact.startedAt === b.startedAt && fact.phase === 'running' && fact.runId === v.runId && !fact.reason && !fact.preparation
          && owner.codexExecutions.hasBoardTools(v.sessionKey.slice(6)) && !!allowed(v.sessionKey, b.actorId, b.grant);
      }
    }
    if (!validConnectorCodexToolsOutput(kind, value)) throw Error('connector_storage_unavailable');
    return value as ConnectorCodexToolsCommands[K]['output'];
  };
  return Object.assign(execute, { dispose() { bindings.clear(); } });
}
