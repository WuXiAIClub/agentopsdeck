import type { CodexExecution, CodexExecutionPhase } from '../codex/executions.js';
import type { NativeHistoryCheckpoint } from '../codex/native-history.js';
import type { OpenClawExecution, OpenClawRunObservation } from '../openclaw/executions.js';
import { validConnectorExecutionOutput, validConnectorNativeHistory, type ExecutionOwner } from './connector-execution-domain.js';

type Command = { sessionKey: string; commandId: string };
type BoundRun = { sessionKey: string; connectionId: string; runId: string };
// Admission/ACK callbacks deliberately do not cross this boundary. Those must
// become fixed multi-participant transactions, not independent journal writes.
export type ConnectorExecutionObservationCommands = {
  codexExecutionObserve: { input: BoundRun & { phase: Exclude<CodexExecutionPhase, 'starting' | 'unknown'>; expected: Pick<CodexExecution, 'commandId' | 'revision'> | null }; output: boolean };
  codexExecutionUncertain: { input: Command; output: boolean };
  codexExecutionTool: { input: BoundRun & { itemId: string; completed: boolean }; output: boolean };
  codexHistorySettle: { input: { expected: Pick<CodexExecution, 'sessionKey' | 'commandId' | 'runId'>; sync: 'current' | 'error' }; output: boolean };
  codexHistoryCompareSettle: { input: { expected: CodexExecution; sync: 'current' | 'error' }; output: boolean };
  codexCleanupRecovered: { input: { sessionKey: string; runId: string }; output: boolean };
  codexNativeHistorySettle: { input: { expected: CodexExecution; checkpoint: NativeHistoryCheckpoint }; output: boolean };
  codexNativeHistoryInvalidate: { input: { sessionKey: string; reason: NativeHistoryCheckpoint['reason']; readableSuccessorTurnId: string | null }; output: boolean };
  codexExecutionDisconnect: { input: { sessionKey: string; connectionId: string }; output: boolean };
  codexExecutionRecoverTerminal: { input: { expected: CodexExecution; runId: string; phase: 'completed' | 'failed' | 'interrupted' }; output: boolean };
  openClawHistorySettle: { input: { sessionKey: string; revision: number; state: 'current' | 'error' }; output: boolean };
  openClawConnectionBind: { input: Command & { connectionId: string }; output: boolean };
  openClawExecutionCompleteQuery: { input: { expected: OpenClawExecution }; output: boolean };
  openClawExecutionUncertain: { input: Command; output: boolean };
  openClawExecutionUnowned: { input: { sessionKey: string }; output: boolean };
  // Gateway final replies use a separate multi-participant transaction. This
  // command only carries lifecycle observations, never transcript payloads.
  openClawExecutionObserve: { input: { sessionKey: string; event: Pick<OpenClawRunObservation, 'runId' | 'phase' | 'gatewayConnectionId'> }; output: boolean };
};
export type ConnectorExecutionObservationKind = keyof ConnectorExecutionObservationCommands;
export const connectorExecutionObservationSteps = Object.freeze({
  codexExecutionObserve: 44, codexExecutionUncertain: 45, codexExecutionTool: 46,
  codexHistorySettle: 47, codexNativeHistorySettle: 48, codexNativeHistoryInvalidate: 49,
  codexHistoryCompareSettle: 246, codexCleanupRecovered: 247,
  codexExecutionDisconnect: 50, codexExecutionRecoverTerminal: 51,
  openClawHistorySettle: 52, openClawConnectionBind: 53, openClawExecutionCompleteQuery: 54,
  openClawExecutionUncertain: 55, openClawExecutionUnowned: 56, openClawExecutionObserve: 57,
});
export const isConnectorExecutionObservationKind = (kind: string): kind is ConnectorExecutionObservationKind => Object.hasOwn(connectorExecutionObservationSteps, kind);
const fields = (v: unknown, keys: string[], optional: string[] = []): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  && keys.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => keys.includes(key) || optional.includes(key));
// Match the original journals, including JSON-byte bounds and untrimmed IDs.
const codexId = (v: unknown, limit = 4096): v is string => typeof v === 'string' && !!v.trim()
  && !/[\u0000-\u001f\u007f]/.test(v) && Buffer.byteLength(JSON.stringify(v)) <= limit;
