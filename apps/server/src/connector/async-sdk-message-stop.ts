import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import type { SdkMessageStopRequest } from './connector-sdk-stop-domain.js';
import type { SdkAgentId, SdkCompactRef, SdkExecution } from './sdk-execution-journal.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { sameSdkCompactRef } from './connector-sdk-compact-domain.js';

/** Same original message receipt for both physical lanes. This coordinator is
 * not an executor or an authority source: the worker checks current evidence,
 * and the original owning driver supplies its exact native callback/reference.
 * The caller retains this entire Promise beyond HTTP deadlines and shutdown. */
export async function dispatchSdkMessageStop(input: SdkMessageStopRequest, options: {
  owner: Pick<AsyncConnectorOwner, 'command'>; runtime: SdkAgentId;
  kind: 'message' | 'compact'; ref: SdkCompactRef | null;
  available: (ref: SdkCompactRef) => boolean;
  interrupt: (execution: SdkExecution) => Promise<void>;
  diagnostics?: PerformanceDiagnostics;
  authority?: ApplicationCommandScope | undefined;
}) {
  const request = { ...input }, { owner, runtime } = options;
  if (request.runtime !== runtime) throw Error('connector_storage_unavailable');
  const ref = options.ref ? { ...options.ref } : null;
  const trace = guardedTrace(options.diagnostics ?? performanceDiagnostics, 'sdk-async-dispatch');
  let failed = true;
  const unknown = async (execution: SdkExecution) => {
    try { await owner.command('sdkExecutionUnknown', { runtime, ref: {
      key: execution.key, id: execution.id, epoch: execution.epoch, nativeSessionId: execution.nativeSessionId,
    } }); } catch { /* The original durable receipt/intent stays protected. */ }
  };
  try {
    trace.add('step', 7);
    await options.authority?.authorize('prepare'); options.authority?.local();
    const claimed = await owner.command('sdkMessageStopClaim', { ...request, ref: ref && options.available(ref) ? ref : null });
    if ('error' in claimed || !claimed.execution) {
      failed = !('receipt' in claimed && claimed.receipt.state === 'accepted'); return claimed;
    }
    const execution = claimed.execution;
    if (!ref || !sameSdkCompactRef(ref, execution) || (execution.kind ?? 'message') !== options.kind || !options.available(execution)) {
      await unknown(execution); return claimed;
    }
    const binding = { runtime, key: request.key, commandKey: request.commandKey, receiptId: claimed.receipt.id,
      ref: { key: execution.key, id: execution.id, epoch: execution.epoch, nativeSessionId: execution.nativeSessionId } };
    await options.authority?.authorize('effect'); options.authority?.local();
    if (await owner.command('sdkMessageStopReady', { ...binding, authorization: request.authorization }) !== true) return claimed;
    options.authority?.local();
    if (!options.available(execution)) { await unknown(execution); return claimed; }
    trace.add('step', 8);
    try {
      // No HTTP signal/deadline may abandon the original physical Promise.
      await options.interrupt(execution);
      if (await owner.command('sdkMessageStopSettle', binding) !== true) throw Error('connector_storage_unavailable');
      failed = false;
    } catch { await unknown(execution); }
    return claimed;
  } finally { trace.finish(failed); }
}
