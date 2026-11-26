import { MAX_MESSAGE_CHARS, sessionRuntimeId, type ChatMessage, type SessionExecutionSnapshot, type SessionHistoryStatus } from '@agentopsdeck/shared';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { validRuntimeReadOutput, type RuntimeReadScope, type PublicReadRuntime } from './connector-runtime-read-domain.js';
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
  revision: string; sourceCursor?: string; limits: { maxMessageChars: number }; historyStatus?: SessionHistoryStatus };
type Bodies = { state: SessionExecutionSnapshot; page: Page; message: { message: ChatMessage; updatedAt: number; sourceCursor: string } };
type Selection = { limit?: number; before?: string; messageId?: string; asynchronous?: boolean };
type Result<K extends keyof Bodies> = { error: 400 | 403 | 404 | 409 | 503; reason?: 'source' | 'projection' | 'history' }
  | { pending: true } | { body: Bodies[K] };
type DisplayProof = { current(): boolean; verify(): Promise<boolean> };
type DisplayRead = { work: Promise<DisplayProof | undefined>; settledAt?: number };
export type AsyncRuntimeReadsOptions = {
  projection: DeckStore; snapshot: EventSnapshotRead;
  refresh(key: string, options: { maxAgeMs: number; readOnly: true }): Promise<void>;
  historyReady(key: string): boolean;
  display?(key: string): Promise<DisplayProof | undefined>;
  requestRecovery?(key: string, expectedRunId: string): Promise<boolean>;
  stopBackgroundTerminals?(key: string, expectedRunId: string): Promise<boolean>;
  /** Only the latest authorized text projection, never detail/older pages or
   * execution admission. No claim that native reconciliation has finished. */
  allowRecentProjection?: boolean;
  timeoutMs?: number; preparationWaitMs?: number; diagnostics?: PerformanceDiagnostics;
};

/** Read credentials stay in the sole worker. Original hydration and causal
 * snapshots stay with the runtime; neither can release execution protection. */
