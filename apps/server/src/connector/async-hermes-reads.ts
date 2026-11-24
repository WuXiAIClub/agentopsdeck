import { MAX_MESSAGE_CHARS, type ChatMessage, type SessionExecutionSnapshot } from '@agentopsdeck/shared';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { sameHermesReader, validConnectorHermesReadOutput, type HermesReadScope,
  type HermesReadIdentity, type ConnectorHermesReadKind, type ConnectorHermesReadCommands } from './connector-hermes-read-domain.js';
import type { DeckStore } from '../projection/deck-store.js';
import type { EventSnapshotRead } from '../routes/events.js';
import { ReadRequestOwner } from '../lifecycle/read-request-owner.js';
import { createHistoryPreparation } from '../refresh/history-preparation.js';
import { summarizeToolMessage } from '../messages/tool-summary.js';
import { readIndexedToolMessage } from '../codex/indexed-tool-output.js';
import { stableGatewayRowsRevision } from '../refresh/signature.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Page = { messages: ChatMessage[]; totalCount: number; hiddenCount: number; updatedAt: number;
  revision: string; sourceCursor: string; limits: { maxMessageChars: number } };
type Bodies = { state: SessionExecutionSnapshot; page: Page; message: { message: ChatMessage; updatedAt: number; sourceCursor: string } };
type Selection = { limit?: number; before?: string; messageId?: string; asynchronous?: boolean };
type Result<K extends keyof Bodies> = { error: 401 | 403 | 404 | 409 | 503 } | { pending: true } | { body: Bodies[K] };
export type AsyncHermesReadsOptions = {
  projection: DeckStore; snapshot: EventSnapshotRead;
  refresh(key: string, options: { maxAgeMs: number; readOnly: true }): Promise<void>;
  historyReady(key: string): boolean;
  timeoutMs?: number; preparationWaitMs?: number; diagnostics?: PerformanceDiagnostics;
};

/** Public read-only entry: original credentials -> sole worker -> original
 * runtime hydration + causal projection -> fresh worker delivery. Never sends,
 * interrupts, unlocks unknown work or constructs another native/DB owner. */
