import { ConnectorOwnerUnavailable, encodeConnectorOwnerJson, connectorOwnerCommandBytes,
  type ConnectorOwnerCommands, type ConnectorOwnerKind } from './connector-owner-domain.js';
import { SDK_MESSAGE_PAYLOAD_BYTES, validConnectorSdkMessageInput, validConnectorSdkMessageOutput,
  type ConnectorSdkMessageCommands, type ConnectorSdkMessageKind } from './connector-sdk-message-domain.js';
import { runNativeOperation } from './native-operation.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';

type Owner = { command<K extends ConnectorOwnerKind>(kind: K, input: ConnectorOwnerCommands[K]['input']): Promise<ConnectorOwnerCommands[K]['output']> };
type Wait = { timeoutMs: number; signal?: AbortSignal };
/** Deadline cancels only this caller's wait. Physical admission and its budget
 * remain owned by the original worker. Unknown is recovered by read, not send.
 * The notification is installed on the original physical Promise, not HTTP ACK:
 * a late successful original commit still wakes its existing dispatch owner. */
export class AsyncSdkMessages {
  private readonly command: Owner['command'];
  private readonly admitted: (runtime: 'claude-code' | 'ghcp' | 'antigravity', key: string) => void | Promise<void>;
  private readonly tasks = new Set<Promise<unknown>>();
  private bytes = 0;
  private frozen = false;
  private closing: Promise<void> | undefined;
  constructor(owner: Owner, admitted: (runtime: 'claude-code' | 'ghcp' | 'antigravity', key: string) => void | Promise<void>,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    // Retain the original participants, not a caller-owned mutable options
    // object. Later method replacement cannot redirect an accepted command.
    this.command = owner.command.bind(owner);
    this.admitted = admitted;
  }
  private call<K extends ConnectorSdkMessageKind>(kind: K, input: ConnectorSdkMessageCommands[K]['input'], authority?: ApplicationCommandScope) {
    let request: ConnectorSdkMessageCommands[K]['input'];
    try {
      // Inspect data without invoking getters/toJSON. The original fixed wire
      // schema is authoritative; no caller actor or authorization DTO is added.
      request = JSON.parse(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes(kind)));
      if (!validConnectorSdkMessageInput(kind, request)) throw new ConnectorOwnerUnavailable();
    } catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    const size = 'payloadJson' in request ? Buffer.byteLength(request.payloadJson) : 0;
    if (this.frozen || this.tasks.size >= 128 || this.bytes + size > 2 * SDK_MESSAGE_PAYLOAD_BYTES) {
      return Promise.reject(new ConnectorOwnerUnavailable());
    }
    this.bytes += size;
    // Register before invoking the owner. HTTP cancellation/deadline cannot
    // release SQL, attachment or post-commit notification ownership.
    const work = Promise.resolve().then(async () => {
      const trace = guardedTrace(this.diagnostics, 'sdk-message-admission');
      trace.add('step', kind === 'sdkMessageSend' ? 1 : kind === 'sdkMessageReceiptRead' ? 2 : 3);
      let failed = true;
      const warning = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000);
      warning.unref();
      try {
        if (authority) { await authority.authorize('effect'); authority.local(); }
        const result = await this.command(kind, request);
        if (!validConnectorSdkMessageOutput(kind, result) || 'receipt' in result
          && (result.runtime !== request.runtime || result.key !== request.key || result.commandKey !== request.commandKey)) {
          throw new ConnectorOwnerUnavailable();
        }
        if (kind === 'sdkMessageSend' && 'admitted' in result && result.admitted) {
          trace.add('admitted', 1);
          try { await this.admitted(request.runtime, request.key); }
          catch { trace.add('deferred', 1); /* Original committed receipt wins. */ }
        }
        trace.add('settled', 1); failed = false;
        return result;
      } finally { clearTimeout(warning); trace.finish(failed); }
    });
    this.tasks.add(work);
    const release = () => { this.tasks.delete(work); this.bytes -= size; };
    void work.then(release, release);
    return work;
  }
  send(input: ConnectorSdkMessageCommands['sdkMessageSend']['input'], wait: Wait) {
    return runNativeOperation(() => this.sendPhysical(input), wait);
  }
  /** Original SQL ACK and notification stay owned after any HTTP deadline. */
  sendPhysical(input: ConnectorSdkMessageCommands['sdkMessageSend']['input'], authority?: ApplicationCommandScope) {
    return this.call('sdkMessageSend', input, authority);
  }
  readReceipt(input: ConnectorSdkMessageCommands['sdkMessageReceiptRead']['input'], wait: Wait) {
    return runNativeOperation(() => this.readReceiptPhysical(input), wait);
  }
  readReceiptPhysical(input: ConnectorSdkMessageCommands['sdkMessageReceiptRead']['input']) {
    return this.call('sdkMessageReceiptRead', input);
  }
  readSendReceipt(input: ConnectorSdkMessageCommands['sdkMessageSendReceiptRead']['input'], wait: Wait) {
    return runNativeOperation(() => this.readSendReceiptPhysical(input), wait);
  }
  readSendReceiptPhysical(input: ConnectorSdkMessageCommands['sdkMessageSendReceiptRead']['input']) {
    return this.call('sdkMessageSendReceiptRead', input);
  }
  freeze(): void { this.frozen = true; }
  close(): Promise<void> {
    this.freeze();
    return this.closing ??= Promise.resolve().then(async () => {
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
    });
  }
}
