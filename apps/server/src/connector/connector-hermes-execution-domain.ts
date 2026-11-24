import type { ChatMessage } from '@agentopsdeck/shared';
import type { HermesExecution, HermesToolObservation } from '../hermes/journal.js';
import type { HermesHistoryRow } from '../hermes/history.js';
import type { ConnectorUserStore } from './connector-user-store.js';

type Page = { after: string; limit: number };
type Ack = { key: string; id: string; live: string; epoch: string; changed: boolean };
export type ConnectorHermesExecutionCommands = {
  hermesExecutionRead: { input: { sessionKey: string }; output: HermesExecution | null };
  hermesExecutionPage: { input: Page; output: string[] };
  hermesRecoveryPage: { input: Page; output: string[] };
  hermesExecutionAdmitted: { input: { execution: HermesExecution }; output: Ack };
  hermesExecutionUnknown: { input: { execution: HermesExecution }; output: Ack };
  hermesExecutionTool: { input: { execution: HermesExecution; observation: HermesToolObservation }; output: Ack & { message: ChatMessage | null } };
  hermesExecutionTerminal: { input: { execution: HermesExecution; phase: 'completed' | 'failed' | 'interrupted';
    stored: string; rows: HermesHistoryRow[] }; output: Ack };
};
export type ConnectorHermesExecutionKind = keyof ConnectorHermesExecutionCommands;
export const connectorHermesExecutionSteps = Object.freeze({ hermesExecutionRead: 143, hermesExecutionPage: 144,
  hermesRecoveryPage: 145, hermesExecutionAdmitted: 146, hermesExecutionUnknown: 147, hermesExecutionTerminal: 148, hermesExecutionTool: 160 });
export const isConnectorHermesExecutionKind = (kind: string): kind is ConnectorHermesExecutionKind => Object.hasOwn(connectorHermesExecutionSteps, kind);
// A whole native snapshot is bounded, never silently truncated. Larger original
// histories fail closed; no fallback writer, automatic prompt retry or unlock.
export const HERMES_TERMINAL_COMMAND_BYTES = 64 * 1024 * 1024;
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(key => Object.hasOwn(v, key))
  && Object.keys(v).every(key => required.includes(key) || optional.includes(key));
const id = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => id(v) && v.startsWith('hermes:') && v.length > 7;
const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
function execution(v: unknown): v is HermesExecution {
  if (!fields(v, ['id', 'key', 'live', 'epoch', 'phase', 'members', 'at', 'updated'], ['batch', 'row'])
    || !id(v.id) || !key(v.key) || !id(v.live, 1024) || !id(v.epoch, 1024)
    || !['starting', 'running', 'completed', 'failed', 'interrupted', 'unknown'].includes(String(v.phase))
    || !timestamp(v.at) || !timestamp(v.updated) || !Array.isArray(v.members) || v.members.length < 1 || v.members.length > 16
    || !v.members.every(member => id(member)) || new Set(v.members).size !== v.members.length
    || Object.hasOwn(v, 'row') && !positive(v.row)) return false;
  if (!Object.hasOwn(v, 'batch')) return v.members.length === 1;
  return fields(v.batch, ['separator', 'members']) && typeof v.batch.separator === 'string' && !!v.batch.separator
    && Buffer.byteLength(v.batch.separator) <= 4096 && Array.isArray(v.batch.members)
    && v.batch.members.length === v.members.length && v.members.length >= 2
    && v.batch.members.every((member, index) => fields(member, ['id', 'createdAt', 'imageCount'])
      && member.id === (v.members as string[])[index] && timestamp(member.createdAt) && member.imageCount === 0);
}
export { execution as validHermesExecution };
export function validHermesHistoryRows(v: unknown): v is HermesHistoryRow[] {
  if (!Array.isArray(v) || v.length > 50_000) return false;
  const ids = new Set<number>();
  return v.every(row => {
    if (!fields(row, ['role', 'text', 'timestamp'], ['row_id', 'hidden', 'toolName'])
      || !['user', 'assistant', 'system', 'tool'].includes(String(row.role)) || typeof row.text !== 'string'
      || typeof row.timestamp !== 'number' || !Number.isFinite(row.timestamp)
      || Object.hasOwn(row, 'hidden') && typeof row.hidden !== 'boolean'
      || Object.hasOwn(row, 'toolName') && (typeof row.toolName !== 'string' || row.toolName.length > 256)
      || Object.hasOwn(row, 'row_id') && (!positive(row.row_id) || ids.has(row.row_id))) return false;
    if (row.row_id !== undefined) ids.add(row.row_id as number);
    return true;
  });
}
export function validConnectorHermesExecutionInput(kind: ConnectorHermesExecutionKind, v: unknown): boolean {
  if (kind === 'hermesExecutionRead') return fields(v, ['sessionKey']) && key(v.sessionKey);
  if (kind === 'hermesExecutionPage' || kind === 'hermesRecoveryPage') return fields(v, ['after', 'limit'])
    && (v.after === '' || key(v.after)) && positive(v.limit) && v.limit <= 64;
  if (kind === 'hermesExecutionTool') return fields(v, ['execution', 'observation']) && execution(v.execution)
    && ['starting', 'running'].includes(v.execution.phase)
    && fields(v.observation, ['toolId', 'phase', 'at'], ['name']) && id(v.observation.toolId)
    && ['call', 'result'].includes(String(v.observation.phase)) && timestamp(v.observation.at)
    && (!Object.hasOwn(v.observation, 'name') || typeof v.observation.name === 'string' && v.observation.name.length <= 256);
  if (kind === 'hermesExecutionTerminal') return fields(v, ['execution', 'phase', 'stored', 'rows'])
    && execution(v.execution) && v.execution.phase === 'running' && positive(v.execution.row)
    && ['completed', 'failed', 'interrupted'].includes(String(v.phase)) && id(v.stored, 1024) && validHermesHistoryRows(v.rows)
    && v.rows.some(row => row.role === 'user' && row.row_id === (v.execution as HermesExecution).row);
  return fields(v, ['execution']) && execution(v.execution)
    && (kind !== 'hermesExecutionAdmitted' || v.execution.phase === 'running' && positive(v.execution.row));
}
export function validConnectorHermesExecutionOutput(kind: ConnectorHermesExecutionKind, v: unknown): boolean {
  if (kind === 'hermesExecutionRead') return v === null || execution(v);
  if (kind === 'hermesExecutionPage' || kind === 'hermesRecoveryPage') return Array.isArray(v) && v.length <= 64
    && v.every((item, index) => key(item) && (index === 0 || compare(v[index - 1] as string, item) < 0));
  if (!fields(v, ['key', 'id', 'live', 'epoch', 'changed', ...(kind === 'hermesExecutionTool' ? ['message'] : [])])
    || !key(v.key) || !id(v.id) || !id(v.live, 1024) || !id(v.epoch, 1024) || typeof v.changed !== 'boolean') return false;
  if (kind !== 'hermesExecutionTool') return true;
  const m = v.message;
  return v.changed === false ? m === null : fields(m, ['id', 'sessionKey', 'turnId', 'role', 'toolCallId', 'toolName', 'toolPhase', 'text', 'status', 'createdAt'])
    && m.sessionKey === v.key && m.turnId === v.id && m.role === 'tool' && typeof m.toolCallId === 'string'
    && m.toolCallId.startsWith(`${v.id}:`) && typeof m.toolName === 'string' && m.toolName.length <= 256
    && ['call', 'result'].includes(String(m.toolPhase)) && m.id === `hermes-tool:${m.toolCallId}:${m.toolPhase}`
    && m.text === `Tool: ${m.toolName}\n${m.toolPhase === 'call' ? 'Started' : 'Completed'}`
    && m.status === (m.toolPhase === 'call' ? 'sending' : 'sent') && timestamp(m.createdAt);
}

