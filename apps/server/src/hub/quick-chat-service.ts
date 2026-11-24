import { createHash } from 'node:crypto';
import { QuickChatConflict, QuickChatStore, type QuickChatCapability, type QuickChatProfile } from './quick-chat-store.js';
import type { ResearchSynthesisConfig } from './workspace-research.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncQuickChatExecution, AsyncQuickChatContext } from './async-quick-chat-execution.js';

/** Uses only the fixed administrator-configured standalone Responses endpoint.
 * originalLookup means the Hub's original durable receipt, NOT provider replay
 * or retrieval. If a provider response is lost, it may remain unknown forever.
 * A bounded, caller-supplied transcript enables temporary multi-turn chat.
 * No session/thread endpoint, background response or provider continuation is used. */
export class QuickChatService {
  private closed = false;
  private readonly originalWork = new Set<Promise<unknown>>();
  private closeWork: Promise<void> | undefined;
  private active = new Set<AbortController>();
  private models: Array<{ id: string; label: string }> = [];
  private catalogState: 'ready' | 'unavailable' = 'unavailable';
  private catalogExpires = 0;
  private catalogRead: Promise<void> | undefined;
  private catalogObservation: Promise<void> | undefined;
  private catalogControllers = new Set<AbortController>();
  private readonly expiryTimer: ReturnType<typeof setInterval>;
  constructor(private readonly legacyStore: QuickChatStore | undefined, private readonly config?: ResearchSynthesisConfig,
    private readonly transport: typeof fetch = fetch, private readonly timeoutMs = 45_000,
    private readonly options: { discoverModels?: boolean; defaultModel?: string; catalogTimeoutMs?: number;
      diagnostics?: PerformanceDiagnostics; persistence?: AsyncQuickChatExecution } = {}) {
    this.models = config ? [{ id: config.model, label: config.model }] : [];
    void this.purgeExpired()?.catch(() => {});
    this.expiryTimer = setInterval(() => { try { void this.purgeExpired()?.catch(() => {}); } catch { /* Reads still fail closed; retry next bounded sweep. */ } }, 60_000);
    this.expiryTimer.unref?.();
  }
  get store(): QuickChatStore {
    if (!this.legacyStore) throw new Error('Quick chat synchronous store unavailable');
    return this.legacyStore;
  }
  get persistence() { return this.options.persistence; }
  private purgeExpired() {
    if (this.options.persistence) return this.trackOriginal(async () => {
      let trace: ReturnType<PerformanceDiagnostics['start']> | undefined, failed = true;
      try { trace = (this.options.diagnostics ?? performanceDiagnostics).start('hub-quick-chat'); trace.add('step', 16); } catch { /* Observation only. */ }
      try { await this.options.persistence!.effect({ action: 'expire' }); failed = false; }
      finally { try { trace?.add(failed ? 'unknown' : 'settled', 1); trace?.finish(failed); } catch { /* Original ACK unchanged. */ } }
    });
    let trace: ReturnType<PerformanceDiagnostics['start']> | undefined, failed = true;
    try { trace = (this.options.diagnostics ?? performanceDiagnostics).start('hub-quick-chat'); trace.add('step',16); } catch { /* Observation only. */ }
    try { this.store.purgeExpired(); failed = false; }
    finally {
      try { trace?.add(failed ? 'unknown' : 'settled',1); trace?.finish(failed); } catch { /* Keep the original sweep result. */ }
    }
  }
  target(owner: string) {
    if (this.closed || !this.config?.users.includes(owner)) return;
    return { id: 'hub-standalone', label: 'Hub standalone Responses', provider: new URL(this.config.url).origin,
      model: this.models.some(m => m.id === this.options.defaultModel) ? this.options.defaultModel!
        : this.models.some(m => m.id === this.config!.model) ? this.config.model : this.models[0]!.id,
      models: this.models, catalogState: this.catalogState, maxOutput: 2000, recovery: 'local-receipt-only' as const };
  }
  /** Model discovery uses the same fixed provider and credential as inference.
   * Agent-only login models are not advertised as standalone capabilities. */
  async catalog(owner: string, force = false) {
    if (!this.target(owner) || !this.config || !this.options.discoverModels) return this.target(owner);
    if (!this.catalogRead && (force || Date.now() >= this.catalogExpires)) {
      this.startCatalog();
    }
    await this.catalogObservation;
    return this.target(owner);
  }
  private startCatalog() {
    let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
    const controller = new AbortController(); this.catalogControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.options.catalogTimeoutMs ?? 5000); timer.unref?.();
    const unavailable = () => {
      this.models = [{ id: this.config!.model, label: this.config!.model }]; this.catalogState = 'unavailable';
    };
    let stopObserving!: () => void;
    const stopped = new Promise<void>(resolve => { stopObserving = () => { unavailable(); resolve(); }; });
    controller.signal.addEventListener('abort', stopObserving, { once: true });
    const work = this.trackOriginal(async () => {
      try { trace = (this.options.diagnostics ?? performanceDiagnostics).start('hub-quick-chat'); trace.add('step', 7); } catch { /* Observation only. */ }
      try {
      if (controller.signal.aborted || this.closed) return;
      const url = new URL(this.config!.url);
      if (!url.pathname.endsWith('/responses')) throw Error('catalog-unavailable');
      url.pathname = url.pathname.slice(0, -'responses'.length) + 'models';
      const response = await this.transport(url.href, { method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.config!.token}` } });
      if (controller.signal.aborted) { await response.body?.cancel(); return; }
      if (!response.ok || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel(); throw Error('catalog-unavailable');
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0, finished = false;
      // Keep the first cancel promise. A second cancel on a closed stream can
      // resolve before the underlying source has finished its original cleanup.
      let cancellation: Promise<void> | undefined;
      const cancelReader = () => cancellation ??= reader.cancel().catch(() => {});
      const abort = () => { void cancelReader(); };
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        while (true) {
          if (controller.signal.aborted) throw Error('catalog-timeout');
          const part = await reader.read();
          if (controller.signal.aborted) throw Error('catalog-timeout');
          if (part.done) { finished = true; break; }
          bytes += part.value.byteLength; if (bytes > 128 * 1024) throw Error('catalog-oversize'); chunks.push(part.value);
        }
      } finally { controller.signal.removeEventListener('abort', abort); if (!finished || cancellation) await cancelReader(); reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      if (!Array.isArray(data.data) || data.data.length > 512 || !data.data.length
        || data.data.some((m: { id?: unknown }) => !m || typeof m.id !== 'string' || !m.id.length || m.id.length > 128
          || m.id.trim() !== m.id || /[\u0000-\u001f\u007f]/.test(m.id))) throw Error('catalog-shape');
      this.models = [...new Set<string>(data.data.map((m: { id: string }) => m.id))].map(id => ({ id, label: id }));
      this.catalogState = 'ready';
    } catch {
      // Do not keep extra permissions from a stale/failed catalogue. The fixed
      // administrator-configured default is the legacy standalone capability.
      unavailable();
    } finally { clearTimeout(timer); this.catalogControllers.delete(controller); this.catalogExpires = Date.now() + 30_000; }
    });
    // Keep the original read lease even if cancellation is ignored. Subsequent
    // force reads share its bounded observation, not a second provider request.
    this.catalogRead = work;
    this.catalogObservation = Promise.race([work, stopped]).finally(() => {
      controller.signal.removeEventListener('abort', stopObserving);
      try { trace?.add(this.catalogState === 'ready' ? 'settled' : 'unknown', 1); trace?.finish(this.catalogState !== 'ready'); } catch { /* Logging cannot release the read lease. */ }
    });
    void work.then(() => {
      if (this.catalogRead === work) { this.catalogRead = undefined; this.catalogObservation = undefined; }
    });
  }
  private capability(owner: string): QuickChatCapability {
    const target = this.target(owner); if (!target || !this.config) throw new QuickChatConflict('target-unavailable');
    return { ephemeralRequest: true, noPersistentThread: true, originalLookup: true, maxOutput: target.maxOutput,
      epoch: createHash('sha256').update(JSON.stringify([this.config.url, this.config.model, this.config.token, this.config.users])).digest('hex') };
  }
  saveProfile(owner: string, revision: number, profile: Omit<QuickChatProfile, 'revision'>, authorized?: () => boolean) {
    const target = this.target(owner);
    if (!target || profile.target !== target.id || !this.models.some(m => m.id === profile.model)) throw new QuickChatConflict('target-changed');
    return this.store.saveProfile(owner, revision, profile, this.capability(owner), authorized);
  }
  saveProfileAwaited(context: AsyncQuickChatContext, revision: number, profile: Omit<QuickChatProfile, 'revision'>) {
    if (this.closed) return Promise.reject(new QuickChatConflict('authority'));
    return this.trackOriginal(async () => {
      await context.check();
      const target = this.target(context.ownerUserId);
      if (!target || profile.target !== target.id || !this.models.some(m => m.id === profile.model)) throw new QuickChatConflict('target-changed');
      return (await context.save(revision, profile, this.capability(context.ownerUserId))).profile!;
    });
  }
  inspect(owner: string, requestId: string) {
    const receipt = this.store.receipt(owner, requestId); if (!receipt) throw new QuickChatConflict('missing');
    // Hash and capability epoch are internal and must not become client tokens.
    const { fingerprint: _, capabilityEpoch: __, resultRef: ___, ...safe } = receipt;
    return { receipt: safe, output: this.store.result(owner, requestId) ?? null };
  }
  send(owner: string, requestId: string, profileId: string, revision: number, input: string, authorized: () => boolean,
    history: unknown = [], context?: AsyncQuickChatContext) {
    if (this.closed) return Promise.reject(new QuickChatConflict('authority'));
    return this.trackOriginal(() => this.sendOriginal(owner, requestId, profileId, revision, input, authorized, history, context));
  }
  private async sendOriginal(owner: string, requestId: string, profileId: string, revision: number, input: string,
    authorized: () => boolean, history: unknown, context?: AsyncQuickChatContext) {
    if (context) { if (owner !== context.ownerUserId) throw new QuickChatConflict('authority'); await context.check(); }
    if (!authorized()) throw new QuickChatConflict('authority');
    // Only complete user/assistant pairs from this temporary conversation are
    // accepted. Never accept system/tool roles or read another session's history.
    if (typeof input !== 'string' || !input.trim() || input.length > 8000 || !Array.isArray(history)
      || history.length > 32 || history.length % 2 !== 0) throw new QuickChatConflict('input');
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    let chars = input.length;
    for (const [index, item] of history.entries()) {
      const role = index % 2 ? 'assistant' : 'user';
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !['role', 'content'].includes(k))
        || item.role !== role || typeof item.content !== 'string' || !item.content.trim()
        || item.content.length > (role === 'user' ? 8000 : 32000)) throw new QuickChatConflict('input');
      chars += item.content.length; if (chars > 48000) throw new QuickChatConflict('input');
      messages.push({ role, content: item.content });
    }
    // Bind deduplication to the whole frozen turn, without storing its plaintext.
    // Preserve legacy single-question receipt identities.
    const identityInput = messages.length ? createHash('sha256').update(JSON.stringify([messages, input])).digest('hex') : input;
    // Original receipt recovery never performs provider discovery or inference.
    if (!(context ? (await context.lookup(requestId, profileId)).receipt : this.store.receipt(owner, requestId))) await this.catalog(owner);
    if (context) await context.check();
    if (!authorized() || this.closed) throw new QuickChatConflict('authority');
    const capability = this.capability(owner), target = this.target(owner)!;
    const snapshot = context ? await context.lookup(requestId, profileId) : undefined;
    const previous = snapshot ? snapshot.receipt : this.store.receipt(owner, requestId),
      profile = snapshot ? snapshot.profile : this.store.profile(owner, profileId);
    if (this.closed) throw new QuickChatConflict('authority');
    if (!previous && (!profile || profile.target !== target.id || !this.models.some(m => m.id === profile.model))) throw new QuickChatConflict('target-changed');
    if (!previous && this.active.size >= 2) throw new QuickChatConflict('provider-capacity');
    if (context) await context.admit(requestId, profileId, revision, identityInput, capability);
    else this.store.admit(owner, requestId, profileId, revision, identityInput, capability, authorized);
    // Reserve before awaited claim. Two callers cannot both observe a free slot
    // and dispatch after the same original work has already filled capacity.
    const controller = new AbortController();
    const needsSlot = !previous || previous.state === 'admitted';
    if (this.closed || needsSlot && this.active.size >= 2) throw new QuickChatConflict('provider-capacity');
    if (needsSlot) this.active.add(controller);
    let claimed: { claimed: boolean; receipt: import('./quick-chat-store.js').QuickChatReceipt; settlementProof?: string | null };
    try {
      if (context) {
        const result = await context.claim(requestId, identityInput, capability);
        claimed = { claimed: result.claimed, receipt: result.receipt!, settlementProof: result.settlementProof };
      } else claimed = this.store.claim(owner, requestId, identityInput, capability, () => !this.closed && authorized());
      if (!claimed.claimed) { this.active.delete(controller); return context ? context.inspect(requestId) : this.inspect(owner, requestId); }
      if (!needsSlot) throw new QuickChatConflict('preflight');
    } catch (error) { this.active.delete(controller); throw error; }
    // A transaction diagnostic can reenter close after the original claim.
    // Retain its UNKNOWN receipt, but never start a provider after that fence.
    if (this.closed) { this.active.delete(controller); throw new QuickChatConflict('authority'); }
    const timer = setTimeout(() => controller.abort(), this.timeoutMs); timer.unref?.();
    // Cancelling HTTP observation is not provider settlement. A transport may
    // ignore AbortSignal; keep its active slot until the original work settles.
    // Fixed phase only: no prompt/output, request ID, owner, URL, provider
    // exception or credential is ever passed to diagnostics. The original
    // provider work (not HTTP observation) owns this trace and its active slot.
    let trace: ReturnType<PerformanceDiagnostics['start']> | undefined, stage = 12, completed = false;
    let stopObserving!: () => void;
    const observationStopped = new Promise<void>(resolve => { stopObserving = resolve; });
    const stopped = () => {
      stopObserving();
      try { trace?.reportPending({step:stage,pending:1,cancelled:1,unknown:1}); } catch { /* Never settle or release to log. */ }
    };
    controller.signal.addEventListener('abort', stopped, { once: true });
    const work = this.trackOriginal(async () => {
      try { trace = (this.options.diagnostics ?? performanceDiagnostics).start('hub-quick-chat'); } catch { /* Observation only. */ }
      try {
      if (controller.signal.aborted || this.closed) return;
      // Claim was durably written synchronously immediately before this I/O.
      const response = await this.transport(this.config!.url, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.config!.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: claimed.receipt.profile.model, store: false, stream: false, tools: [],
          max_output_tokens: claimed.receipt.profile.outputLimit, input: [...messages, { role: 'user', content: input }] }) });
      stage = 13;
      if (controller.signal.aborted) { await response.body?.cancel(); return; }
      if (!response.ok || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel(); return;
      }
      stage = 14;
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0, finished = false;
      let cancellation: Promise<void> | undefined;
      const cancelReader = () => cancellation ??= reader.cancel().catch(() => {});
      const abort = () => { void cancelReader(); };
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        while (true) {
          if (controller.signal.aborted) throw new Error('stopped');
          const part = await reader.read();
          if (controller.signal.aborted) throw new Error('stopped');
          if (part.done) { finished = true; break; }
          bytes += part.value.byteLength; if (bytes > 128 * 1024) throw new Error('oversize'); chunks.push(part.value);
        }
      } finally { controller.signal.removeEventListener('abort', abort); if (!finished || cancellation) await cancelReader(); reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      if (data.status !== 'completed' || !Array.isArray(data.output)) throw new Error('incomplete');
      let output = '';
      for (const item of data.output) {
        if (item?.type === 'reasoning') continue;
        if (item?.type !== 'message' || item.role !== 'assistant' || item.status !== undefined && item.status !== 'completed' || !Array.isArray(item.content)) throw new Error('shape');
        for (const part of item.content) {
          if (part?.type === 'output_text' && typeof part.text === 'string') output += part.text;
          else if (part?.type === 'refusal' && typeof part.refusal === 'string') output += part.refusal;
          else throw new Error('shape');
        }
      }
      stage = 15;
      if (context) {
        if (!claimed.settlementProof || !this.options.persistence) throw new Error('settlement-unavailable');
        await this.options.persistence.effect({ action: 'settle', ownerUserId: owner, requestId, proof: claimed.settlementProof, output });
      } else this.store.complete(owner, requestId, output);
      completed = true;
    } catch { /* Transport, timeout, parse or durable write failure is unknown, never a retry. */ }
    finally {
      clearTimeout(timer); this.active.delete(controller);
      try { trace?.add('step',stage); trace?.add(completed ? 'settled' : 'unknown',1);
        if (controller.signal.aborted) trace?.add('cancelled',1);
        trace?.finish(!completed); } catch { /* Keep the original SQL/provider outcome. */ }
    }
    });
    try { await Promise.race([work, observationStopped]); }
    finally { controller.signal.removeEventListener('abort', stopped); }
    return context ? context.inspect(requestId) : this.inspect(owner, requestId);
  }
  /** Publish original ownership before transport or diagnostics can reenter.
   * Only actual settlement removes work, never the HTTP observation race. */
  private trackOriginal<T>(run: () => Promise<T>): Promise<T> {
    const work = Promise.resolve().then(run);
    // Caller conflicts/denials are still returned to the original caller, but
    // are not a failure to drain the underlying work. Keep a settlement-only
    // promise so close waits ALL operations, including rejected admissions.
    const retained = work.then(() => { this.originalWork.delete(retained); }, () => { this.originalWork.delete(retained); });
    this.originalWork.add(retained);
    return work;
  }
  /** Fence admission synchronously, then acknowledge only original settlement.
   * Abort is a signal, not a provider outcome or permission to close SQLite. */
  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closed = true; clearInterval(this.expiryTimer);
    let resolve!: () => void, reject!: (error: Error) => void;
    this.closeWork = new Promise<void>((ok, bad) => { resolve = ok; reject = bad; });
    let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
    try { trace = (this.options.diagnostics ?? performanceDiagnostics).start('hub-quick-chat'); trace.add('step',17); } catch { /* Observation only. */ }
    const warning = setTimeout(() => {
      try { trace?.reportPending({step:17,pending:this.originalWork.size,unknown:1}); } catch { /* Never release original work. */ }
    },30_000); warning.unref?.();
    for (const controller of [...this.active, ...this.catalogControllers]) controller.abort();
    void Promise.allSettled([...this.originalWork]).then(async results => {
      await this.options.persistence?.close();
      if (results.some(result => result.status === 'rejected')) throw new Error('Quick chat drain unavailable');
    }).then(() => {
      clearTimeout(warning);
      try { trace?.add('settled',1); trace?.finish(); } catch { /* Preserve the real close acknowledgement. */ }
      resolve();
    },() => {
      clearTimeout(warning);
      try { trace?.add('unknown',1); trace?.finish(true); } catch { /* Preserve original ownership failure. */ }
      reject(new Error('Quick chat drain unavailable'));
    });
    return this.closeWork;
  }
}