export class AsyncRuntimeReads {
  private readonly reads: ReadRequestOwner;
  private readonly prepare: ReturnType<typeof createHistoryPreparation>;
  private readonly hydration = new Map<string, Promise<void>>();
  private readonly displayReads = new Map<string, DisplayRead>();
  private readonly displayChecks = new Map<string, Promise<boolean>>();
  private readonly displaySnapshots = new Map<string, Promise<unknown>>();
  private readonly diagnostics: PerformanceDiagnostics;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>, private readonly options: AsyncRuntimeReadsOptions,
    private readonly runtime: PublicReadRuntime) {
    if (typeof options.snapshot !== 'function' || typeof options.historyReady !== 'function' || typeof options.refresh !== 'function')
      throw new TypeError('Original runtime history and event snapshot required');
    this.diagnostics = options.diagnostics ?? performanceDiagnostics;
    this.reads = new ReadRequestOwner('connector-event-projection', { waitMs: options.timeoutMs, diagnostics: this.diagnostics, limit: 8 });
    this.prepare = createHistoryPreparation({ ...(options.preparationWaitMs === undefined ? {} : { waitMs: options.preparationWaitMs }), capacity: 64 });
  }
  state(input: RuntimeReadScope, request: Request) { return this.read('state', input, {}, request); }
  async recheck(input: RuntimeReadScope & { expectedRunId: string }, request: Request) {
    const original = { key: input.key, authorization: input.authorization }, expectedRunId = input.expectedRunId;
    return (await this.reads.run(request, async context => {
      const { value: authorized } = await context.stage(87, () => this.command(original));
      if ('error' in authorized) return authorized;
      if (!this.options.requestRecovery) return { error: 409 as const };
      const { value: checked } = await context.stage(89, () => this.command({ ...original, readerId: authorized.readerId }));
      if ('error' in checked) return checked;
      context.check();
      const { value: requested } = await context.stage(95, () => this.options.requestRecovery!(original.key, expectedRunId));
      const { value: delivered } = await context.stage(93, () => this.command({ ...original, readerId: authorized.readerId }));
      if ('error' in delivered) return delivered;
      context.check();
      return requested ? { requested: true as const } : { error: 409 as const };
    })).value;
  }
  async stopBackgroundTerminals(input: RuntimeReadScope & { expectedRunId: string }, request: Request) {
    const original = { key: input.key, authorization: input.authorization }, expectedRunId = input.expectedRunId;
    return (await this.reads.run(request, async context => {
      const { value: authorized } = await context.stage(87, () => this.authorizeInterrupt(original));
      if ('error' in authorized) return authorized;
      if (!this.options.stopBackgroundTerminals) return { error: 409 as const };
      const { value: checked } = await context.stage(89, () => this.authorizeInterrupt(original, authorized.actorId));
      if ('error' in checked) return checked;
      context.check();
      const { value: stopped } = await context.stage(95, () => this.options.stopBackgroundTerminals!(original.key, expectedRunId));
      const { value: delivered } = await context.stage(93, () => this.authorizeInterrupt(original, authorized.actorId));
      if ('error' in delivered) return delivered;
      context.check();
      return stopped ? { stopped: true as const } : { error: 409 as const };
    })).value;
  }
  page(input: RuntimeReadScope & { limit: number; before?: string; asynchronous?: boolean }, request: Request) {
    return this.read('page', { key: input.key, authorization: input.authorization }, { limit: input.limit,
      ...(input.before === undefined ? {} : { before: input.before }),
      ...(input.asynchronous === undefined ? {} : { asynchronous: input.asynchronous }) }, request);
  }
  message(input: RuntimeReadScope & { messageId: string }, request: Request) {
    return this.read('message', { key: input.key, authorization: input.authorization }, { messageId: input.messageId }, request);
  }
  private async authorizeInterrupt(input: RuntimeReadScope, actorId?: string) {
    if (typeof input.key !== 'string' || !input.key.length || Buffer.byteLength(input.key) > 512
      || /[\x00-\x1f\x7f]/.test(input.key) || sessionRuntimeId(input.key) !== this.runtime) throw new ConnectorOwnerUnavailable();
    if (typeof input.authorization !== 'string' || Buffer.byteLength(input.authorization) > 4096
      || /[\x00-\x1f\x7f]/.test(input.authorization)) return { error: 403 as const };
    const actor = await this.owner.command('tokenAuthenticate', { authorization: input.authorization });
    if (!validConnectorOwnerOutput('tokenAuthenticate', actor)) throw new ConnectorOwnerUnavailable();
    // Direct non-delegated interrupt authority maps to messages:send + messages:read without execution:delegate.
    if (!actor || actor.tokenId.startsWith('actor_') || actor.scopes.includes('execution:delegate')
      || !actor.scopes.includes('messages:send') || !actor.scopes.includes('messages:read')) return { error: 403 as const };
    if (actorId !== undefined && actor.tokenId !== actorId) return { error: 409 as const };
    const deleted = await this.owner.command('receiptDeletion', { sessionKey: input.key });
    if (!validConnectorOwnerOutput('receiptDeletion', deleted)) throw new ConnectorOwnerUnavailable();
    if (deleted !== null) return { error: 404 as const };
    return { key: input.key, actorId: actor.tokenId };
  }
  private async command(input: RuntimeReadScope | RuntimeReadScope & { readerId: string }) {
    const value = 'readerId' in input
      ? await this.owner.command(this.runtime === 'codex' ? 'codexReadDeliver' : 'openClawReadDeliver', input)
      : await this.owner.command(this.runtime === 'codex' ? 'codexReadAuthorize' : 'openClawReadAuthorize', input);
    if (!validRuntimeReadOutput(this.runtime, value) || !('error' in value) && (value.key !== input.key
      || 'readerId' in input && value.readerId !== input.readerId)) throw new ConnectorOwnerUnavailable();
    return value;
  }
  private refresh(key: string): Promise<void> {
    if (this.closed) return Promise.reject(new ConnectorOwnerUnavailable());
    const existing = this.hydration.get(key); if (existing) return existing;
    if (this.hydration.size >= 8) return Promise.reject(new ConnectorOwnerUnavailable());
    // Reserve before runtime callbacks; 202/abort never frees original work.
    const work = Promise.resolve().then(() => {
      if (this.closed) throw new ConnectorOwnerUnavailable();
      return this.options.refresh(key, { maxAgeMs: 1500, readOnly: true });
    });
    this.hydration.set(key, work);
    void work.then(() => this.hydration.delete(key), () => this.hydration.delete(key));
    return work;
  }
  private async prepareDisplay(key: string, signal: AbortSignal): Promise<{ pending: true } | { display: DisplayProof | undefined }> {
    signal.throwIfAborted();
    // Only completed, unclaimed proofs expire. A timed-out HTTP observer never
    // frees an original native read, opens another slot or cancels its drain.
    for (const [id, entry] of this.displayReads) if (entry.settledAt !== undefined && Date.now() - entry.settledAt > 30_000)
      this.displayReads.delete(id);
    let entry = this.displayReads.get(key);
    if (!entry) {
      if (this.displayReads.size >= 8) for (const [id, prior] of this.displayReads) {
        if (prior.settledAt !== undefined) { this.displayReads.delete(id); break; }
      }
      if (this.displayReads.size >= 8) return { pending: true };
      entry = { work: Promise.resolve().then(() => {
        if (this.closed) throw new ConnectorOwnerUnavailable();
        return this.options.display!(key);
      }) };
      const original = entry;
      void entry.work.then(() => { original.settledAt = Date.now(); }, () => { original.settledAt = Date.now(); });
      this.displayReads.set(key, entry);
    }
    const original = entry;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    try {
      const result = await Promise.race([
        original.work.then(display => ({ display })),
        new Promise<{ pending: true }>((resolve, reject) => {
          timer = setTimeout(() => resolve({ pending: true }), this.options.preparationWaitMs ?? 500);
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
      signal.throwIfAborted();
      if ('display' in result && this.displayReads.get(key) === original) this.displayReads.delete(key);
      return result;
    } catch (error) {
      if (original.settledAt !== undefined && this.displayReads.get(key) === original) this.displayReads.delete(key);
      throw error;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  private async verifyDisplay(key: string, display: DisplayProof, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (this.displayChecks.has(key) || this.displayChecks.size >= 8) return false;
    // A slow observer must not release the physical verification slot. A later
    // request starts a fresh proof only after the original check has settled.
    const work = Promise.resolve().then(() => display.verify());
    this.displayChecks.set(key, work);
    void work.then(() => this.displayChecks.delete(key), () => this.displayChecks.delete(key));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    try {
      const verified = await Promise.race([work, new Promise<boolean>((resolve, reject) => {
        timer = setTimeout(() => resolve(false), this.options.preparationWaitMs ?? 500);
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })]);
      signal.throwIfAborted();
      return verified;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  private async snapshotDisplay<T>(key: string, capture: () => Promise<T>, signal: AbortSignal): Promise<{ value: T } | { pending: true }> {
    signal.throwIfAborted();
    if (this.displaySnapshots.has(key) || this.displaySnapshots.size >= 8) return { pending: true };
    // A Deck-wide barrier may be slow even when it does not reject. Retain its
    // original physical ownership after the display observer stops waiting.
    const work = Promise.resolve().then(capture);
    this.displaySnapshots.set(key, work);
    void work.then(() => this.displaySnapshots.delete(key), () => this.displaySnapshots.delete(key));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    try {
      const result = await Promise.race([work.then(value => ({ value })), new Promise<{ pending: true }>((resolve, reject) => {
        timer = setTimeout(() => resolve({ pending: true }), this.options.preparationWaitMs ?? 500);
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })]);
      signal.throwIfAborted();
      return result;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  private async read<K extends keyof Bodies>(kind: K, input: RuntimeReadScope, selection: Selection, request: Request): Promise<Result<K>> {
    const original = { ...input }, selected = { ...selection }, key = original.key;
    return (await this.reads.run(request, async context => {
      const { value: authorized } = await context.stage(87, () => this.command(original));
      if ('error' in authorized) return authorized;
      if (kind === 'page' && selected.before !== undefined && (!selected.before.length || selected.before.length > 4096)) return { error: 400 as const };
      if (kind === 'page' && (!Number.isSafeInteger(selected.limit) || selected.limit! < 1 || selected.limit! > 500)
        || kind === 'message' && (!selected.messageId || selected.messageId.length > 4096)) throw new ConnectorOwnerUnavailable();
      const deliver = () => this.command({ ...original, readerId: authorized.readerId });
      const recent = async (): Promise<Result<K>> => {
        // This is explicitly an unverified display projection, NOT a Deck
        // snapshot. Requiring the global causal barrier here couples readable
        // history to every runtime's health and defeats fault isolation. Never
        // attach a source cursor or use these rows as execution evidence.
        const { value: body } = await context.stage(92, () => {
          context.check();
          if (!this.options.projection.getSession(key)) return null;
          const page = this.options.projection.getMessageHistoryPage(key, selected.limit!, selected.before);
          if (!page?.messages.length) return null;
          const messages = page.messages.map(summarizeToolMessage);
          return { ...page, messages, updatedAt: Date.now(), historyStatus: 'cached' as const,
            revision: `cached:${stableGatewayRowsRevision(messages)}`, limits: { maxMessageChars: MAX_MESSAGE_CHARS } };
        });
        const { value: checked } = await context.stage(93, deliver);
        if ('error' in checked) return checked;
        context.check();
        return body ? { body: body as Bodies[K] } : selected.before !== undefined ? { error: 409 as const }
          : selected.asynchronous ? { pending: true } : { error: 503, reason: 'history' };
      };
      const canReadRecent = () => kind === 'page' && selected.before === undefined && this.options.allowRecentProjection === true;
      if (canReadRecent() && (this.displayChecks.has(key) || this.displaySnapshots.has(key))) return recent();
      let display: DisplayProof | undefined;
      try {
        if (kind !== 'state' && this.options.display) {
          if (canReadRecent()) {
            const prepared = (await context.stage(95, () => this.prepareDisplay(key, context.signal))).value;
            if ('pending' in prepared) return recent();
            display = prepared.display;
          } else display = (await context.stage(95, () => this.options.display!(key))).value;
        }
      } catch (error) {
        context.check();
        if (canReadRecent()) return recent();
        throw error;
      }
      const historyReady = () => display ? display.current() : this.options.historyReady(key) === true;
      if (kind !== 'state') {
        const cached = (display?.current() === true) || this.options.historyReady(key) === true && (kind === 'message'
          ? this.options.projection.hasMessage(key, selected.messageId!)
          : selected.before !== undefined && this.options.projection.hasMessage(key, selected.before));
        // Latest display has a bounded observer even for clients which do not
        // negotiate 202. Keep their wire contract (empty => 503), but do not
        // hold readable text behind a slow native refresh until HTTP expires.
        const { value: outcome } = await context.stage(88, () => cached ? 'ready' : selected.asynchronous === true || canReadRecent()
          ? this.prepare(key, () => this.refresh(key), () => this.options.historyReady(key) === true, context.signal)
          : this.refresh(key).then(() => 'ready', () => 'failed'));
        const { value: rebound } = await context.stage(89, deliver);
        if ('error' in rebound) return rebound;
        if (outcome === 'pending' || selected.asynchronous === true && outcome === 'ready' && !historyReady())
          return canReadRecent() ? recent() : { pending: true as const };
        if (outcome !== 'ready' || !historyReady()) return canReadRecent() ? recent() : { error: 503 as const, reason: 'history' as const };
      }
      let detail: ChatMessage | undefined, source: ChatMessage | undefined;
      if (kind === 'message') {
        source = this.options.projection.getMessage(key, selected.messageId!);
        if (!source) return { error: 404 as const };
        try { ({ value: detail } = await context.stage(90, () => readIndexedToolMessage(source!))); }
        catch {
          context.check();
          const { value: checked } = await context.stage(91, deliver);
          return 'error' in checked ? checked : { error: 409 as const, reason: 'source' as const };
        }
      }
      const currentDetail = () => this.options.projection.getMessage(key, selected.messageId!) === source;
      let capturedReady = true;
      let body: Bodies[K] | null;
      let sessionMessages: ChatMessage[] | undefined;
      let capturedListVersion = 0;
      // A verified native history proof is scoped to this session's execution,
      // connection, projection and source. Do not require unrelated runtimes
      // to stop committing before reading its pages. This is NOT a Deck-wide
      // snapshot: omit sourceCursor, retain the final native proof and token
      // delivery checks, and never use it for state, detail or admission.
      const captureSessionPage = () => {
        context.check();
        if (!display?.current()) { capturedReady = false; return null; }
        sessionMessages = this.options.projection.getMessages(key);
        capturedListVersion = this.options.projection.getMessageListVersion(key);
        const page = this.options.projection.getMessageHistoryPage(key, selected.limit!, selected.before);
        if (!page) return null;
        const messages = page.messages.map(summarizeToolMessage);
        return { ...page, messages, updatedAt: Date.now(), revision: stableGatewayRowsRevision(messages), historyStatus: 'verified-session',
          limits: { maxMessageChars: MAX_MESSAGE_CHARS } } as Bodies[K];
      };
      const capture = () => this.options.snapshot(cursor => {
        context.check();
        if (typeof cursor !== 'string' || !cursor) throw new ConnectorOwnerUnavailable();
        if (kind === 'state') return this.options.projection.getSessionExecution(key, cursor);
        if (!historyReady()) {
          capturedReady = false;
          return null;
        }
        if (kind === 'message') return currentDetail() ? { message: detail!, updatedAt: Date.now(), sourceCursor: cursor } : null;
        const page = this.options.projection.getMessageHistoryPage(key, selected.limit!, selected.before);
        if (!page) return null;
        const messages = page.messages.map(summarizeToolMessage);
        return { ...page, messages, updatedAt: Date.now(), revision: stableGatewayRowsRevision(messages), sourceCursor: cursor,
          limits: { maxMessageChars: MAX_MESSAGE_CHARS } };
      }) as Promise<Bodies[K] | null>;
      try {
        if (kind === 'page' && display) {
          ({ value: body } = await context.stage(92, captureSessionPage));
        } else if (canReadRecent()) {
          const result = (await context.stage(92, () => this.snapshotDisplay(key, capture, context.signal))).value;
          if ('pending' in result) return recent();
          body = result.value;
        } else ({ value: body } = await context.stage(92, capture));
      }
      catch (error) { context.check(); if (canReadRecent()) return recent(); throw error; }
      let displayVerified = !display;
      try { if (display) displayVerified = (await context.stage(96, () => canReadRecent()
        ? this.verifyDisplay(key, display!, context.signal) : display!.verify())).value; }
      catch (error) { context.check(); if (!canReadRecent()) throw error; }
      const { value: delivered } = await context.stage(93, deliver);
      if ('error' in delivered) return delivered;
      if (sessionMessages && (sessionMessages !== this.options.projection.getMessages(key)
        || capturedListVersion !== this.options.projection.getMessageListVersion(key))) {
        if (canReadRecent()) return recent();
        return selected.asynchronous === true ? { pending: true as const } : { error: 409 as const, reason: 'projection' as const };
      }
      if ((!displayVerified || !capturedReady || !historyReady()) && canReadRecent()) return recent();
      if (!displayVerified) return kind === 'page' && selected.asynchronous === true
        ? { pending: true as const } : { error: 409 as const, reason: 'projection' as const };
      if (kind === 'state' && !this.options.projection.getSession(key)) return { error: 404 as const };
      if (kind !== 'state' && (!capturedReady || !historyReady())) {
        if (kind === 'message') return { error: 409 as const, reason: 'projection' as const };
        return selected.asynchronous === true ? { pending: true as const } : { error: 503 as const, reason: 'history' as const };
      }
      if (kind === 'message' && !currentDetail()) return { error: 409 as const, reason: 'projection' as const };
      context.check();
      return body ? { body: body as Bodies[K] } : { error: (kind === 'state' ? 404 : 409) as 404 | 409 };
    })).value;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const draining = this.reads.close();
    return this.closing = Promise.resolve().then(async () => {
      await draining;
      while (this.hydration.size) await Promise.allSettled([...this.hydration.values()]);
      await Promise.allSettled([...this.displayReads.values()].map(entry => entry.work));
      await Promise.allSettled([...this.displayChecks.values()]);
      await Promise.allSettled([...this.displaySnapshots.values()]);
      this.displayReads.clear();
      const trace = guardedTrace(this.diagnostics, 'connector-event-projection'); trace.add('step', 94); trace.finish();
    });
  }
}
