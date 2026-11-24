import type { SendMessageRequest } from '@agentopsdeck/shared';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { normalizeSendMessageRequest, persistUploadedMedia } from '../messages/send-message.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable, encodeConnectorOwnerJson, connectorOwnerCommandBytes } from './connector-owner-domain.js';
import { validConnectorCodexMessageInput, validConnectorCodexMessageOutput, CODEX_MESSAGE_PAYLOAD_BYTES,
  type ConnectorCodexMessageCommands, type ConnectorCodexMessageKind, type CodexMessageIntent,
  type CodexMessageScope, type CodexMessageImage, type CodexMessageResult } from './connector-codex-message-domain.js';
import { runNativeOperation } from './native-operation.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';

type Wait = { timeoutMs: number; signal?: AbortSignal };
type Send = ConnectorCodexMessageCommands['codexMessageClaim']['input'];
/** Owns physical attachment/SQL work, not delivery waiters. No native effect. */
export class AsyncCodexMessages {
  private frozen = false;
  private closing?: Promise<void>;
  private readonly tasks = new Set<Promise<unknown>>();
  private bytes = 0;
  constructor(private readonly options: {
    owner: Pick<AsyncConnectorOwner, 'command'>;
    ready(): boolean;
    sessionExists(key: string): boolean;
    /** Exact native read only, after original send authority; no recovery/send. */
    prepareSession?(key: string): Promise<void>;
    displayBlocked(key: string): boolean;
    admitted(key: string, text: string, result: CodexMessageResult): void | Promise<void>;
    persist?: (items: SendMessageRequest['media'], options?: { check?: () => Promise<void> }) => Promise<CodexMessageImage[]>;
    diagnostics?: PerformanceDiagnostics;
  }) {
    this.options = Object.freeze({ ...options,
      owner: Object.freeze({ command: options.owner.command.bind(options.owner) }),
      ready: options.ready.bind(options), sessionExists: options.sessionExists.bind(options),
      displayBlocked: options.displayBlocked.bind(options), admitted: options.admitted.bind(options),
      ...(options.prepareSession ? { prepareSession: options.prepareSession.bind(options) } : {}),
      ...(options.persist ? { persist: options.persist.bind(options) } : {}),
    });
  }
  private call<K extends ConnectorCodexMessageKind>(kind: K, input: ConnectorCodexMessageCommands[K]['input']) {
    return this.options.owner.command(kind, input).then(result => {
      if (!validConnectorCodexMessageOutput(kind, result)) throw new ConnectorOwnerUnavailable();
      if ('key' in input && typeof result === 'object' && 'receipt' in result
        && (result.key !== input.key || result.commandKey !== input.commandKey)) throw new ConnectorOwnerUnavailable();
      return result;
    });
  }
  private retain<T>(invoke: () => Promise<T>, bytes: number): Promise<T> {
    if (this.frozen || this.tasks.size >= 128 || this.bytes + bytes > 2 * CODEX_MESSAGE_PAYLOAD_BYTES) return Promise.reject(new ConnectorOwnerUnavailable());
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
  /** Whole physical chain, without a delivery deadline. An application scope
   * must own this promise, not send()'s shorter HTTP waiter. Scope observations
   * supplement, NEVER replace, original Connector transaction authority. */
  sendPhysical(request: Send, authority?: ApplicationCommandScope) {
    let snapshot: Send;
    try {
      snapshot = JSON.parse(encodeConnectorOwnerJson(request, connectorOwnerCommandBytes('codexMessageClaim'))) as Send;
      if (!validConnectorCodexMessageInput('codexMessageClaim', snapshot)) throw new ConnectorOwnerUnavailable();
    }
    catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    return this.retain(async () => {
      const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'codex-message');
      const warning = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000); warning.unref();
      let failed = true, intent: CodexMessageIntent | undefined;
      try {
        await authority?.authorize('prepare');
        authority?.local();
        const { payloadJson, rejectFresh, application, ...scope } = snapshot;
        trace.add('step', 1);
        if (!rejectFresh && this.options.ready() === true && !this.options.sessionExists(scope.key)
          && this.options.prepareSession) {
          // A missing Deck projection is not a native tombstone. Authenticate
          // exact send authority BEFORE probing native state. Existing receipts
          // still go through claim's payload-conflict check, without hydration.
          const original = await this.call('codexMessageSendReceiptRead', scope);
          if ('error' in original) { failed = false; return original; }
          if (!original.receipt) {
            await authority?.authorize('prepare'); authority?.local();
            if (this.options.ready() !== true) throw new ConnectorOwnerUnavailable();
            await this.options.prepareSession(scope.key);
            const current = await this.call('codexMessageSendReceiptRead', scope);
            if ('error' in current) { failed = false; return current; }
            await authority?.authorize('prepare'); authority?.local();
            // Failed/obsolete projection is UNKNOWN, not a fresh durable 404.
            this.local(scope.key);
          }
        }
        const unavailable = rejectFresh ?? (this.options.ready() !== true ? 'runtime_unavailable' as const
          : this.options.sessionExists(scope.key) !== true ? 'session_missing' as const : undefined);
        const claimed = await this.call('codexMessageClaim', { ...scope, payloadJson, ...(application ? { application } : {}), ...(unavailable ? { rejectFresh: unavailable } : {}) });
        if ('error' in claimed || !claimed.intent) { failed = false; return claimed; }
        intent = claimed.intent;
        await authority?.authorize('prepare');
        authority?.local();
        this.local(scope.key);
        const normalized = normalizeSendMessageRequest(JSON.parse(payloadJson));
        if ('error' in normalized) throw new ConnectorOwnerUnavailable();
        trace.add('step', 2);
        const ready = await this.call('codexMessageReady', { ...scope, intent });
        if (ready !== true) { if (typeof ready === 'object') return ready; throw new ConnectorOwnerUnavailable(); }
        this.local(scope.key);
        trace.add('step', 3);
        await authority?.authorize('effect');
        authority?.local();
        // Unknown ready/file/commit ACK never obtains a new capability or retries effects.
        const persisted = await (this.options.persist ?? persistUploadedMedia)(normalized.media, { check: async () => {
          this.local(scope.key); await authority?.authorize('effect'); authority?.local();
        } });
        const images = persisted.map(({ filePath, media }) => ({ filePath, media }));
        this.local(scope.key);
        await authority?.authorize('effect');
        authority?.local();
        trace.add('step', 4);
        const result = await this.call('codexMessageCommit', { ...scope, intent, images, displayBlocked: this.options.displayBlocked(scope.key) });
        if ('receipt' in result && result.admitted) {
          trace.add('admitted', 1);
          try { await this.options.admitted(scope.key, normalized.message, result); } catch { trace.add('deferred', 1); }
        }
        failed = false; return result;
      } finally {
        // Retire volatile capability only; durable unknown is never unlocked.
        if (intent) { try { await this.call('codexMessageRelease', { intent }); } catch { trace.add('unknown', 1); } }
        clearTimeout(warning); trace.finish(failed);
      }
    }, Buffer.byteLength(snapshot.payloadJson));
  }
  readReceipt(input: CodexMessageScope, wait: Wait) {
    return runNativeOperation(() => this.readReceiptPhysical(input), wait);
  }
  readReceiptPhysical(input: CodexMessageScope) {
    let snapshot: CodexMessageScope;
    try {
      snapshot = JSON.parse(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes('codexMessageReceiptRead')));
      if (!validConnectorCodexMessageInput('codexMessageReceiptRead', snapshot)) throw new ConnectorOwnerUnavailable();
    } catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    return this.retain(() => this.call('codexMessageReceiptRead', snapshot), 0);
  }
  readSendReceipt(input: CodexMessageScope, wait: Wait) {
    return runNativeOperation(() => this.readSendReceiptPhysical(input), wait);
  }
  readSendReceiptPhysical(input: CodexMessageScope) {
    let snapshot: CodexMessageScope;
    try {
      snapshot = JSON.parse(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes('codexMessageSendReceiptRead')));
      if (!validConnectorCodexMessageInput('codexMessageSendReceiptRead', snapshot)) throw new ConnectorOwnerUnavailable();
    } catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    return this.retain(() => this.call('codexMessageSendReceiptRead', snapshot), 0);
  }
  freeze() { this.frozen = true; }
  drain(): Promise<void> { return Promise.allSettled([...this.tasks]).then(() => {}); }
  close(): Promise<void> {
    this.freeze();
    return this.closing ??= Promise.resolve().then(async () => { while (this.tasks.size) await Promise.allSettled([...this.tasks]); });
  }
}
