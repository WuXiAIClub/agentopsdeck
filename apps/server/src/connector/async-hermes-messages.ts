import { ConnectorOwnerUnavailable, encodeConnectorOwnerJson, connectorOwnerCommandBytes,
  type ConnectorOwnerCommands, type ConnectorOwnerKind } from './connector-owner-domain.js';
import { HERMES_MESSAGE_PAYLOAD_BYTES, validConnectorHermesMessageInput, validConnectorHermesMessageOutput,
  type ConnectorHermesMessageCommands, type ConnectorHermesMessageKind } from './connector-hermes-message-domain.js';
import { runNativeOperation } from './native-operation.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';

type Owner = { command<K extends ConnectorOwnerKind>(kind: K, input: ConnectorOwnerCommands[K]['input']): Promise<ConnectorOwnerCommands[K]['output']> };
type Wait = { timeoutMs: number; signal?: AbortSignal };
/** Caller deadline cancels a wait, not original admission. The physical promise
 * notifies once even after a lost HTTP wait; recovery reads cannot notify. */
export class AsyncHermesMessages {
  private stopped = false;
  private closing: Promise<void> | undefined;
  private readonly tasks = new Set<Promise<unknown>>();
  private bytes = 0;
  private readonly command: Owner['command'];
  constructor(owner: Owner, private readonly admitted: (key: string) => void | Promise<void>,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) { this.command = owner.command.bind(owner); }
  private call<K extends ConnectorHermesMessageKind>(kind: K, input: ConnectorHermesMessageCommands[K]['input'], notify = false, authority?: ApplicationCommandScope) {
    let request: ConnectorHermesMessageCommands[K]['input'];
    try {
      request = JSON.parse(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes(kind)));
      if (!validConnectorHermesMessageInput(kind, request)) throw new ConnectorOwnerUnavailable();
    } catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    const size = 'payloadJson' in request ? Buffer.byteLength(request.payloadJson) : 0;
    if (this.stopped || this.tasks.size >= 128 || this.bytes + size > 2 * HERMES_MESSAGE_PAYLOAD_BYTES) return Promise.reject(new ConnectorOwnerUnavailable());
    this.bytes += size;
    const { key, commandKey } = request;
    // Register before invoking the owner; caller deadlines never drop this
    // physical transaction or its original admission notification from drain.
    const work = Promise.resolve().then(async () => {
      const trace = guardedTrace(this.diagnostics, 'hermes-message-admission');
      trace.add('step', kind === 'hermesMessageSend' ? 1 : kind === 'hermesMessageReceiptRead' ? 2 : 3);
      let failed = true;
      const warning = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000); warning.unref();
      try {
        if (authority) { await authority.authorize('effect'); authority.local(); }
        const result = await this.command(kind, request);
        if (!validConnectorHermesMessageOutput(kind, result) || 'receipt' in result
          && (result.key !== key || result.commandKey !== commandKey)) throw new ConnectorOwnerUnavailable();
        if (notify && 'admitted' in result && result.admitted) {
          trace.add('admitted', 1);
          try { await this.admitted(key); } catch { trace.add('deferred', 1); /* committed receipt survives projection failure */ }
        }
        trace.add('settled', 1); failed = false; return result;
      } finally { clearTimeout(warning); trace.finish(failed); }
    });
    this.tasks.add(work);
    const release = () => { this.tasks.delete(work); this.bytes -= size; };
    void work.then(release, release);
    return work;
  }
  send(input: ConnectorHermesMessageCommands['hermesMessageSend']['input'], wait: Wait) {
    return runNativeOperation(() => this.sendPhysical(input), wait);
  }
  /** Do not wrap the shorter send() waiter in an application scope. */
  sendPhysical(input: ConnectorHermesMessageCommands['hermesMessageSend']['input'], authority?: ApplicationCommandScope) {
    return this.call('hermesMessageSend', input, true, authority);
  }
  readReceipt(input: ConnectorHermesMessageCommands['hermesMessageReceiptRead']['input'], wait: Wait) {
    return runNativeOperation(() => this.readReceiptPhysical(input), wait);
  }
  readReceiptPhysical(input: ConnectorHermesMessageCommands['hermesMessageReceiptRead']['input']) {
    return this.call('hermesMessageReceiptRead', input);
  }
  readSendReceipt(input: ConnectorHermesMessageCommands['hermesMessageSendReceiptRead']['input'], wait: Wait) {
    return runNativeOperation(() => this.readSendReceiptPhysical(input), wait);
  }
  readSendReceiptPhysical(input: ConnectorHermesMessageCommands['hermesMessageSendReceiptRead']['input']) {
    return this.call('hermesMessageSendReceiptRead', input);
  }
  freeze(): void { this.stopped = true; }
  close(): Promise<void> {
    this.freeze();
    return this.closing ??= Promise.resolve().then(async () => {
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
    });
  }
}
