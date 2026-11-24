import type { ConnectorUserStore } from './connector-user-store.js';
import type { CodexExecution } from '../codex/executions.js';
import type { OpenClawExecution } from '../openclaw/executions.js';

type Session = { sessionKey: string };
type Page = { after: string; limit: number };
export const EXECUTION_READ_BATCH = 16;
/** Read evidence only. The original receiver retains all publication rights;
 * neither absence nor a terminal outcome grants permission to dispatch. */
export type CodexHistoryObservation = {
  execution: CodexExecution | null; deleted: boolean; outcomeUnknown: boolean;
};
export type CodexMaintenanceObservation = { pendingExecutions: number; queuedMessages: number };
export type ConnectorExecutionCommands = {
  codexMaintenanceObservation: { input: Record<string, never>; output: CodexMaintenanceObservation };
  codexExecutionRead: { input: Session; output: CodexExecution | null };
  codexHistoryObservation: { input: Session; output: CodexHistoryObservation };
  openClawExecutionRead: { input: Session; output: OpenClawExecution | null };
  openClawRecoveryCandidate: { input: Session & { connectionId: string | null }; output: OpenClawExecution | null };
  executionSessionPage: { input: Page & { runtime: 'codex' | 'openclaw' }; output: string[] };
  executionFactBatch: { input: { runtime: 'codex' | 'openclaw'; keys: string[] };
    output: (CodexExecution | OpenClawExecution | null)[] };
  codexConnectionRecoveryPage: { input: Page & { previousConnectionId: string | null; nextConnectionId: string | null }; output: string[] };
  turnQueuePending: { input: Session & { runtime: 'codex' | 'openclaw' }; output: boolean };
};
export type ConnectorExecutionKind = keyof ConnectorExecutionCommands;
export const connectorExecutionSteps = Object.freeze({
  codexExecutionRead: 39, openClawExecutionRead: 40, executionSessionPage: 41,
  codexConnectionRecoveryPage: 42, turnQueuePending: 43,
  openClawRecoveryCandidate: 194,
  codexHistoryObservation: 248,
  codexMaintenanceObservation: 249,
  executionFactBatch: 370,
});
export const isConnectorExecutionKind = (kind: string): kind is ConnectorExecutionKind => Object.hasOwn(connectorExecutionSteps, kind);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => object(v)
  && required.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => required.includes(key) || optional.includes(key));
const text = (v: unknown, maximum = 4096): v is string => typeof v === 'string' && v.length > 0 && !!v.trim()
  && !/[\u0000-\u001f\u007f]/.test(v) && Buffer.byteLength(v) <= maximum;
