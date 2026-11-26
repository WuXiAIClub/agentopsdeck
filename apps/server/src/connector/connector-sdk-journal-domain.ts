import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { SdkAgentId, SdkCompactRef, SdkCompactResult, SdkJournalSnapshot, SdkTerminalOutcome } from './sdk-execution-journal.js';
import { SDK_JOURNAL_SNAPSHOT_BYTES } from './sdk-execution-journal.js';
import { validateSdkMetricSample, metricNumber, type SdkMetricSample } from './sdk-metrics.js';
import { validSdkModel } from './sdk-models.js';

type Scope = { runtime: SdkAgentId };
type Execution = Scope & { ref: SdkCompactRef };
export type ConnectorSdkJournalCommands = {
  sdkSnapshotRead: { input: Scope & { key: string }; output: SdkJournalSnapshot };
  sdkSessionPage: { input: Scope & { after: string; limit: number }; output: string[] };
  sdkPendingCount: { input: Scope; output: number };
  sdkExecutionAcknowledge: { input: Execution & { nativeRequestId: string }; output: boolean };
  sdkExecutionStop: { input: Execution; output: boolean };
  sdkExecutionTerminal: { input: Execution & { outcome: SdkTerminalOutcome }; output: boolean };
  sdkExecutionSettle: { input: Execution & { historyPersisted: boolean; nativeQuiescent: boolean }; output: boolean };
  sdkExecutionUnknown: { input: Execution; output: boolean };
  sdkCompactTerminal: { input: Execution & { result: SdkCompactResult }; output: boolean };
  sdkCompactStop: { input: Execution; output: boolean };
  sdkCompactSettle: { input: Execution & { completionEventId: string; historyPersisted: boolean; nativeQuiescent: boolean }; output: boolean };
  sdkMetricsObserve: { input: Execution & { sample: SdkMetricSample }; output: boolean };
};
export type ConnectorSdkJournalKind = keyof ConnectorSdkJournalCommands;
export const connectorSdkJournalSteps = Object.freeze({
  sdkSnapshotRead: 64, sdkSessionPage: 65, sdkPendingCount: 66, sdkExecutionAcknowledge: 67,
  sdkExecutionStop: 68, sdkExecutionTerminal: 69, sdkExecutionSettle: 70, sdkExecutionUnknown: 71,
  sdkCompactTerminal: 72, sdkCompactStop: 73, sdkCompactSettle: 74, sdkMetricsObserve: 75,
});
// Up to256 reconciled root calls, still covered by the whole owner's12MiB
// pending admission budget. This allowance does not enlarge other commands.
export const SDK_METRICS_COMMAND_BYTES = 512 * 1024;
export const isConnectorSdkJournalKind = (kind: string): kind is ConnectorSdkJournalKind => Object.hasOwn(connectorSdkJournalSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => v !== null
  && typeof v === 'object' && !Array.isArray(v) && required.every(key => Object.hasOwn(v, key))
  && Object.keys(v).every(key => required.includes(key) || optional.includes(key));
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const runtime = (v: unknown): v is SdkAgentId => v === 'claude-code' || v === 'ghcp' || v === 'antigravity';
const key = (v: unknown, r?: unknown): v is string => id(v) && runtime(sessionRuntimeId(v))
  && v !== `${sessionRuntimeId(v)}:` && (r === undefined || sessionRuntimeId(v) === r);
const outcome = (v: unknown) => v === 'completed' || v === 'failed' || v === 'interrupted';
const model = (v: unknown) => typeof v === 'string' && validSdkModel(v);
const sample = (v: unknown): boolean => { try { validateSdkMetricSample(v); return true; } catch { return false; } };
const ref = (v: unknown, r: unknown): v is SdkCompactRef => fields(v, ['id', 'key', 'epoch', 'nativeSessionId'])
  && id(v.id) && key(v.key, r) && id(v.epoch) && id(v.nativeSessionId);
export function validConnectorSdkJournalInput(kind: ConnectorSdkJournalKind, value: unknown): boolean {
  if (!fields(value, ['runtime'], ['key', 'after', 'limit', 'ref', 'nativeRequestId', 'outcome', 'result',
    'completionEventId', 'historyPersisted', 'nativeQuiescent', 'sample']) || !runtime(value.runtime)) return false;
  switch (kind) {
    case 'sdkSnapshotRead': return fields(value, ['runtime', 'key']) && key(value.key, value.runtime);
    case 'sdkSessionPage': return fields(value, ['runtime', 'after', 'limit']) && (value.after === '' || key(value.after, value.runtime))
      && metricNumber(value.limit) && value.limit >= 1 && value.limit <= 64;
    case 'sdkPendingCount': return fields(value, ['runtime']);
    default: if (!ref(value.ref, value.runtime)) return false;
  }
  switch (kind) {
    case 'sdkExecutionStop': case 'sdkExecutionUnknown': case 'sdkCompactStop': return fields(value, ['runtime', 'ref']);
    case 'sdkExecutionAcknowledge': return fields(value, ['runtime', 'ref', 'nativeRequestId']) && id(value.nativeRequestId);
    case 'sdkExecutionTerminal': return fields(value, ['runtime', 'ref', 'outcome']) && outcome(value.outcome);
    case 'sdkExecutionSettle': return fields(value, ['runtime', 'ref', 'historyPersisted', 'nativeQuiescent'])
      && typeof value.historyPersisted === 'boolean' && typeof value.nativeQuiescent === 'boolean';
    case 'sdkCompactTerminal': return fields(value, ['runtime', 'ref', 'result'])
      && fields(value.result, ['nativeRequestId', 'completionEventId', 'outcome'])
      && id(value.result.nativeRequestId) && id(value.result.completionEventId) && outcome(value.result.outcome);
    case 'sdkCompactSettle': return fields(value, ['runtime', 'ref', 'completionEventId', 'historyPersisted', 'nativeQuiescent'])
      && id(value.completionEventId) && typeof value.historyPersisted === 'boolean' && typeof value.nativeQuiescent === 'boolean';
    case 'sdkMetricsObserve': return fields(value, ['runtime', 'ref', 'sample']) && sample(value.sample)
      && (!Object.hasOwn(value.sample as object, 'reconciledCalls') || value.runtime === 'claude-code');
  }
}
function metrics(v: unknown): boolean {
  if (!fields(v, [], ['executionId', 'sequence', 'context', 'usage', 'compactionCount'])
    || v.executionId !== undefined && !id(v.executionId) || v.sequence !== undefined && !metricNumber(v.sequence)
    || v.compactionCount !== undefined && !metricNumber(v.compactionCount)) return false;
  return sample({ eventId: 'snapshot', sequence: 1, compacted: true, ...(v.context !== undefined ? { context: v.context } : {}),
    ...(v.usage !== undefined ? { usage: v.usage } : {}) });
}
export function validSdkJournalSnapshot(v: unknown): v is SdkJournalSnapshot {
  if (!fields(v, ['session', 'execution', 'deletion', 'canStart', 'unresolved'])
    || typeof v.canStart !== 'boolean' || typeof v.unresolved !== 'boolean') return false;
  const s = v.session, e = v.execution, d = v.deletion;
  if (s !== null && (!fields(s, ['key', 'nativeSessionId', 'title', 'createdAt', 'nativeState'], ['model', 'metrics'])
    || !key(s.key) || !id(s.nativeSessionId) || typeof s.title !== 'string' || s.title.length > 512 || !metricNumber(s.createdAt)
    || !['allocated', 'starting', 'ready', 'unknown'].includes(s.nativeState as string)
    || s.model !== undefined && !model(s.model) || s.metrics !== undefined && !metrics(s.metrics))) return false;
  if (d !== null && (!fields(d, ['id', 'key', 'nativeSessionId', 'phase', 'createdAt']) || !id(d.id) || !key(d.key)
    || !id(d.nativeSessionId) || !['pending', 'unknown', 'deleted'].includes(d.phase as string) || !metricNumber(d.createdAt))) return false;
  if (e !== null) {
    if (!fields(e, ['id', 'key', 'epoch', 'nativeSessionId', 'members', 'nativeMode', 'phase', 'stopRequested', 'createdAt', 'updatedAt'],
      ['kind', 'control', 'nativeRequestId', 'model', 'batch', 'outcome']) || !id(e.id) || !key(e.key) || !id(e.epoch) || !id(e.nativeSessionId)
      || !Array.isArray(e.members) || e.members.length > 16 || !e.members.every(id) || new Set(e.members).size !== e.members.length
      || !['create', 'resume'].includes(e.nativeMode as string) || !['dispatching', 'running', 'settling', 'completed', 'failed', 'interrupted', 'unknown'].includes(e.phase as string)
      || typeof e.stopRequested !== 'boolean' || !metricNumber(e.createdAt) || !metricNumber(e.updatedAt)
      || e.nativeRequestId !== undefined && !id(e.nativeRequestId) || e.model !== undefined && !model(e.model)
      || e.outcome !== undefined && !outcome(e.outcome)) return false;
    if (e.kind === 'compact') {
      if (e.members.length !== 0 || e.nativeMode !== 'resume' || e.batch !== undefined
        || !fields(e.control, ['actorId'], ['completionEventId']) || !id(e.control.actorId)
        || e.control.completionEventId !== undefined && !id(e.control.completionEventId)) return false;
    } else if (e.kind !== undefined && e.kind !== 'message' || e.control !== undefined || e.members.length < 1) return false;
    if (e.batch !== undefined) {
      const b = e.batch;
      if (!fields(b, ['separator', 'members']) || typeof b.separator !== 'string'
        || !/^\n\n\[Queued message boundary [a-f0-9-]{36}\]\n\n$/.test(b.separator)
        || !Array.isArray(b.members) || b.members.length < 1 || b.members.length !== e.members.length
        || !b.members.every((m, i) => fields(m, ['id', 'createdAt', 'imageCount']) && m.id === (e.members as string[])[i]
          && metricNumber(m.createdAt) && metricNumber(m.imageCount))) return false;
    }
  }
  const records = [s, e, d].filter(value => value !== null) as Record<string, unknown>[];
  const session = s as Record<string, unknown> | null, execution = e as Record<string, unknown> | null, deletion = d as Record<string, unknown> | null;
  const unresolved = deletion !== null ? deletion.phase !== 'deleted'
    : !!session && !['allocated', 'ready'].includes(session.nativeState as string) || !!execution && !outcome(execution.phase);
  return records.every(record => record.key === records[0]!.key && record.nativeSessionId === records[0]!.nativeSessionId)
    && v.unresolved === unresolved
    && (!v.canStart || !!session && deletion === null && ['allocated', 'ready'].includes(session.nativeState as string)
      && (!execution || outcome(execution.phase)))
    && !(d !== null && (d as { phase: string }).phase === 'deleted' && s !== null)
    && Buffer.byteLength(JSON.stringify(v)) <= SDK_JOURNAL_SNAPSHOT_BYTES + 1024;
}
export function validConnectorSdkJournalOutput(kind: ConnectorSdkJournalKind, v: unknown): boolean {
  if (kind === 'sdkSnapshotRead') return validSdkJournalSnapshot(v);
  if (kind === 'sdkSessionPage') return Array.isArray(v) && v.length <= 64 && v.every(value => key(value));
  if (kind === 'sdkPendingCount') return metricNumber(v);
  return typeof v === 'boolean';
}

/** Fixed observations on the ONE original journal/queue. Admission, creation,
 * deletion, settings and compact intent are intentionally not exposed without
 * their original fresh authorization/receipt transaction. No provider/replay. */
export function executeConnectorSdkJournal<K extends ConnectorSdkJournalKind>(kind: K,
  input: ConnectorSdkJournalCommands[K]['input'], owner: Pick<ConnectorUserStore, 'claudeJournal' | 'copilotJournal' | 'antigravityJournal' | 'turns'>): ConnectorSdkJournalCommands[K]['output'] {
  if (!validConnectorSdkJournalInput(kind, input)) throw Error('connector_storage_unavailable');
  const journal = input.runtime === 'claude-code' ? owner.claudeJournal : input.runtime === 'ghcp' ? owner.copilotJournal : owner.antigravityJournal;
  const v = input as Execution & { nativeRequestId: string; outcome: SdkTerminalOutcome; result: SdkCompactResult;
    completionEventId: string; historyPersisted: boolean; nativeQuiescent: boolean; sample: SdkMetricSample };
  let value: unknown;
  if (kind === 'sdkSnapshotRead') {
    const key = (input as { key: string }).key;
    const snapshot = journal.readSnapshot(key);
    if ([snapshot.session, snapshot.execution, snapshot.deletion].some(record => record !== null && record.key !== key)) throw Error('connector_storage_unavailable');
    value = snapshot;
  }
  else if (kind === 'sdkSessionPage') {
    const p = input as { after: string; limit: number };
    value = journal.sessionKeys(p.after || undefined, p.limit);
    if ((value as string[]).some(key => sessionRuntimeId(key) !== input.runtime)) throw Error('connector_storage_unavailable');
  } else if (kind === 'sdkPendingCount') value = journal.pendingCount();
  else {
    const snapshot = journal.readSnapshot(v.ref.key);
    if (!validSdkJournalSnapshot(snapshot) || [snapshot.session, snapshot.execution, snapshot.deletion]
      .some(record => record !== null && record.key !== v.ref.key)) throw Error('connector_storage_unavailable');
    const e = snapshot.execution;
    if (!e || e.id !== v.ref.id || e.epoch !== v.ref.epoch || e.nativeSessionId !== v.ref.nativeSessionId) return false as ConnectorSdkJournalCommands[K]['output'];
    switch (kind) {
      case 'sdkExecutionAcknowledge': value = journal.acknowledge(v.ref, v.nativeRequestId, owner.turns); break;
      case 'sdkExecutionStop': value = journal.requestStop(v.ref); break;
      case 'sdkExecutionTerminal': value = journal.observeTerminal(v.ref, v.outcome, owner.turns); break;
      case 'sdkExecutionSettle': value = v.historyPersisted && v.nativeQuiescent && journal.confirmSettled(v.ref); break;
      case 'sdkExecutionUnknown': value = journal.markUnknown(v.ref, owner.turns); break;
      case 'sdkCompactTerminal': value = journal.observeCompactTerminal(v.ref, v.result); break;
      case 'sdkCompactStop': value = journal.requestCompactStop(v.ref); break;
      case 'sdkCompactSettle': value = journal.confirmCompactSettled({ ...v.ref, completionEventId: v.completionEventId,
        historyPersisted: v.historyPersisted, nativeQuiescent: v.nativeQuiescent }); break;
      case 'sdkMetricsObserve': value = journal.recordMetrics(v.ref, v.sample); break;
    }
  }
  if (!validConnectorSdkJournalOutput(kind, value)) throw Error('connector_storage_unavailable');
  return value as ConnectorSdkJournalCommands[K]['output'];
}
