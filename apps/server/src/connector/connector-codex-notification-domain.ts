import { settleCodexNativeNotification, type CodexNativeNotification, type CodexNativeNotificationResult } from '../codex/native-notification.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validConnectorExecutionOutput } from './connector-execution-domain.js';

export type ConnectorCodexNotificationCommands = {
  codexNativeNotification: { input: CodexNativeNotification; output: CodexNativeNotificationResult };
};
export type ConnectorCodexNotificationKind = keyof ConnectorCodexNotificationCommands;
export const connectorCodexNotificationSteps = Object.freeze({ codexNativeNotification: 217 });
export const isConnectorCodexNotificationKind = (kind: string): kind is ConnectorCodexNotificationKind => Object.hasOwn(connectorCodexNotificationSteps, kind);
const fields = (v: unknown, keys: string[]): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
  && keys.every(key => Object.hasOwn(v, key)) && Object.keys(v).length === keys.length;
const id = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim()
  && !/[\x00-\x1f\x7f]/.test(v) && Buffer.byteLength(JSON.stringify(v)) <= max;
export function validConnectorCodexNotificationInput(_kind: ConnectorCodexNotificationKind, v: unknown): v is CodexNativeNotification {
  return fields(v, ['sessionKey', 'connectionId', 'runId', 'kind', 'phase', 'successorItemTurnId', 'projectable', 'tool'])
    && id(v.sessionKey, 4096) && v.sessionKey.startsWith('codex:')
    && (v.connectionId === null || id(v.connectionId, 128)) && (v.runId === null || id(v.runId, 512))
    && ['start', 'complete', 'turn', 'item', 'goal', 'status', 'other'].includes(v.kind)
    && (v.phase === null || ['running', 'completed', 'failed', 'interrupted'].includes(v.phase))
    && (v.kind === 'start' ? v.phase === 'running' : v.kind === 'complete' ? v.phase !== 'running' : v.phase === null)
    && (v.successorItemTurnId === null || v.kind === 'item' && id(v.successorItemTurnId, 512))
    && typeof v.projectable === 'boolean' && (v.tool === null || v.kind === 'item'
      && fields(v.tool, ['id', 'event']) && id(v.tool.id, 512) && ['started', 'completed', 'unsettled'].includes(v.tool.event));
}
export function validConnectorCodexNotificationOutput(_kind: ConnectorCodexNotificationKind, v: unknown): v is CodexNativeNotificationResult {
  return fields(v, ['kind', 'invalidate', 'wake', 'execution']) && ['ignore', 'successor', 'project', 'late_tool'].includes(v.kind)
    && typeof v.invalidate === 'boolean' && typeof v.wake === 'boolean' && (!v.wake || v.kind === 'successor')
    && (v.execution === null || validConnectorExecutionOutput('codexExecutionRead', v.execution))
    && (v.kind !== 'late_tool' || !!v.execution?.runId && ['completed', 'failed', 'interrupted'].includes(v.execution.phase));
}
export function executeConnectorCodexNotification(_kind: ConnectorCodexNotificationKind, input: CodexNativeNotification,
  owner: ConnectorUserStore): CodexNativeNotificationResult {
  if (!validConnectorCodexNotificationInput(_kind, input)) throw Error('connector_storage_unavailable');
  const result = settleCodexNativeNotification(owner.codexExecutions, input);
  if (!validConnectorCodexNotificationOutput(_kind, result)) throw Error('connector_storage_unavailable');
  return result;
}