export class AsyncHermesReads {
  private readonly reads: ReadRequestOwner;
  private readonly prepare: ReturnType<typeof createHistoryPreparation>;
  private readonly hydration = new Map<string, Promise<void>>();
  private readonly diagnostics: PerformanceDiagnostics;
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>, private readonly options: AsyncHermesReadsOptions) {
    if (typeof options.snapshot !== 'function') throw new TypeError('Original Hermes event snapshot required');
    this.diagnostics = options.diagnostics ?? performanceDiagnostics;
    this.reads = new ReadRequestOwner('connector-event-projection', { waitMs: options.timeoutMs, diagnostics: this.diagnostics, limit: 8 });
    this.prepare = createHistoryPreparation({ ...(options.preparationWaitMs === undefined ? {} : { waitMs: options.preparationWaitMs }), capacity: 64 });
  }
  state(input: HermesReadScope, request: Request) { return this.read('state', input, {}, request); }
  page(input: HermesReadScope & { limit: number; before?: string; asynchronous?: boolean }, request: Request) {
    return this.read('page', { key: input.key, authorization: input.authorization }, { limit: input.limit,
      ...(input.before === undefined ? {} : { before: input.before }),
      ...(input.asynchronous === undefined ? {} : { asynchronous: input.asynchronous }) }, request);
  }
  message(input: HermesReadScope & { messageId: string }, request: Request) {
    return this.read('message', { key: input.key, authorization: input.authorization }, { messageId: input.messageId }, request);
  }
  private async command<K extends ConnectorHermesReadKind>(kind: K, input: ConnectorHermesReadCommands[K]['input']) {
    const value = await this.owner.command(kind, input);
    if (!validConnectorHermesReadOutput(kind, value) || !('error' in value) && (value.key !== input.key
      || 'readerId' in input && !sameHermesReader(input, value))) throw new ConnectorOwnerUnavailable();
    return value;
  }
  private refresh(key: string): Promise<void> {
    if (this.closed) return Promise.reject(new ConnectorOwnerUnavailable());
    const existing = this.hydration.get(key); if (existing) return existing;
    if (this.hydration.size >= 8) return Promise.reject(new ConnectorOwnerUnavailable());
    // Reserve before calling injected/runtime code. A 202 or ended HTTP waiter
    // cannot release this physical per-key slot or replace its original work.
    const work = Promise.resolve().then(() => {
      if (this.closed) throw new ConnectorOwnerUnavailable();
      return this.options.refresh(key, { maxAgeMs: 1500, readOnly: true });
    });
    this.hydration.set(key, work);
    void work.then(() => this.hydration.delete(key), () => this.hydration.delete(key));
    return work;
  }
  private async read<K extends keyof Bodies>(kind: K, input: HermesReadScope, selection: Selection, request: Request): Promise<Result<K>> {
    const original = { ...input }, selected = { ...selection }, key = original.key;
    if (kind === 'page' && (!Number.isSafeInteger(selected.limit) || selected.limit! < 1 || selected.limit! > 500
      || selected.before !== undefined && (!selected.before.length || selected.before.length > 4096))
      || kind === 'message' && (!selected.messageId || selected.messageId.length > 4096)) throw new ConnectorOwnerUnavailable();
    return (await this.reads.run(request, async context => {
      const { value: authorized } = await context.stage(80, () => this.command('hermesReadAuthorize', original));
      if ('error' in authorized) return authorized;
      let current: HermesReadIdentity = authorized;
      if (kind !== 'state') {
        const cached = this.options.historyReady(key) === true && (kind === 'message'
          ? this.options.projection.hasMessage(key, selected.messageId!)
          : selected.before !== undefined && this.options.projection.hasMessage(key, selected.before));
        const { value: outcome } = await context.stage(81, () => cached ? 'ready' : selected.asynchronous === true
          ? this.prepare(key, () => this.refresh(key), () => this.options.historyReady(key) === true, context.signal)
          : this.refresh(key).then(() => 'ready', () => 'failed'));
        // A successful native read can legitimately advance the journal fence.
        // Rebind its digest, but never accept a different reader/native session.
        const { value: rebound } = await context.stage(82, () => this.command('hermesReadAuthorize', original));
        if ('error' in rebound) return rebound;
        if (rebound.readerId !== authorized.readerId || rebound.stored !== authorized.stored) return { error: 409 as const };
        current = rebound;
        if (outcome === 'pending' || selected.asynchronous === true && outcome === 'ready' && this.options.historyReady(key) !== true) return { pending: true as const };
        if (outcome !== 'ready' || this.options.historyReady(key) !== true) return { error: 503 as const };
      }
      let detail: ChatMessage | undefined, source: ChatMessage | undefined;
      if (kind === 'message') {
        source = this.options.projection.getMessage(key, selected.messageId!);
        if (!source) return { error: 404 as const };
        try { ({ value: detail } = await context.stage(83, () => readIndexedToolMessage(source!))); }
        catch { context.check(); return { error: 409 as const }; }
      }
      const { value: body } = await context.stage(84, () => this.options.snapshot(cursor => {
        context.check();
        if (typeof cursor !== 'string' || !cursor) throw new ConnectorOwnerUnavailable();
        if (!this.options.projection.getSessionExecution(key, cursor)) return null;
        if (kind === 'state') return this.options.projection.getSessionExecution(key, cursor);
        if (this.options.historyReady(key) !== true) throw new ConnectorOwnerUnavailable();
        if (kind === 'message') return this.options.projection.getMessage(key, selected.messageId!) === source
          ? { message: detail!, updatedAt: Date.now(), sourceCursor: cursor } : null;
        const page = this.options.projection.getMergedMessageHistoryPage(key, selected.limit!, selected.before);
        if (!page) return null;
        const messages = page.messages.map(summarizeToolMessage);
        return { ...page, messages, updatedAt: Date.now(), revision: stableGatewayRowsRevision(messages), sourceCursor: cursor,
          limits: { maxMessageChars: MAX_MESSAGE_CHARS } };
      }));
      const { value: delivered } = await context.stage(85, () => this.command('hermesReadDeliver', { ...original,
        readerId: current.readerId, stored: current.stored, digest: current.digest }));
      if ('error' in delivered) return delivered;
      if (!sameHermesReader(current, delivered)) throw new ConnectorOwnerUnavailable();
      if (kind !== 'state' && this.options.historyReady(key) !== true) throw new ConnectorOwnerUnavailable();
      if (kind === 'message' && this.options.projection.getMessage(key, selected.messageId!) !== source) return { error: 409 as const };
      context.check();
      return body ? { body: body as Bodies[K] } : { error: (kind === 'page' ? 409 : 404) as 404 | 409 };
    })).value;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const draining = this.reads.close();
    return this.closing = Promise.resolve().then(async () => {
      await draining;
      while (this.hydration.size) await Promise.allSettled([...this.hydration.values()]);
      const trace = guardedTrace(this.diagnostics, 'connector-event-projection'); trace.add('step', 86); trace.finish();
    });
  }
}
