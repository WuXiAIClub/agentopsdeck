import type { SessionExecutionSnapshot } from '@agentopsdeck/shared';

const statuses = ['idle', 'running', 'failed', 'waiting', 'pending_subagent', 'unknown'];
const phases = ['starting', 'running', 'waiting', 'finalizing', 'completed', 'failed', 'interrupted', 'unknown'];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid execution snapshot');
  return value as Record<string, unknown>;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error('Invalid execution state');
  return value as T;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid execution timestamp/count');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid execution flag');
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid execution identity');
  return value;
}

/** Used on both sides of the Connector boundary. Never forward arbitrary
 * upstream fields or reinterpret transport failure as an idle execution.
 * SessionRef is set by the Hub from its pinned node, not trusted from upstream.
 */
export function sessionExecutionSnapshot(value: unknown, sessionKey: string, sourceCursor?: string): SessionExecutionSnapshot {
  const row = object(value);
  if (identifier(row.sessionKey) !== sessionKey) throw new Error('Execution snapshot identity mismatch');
  const result: SessionExecutionSnapshot = { sessionKey, status: choice(row.status, statuses) as SessionExecutionSnapshot['status'] };
  for (const key of ['runStartedAt', 'runCompletedAt'] as const) if (row[key] !== undefined) result[key] = count(row[key]);
  if (row.hasActiveRun !== undefined) result.hasActiveRun = boolean(row.hasActiveRun);
  if (row.runtime !== undefined) {
    const runtime = object(row.runtime);
    result.runtime = {
      phase: choice(runtime.phase, phases) as NonNullable<SessionExecutionSnapshot['runtime']>['phase'],
      connection: choice(runtime.connection, ['connected', 'disconnected']),
      sync: choice(runtime.sync, ['current', 'syncing', 'error']), lastEventAt: count(runtime.lastEventAt),
      ...(runtime.turnId === undefined ? {} : { turnId: identifier(runtime.turnId) }),
      ...(runtime.threadActivity === undefined ? {} : { threadActivity: choice(runtime.threadActivity, ['idle', 'running', 'waiting', 'unknown']) }),
    };
  }
  if (row.structuredStatus !== undefined) {
    const state = object(row.structuredStatus);
    result.structuredStatus = {
      runState: choice(state.runState, ['idle', 'running', 'failed', 'waiting', 'unknown']),
      childState: choice(state.childState, ['idle', 'pending', 'unknown']),
      pendingSubagentCount: count(state.pendingSubagentCount), hasActiveRun: boolean(state.hasActiveRun),
      displayStatus: choice(state.displayStatus, statuses) as SessionExecutionSnapshot['status'],
    };
  }
  const cursor = sourceCursor ?? row.sourceCursor;
  if (cursor !== undefined) result.sourceCursor = identifier(cursor);
  return result;
}
