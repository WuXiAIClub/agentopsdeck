import type { CodexExecution, CodexExecutions } from './executions.js';

/** Original native evidence only. This is never a permission/dispatch proof.
 * Payload text, file paths, callbacks and native effects stay with the receiver. */
export type CodexNativeNotification = {
  sessionKey: string;
  connectionId: string | null;
  runId: string | null;
  kind: 'start' | 'complete' | 'turn' | 'item' | 'goal' | 'status' | 'other';
  phase: 'running' | 'completed' | 'failed' | 'interrupted' | null;
  successorItemTurnId: string | null;
  projectable: boolean;
  tool: { id: string; event: 'started' | 'completed' | 'unsettled' } | null;
};
export type CodexNativeNotificationResult = {
  kind: 'ignore' | 'successor' | 'project' | 'late_tool';
  invalidate: boolean;
  wake: boolean;
  execution: CodexExecution | null;
};
type Journal = Pick<CodexExecutions, 'get' | 'invalidateNativeHistory' | 'observe' | 'observeCommandTool'>;
const terminal = (phase: string) => ['completed', 'failed', 'interrupted'].includes(phase);

/** One serialized owner operation. Keep the pre-observation snapshot: before
 * ACK a native event is evidence, not authority to project this command. */
export function settleCodexNativeNotification(journal: Journal, event: CodexNativeNotification): CodexNativeNotificationResult {
  const { sessionKey, connectionId, runId, kind, phase, tool } = event;
  const execution = journal.get(sessionKey);
  let invalidate = false;
  const result = (kind: CodexNativeNotificationResult['kind'], wake = false): CodexNativeNotificationResult =>
    ({ kind, invalidate, wake, execution: execution ?? null });
  if (execution?.nativeHistory && runId === execution.runId && kind === 'item') {
    journal.invalidateNativeHistory(sessionKey);
    invalidate = true;
  }
  // Successor/Goal activity invalidates the predecessor's read proof without
  // adopting its native identity, including after terminal journal settlement.
  if (execution?.runId && terminal(execution.phase)
    && ((runId && runId !== execution.runId && (execution.nativeHistory || kind === 'start'))
      || kind === 'goal' || execution.nativeHistory && kind === 'status')) {
    const readableProtectedHead = execution.sync === 'current' && execution.nativeHistory?.state === 'blocked'
      && event.successorItemTurnId !== null && event.successorItemTurnId === execution.nativeHistory.turnId
      && event.successorItemTurnId !== execution.runId;
    journal.invalidateNativeHistory(sessionKey, 'changed', event.successorItemTurnId ?? undefined);
    invalidate = true;
    return result('successor', !readableProtectedHead);
  }
  if (execution && (execution.preparation || execution.connectionId !== connectionId
    || execution.phase === 'unknown' && execution.reason !== 'send_unknown')) return result('ignore');
  if (execution?.runId && ((runId && runId !== execution.runId)
    || ['start', 'complete', 'turn', 'item'].includes(kind) && !runId)) return result('ignore');
  if (execution?.runId && terminal(execution.phase)
    && (kind === 'start' || kind === 'complete' && runId === execution.runId && phase !== execution.phase)) return result('ignore');
  if (['start', 'complete'].includes(kind) && (!runId || kind === 'complete' && (!phase || !terminal(phase)))) return result('ignore');
  if (runId && connectionId && phase) journal.observe(sessionKey, connectionId, runId, phase);
  if (execution && (!execution.runId || execution.phase === 'unknown') || !event.projectable) return result('ignore');
  if (tool && execution?.runId && connectionId) {
    const completed = tool.event !== 'started';
    const changed = (terminal(execution.phase) || tool.event !== 'unsettled')
      && journal.observeCommandTool(sessionKey, connectionId, execution.runId, tool.id, completed);
    if (terminal(execution.phase)) {
      if (!changed) return result('ignore');
      const updated = journal.get(sessionKey);
      if (!completed && updated?.revision === execution.revision
        || completed && !execution.pendingCommandTools?.includes(tool.id)) return result('ignore');
      return result('late_tool');
    }
    // Preserve the original receiver: failed starts cannot open a tool;
    // completed tool messages still update the existing transcript projection.
    if (!completed && !changed) return result('ignore');
  }
  return result('project');
}
