import type { GatewayWsClient } from '../gateway/ws-client.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable, connectorOwnerCommandBytes, encodeConnectorOwnerJson } from './connector-owner-domain.js';
import { OPENCLAW_MESSAGE_PAYLOAD_BYTES } from './connector-openclaw-message-domain.js';
import { validConnectorOpenClawCompactOutput, type ConnectorOpenClawCompactCommands, type ConnectorOpenClawCompactKind,
  type OpenClawCompactIntent, type OpenClawCompactResult, type OpenClawCompactDisplay } from './connector-openclaw-compact-domain.js';
import { runNativeOperation } from './native-operation.js';

type Request = Omit<ConnectorOpenClawCompactCommands['openClawCompactClaim']['input'], 'connectionId' | 'veto' | 'display'>;
type Read = Omit<ConnectorOpenClawCompactCommands['openClawCompactReceiptRead']['input'], 'purpose'>;
type Wait = { timeoutMs: number; signal?: AbortSignal };
/** The native send is single-shot on the original connection. Deadlines end
 * waiting only; close drains the original physical send/settlement. */
export class AsyncOpenClawCompact {
  private readonly tasks = new Set<Promise<unknown>>();
  private bytes = 0;
  private frozen = false;
  private closing?: Promise<void>;
  constructor(private readonly options: { owner: Pick<AsyncConnectorOwner, 'command'>;
    gateway: Pick<GatewayWsClient, 'connectionId' | 'requestBound'>;
    available(): boolean;
    session(key: string): OpenClawCompactDisplay & { exists: boolean; busy: boolean };
    project(result: OpenClawCompactResult): void | Promise<void>;
    diagnostics?: PerformanceDiagnostics }) {}
  private async call<K extends ConnectorOpenClawCompactKind>(kind: K, input: ConnectorOpenClawCompactCommands[K]['input']) {
    const result = await this.options.owner.command(kind, input);
    if (!validConnectorOpenClawCompactOutput(kind, result)) throw new ConnectorOwnerUnavailable();
    if (result && typeof result === 'object' && !('error' in result)) {
      // The full fixed-command output schema was checked above. TypeScript
      // cannot narrow a generic command's indexed input/output union together.
      const view = ('result' in result ? result.result : result) as OpenClawCompactResult;
      const ref = ('intent' in input ? input.intent : input) as OpenClawCompactIntent | Read;
      if (view.key !== ref.key || view.commandKey !== ref.commandKey
        || 'receiptId' in ref && view.receipt?.id !== ref.receiptId) throw new ConnectorOwnerUnavailable();
    }
    return result;
  }
  private track<T>(input: unknown, work: (snapshot: unknown) => Promise<T>): Promise<T> {
    let snapshot: unknown, bytes: number;
    try { const encoded = encodeConnectorOwnerJson(input, connectorOwnerCommandBytes('openClawCompactClaim'));
      bytes = Buffer.byteLength(encoded); snapshot = JSON.parse(encoded); }
    catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    return Promise.resolve().then(() => {
      if (this.frozen || this.tasks.size >= 128 || this.bytes + bytes > 2 * OPENCLAW_MESSAGE_PAYLOAD_BYTES) throw new ConnectorOwnerUnavailable();
      this.bytes += bytes;
      const task = Promise.resolve().then(() => work(snapshot)); this.tasks.add(task);
      const done = () => { this.tasks.delete(task); this.bytes -= bytes; }; void task.then(done, done); return task;
    });
  }
  compact(input: Request, wait: Wait) { return runNativeOperation(() => this.compactPhysical(input), wait); }
  compactPhysical(input: Request, authority?: ApplicationCommandScope) { return this.track(input, v => this.once(v as Request, authority)); }
  read(input: Read, wait: Wait) { return runNativeOperation(() => this.readPhysical(input), wait); }
  readPhysical(input: Read, authority?: ApplicationCommandScope) { return this.track(input, v => this.readCurrent(v as Read, 'read', authority)); }
  readForSend(input: Read, wait: Wait) { return runNativeOperation(() => this.track(input, v => this.readCurrent(v as Read, 'send')), wait); }
  private async readCurrent(input: Read, purpose: 'read' | 'send', authority?: ApplicationCommandScope) {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'openclaw-compact');
    let failed = true;
    try {
      trace.add('step', purpose === 'read' ? 6 : 7);
      const result = await this.call('openClawCompactReceiptRead', { ...input, purpose });
      if (authority) { await authority.authorize('prepare'); authority.local(); }
      if (!('error' in result) && result.projection && !this.frozen) await this.options.project(structuredClone(result));
      failed = false; return result;
    } finally { trace.finish(failed); }
  }
  private async once(input: Request, authority?: ApplicationCommandScope) {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'openclaw-compact');
    let intent: OpenClawCompactIntent | undefined, sent = false, failed = true;
    const { payloadJson: _payloadJson, application: _application, ...scope } = input;
    try {
      trace.add('step', 1);
      if (authority) { await authority.authorize('prepare'); authority.local(); }
      const { exists, busy, ...display } = this.options.session(input.key);
      const available = !this.frozen && this.options.available() === true;
      const claimed = await this.call('openClawCompactClaim', { ...input, display,
        connectionId: available ? this.options.gateway.connectionId() ?? null : null,
        veto: !exists ? 'session_missing' : !available ? 'runtime_unavailable' : busy ? 'session_busy' : null });
      if ('error' in claimed) return claimed;
      if (!claimed.intent) { if (authority) { await authority.authorize('prepare'); authority.local(); } failed = false; return claimed.result; }
      intent = claimed.intent;
      const current = () => {
        authority?.local();
        const session = this.options.session(input.key);
        if (this.frozen || this.options.available() !== true || this.options.gateway.connectionId() !== intent!.connectionId
          || !session.exists || session.busy) throw new ConnectorOwnerUnavailable();
      };
      current(); trace.add('step', 2);
      if (authority) { await authority.authorize('effect'); authority.local(); }
      if (await this.call('openClawCompactReady', { ...scope, intent }) !== true) throw new ConnectorOwnerUnavailable();
      current(); trace.add('step', 3);
      const reply = await this.options.gateway.requestBound<unknown>('chat.send', { sessionKey: input.key, message: '/compact',
        deliver: false, idempotencyKey: intent.commandId }, intent.connectionId, () => { current(); sent = true; });
      if (!sent || reply.connectionId !== intent.connectionId || !reply.payload || typeof reply.payload !== 'object' || Array.isArray(reply.payload)) throw new ConnectorOwnerUnavailable();
      const native = reply.payload as Record<string, unknown>, runId = native.runId ?? native.id;
      const valid = (v: unknown, max: number): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
      if (!valid(runId, 512) || native.status !== undefined && !valid(native.status, 128)) throw new ConnectorOwnerUnavailable();
      trace.add('step', 4);
      const settled = await this.call('openClawCompactSettle', { intent, outcome: 'acknowledged', runId, status: native.status as string ?? null });
      if (!settled || settled.receipt?.state !== 'accepted') throw new ConnectorOwnerUnavailable();
      const view = await this.readCurrent(scope, 'send', authority); failed = false; return view;
    } catch {
      if (intent) {
        try { await this.call('openClawCompactSettle', { intent, outcome: sent ? 'unknown' : 'not_dispatched', runId: null, status: null }); }
        catch { /* An ACK may already have committed; never retry native work. */ }
        try { return await this.readCurrent(scope, 'send', authority); } catch { /* Original remains recoverable. */ }
      }
      throw new ConnectorOwnerUnavailable();
    } finally {
      if (intent) { try { await this.call('openClawCompactRelease', { intent }); } catch { /* Retirement is not settlement. */ } }
      trace.finish(failed);
    }
  }
  freeze() { this.frozen = true; }
  /** Snapshot of accepted physical native/settlement/projection work. */
  drain(): Promise<void> { return Promise.allSettled([...this.tasks]).then(() => {}); }
  close() {
    if (this.closing) return this.closing;
    this.freeze();
    return this.closing = Promise.resolve().then(async () => { while (this.tasks.size) await Promise.allSettled([...this.tasks]); });
  }
}