// Preserve exact legacy identities. OpenClaw's original journal accepts raw
// bounded strings; Codex rejects controls but does not trim an existing ID.
const rawText = (v: unknown, maximum = 4096): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= maximum;
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const runtime = (v: unknown) => v === 'codex' || v === 'openclaw';
const connection = (v: unknown) => v === null || text(v, 128);
const binary = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export function validConnectorExecutionInput(kind: ConnectorExecutionKind, v: unknown): boolean {
  if (kind === 'codexMaintenanceObservation') return fields(v, []);
  if (kind === 'openClawRecoveryCandidate') return fields(v, ['sessionKey', 'connectionId']) && rawText(v.sessionKey)
    && (v.connectionId === null || rawText(v.connectionId, 512));
  if (kind === 'codexExecutionRead' || kind === 'codexHistoryObservation' || kind === 'openClawExecutionRead') return fields(v, ['sessionKey']) && (kind === 'openClawExecutionRead' ? rawText(v.sessionKey) : text(v.sessionKey));
  if (kind === 'turnQueuePending') return fields(v, ['runtime', 'sessionKey']) && runtime(v.runtime) && rawText(v.sessionKey);
  if (kind === 'executionFactBatch') return fields(v, ['runtime', 'keys']) && runtime(v.runtime)
    && Array.isArray(v.keys) && v.keys.length > 0 && v.keys.length <= EXECUTION_READ_BATCH
    && v.keys.every((key, index, keys) => (v.runtime === 'codex' ? text(key) : rawText(key))
      && (index === 0 || binary(keys[index - 1], key) < 0));
  const extra = kind === 'executionSessionPage' ? ['runtime'] : ['previousConnectionId', 'nextConnectionId'];
  return fields(v, ['after', 'limit', ...extra]) && typeof v.after === 'string' && !v.after.includes('\0') && Buffer.byteLength(v.after) <= 4096
    && revision(v.limit) && v.limit <= 64 && (kind === 'executionSessionPage' ? runtime(v.runtime)
      : connection(v.previousConnectionId) && connection(v.nextConnectionId) && v.previousConnectionId !== v.nextConnectionId);
}
const optional = (v: Record<string, unknown>, key: string, check: (value: unknown) => boolean) => !Object.hasOwn(v, key) || check(v[key]);
export function validConnectorNativeHistory(v: unknown): boolean {
  return fields(v, ['turnId', 'fingerprint', 'connectionId', 'state', 'reason']) && text(v.turnId, 512) && text(v.connectionId, 128)
    && typeof v.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(v.fingerprint) && ['verified', 'blocked'].includes(String(v.state))
    && ['settled', 'goal-active', 'goal-paused', 'goal-blocked', 'goal-usageLimited', 'goal-budgetLimited', 'goal-unknown',
      'native-unavailable', 'background-work', 'subagent-review', 'cleanup-unconfirmed', 'changed', 'restarted'].includes(String(v.reason));
}
function batch(v: unknown): boolean {
  return fields(v, ['separator', 'members']) && typeof v.separator === 'string' && v.separator.length > 0 && Buffer.byteLength(v.separator) <= 4096
    && Array.isArray(v.members) && v.members.length >= 2 && v.members.length <= 16
    && v.members.every(member => fields(member, ['id', 'createdAt', 'imageCount']) && text(member.id, 512) && typeof member.createdAt === 'number' && Number.isFinite(member.createdAt)
      && Number.isSafeInteger(member.imageCount) && Number(member.imageCount) >= 0)
    && new Set(v.members.map(member => member.id)).size === v.members.length;
}
function fact(v: unknown, codex: boolean): boolean {
  const required = ['sessionKey', 'commandId', 'phase', 'startedAt', 'updatedAt', ...(codex ? ['connectionId', 'sync', 'revision'] : ['origin'])];
  const extra = codex ? ['preparation', 'pendingCommandTools', 'batch', 'nativeHistory'] : ['gatewayConnectionId', 'revision', 'historySync'];
  const identity = codex ? text : rawText;
  if (!fields(v, required, ['runId', 'completedAt', 'reason', ...extra]) || !identity(v.sessionKey) || !identity(v.commandId, 512)
    || !nonnegative(v.startedAt) || !nonnegative(v.updatedAt) || !optional(v, 'completedAt', nonnegative) || !optional(v, 'runId', value => identity(value, 512))) return false;
  if (codex) return text(v.connectionId, 128) && revision(v.revision) && ['starting', 'running', 'unknown', 'completed', 'failed', 'interrupted'].includes(String(v.phase))
    && ['current', 'syncing', 'error'].includes(String(v.sync)) && optional(v, 'preparation', value => value === 'active' || value === 'ready')
    && optional(v, 'reason', value => ['restarted', 'send_unknown', 'preparation_unknown', 'identity_conflict', 'evidence_overflow'].includes(String(value)))
    && optional(v, 'batch', batch) && optional(v, 'nativeHistory', validConnectorNativeHistory)
    && optional(v, 'pendingCommandTools', value => Array.isArray(value) && Buffer.byteLength(JSON.stringify(value)) <= 2048
      && value.every(item => text(item, 512) && item.trim() === item) && new Set(value).size === value.length);
  return ['gateway', 'cli'].includes(String(v.origin)) && ['starting', 'running', 'waiting', 'unknown', 'completed', 'failed'].includes(String(v.phase))
    && optional(v, 'gatewayConnectionId', value => rawText(value, 512)) && optional(v, 'revision', revision)
    && optional(v, 'reason', value => ['send_unknown', 'restarted', 'run_unbound', 'ack_conflict', 'terminal_conflict', 'evidence_overflow', 'unowned_run'].includes(String(value)))
    && optional(v, 'historySync', value => fields(value, ['revision', 'state']) && revision(value.revision) && ['pending', 'error', 'current'].includes(String(value.state)));
}
export function validConnectorExecutionOutput(kind: ConnectorExecutionKind, v: unknown): boolean {
  if (kind === 'codexMaintenanceObservation') return fields(v, ['pendingExecutions', 'queuedMessages'])
    && [v.pendingExecutions, v.queuedMessages].every(n => Number.isSafeInteger(n) && Number(n) >= 0);
  if (kind === 'codexHistoryObservation') return fields(v, ['execution', 'deleted', 'outcomeUnknown'])
    && (v.execution === null || fact(v.execution, true)) && typeof v.deleted === 'boolean' && typeof v.outcomeUnknown === 'boolean';
  if (kind === 'turnQueuePending') return typeof v === 'boolean';
  if (kind === 'executionFactBatch') return Array.isArray(v) && v.length > 0 && v.length <= EXECUTION_READ_BATCH
    && v.every(value => value === null || fact(value, true) || fact(value, false));
  if (kind === 'codexExecutionRead' || kind === 'openClawExecutionRead' || kind === 'openClawRecoveryCandidate') return v === null || fact(v, kind === 'codexExecutionRead');
  return Array.isArray(v) && v.length <= 64 && v.every((key, index) => rawText(key) && (index === 0 || binary(v[index - 1]!, key) < 0));
}
export type ExecutionOwner = Pick<ConnectorUserStore, 'codexExecutions' | 'openClawExecutions' | 'turns'>;

/** Shared by the original native connection observer and the fixed worker
 * command. Validate the entire bounded page before strengthening protection;
 * an unreadable fact must never be mistaken for a successfully drained page. */
