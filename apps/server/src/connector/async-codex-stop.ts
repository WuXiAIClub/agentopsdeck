import type { CodexAppServer } from '../codex/app-server.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable, connectorOwnerCommandBytes, encodeConnectorOwnerJson } from './connector-owner-domain.js';
import { CODEX_MESSAGE_PAYLOAD_BYTES, type CodexMessageScope } from './connector-codex-message-domain.js';
import { validConnectorCodexStopOutput, type ConnectorCodexStopCommands, type ConnectorCodexStopKind,
  type CodexStopIntent } from './connector-codex-stop-domain.js';
import { runNativeOperation } from './native-operation.js';

type Request = Omit<ConnectorCodexStopCommands['codexStopClaim']['input'], 'connectionId'>;
type Wait = { timeoutMs: number; signal?: AbortSignal };
/** Retains physical work after HTTP timeout. No replay, execution unlock or
 * terminal settlement: a native interrupt ACK is only a control receipt. */
export class AsyncCodexStop {
  private readonly tasks = new Set<Promise<unknown>>();
  private bytes = 0;
  private frozen = false;
  private closing?: Promise<void>;
  constructor(private readonly options: { owner: Pick<AsyncConnectorOwner, 'command'>;
    runtime: Pick<CodexAppServer, 'stopConnectionId' | 'interruptOwned'>;
    available(): boolean; diagnostics?: PerformanceDiagnostics }) {}
  private async call<K extends ConnectorCodexStopKind>(kind: K, input: ConnectorCodexStopCommands[K]['input']) {
    const result = await this.options.owner.command(kind, input);
    if (!validConnectorCodexStopOutput(kind, result)) throw new ConnectorOwnerUnavailable();
    if (result && typeof result === 'object' && 'receipt' in result) {
      const expected = 'intent' in input ? input.intent : input as CodexMessageScope;
      if (result.key !== expected.key || result.commandKey !== expected.commandKey
        || 'receiptId' in expected && result.receipt?.id !== expected.receiptId) throw new ConnectorOwnerUnavailable();
    }
    if (kind === 'codexStopClaim' && result && typeof result === 'object' && 'result' in result) {
      const p = input as Request;
      if (result.result.key !== p.key || result.result.commandKey !== p.commandKey) throw new ConnectorOwnerUnavailable();
    }
    return result;
  }
  private retain<T>(operation: () => Promise<T>, bytes: number) {
    if (this.frozen || this.tasks.size >= 128 || this.bytes + bytes > 2 * CODEX_MESSAGE_PAYLOAD_BYTES) return Promise.reject(new ConnectorOwnerUnavailable());
    this.bytes += bytes;
    const task = Promise.resolve().then(operation); this.tasks.add(task);
    const done = () => { this.tasks.delete(task); this.bytes -= bytes; }; void task.then(done, done); return task;
  }
  stop(input: Request, wait: Wait) {
    return runNativeOperation(() => this.stopPhysical(input), wait);
  }
  stopPhysical(input: Request, authority?: ApplicationCommandScope) {
    let snapshot: Request, bytes: number;
    try { const encoded = encodeConnectorOwnerJson(input, connectorOwnerCommandBytes('codexStopClaim')); bytes = Buffer.byteLength(encoded); snapshot = JSON.parse(encoded) as Request; }
    catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    return this.retain(() => this.once(snapshot, authority), bytes);
  }
  readReceipt(input: CodexMessageScope, wait: Wait) {
    return runNativeOperation(() => this.readReceiptPhysical(input), wait);
  }
  readReceiptPhysical(input: CodexMessageScope) {
    const snapshot = structuredClone(input);
    return this.retain(() => this.call('codexStopReceiptRead', snapshot), 0);
  }
  private async once(input: Request, authority?: ApplicationCommandScope) {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'codex-stop');
    let intent: CodexStopIntent | undefined, sent = false, acknowledged = false, failed = true;
    const { payloadJson: _payloadJson, application: _application, ...scope } = input;
    const readOriginal = async () => {
      const result = await this.call('codexStopReceiptRead', scope);
      if ('receipt' in result && intent && result.receipt?.id !== intent.receiptId) throw new ConnectorOwnerUnavailable();
      return result;
    };
    try {
      trace.add('step', 1);
      await authority?.authorize('prepare'); authority?.local();
      const claimed = await this.call('codexStopClaim', { ...input,
        connectionId: !this.frozen && this.options.available() === true ? this.options.runtime.stopConnectionId : null });
      if ('error' in claimed) return claimed;
      if (!claimed.intent) { failed = false; return claimed.result; }
      intent = claimed.intent;
      const local = () => {
        authority?.local();
        if (this.frozen || this.options.available() !== true || this.options.runtime.stopConnectionId !== intent!.connectionId) throw new ConnectorOwnerUnavailable();
      };
      local(); trace.add('step', 2);
      await authority?.authorize('effect'); local();
      if (await this.call('codexStopReady', { ...scope, intent }) !== true) throw new ConnectorOwnerUnavailable();
      local(); trace.add('step', 3);
      await this.options.runtime.interruptOwned(intent, {
        check: async afterInterrupt => {
          local();
          await authority?.authorize('effect'); local();
          const observation = await this.call('codexStopCheck', { ...scope, intent: intent!, afterInterrupt });
          local(); if (!observation) throw new ConnectorOwnerUnavailable(); return observation;
        },
        dispatched: () => { local(); sent = true; },
        acknowledged: async () => {
          acknowledged = true; trace.add('step', 4);
          const settled = await this.call('codexStopSettle', { intent: intent!, outcome: 'acknowledged' });
          if (!settled || settled.receipt?.state !== 'accepted') throw new ConnectorOwnerUnavailable();
        },
      });
      trace.add('step', 5);
      const result = await readOriginal();
      failed = false; return result;
    } catch {
      if (intent) {
        // Never downgrade a possibly committed ACK or replay its settlement.
        if (!acknowledged) try { await this.call('codexStopSettle', { intent, outcome: sent ? 'unknown' : 'not_dispatched' }); } catch { trace.add('unknown', 1); }
        try { return await readOriginal(); } catch { /* Durable receipt remains protected. */ }
      }
      throw new ConnectorOwnerUnavailable();
    } finally {
      if (intent) try { await this.call('codexStopRelease', { intent }); } catch { trace.add('unknown', 1); }
      trace.add('admitted', acknowledged ? 1 : 0); trace.finish(failed);
    }
  }
  freeze() { this.frozen = true; }
  drain() { return Promise.allSettled([...this.tasks]).then(() => {}); }
  close() {
    this.freeze();
    return this.closing ??= Promise.resolve().then(async () => { while (this.tasks.size) await Promise.allSettled([...this.tasks]); });
  }
}
