import type { ConnectorUserStore } from './connector-user-store.js';
import { validStoppedCodexRuns, type StoppedCodexRun } from '../codex/stopped-recovery.js';

type Preservation = {
  sessionKey: string; queueSha256: string;
  execution: null | { commandId: string; connectionId: string; phase: string; sync: string;
    runId?: string; executionProtection?: { state: string; reason?: string }; cleanupRecovered: boolean };
};
export type ConnectorMaintenanceCommands = {
  runtimeMaintenanceObserve: { input: { historyRecovery: boolean }; output: {
    nodeId: string; pendingExecutions: number; queuedMessages: number; recoveryRuns?: StoppedCodexRun[];
  } };
  runtimeMaintenanceHistory: { input: Record<string, never>; output: string[] };
  runtimeMaintenanceSdkSession: { input: { key: string; runtime: 'claude-code' | 'ghcp' | 'antigravity' }; output: boolean };
  runtimeMaintenanceInteractions: { input: Record<string, never>; output: string[] };
  runtimeMaintenancePreservation: { input: { key: string; codex: boolean }; output: Preservation };
};
export type ConnectorMaintenanceKind = keyof ConnectorMaintenanceCommands;
export const connectorMaintenanceSteps = Object.freeze({ runtimeMaintenanceObserve: 336, runtimeMaintenanceHistory: 337,
  runtimeMaintenanceSdkSession: 338, runtimeMaintenanceInteractions: 339, runtimeMaintenancePreservation: 340 });
export const isConnectorMaintenanceKind = (kind: string): kind is ConnectorMaintenanceKind => Object.hasOwn(connectorMaintenanceSteps, kind);
const record = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown): v is string => typeof v === 'string' && !!v.length && Buffer.byteLength(v) <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const keys = (v: unknown): v is string[] => Array.isArray(v) && v.every(text) && new Set(v).size === v.length;
export function validConnectorMaintenanceInput(kind: ConnectorMaintenanceKind, v: unknown): boolean {
  switch (kind) {
    case 'runtimeMaintenanceObserve': return record(v, ['historyRecovery']) && typeof v.historyRecovery === 'boolean';
    case 'runtimeMaintenanceHistory': case 'runtimeMaintenanceInteractions': return record(v, []);
    case 'runtimeMaintenanceSdkSession': return record(v, ['key', 'runtime']) && ['claude-code', 'ghcp', 'antigravity'].includes(v.runtime as string)
      && text(v.key) && v.key.startsWith(`${v.runtime}:`);
    case 'runtimeMaintenancePreservation': return record(v, ['key', 'codex']) && text(v.key) && typeof v.codex === 'boolean'
      && (v.codex ? v.key.startsWith('codex:') : /^(claude-code|ghcp|antigravity):/.test(v.key));
  }
}
export function validConnectorMaintenanceOutput(kind: ConnectorMaintenanceKind, v: unknown): boolean {
  switch (kind) {
    case 'runtimeMaintenanceObserve': return record(v, ['nodeId', 'pendingExecutions', 'queuedMessages'], ['recoveryRuns'])
      && text(v.nodeId) && count(v.pendingExecutions) && count(v.queuedMessages)
      && (!Object.hasOwn(v, 'recoveryRuns') || validStoppedCodexRuns(v.recoveryRuns));
    case 'runtimeMaintenanceHistory': return keys(v) && v.every(k => k.startsWith('codex:'));
    case 'runtimeMaintenanceInteractions': return keys(v);
    case 'runtimeMaintenanceSdkSession': return typeof v === 'boolean';
    case 'runtimeMaintenancePreservation': {
      if (!record(v, ['sessionKey', 'queueSha256', 'execution']) || !text(v.sessionKey)
        || typeof v.queueSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.queueSha256)) return false;
      const e = v.execution;
      if (e === null) return true;
      if (!record(e, ['commandId', 'connectionId', 'phase', 'sync', 'cleanupRecovered'], ['runId', 'executionProtection'])
        || !['commandId', 'connectionId', 'phase', 'sync'].every(k => text(e[k])) || typeof e.cleanupRecovered !== 'boolean'
        || Object.hasOwn(e, 'runId') && !text(e.runId)) return false;
      return !Object.hasOwn(e, 'executionProtection') || record(e.executionProtection, ['state'], ['reason'])
        && text(e.executionProtection.state) && (!Object.hasOwn(e.executionProtection, 'reason') || text(e.executionProtection.reason));
    }
  }
}

/** Private root capability, like maintenanceSnapshot: never registered as a
 * public RPC. Caller lifecycle authority/fence is rechecked before delivery.
 * Every command runs on the original sole connection without interleaved await.
 * Recovery only settles existing terminal interactions; no native send/replay. */
export function createConnectorMaintenanceCommands(owner: ConnectorUserStore) {
  return function execute<K extends ConnectorMaintenanceKind>(kind: K,
    input: ConnectorMaintenanceCommands[K]['input']): ConnectorMaintenanceCommands[K]['output'] {
    if (!validConnectorMaintenanceInput(kind, input)) throw Error('Invalid maintenance command');
    let value: unknown;
    switch (kind) {
      case 'runtimeMaintenanceObserve': {
        const { historyRecovery } = input as ConnectorMaintenanceCommands['runtimeMaintenanceObserve']['input'];
        const recoveryRuns = owner.codexExecutions.maintenanceRecoveryRuns();
        value = { nodeId: owner.nodeId,
          pendingExecutions: owner.codexExecutions.maintenancePending({ historyRecovery })
            + owner.openClawExecutions.maintenancePending() + owner.hermesJournal.maintenancePending()
            + owner.claudeJournal.pendingCount() + owner.copilotJournal.pendingCount() + owner.antigravityJournal.pendingCount() + owner.interactions.unresolvedCount(),
          queuedMessages: owner.turns.maintenanceCount() + owner.mirrorOutbox.maintenancePending(),
          ...(recoveryRuns ? { recoveryRuns } : {}) }; break;
      }
      case 'runtimeMaintenanceHistory': value = owner.codexExecutions.maintenanceHistorySessions(); break;
      case 'runtimeMaintenanceSdkSession': {
        const { key, runtime } = input as ConnectorMaintenanceCommands['runtimeMaintenanceSdkSession']['input'];
        value = !!(runtime === 'claude-code' ? owner.claudeJournal : runtime === 'ghcp' ? owner.copilotJournal : owner.antigravityJournal).session(key); break;
      }
      case 'runtimeMaintenanceInteractions': value = owner.reconcileEndedInteractions(); break;
      case 'runtimeMaintenancePreservation': {
        const { key, codex } = input as ConnectorMaintenanceCommands['runtimeMaintenancePreservation']['input'];
        const e = codex ? owner.codexExecutions.get(key) : undefined;
        value = { sessionKey: key, queueSha256: owner.maintenanceQueueSha256(), execution: e ? {
          commandId: e.commandId, connectionId: e.connectionId, phase: e.phase, sync: e.sync,
          ...(e.runId ? { runId: e.runId } : {}),
          ...(e.nativeHistory ? { executionProtection: { state: e.nativeHistory.state,
            ...(e.nativeHistory.reason ? { reason: e.nativeHistory.reason } : {}) } } : {}),
          cleanupRecovered: !!e.runId && owner.codexExecutions.cleanupRecovered(key, e.runId),
        } : null }; break;
      }
    }
    if (!validConnectorMaintenanceOutput(kind, value)) throw Error('Invalid maintenance observation');
    return value as ConnectorMaintenanceCommands[K]['output'];
  };
}
