import type { SendMessageRequest } from '@agentopsdeck/shared';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { normalizeSendMessageRequest, persistUploadedMedia } from '../messages/send-message.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable, encodeConnectorOwnerJson, connectorOwnerCommandBytes } from './connector-owner-domain.js';
import { validConnectorOpenClawMessageInput, validConnectorOpenClawMessageOutput, OPENCLAW_MESSAGE_PAYLOAD_BYTES,
  type ConnectorOpenClawMessageCommands, type ConnectorOpenClawMessageKind, type OpenClawMessageIntent,
  type OpenClawMessageScope, type OpenClawMessageMedia } from './connector-openclaw-message-domain.js';
import { runNativeOperation } from './native-operation.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';

type Wait = { timeoutMs: number; signal?: AbortSignal };
type Send = Omit<ConnectorOpenClawMessageCommands['openClawMessageClaim']['input'], 'defaultAgentId'>;
/** Original file effects stay outside SQL. HTTP deadlines end delivery only;
 * accepted physical work, settlement and admission notification stay in drain. */
export class AsyncOpenClawMessages {
  private frozen = false;
  private closing?: Promise<void>;
  private readonly tasks = new Set<Promise<unknown>>();
  private bytes = 0;
  constructor(private readonly options: {
    owner: Pick<AsyncConnectorOwner, 'command'>;
    defaultAgentId: string;
    ready(): boolean;
    sessionExists(key: string): boolean;
    admitted(key: string): void | Promise<void>;
    persist?: (items: SendMessageRequest['media'], options?: { check?: () => Promise<void> }) => Promise<OpenClawMessageMedia[]>;
    diagnostics?: PerformanceDiagnostics;
  }) {
    this.options = Object.freeze({ ...options,
      owner: Object.freeze({ command: options.owner.command.bind(options.owner) }),
      ready: options.ready.bind(options), sessionExists: options.sessionExists.bind(options),
      admitted: options.admitted.bind(options),
      ...(options.persist ? { persist: options.persist.bind(options) } : {}),
    });
  }
  private call<K extends ConnectorOpenClawMessageKind>(kind: K, input: ConnectorOpenClawMessageCommands[K]['input']) {
    return this.options.owner.command(kind, input).then(result => {
      if (!validConnectorOpenClawMessageOutput(kind, result)) throw new ConnectorOwnerUnavailable();
      if ('key' in input && typeof result === 'object' && 'receipt' in result
        && (result.key !== input.key || result.commandKey !== input.commandKey)) throw new ConnectorOwnerUnavailable();
      return result;
    });
  }
  private retain<T>(invoke: () => Promise<T>, bytes: number): Promise<T> {
    if (this.frozen || this.tasks.size >= 128 || this.bytes + bytes > 2 * OPENCLAW_MESSAGE_PAYLOAD_BYTES) return Promise.reject(new ConnectorOwnerUnavailable());
    this.bytes += bytes;
    const work = Promise.resolve().then(invoke); this.tasks.add(work);
    const release = () => { this.tasks.delete(work); this.bytes -= bytes; };
    void work.then(release, release); return work;
  }
  private local(key: string) {
    if (this.options.ready() !== true || this.options.sessionExists(key) !== true) throw new ConnectorOwnerUnavailable();
  }
  send(request: Send, wait: Wait) {
    return runNativeOperation(() => this.sendPhysical(request), wait);
  }
  /** Full original file/SQL/notification/retirement lifetime, not HTTP wait.
   * Application observations do not replace token/grant transaction checks. */
  sendPhysical(request: Send, authority?: ApplicationCommandScope) {
    // Pin exact private JSON without invoking caller toJSON/getters.
    let snapshot: Send;
    try {
      snapshot = JSON.parse(encodeConnectorOwnerJson(request, connectorOwnerCommandBytes('openClawMessageClaim'))) as Send;
      if (!validConnectorOpenClawMessageInput('openClawMessageClaim', { ...snapshot, defaultAgentId: this.options.defaultAgentId })) throw new ConnectorOwnerUnavailable();
    }
    catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    return this.retain(async () => {
      const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'openclaw-message');
      const warning = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000); warning.unref();
      let failed = true, intent: OpenClawMessageIntent | undefined;
      try {
        await authority?.authorize('prepare');
        authority?.local();
        const { payloadJson, rejectFresh, application, ...scope } = snapshot;
        trace.add('step', 1);
        const unavailable = rejectFresh ?? (this.options.ready() !== true ? 'runtime_unavailable' as const
          : this.options.sessionExists(scope.key) !== true ? 'session_missing' as const : undefined);
        const claimed = await this.call('openClawMessageClaim', { ...scope, payloadJson, defaultAgentId: this.options.defaultAgentId, ...(application ? { application } : {}),
          ...(unavailable ? { rejectFresh: unavailable } : {}) });
        if ('error' in claimed || !claimed.intent) { failed = false; return claimed; }
        intent = claimed.intent;
        await authority?.authorize('prepare');
        authority?.local();
        this.local(scope.key);
        const normalized = normalizeSendMessageRequest(JSON.parse(payloadJson));
        if ('error' in normalized) throw new ConnectorOwnerUnavailable();
        trace.add('step', 2);
        const ready = await this.call('openClawMessageReady', { ...scope, intent });
        if (ready !== true) { if (typeof ready === 'object') return ready; throw new ConnectorOwnerUnavailable(); }
        this.local(scope.key);
        trace.add('step', 3);
        await authority?.authorize('effect');
        authority?.local();
        // A lost reply never obtains a second ready or reconstructs this intent.
        const persisted = await (this.options.persist ?? persistUploadedMedia)(normalized.media, { check: async () => {
          this.local(scope.key); await authority?.authorize('effect'); authority?.local();
        } });
        const media = persisted.map(({ filePath, media }) => ({ filePath, media }));
        this.local(scope.key);
        await authority?.authorize('effect');
        authority?.local();
        trace.add('step', 4);
        const result = await this.call('openClawMessageCommit', { ...scope, intent, media });
        if ('receipt' in result && result.admitted) {
          trace.add('admitted', 1);
          try { await this.options.admitted(scope.key); } catch { trace.add('deferred', 1); /* original receipt wins */ }
        }
        failed = false; return result;
      } finally {
        // Retire volatile capability, NEVER clear durable unknown or replay files.
        if (intent) { try { await this.call('openClawMessageRelease', { intent }); } catch { trace.add('unknown', 1); } }
        clearTimeout(warning); trace.finish(failed);
      }
    }, Buffer.byteLength(snapshot.payloadJson));
  }
  readReceipt(input: OpenClawMessageScope, wait: Wait) {
    return runNativeOperation(() => this.readReceiptPhysical(input), wait);
  }
  readReceiptPhysical(input: OpenClawMessageScope) {
    let snapshot: OpenClawMessageScope;
    try {
      snapshot = JSON.parse(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes('openClawMessageReceiptRead')));
      if (!validConnectorOpenClawMessageInput('openClawMessageReceiptRead', snapshot)) throw new ConnectorOwnerUnavailable();
    } catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    return this.retain(() => this.call('openClawMessageReceiptRead', snapshot), 0);
  }
  readSendReceipt(input: OpenClawMessageScope, wait: Wait) {
    return runNativeOperation(() => this.readSendReceiptPhysical(input), wait);
  }
  readSendReceiptPhysical(input: OpenClawMessageScope) {
    let snapshot: OpenClawMessageScope;
    try {
      snapshot = JSON.parse(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes('openClawMessageSendReceiptRead')));
      if (!validConnectorOpenClawMessageInput('openClawMessageSendReceiptRead', snapshot)) throw new ConnectorOwnerUnavailable();
    } catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    return this.retain(() => this.call('openClawMessageSendReceiptRead', snapshot), 0);
  }
  freeze() { this.frozen = true; }
  /** Snapshot of accepted physical file/SQL work, not HTTP waiters. */
  drain(): Promise<void> { return Promise.allSettled([...this.tasks]).then(() => {}); }
  close(): Promise<void> {
    this.freeze();
    return this.closing ??= Promise.resolve().then(async () => { while (this.tasks.size) await Promise.allSettled([...this.tasks]); });
  }
}
