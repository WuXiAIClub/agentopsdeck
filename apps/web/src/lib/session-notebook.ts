import { NOTEBOOK_MAX_CHARS, type SessionNotebookDocument } from '@agentopsdeck/shared';
export { NOTEBOOK_MAX_CHARS };
export type NotebookTransferOutcome = 'applied' | 'busy' | 'unavailable' | 'too-large';
/** Fence untrusted citations as literal text; preserve existing Markdown byte-for-byte. */
export function prependNotebookReading(existing: string, reading: string): string {
  let longest = 2;
  for (const match of reading.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${reading}\n${fence}\n\n${existing}`;
}
export type NotebookDocument = SessionNotebookDocument;
export type NotebookState = {
  phase: 'closed' | 'loading' | 'ready' | 'saving' | 'error' | 'conflict';
  text: string; document?: NotebookDocument; remote?: NotebookDocument | undefined; localUnavailable: boolean;
};
type Draft = Pick<NotebookDocument, 'text' | 'revision' | 'resourceId'>;
export type NotebookDependencies = {
  read: () => Promise<NotebookDocument>; write: (value: Draft) => Promise<NotebookDocument>;
  current: () => boolean; storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; key: string; maxChars?: number;
  cacheKey?: string | undefined;
};

const MAX_CACHED_NOTEBOOKS = 128;
const cachedNotebookDocuments = new Map<string, NotebookDocument>();

export function readCachedNotebookDocument(cacheKey: string | undefined): NotebookDocument | undefined {
  if (!cacheKey) return undefined;
  const doc = cachedNotebookDocuments.get(cacheKey);
  return doc ? { ...doc } : undefined;
}

export function writeCachedNotebookDocument(cacheKey: string | undefined, doc: NotebookDocument): void {
  if (!cacheKey) return;
  cachedNotebookDocuments.delete(cacheKey);
  cachedNotebookDocuments.set(cacheKey, { ...doc });
  while (cachedNotebookDocuments.size > MAX_CACHED_NOTEBOOKS) {
    const oldest = cachedNotebookDocuments.keys().next().value;
    if (oldest === undefined) break;
    cachedNotebookDocuments.delete(oldest);
  }
}

export function clearCachedNotebookDocuments(predicate?: (key: string) => boolean): void {
  if (!predicate) {
    cachedNotebookDocuments.clear();
    return;
  }
  for (const key of [...cachedNotebookDocuments.keys()]) {
    if (predicate(key)) cachedNotebookDocuments.delete(key);
  }
}

/** One serialized writer per resource. Uncertain writes are reconciled by GET,
 * never replayed blindly. Draft recovery is also bound to the verified node. */
export class NotebookController {
  private state: NotebookState = { phase: 'closed', text: '', localUnavailable: false };
  private hydratedFromCache = false;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = false;
  private departed = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;
  private epoch = 0;
  private idleWaiters = new Set<() => void>();
  constructor(private readonly deps: NotebookDependencies) {
    const cached = this.deps.current() ? readCachedNotebookDocument(this.deps.cacheKey) : undefined;
    if (cached) {
      let draftText: string | undefined;
      let localUnavailable = false;
      try {
        const raw = this.deps.storage().getItem(this.deps.key);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object' && 'text' in parsed && typeof parsed.text === 'string' && parsed.text.length <= this.maxChars
          && 'revision' in parsed && Number.isSafeInteger(parsed.revision) && 'resourceId' in parsed && typeof parsed.resourceId === 'string'
          && (parsed as Draft).resourceId === cached.resourceId && (parsed as Draft).revision === cached.revision) {
          draftText = (parsed as Draft).text;
        }
      } catch {
        localUnavailable = true;
      }
      this.state = { phase: 'ready', document: cached, text: draftText ?? cached.text, localUnavailable };
      this.hydratedFromCache = true;
    }
  }
  private get maxChars() { return this.deps.maxChars ?? NOTEBOOK_MAX_CHARS; }
  needsRevalidate = () => this.hydratedFromCache && !this.pending;
  /** Invalidate pre-lock responses, even if the same account unlocks before
   * they arrive. Keep drafts; resume must reconcile instead of replaying PUT. */
  suspend() { this.epoch++; clearTimeout(this.timer); clearTimeout(this.retryTimer); }
  async reconcile() {
    const epoch = this.epoch;
    if (this.pending) await this.settled();
    if (epoch === this.epoch && !this.departed && this.deps.current() && this.state.phase !== 'closed') await this.load();
  }
  settled = () => this.pending ? new Promise<void>(resolve => this.idleWaiters.add(resolve)) : Promise.resolve();
  private notifyIdle() {
    queueMicrotask(() => { if (!this.pending) { this.idleWaiters.forEach(resolve => resolve()); this.idleWaiters.clear(); } });
  }
  get = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<NotebookState>) {
    if (!this.deps.current()) return;
    this.state = { ...this.state, ...change }; this.listeners.forEach(listener => listener());
  }
  dirty = () => Boolean(this.state.document && this.state.text !== this.state.document.text);
  private persist() {
    if (this.departed || !this.deps.current() || !this.state.document) return;
    try {
      const store = this.deps.storage();
      if (this.dirty()) store.setItem(this.deps.key, JSON.stringify({ resourceId: this.state.document.resourceId, revision: this.state.document.revision, text: this.state.text }));
      else store.removeItem(this.deps.key);
    } catch { this.publish({ localUnavailable: true }); }
  }
  async load(allowSave = true) {
    if (this.pending || !this.deps.current()) return;
    clearTimeout(this.retryTimer);
    const epoch = this.epoch;
    const current = () => epoch === this.epoch && this.deps.current();
    this.pending = true;
    this.hydratedFromCache = false;
    // Background revision checks must not toggle contenteditable off/on: that
    // blurs ProseMirror, flushes onBlur and interrupts IME/selection. Only the
    // initial load has no safe document to edit. The draft is sampled AFTER
    // the read below, so typing during this request is preserved/conflicted.
    if (!this.state.document) this.publish({ phase: 'loading' });
    try {
      const remote = await this.deps.read();
      if (!current()) return;
      writeCachedNotebookDocument(this.deps.cacheKey, remote);
      let draft: Draft | undefined = this.dirty() && this.state.document ? { ...this.state.document, text: this.state.text } : undefined;
      if (!draft) {
        try {
          const raw = this.deps.storage().getItem(this.deps.key);
          const parsed: unknown = raw ? JSON.parse(raw) : null;
          if (parsed && typeof parsed === 'object' && 'text' in parsed && typeof parsed.text === 'string' && parsed.text.length <= this.maxChars
            && 'revision' in parsed && Number.isSafeInteger(parsed.revision) && 'resourceId' in parsed && typeof parsed.resourceId === 'string') draft = parsed as Draft;
        } catch { this.publish({ localUnavailable: true }); }
      }
      if (draft && draft.resourceId !== remote.resourceId) {
        // Never attach an old node's local draft to a reused connection alias.
        this.publish({ phase: 'conflict', text: draft.text, document: { ...draft, text: '', updatedAt: null }, remote });
      } else if (draft && draft.text !== remote.text && draft.revision !== remote.revision) {
        this.publish({ phase: 'conflict', text: draft.text, document: this.state.document ?? { ...draft, text: remote.text, updatedAt: null }, remote });
      } else {
        this.publish({ phase: 'ready', document: remote, text: draft?.text ?? remote.text, remote: undefined });
        this.persist();
        if (!allowSave && this.dirty()) this.publish({ phase: 'error' });
      }
    } catch { if (current()) this.publish({ phase: 'error' }); }
    finally { this.pending = false; this.notifyIdle(); }
    if (!current()) return;
    if (this.state.phase === 'ready' && this.dirty()) this.schedule();
    if (this.state.phase === 'error') this.scheduleRetry();
    else if (!this.dirty()) this.retryAttempt = 0;
  }
  edit(text: string) {
    if (!this.state.document || text.length > this.maxChars || !this.deps.current()) return;
    this.publish({ text }); this.persist();
    if (this.state.phase === 'ready' || this.state.phase === 'saving') this.schedule();
  }
  /** Explicit UI confirmation only. A dirty/error/conflicting writer is never replaced. */
  prependReading(text: string): NotebookTransferOutcome {
    if (this.departed || !this.deps.current() || !this.state.document || !text.trim()) return 'unavailable';
    if (this.pending || this.state.phase !== 'ready' || this.dirty()) return 'busy';
    if (text.length > this.maxChars) return 'too-large';
    const next = prependNotebookReading(this.state.text, text);
    if (next.length > this.maxChars) return 'too-large';
    this.edit(next);
    return 'applied'; // Staged in the existing revision-aware writer, not a save receipt.
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.departed) return;
    this.timer = setTimeout(() => { void this.flush(); }, 650);
  }
  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (this.departed || !this.deps.current() || this.state.phase !== 'error') return;
    // Reconcile the revision before every retry. Back off even when reads work
    // but writes fail; never automatically resolve a multi-tab conflict.
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(this.retryAttempt++, 4));
    this.retryTimer = setTimeout(() => { void this.retry(); }, delay);
  }
  retry = async () => {
    if (!this.departed && this.deps.current() && this.state.phase === 'error') await this.load();
  };
  async flush() {
    clearTimeout(this.timer);
    if (this.pending || !this.deps.current() || !this.dirty() || this.state.phase !== 'ready' || !this.state.document) return;
    const epoch = this.epoch;
    const current = () => epoch === this.epoch && this.deps.current();
    this.pending = true;
    const value = { resourceId: this.state.document.resourceId, revision: this.state.document.revision, text: this.state.text };
    this.publish({ phase: 'saving' });
    try {
      const saved = await this.deps.write(value);
      if (!current()) return;
      writeCachedNotebookDocument(this.deps.cacheKey, saved);
      this.publish({ document: saved, phase: 'ready' }); this.persist();
    } catch { if (current()) this.publish({ phase: 'error' }); }
    finally { this.pending = false; this.notifyIdle(); }
    if (!current()) return;
    if (this.get().phase === 'error' && !this.departed && this.deps.current()) await this.load(false);
    else if (this.dirty() && this.state.phase === 'ready') this.schedule();
  }
  resolve(keepDraft: boolean) {
    const remote = this.state.remote;
    if (!remote || (keepDraft && remote.resourceId !== this.state.document?.resourceId)) return;
    writeCachedNotebookDocument(this.deps.cacheKey, remote);
    this.publish({ document: remote, text: keepDraft ? this.state.text : remote.text, phase: 'ready', remote: undefined });
    this.persist(); if (this.dirty()) void this.flush();
  }
  leave() { clearTimeout(this.timer); clearTimeout(this.retryTimer); this.departed = true; void this.flush(); }
  enter() { this.departed = false; if (this.state.phase === 'error') this.scheduleRetry(); else if (this.state.phase === 'ready' && this.dirty()) this.schedule(); }
}

/** Shared within one authenticated page. Keep the writer through in-flight
 * saves even when the last view closes; a reopened view must not race it. */
export class NotebookRegistry {
  private entries = new Map<string, { controller: NotebookController; users: number }>();
  private suspended = false;
  constructor(private readonly current: () => boolean) {}
  dirty = () => [...this.entries.values()].some(entry => entry.controller.dirty());
  ready = (keys: string[]) => keys.every(key => {
    const controller = this.entries.get(key)?.controller;
    return !controller || (!controller.dirty() && controller.get().phase === 'ready');
  });
  flush = () => { for (const entry of this.entries.values()) if (entry.users) void entry.controller.flush(); };
  retry = () => { for (const entry of this.entries.values()) if (entry.users) void entry.controller.retry(); };
  suspend = () => { this.suspended = true; for (const entry of this.entries.values()) entry.controller.suspend(); };
  resume = () => { if (this.suspended) { this.suspended = false; this.reconcile(); } };
  reconcile = () => { for (const entry of this.entries.values()) if (entry.users) void entry.controller.reconcile(); };
  get(key: string, dependencies: Omit<NotebookDependencies, 'current'>) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { controller: new NotebookController({ ...dependencies, current: () => !this.suspended && this.current() }), users: 0 };
      this.entries.set(key, entry);
    }
    return entry.controller;
  }
  retain(key: string, controller: NotebookController) {
    const entry = this.entries.get(key);
    if (!entry || entry.controller !== controller) throw new Error('Notebook writer is no longer registered');
    entry.users++; controller.enter();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--entry.users) return;
      controller.leave();
      void controller.settled().then(() => {
        if (!entry.users && this.entries.get(key) === entry) this.entries.delete(key);
      });
    };
  }
}

export function boundNotebookPosition(x: number, y: number, width: number, height: number,
  viewport: { left: number; top: number; width: number; height: number }) {
  return { x: Math.max(viewport.left + 8, Math.min(x, viewport.left + viewport.width - width - 8)),
    y: Math.max(viewport.top + 8, Math.min(y, viewport.top + viewport.height - height - 8)) };
}