export function settleCodexConnectionRecoveryPage(
  input: ConnectorExecutionCommands['codexConnectionRecoveryPage']['input'], journal: ExecutionOwner['codexExecutions']): string[] {
  if (!validConnectorExecutionInput('codexConnectionRecoveryPage', input)) throw Error('connector_storage_unavailable');
  const page = journal.sessionPage(input.after, input.limit);
  if (!validConnectorExecutionOutput('codexConnectionRecoveryPage', page) || page.length > input.limit
    || page.some(key => binary(key, input.after) <= 0)) throw Error('connector_storage_unavailable');
  const facts = page.map(key => {
    const fact = journal.get(key);
    if (!fact || !validConnectorExecutionOutput('codexExecutionRead', fact) || fact.sessionKey !== key) throw Error('connector_storage_unavailable');
    return fact;
  });
  for (const fact of facts) {
    if (input.nextConnectionId && input.previousConnectionId) journal.disconnectAcknowledged(fact.sessionKey, input.previousConnectionId);
    if (fact.nativeHistory && fact.nativeHistory.connectionId !== input.nextConnectionId) journal.invalidateNativeHistory(fact.sessionKey, 'restarted');
  }
  return page;
}
/** Fixed original-journal observations, not permission to dispatch. Connection
 * replacement only strengthens protection: acknowledged runs become unknown,
 * terminal native proofs become blocked. No execution, replay or unlock. Each
 * original mutation retains its own synchronous transaction and journal sinks. */
export function executeConnectorExecution<K extends ConnectorExecutionKind>(kind: K,
  input: ConnectorExecutionCommands[K]['input'], owner: ExecutionOwner): ConnectorExecutionCommands[K]['output'] {
  if (!validConnectorExecutionInput(kind, input)) throw Error('connector_storage_unavailable');
  const v = input as Record<string, unknown>;
  let value: unknown;
  if (kind === 'codexMaintenanceObservation') value = { pendingExecutions: owner.codexExecutions.maintenancePending(),
    queuedMessages: owner.turns.maintenanceCount('codex') };
  else if (kind === 'codexExecutionRead') value = owner.codexExecutions.get(v.sessionKey as string) ?? null;
  else if (kind === 'codexHistoryObservation') {
    const sessionKey = v.sessionKey as string, execution = owner.codexExecutions.get(sessionKey) ?? null;
    if (execution && execution.sessionKey !== sessionKey) throw Error('connector_storage_unavailable');
    // One worker invocation, no awaits or external callbacks between these
    // original reads. Unknown FIFO outcomes survive unowned transcript reads.
    value = { execution, deleted: owner.codexExecutions.isDeletedTerminal(sessionKey),
      outcomeUnknown: owner.turns.head('codex', sessionKey)?.state === 'outcome_unknown'
        || owner.codexExecutions.nativeResumes.pending(sessionKey) };
  }
  else if (kind === 'openClawExecutionRead') value = owner.openClawExecutions.get(v.sessionKey as string) ?? null;
  else if (kind === 'openClawRecoveryCandidate') value = owner.openClawExecutions.recoveryCandidate(v.sessionKey as string, (v.connectionId as string | null) ?? undefined) ?? null;
  else if (kind === 'turnQueuePending') value = owner.turns.hasPending(v.runtime as string, v.sessionKey as string);
  else if (kind === 'executionFactBatch') {
    const batch = input as ConnectorExecutionCommands['executionFactBatch']['input'];
    const codex = batch.runtime === 'codex';
    const journal = codex ? owner.codexExecutions : owner.openClawExecutions;
    value = batch.keys.map(key => {
      const current = journal.get(key) ?? null;
      if (current !== null && (current.sessionKey !== key || !fact(current, codex))) throw Error('connector_storage_unavailable');
      return current;
    });
  }
  else if (kind === 'codexConnectionRecoveryPage') value = settleCodexConnectionRecoveryPage(
    input as ConnectorExecutionCommands['codexConnectionRecoveryPage']['input'], owner.codexExecutions);
  else {
    const journal = v.runtime === 'codex' ? owner.codexExecutions : owner.openClawExecutions;
    const page = journal.sessionPage(v.after as string, v.limit as number);
    // Validate the complete original page BEFORE any effect. Never slice or
    // deduplicate a corrupt page into a apparently valid recovery result.
    if (!validConnectorExecutionOutput(kind, page) || page.length > Number(v.limit) || page.some(key => binary(key, v.after as string) <= 0)) throw Error('connector_storage_unavailable');
    value = page;
  }
  if (!validConnectorExecutionOutput(kind, value)) throw Error('connector_storage_unavailable');
  if ((kind === 'codexExecutionRead' || kind === 'openClawExecutionRead' || kind === 'openClawRecoveryCandidate') && value !== null
    && (value as { sessionKey: string }).sessionKey !== v.sessionKey) throw Error('connector_storage_unavailable');
  return value as ConnectorExecutionCommands[K]['output'];
}
