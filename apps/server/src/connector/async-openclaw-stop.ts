import type { GatewayWsClient } from '../gateway/ws-client.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { confirmOpenClawInterrupt } from '../openclaw/run-control.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import { ConnectorOwnerUnavailable, connectorOwnerCommandBytes, encodeConnectorOwnerJson } from './connector-owner-domain.js';
import { validConnectorOpenClawMessageOutput, OPENCLAW_MESSAGE_PAYLOAD_BYTES } from './connector-openclaw-message-domain.js';
import { validConnectorOpenClawStopOutput, type ConnectorOpenClawStopCommands, type ConnectorOpenClawStopKind,
  type OpenClawStopIntent } from './connector-openclaw-stop-domain.js';
import { runNativeOperation } from './native-operation.js';

type Request = Omit<ConnectorOpenClawStopCommands['openClawStopClaim']['input'], 'connectionId'>;
/** No second execution authority: SQL binds the original run; the original
 * connection owner may veto, and an abort ACK never completes that run. */
export class AsyncOpenClawStop {
  private readonly tasks = new Set<Promise<unknown>>();
  private bytes = 0;
  private frozen = false;
  private closing?: Promise<void>;
  constructor(private readonly options: { owner: Pick<AsyncConnectorOwner, 'command'>;
    gateway: Pick<GatewayWsClient, 'connectionId' | 'requestBound'>;
    available(): boolean; diagnostics?: PerformanceDiagnostics }) {}
  private async call<K extends ConnectorOpenClawStopKind>(kind: K, input: ConnectorOpenClawStopCommands[K]['input']) {
    const result = await this.options.owner.command(kind, input);
    if (!validConnectorOpenClawStopOutput(kind, result)) throw new ConnectorOwnerUnavailable();
    if (kind === 'openClawStopClaim' && result && typeof result === 'object' && 'result' in result) {
      const p = input as Request;
      if (result.result.key !== p.key || result.result.commandKey !== p.commandKey) throw new ConnectorOwnerUnavailable();
    }
    if (kind === 'openClawStopSettle' && result && typeof result === 'object' && 'receipt' in result) {
      const { intent } = input as ConnectorOpenClawStopCommands['openClawStopSettle']['input'];
      if (result.key !== intent.key || result.commandKey !== intent.commandKey || result.receipt?.id !== intent.receiptId) throw new ConnectorOwnerUnavailable();
    }
    return result;
  }
  stop(input: Request, wait: { timeoutMs: number; signal?: AbortSignal }) {
    return runNativeOperation(() => this.stopPhysical(input), wait);
  }
  stopPhysical(input: Request, authority?: ApplicationCommandScope) {
    let snapshot: Request, bytes: number;
    try { const encoded = encodeConnectorOwnerJson(input, connectorOwnerCommandBytes('openClawStopClaim')); bytes = Buffer.byteLength(encoded); snapshot = JSON.parse(encoded) as Request; }
    catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    const retain = () => {
      if (this.frozen || this.tasks.size >= 128 || this.bytes + bytes > 2 * OPENCLAW_MESSAGE_PAYLOAD_BYTES) throw new ConnectorOwnerUnavailable();
      this.bytes += bytes;
      const task = Promise.resolve().then(() => this.once(snapshot, authority)); this.tasks.add(task);
      const done = () => { this.tasks.delete(task); this.bytes -= bytes; }; void task.then(done, done); return task;
    };
    try { return retain(); } catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
  }
  private async once(input: Request, authority?: ApplicationCommandScope) {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'openclaw-stop');
    let intent: OpenClawStopIntent | undefined, sent = false, failed = true;
    try {
      trace.add('step', 1);
      await authority?.authorize('prepare'); authority?.local();
      const claimed = await this.call('openClawStopClaim', { ...input,
        connectionId: !this.frozen && this.options.available() === true ? this.options.gateway.connectionId() ?? null : null });
      if ('error' in claimed) return claimed;
      if (!claimed.intent) { failed = false; return claimed.result; }
      intent = claimed.intent;
      if (intent.key !== input.key || intent.commandKey !== input.commandKey || intent.receiptId !== claimed.result.receipt?.id) throw new ConnectorOwnerUnavailable();
      const current = () => {
        authority?.local();
        if (this.frozen || this.options.available() !== true || this.options.gateway.connectionId() !== intent!.connectionId) throw new ConnectorOwnerUnavailable();
      };
      current(); trace.add('step', 2);
      const { payloadJson: _payloadJson, application: _application, ...scope } = input;
      await authority?.authorize('effect'); current();
      if (await this.call('openClawStopReady', { ...scope, intent }) !== true) throw new ConnectorOwnerUnavailable();
      current(); trace.add('step', 3);
      const reply = await this.options.gateway.requestBound('chat.abort', { sessionKey: input.key, runId: intent.runId }, intent.connectionId,
        () => { current(); sent = true; });
      if (!sent) throw new ConnectorOwnerUnavailable();
      confirmOpenClawInterrupt(reply, intent.connectionId, intent.runId);
      trace.add('step', 4);
      const settled = await this.call('openClawStopSettle', { intent, outcome: 'acknowledged' });
      if (!settled || settled.receipt?.state !== 'accepted') throw new ConnectorOwnerUnavailable();
      failed = false; return settled;
    } catch {
      if (intent) {
        try {
          const settled = await this.call('openClawStopSettle', { intent, outcome: sent ? 'unknown' : 'not_dispatched' });
          if (settled) return settled;
        } catch { /* Preserve original receipt; no effect replay. */ }
        // A lost settlement ACK may already have committed. This is read-only.
        try {
          const { payloadJson: _payloadJson, application: _application, ...scope } = input;
          const receipt = await this.options.owner.command('openClawMessageSendReceiptRead', scope);
          if (validConnectorOpenClawMessageOutput('openClawMessageSendReceiptRead', receipt) && !('error' in receipt)
            && receipt.key === input.key && receipt.commandKey === input.commandKey && receipt.receipt?.id === intent.receiptId) return receipt;
        } catch { /* Leave durable unknown protected. */ }
      }
      throw new ConnectorOwnerUnavailable();
    } finally {
      if (intent) { try { await this.call('openClawStopRelease', { intent }); } catch { /* Retirement, never settlement. */ } }
      trace.finish(failed);
    }
  }
  freeze() { this.frozen = true; }
  close() {
    if (this.closing) return this.closing;
    this.freeze();
    return this.closing = Promise.resolve().then(async () => { while (this.tasks.size) await Promise.allSettled([...this.tasks]); });
  }
}
