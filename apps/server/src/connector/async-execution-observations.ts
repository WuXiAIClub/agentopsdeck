import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { CodexExecution, CodexExecutionPhase } from '../codex/executions.js';
import type { NativeHistoryCheckpoint } from '../codex/native-history.js';
import type { OpenClawExecution, OpenClawRunObservation } from '../openclaw/executions.js';
import { AsyncConnectorExecutionReads } from './async-execution-reads.js';

/** Fixed original journal observations. Await completion before publishing any
 * resulting projection; recheck local connection/lifecycle after every await.
 * A successful write is NOT native idle/dispatch authority. Admission, ACK,
 * CLI transitions and Gateway replies intentionally remain outside this port.
 * Never activate beside a legacy writer to the same database. */
export class AsyncConnectorExecutionObservations {
  readonly codex;
  readonly openclaw;
  constructor(owner: AsyncConnectorOwner) {
    const reads = new AsyncConnectorExecutionReads(owner);
    this.codex = {
      ...reads.codex,
      observe: (sessionKey: string, connectionId: string, runId: string, phase: Exclude<CodexExecutionPhase, 'starting' | 'unknown'>,
        expected?: Pick<CodexExecution, 'commandId' | 'revision'>) => owner.command('codexExecutionObserve', { sessionKey, connectionId, runId, phase, expected: expected ?? null }),
      uncertain: (sessionKey: string, commandId: string) => owner.command('codexExecutionUncertain', { sessionKey, commandId }),
      observeCommandTool: (sessionKey: string, connectionId: string, runId: string, itemId: string, completed = false) =>
        owner.command('codexExecutionTool', { sessionKey, connectionId, runId, itemId, completed }),
      settleHistory: (expected: Pick<CodexExecution, 'sessionKey' | 'commandId' | 'runId'>, sync: 'current' | 'error') => owner.command('codexHistorySettle', { expected, sync }),
      settleNativeHistory: (expected: CodexExecution, checkpoint: NativeHistoryCheckpoint) => owner.command('codexNativeHistorySettle', { expected, checkpoint }),
      compareSettleHistory: (expected: CodexExecution, sync: 'current' | 'error') => owner.command('codexHistoryCompareSettle', { expected, sync }),
      cleanupRecovered: (sessionKey: string, runId: string) => owner.command('codexCleanupRecovered', { sessionKey, runId }),
      invalidateNativeHistory: (sessionKey: string, reason: NativeHistoryCheckpoint['reason'] = 'changed', readableSuccessorTurnId?: string) =>
        owner.command('codexNativeHistoryInvalidate', { sessionKey, reason, readableSuccessorTurnId: readableSuccessorTurnId ?? null }),
      disconnectAcknowledged: (sessionKey: string, connectionId: string) => owner.command('codexExecutionDisconnect', { sessionKey, connectionId }),
      recoverTerminal: (expected: CodexExecution, runId: string, phase: 'completed' | 'failed' | 'interrupted') => owner.command('codexExecutionRecoverTerminal', { expected, runId, phase }),
    };
    this.openclaw = {
      ...reads.openclaw,
      setHistorySync: (sessionKey: string, revision: number, state: 'current' | 'error') => owner.command('openClawHistorySettle', { sessionKey, revision, state }),
      bindGatewayConnection: (sessionKey: string, commandId: string, connectionId: string) => owner.command('openClawConnectionBind', { sessionKey, commandId, connectionId }),
      completeFromQuery: (expected: OpenClawExecution) => owner.command('openClawExecutionCompleteQuery', { expected }),
      uncertain: (sessionKey: string, commandId: string) => owner.command('openClawExecutionUncertain', { sessionKey, commandId }),
      unownedActivity: (sessionKey: string) => owner.command('openClawExecutionUnowned', { sessionKey }),
      observe: (sessionKey: string, event: Pick<OpenClawRunObservation, 'runId' | 'phase' | 'gatewayConnectionId'>) => {
        const { gatewayConnectionId, ...rest } = event;
        return owner.command('openClawExecutionObserve', { sessionKey, event: { ...rest, ...(gatewayConnectionId !== undefined ? { gatewayConnectionId } : {}) } });
      },
    };
  }
}
