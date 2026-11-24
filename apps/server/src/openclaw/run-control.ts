import { requireExpectedRun, RunControlConflict } from '../commands/run-control.js';
import type { GatewayWsClient } from '../gateway/ws-client.js';
import type { OpenClawExecutions } from './executions.js';

export function confirmOpenClawInterrupt(reply: { connectionId: string; payload: unknown }, connectionId: string, runId: string) {
  const payload = reply.payload as { ok?: unknown; aborted?: unknown; runIds?: unknown } | null;
  if (reply.connectionId !== connectionId || !payload || payload.ok !== true || typeof payload.aborted !== 'boolean'
    || !Array.isArray(payload.runIds) || (payload.aborted
      ? payload.runIds.length !== 1 || payload.runIds[0] !== runId
      : payload.runIds.length !== 0)) throw new Error('Unconfirmed OpenClaw interrupt response');
  if (!payload.aborted) throw new RunControlConflict();
}

// The browser observes a Connector command ID, never an arbitrary native run
// selector. Only a current, unfenced fact on its ACK connection can map it.
export async function interruptOpenClawRun(options: {
  sessionKey: string;
  expectedRunId: unknown;
  executions: OpenClawExecutions;
  gateway: Pick<GatewayWsClient, 'connectionId' | 'requestBound'>;
  authorize: () => void;
}) {
  const commandId = requireExpectedRun(options.expectedRunId);
  options.authorize();
  const connectionId = options.gateway.connectionId();
  const fact = options.executions.recoveryCandidate(options.sessionKey, connectionId);
  if (!connectionId || !fact?.runId || fact.commandId !== commandId) throw new RunControlConflict();
  // No asynchronous preparation here. requestBound with an expected connection
  // sends synchronously or rejects; it never opens a replacement connection.
  const reply = await options.gateway.requestBound('chat.abort', { sessionKey: options.sessionKey, runId: fact.runId }, connectionId);
  confirmOpenClawInterrupt(reply, connectionId, fact.runId);
  // ACK confirms a cancellation request, not that execution has quiesced. No
  // execution fact, queue row or history state may be completed by this control.
  return commandId;
}