const rawId = (v: unknown, limit = 4096): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= limit;
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const state = (v: unknown) => v === 'current' || v === 'error';
const terminal = (v: unknown) => v === 'completed' || v === 'failed' || v === 'interrupted';
const reason = (v: unknown) => validConnectorNativeHistory({ turnId: 'turn', connectionId: 'connection', fingerprint: '0'.repeat(64), state: 'blocked', reason: v });
export function validConnectorExecutionObservationInput(kind: ConnectorExecutionObservationKind, value: unknown): boolean {
  const v = value as Record<string, unknown>;
  switch (kind) {
    case 'codexExecutionUncertain': case 'openClawExecutionUncertain': {
      const id = kind === 'codexExecutionUncertain' ? codexId : rawId;
      return fields(value, ['sessionKey', 'commandId']) && id(v.sessionKey) && id(v.commandId, 512);
    }
    case 'codexExecutionObserve': return fields(value, ['sessionKey', 'connectionId', 'runId', 'phase', 'expected'])
      && codexId(v.sessionKey) && codexId(v.connectionId, 128) && codexId(v.runId, 512) && (v.phase === 'running' || terminal(v.phase))
      && (v.expected === null || fields(v.expected, ['commandId', 'revision']) && codexId(v.expected.commandId, 512) && revision(v.expected.revision));
    case 'codexExecutionTool': return fields(value, ['sessionKey', 'connectionId', 'runId', 'itemId', 'completed'])
      && codexId(v.sessionKey) && codexId(v.connectionId, 128) && codexId(v.runId, 512) && codexId(v.itemId, 512)
      && v.itemId.trim() === v.itemId && typeof v.completed === 'boolean';
    case 'codexHistorySettle': return fields(value, ['expected', 'sync']) && fields(v.expected, ['sessionKey', 'commandId', 'runId'])
      && codexId(v.expected.sessionKey) && codexId(v.expected.commandId, 512) && codexId(v.expected.runId, 512) && state(v.sync);
    case 'codexHistoryCompareSettle': return fields(value, ['expected', 'sync']) && v.expected !== null
      && validConnectorExecutionOutput('codexExecutionRead', v.expected) && state(v.sync);
    case 'codexCleanupRecovered': return fields(value, ['sessionKey', 'runId']) && codexId(v.sessionKey) && codexId(v.runId, 512);
    case 'codexNativeHistorySettle': return fields(value, ['expected', 'checkpoint']) && v.expected !== null
      && validConnectorExecutionOutput('codexExecutionRead', v.expected) && validConnectorNativeHistory(v.checkpoint)
      && fields(v.checkpoint, ['turnId', 'connectionId', 'fingerprint', 'state', 'reason'])
      && codexId(v.checkpoint.turnId, 512) && codexId(v.checkpoint.connectionId, 128);
    case 'codexNativeHistoryInvalidate': return fields(value, ['sessionKey', 'reason', 'readableSuccessorTurnId'])
      && codexId(v.sessionKey) && reason(v.reason) && (v.readableSuccessorTurnId === null || codexId(v.readableSuccessorTurnId, 512));
    case 'codexExecutionDisconnect': return fields(value, ['sessionKey', 'connectionId']) && codexId(v.sessionKey) && codexId(v.connectionId, 128);
    case 'codexExecutionRecoverTerminal': return fields(value, ['expected', 'runId', 'phase']) && v.expected !== null
      && validConnectorExecutionOutput('codexExecutionRead', v.expected) && codexId(v.runId, 512) && terminal(v.phase);
    case 'openClawHistorySettle': return fields(value, ['sessionKey', 'revision', 'state']) && rawId(v.sessionKey) && revision(v.revision) && state(v.state);
    case 'openClawConnectionBind': return fields(value, ['sessionKey', 'commandId', 'connectionId']) && rawId(v.sessionKey) && rawId(v.commandId, 512) && rawId(v.connectionId, 512);
    case 'openClawExecutionCompleteQuery': return fields(value, ['expected']) && v.expected !== null && validConnectorExecutionOutput('openClawExecutionRead', v.expected);
    case 'openClawExecutionUnowned': return fields(value, ['sessionKey']) && rawId(v.sessionKey);
    case 'openClawExecutionObserve': return fields(value, ['sessionKey', 'event']) && rawId(v.sessionKey)
      && fields(v.event, ['runId', 'phase'], ['gatewayConnectionId']) && rawId(v.event.runId, 512)
      && ['running', 'waiting', 'unknown', 'completed', 'failed'].includes(String(v.event.phase))
      && (!Object.hasOwn(v.event, 'gatewayConnectionId') || rawId(v.event.gatewayConnectionId, 512));
  }
}
export const validConnectorExecutionObservationOutput = (_kind: ConnectorExecutionObservationKind, value: unknown): value is boolean => typeof value === 'boolean';
/** Fixed synchronous original transactions run exclusively inside the owner.
 * Results report original journal changes, not native readiness/permission.
 * No generic mutation, caller callback, unlock, replay or admission fallback. */