/** Internal native evidence, NOT a public execution authority or prompt claim.
 * All writes reuse the original journal's transaction and queue connection. */
export function executeConnectorHermesExecution<K extends ConnectorHermesExecutionKind>(kind: K,
  input: ConnectorHermesExecutionCommands[K]['input'], owner: Pick<ConnectorUserStore, 'hermesJournal' | 'turns'>): ConnectorHermesExecutionCommands[K]['output'] {
  if (!validConnectorHermesExecutionInput(kind, input)) throw Error('connector_storage_unavailable');
  const v = input as ConnectorHermesExecutionCommands['hermesExecutionTerminal']['input'] & Page & { sessionKey: string };
  const journal = owner.hermesJournal;
  let result: unknown;
  if (kind === 'hermesExecutionRead') {
    result = journal.current(v.sessionKey) ?? null;
    if (result !== null && (result as HermesExecution).key !== v.sessionKey) throw Error('connector_storage_unavailable');
  }
  else if (kind === 'hermesExecutionPage' || kind === 'hermesRecoveryPage') {
    // Validate the entire original page before any recovery mutation.
    const page = journal.sessionPage(v.after, v.limit);
    if (!validConnectorHermesExecutionOutput(kind, page) || page.length > v.limit || page.some(item => compare(item, v.after) <= 0)) throw Error('connector_storage_unavailable');
    if (kind === 'hermesRecoveryPage') for (const key of page) {
      const current = journal.current(key);
      if (current && (!execution(current) || current.key !== key)) throw Error('connector_storage_unavailable');
    }
    result = kind === 'hermesRecoveryPage' ? journal.recoverPage(v.after, v.limit, owner.turns) : page;
  } else if (kind === 'hermesExecutionTool') {
    const { execution: e, observation } = input as ConnectorHermesExecutionCommands['hermesExecutionTool']['input'];
    const message = journal.observeTool(e, observation);
    result = { key: e.key, id: e.id, live: e.live, epoch: e.epoch, changed: message !== null, message };
  } else {
    const e = v.execution;
    const changed = kind === 'hermesExecutionAdmitted' ? journal.admitted(e, owner.turns)
      : kind === 'hermesExecutionUnknown' ? journal.unknown(e, owner.turns)
      : journal.settleTerminal(e, v.phase, v.stored, v.rows);
    result = { key: e.key, id: e.id, live: e.live, epoch: e.epoch, changed };
  }
  if (!validConnectorHermesExecutionOutput(kind, result)) throw Error('connector_storage_unavailable');
  return result as ConnectorHermesExecutionCommands[K]['output'];
}

export type HermesReplyExpectation = { sessionKey: string } | Page | Pick<HermesExecution, 'key' | 'id' | 'live' | 'epoch'> & { tool?: { id: string; phase: 'call' | 'result' } };
export function connectorHermesReplyMatches(expected: HermesReplyExpectation, value: unknown): boolean {
  if ('after' in expected) return Array.isArray(value) && value.length <= expected.limit && value.every(item => typeof item === 'string' && compare(item, expected.after) > 0);
  if ('sessionKey' in expected) return value === null || (value as HermesExecution).key === expected.sessionKey;
  if (!value || !['key', 'id', 'live', 'epoch'].every(field =>
    (value as Record<string, unknown>)[field] === expected[field as keyof typeof expected])) return false;
  const message = (value as { message?: ChatMessage | null }).message;
  return !expected.tool || message === null || !!message
    && message.toolCallId === `${expected.id}:${expected.tool.id}` && message.toolPhase === expected.tool.phase;
}