export function executeConnectorExecutionObservation<K extends ConnectorExecutionObservationKind>(kind: K,
  input: ConnectorExecutionObservationCommands[K]['input'], owner: ExecutionOwner): boolean {
  if (!validConnectorExecutionObservationInput(kind, input)) throw Error('connector_storage_unavailable');
  const c = owner.codexExecutions, o = owner.openClawExecutions;
  // The public generic port is already validated. Each branch deliberately
  // calls a single original journal operation with its unchanged transaction.
  switch (kind) {
    case 'codexExecutionObserve': { const v = input as ConnectorExecutionObservationCommands['codexExecutionObserve']['input']; return c.observe(v.sessionKey, v.connectionId, v.runId, v.phase, v.expected ?? undefined); }
    case 'codexExecutionUncertain': { const v = input as Command; return c.uncertain(v.sessionKey, v.commandId); }
    case 'codexExecutionTool': { const v = input as ConnectorExecutionObservationCommands['codexExecutionTool']['input']; return c.observeCommandTool(v.sessionKey, v.connectionId, v.runId, v.itemId, v.completed); }
    case 'codexHistorySettle': { const v = input as ConnectorExecutionObservationCommands['codexHistorySettle']['input']; return c.settleHistory(v.expected, v.sync); }
    case 'codexHistoryCompareSettle': { const v = input as ConnectorExecutionObservationCommands['codexHistoryCompareSettle']['input']; return c.settleHistory(v.expected, v.sync); }
    case 'codexCleanupRecovered': { const v = input as ConnectorExecutionObservationCommands['codexCleanupRecovered']['input']; return c.cleanupRecovered(v.sessionKey, v.runId); }
    case 'codexNativeHistorySettle': { const v = input as ConnectorExecutionObservationCommands['codexNativeHistorySettle']['input']; return c.settleNativeHistory(v.expected, v.checkpoint); }
    case 'codexNativeHistoryInvalidate': { const v = input as ConnectorExecutionObservationCommands['codexNativeHistoryInvalidate']['input']; return c.invalidateNativeHistory(v.sessionKey, v.reason, v.readableSuccessorTurnId ?? undefined); }
    case 'codexExecutionDisconnect': { const v = input as ConnectorExecutionObservationCommands['codexExecutionDisconnect']['input']; return c.disconnectAcknowledged(v.sessionKey, v.connectionId); }
    case 'codexExecutionRecoverTerminal': { const v = input as ConnectorExecutionObservationCommands['codexExecutionRecoverTerminal']['input']; return c.recoverTerminal(v.expected, v.runId, v.phase); }
    case 'openClawHistorySettle': { const v = input as ConnectorExecutionObservationCommands['openClawHistorySettle']['input']; return o.setHistorySync(v.sessionKey, v.revision, v.state); }
    case 'openClawConnectionBind': { const v = input as ConnectorExecutionObservationCommands['openClawConnectionBind']['input']; return o.bindGatewayConnection(v.sessionKey, v.commandId, v.connectionId); }
    case 'openClawExecutionCompleteQuery': { const v = input as ConnectorExecutionObservationCommands['openClawExecutionCompleteQuery']['input']; return o.completeFromQuery(v.expected); }
    case 'openClawExecutionUncertain': { const v = input as Command; return o.uncertain(v.sessionKey, v.commandId); }
    case 'openClawExecutionUnowned': { const v = input as ConnectorExecutionObservationCommands['openClawExecutionUnowned']['input']; return o.unownedActivity(v.sessionKey); }
    case 'openClawExecutionObserve': { const v = input as ConnectorExecutionObservationCommands['openClawExecutionObserve']['input']; return o.observe(v.sessionKey, v.event); }
  }
  throw Error('connector_storage_unavailable');
}
