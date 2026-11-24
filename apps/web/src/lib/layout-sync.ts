export type LayoutDocument = { revision: number; content: string | null; snapshot?: string | null };
export type LayoutSyncPhase = 'loading' | 'saved' | 'saving' | 'offline' | 'conflict';
type Dependencies = {
  load: (signal: AbortSignal) => Promise<LayoutDocument>;
  save: (value: { revision: number; content: string }, signal: AbortSignal) => Promise<LayoutDocument>;
  apply: (value: string) => boolean;
  current: () => boolean;
  visible?: () => boolean;
  pending?: () => LayoutDocument | null | undefined;
  checkpoint?: (base: LayoutDocument | null | undefined) => void;
  debounceMs?: number | undefined;
  equivalent?: ((a: string, b: string) => boolean) | undefined;
  merge?: ((input: { local: string; remote: string; base: string | null | undefined; initialBoot: boolean }) => string | null) | undefined;
};
/** One bounded request/timer per collection. A failed write is reconciled by
 * GET before any retry; concurrent edits require an explicit user choice. */
export class LayoutSync {
  private value: string;
  private base: LayoutDocument | undefined;
  private remote: LayoutDocument | undefined;
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private edited = false;
  private restoredPending = false;
  private delay = 15_000;
  private listeners = new Set<() => void>();
  private phase: LayoutSyncPhase = 'loading';
  constructor(value: string, private readonly deps: Dependencies) {
    this.value = value;
    const pending = deps.pending?.();
    if (pending !== undefined) {
      this.edited = true;
      this.restoredPending = true;
      this.base = pending ?? undefined;
    }
  }
  private get debounceMs() {
    return this.deps.debounceMs ?? 1200;
  }
  private same(a: string | null, b: string): boolean {
    if (a === null) return false;
    return a === b || Boolean(this.deps.equivalent?.(a, b));
  }
  private checkpoint() {
    if (!this.edited) {
      this.deps.checkpoint?.(undefined);
      return;
    }
    this.deps.checkpoint?.(
      this.base
        ? { revision: this.base.revision, content: this.base.content, snapshot: this.value }
        : null,
    );
  }
  snapshot = () => this.phase;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify(phase: LayoutSyncPhase) { this.phase = phase; for (const listener of this.listeners) listener(); }
  private current() { return this.active && this.deps.current(); }
  start() { this.active = true; void this.reconcile(); }
  stop() { this.active = false; clearTimeout(this.timer); this.controller?.abort(); this.controller = undefined; }
  edit(value: string) {
    if (this.value === value) return;
    const prev = this.value;
    if (!this.edited && this.same(prev, value)) {
      this.value = value;
      return;
    }
    this.value = value; this.edited = true;
    this.checkpoint();
    if (this.phase !== 'conflict') this.schedule(this.debounceMs);
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (this.current()) this.timer = setTimeout(() => { void this.reconcile(); }, delay);
  }
  retry = () => { if (this.phase !== 'conflict') void this.reconcile(); };
  useRemote = () => {
    if (!this.current() || !this.remote?.content || !this.deps.apply(this.remote.content)) return;
    this.value = this.remote.content; this.base = this.remote; this.edited = false; this.restoredPending = false; this.checkpoint(); this.notify('saved');
  };
  keepLocal = () => {
    if (!this.current() || !this.remote) return;
    this.base = this.remote; this.edited = true; this.restoredPending = false; this.checkpoint(); this.notify('saving'); this.schedule(0);
  };
  async reconcile() {
    if (!this.current() || this.deps.visible?.() === false || this.controller || this.phase === 'conflict') return;
    clearTimeout(this.timer);
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const current = () => this.current() && !controller.signal.aborted && this.controller === controller;
    try {
      const remote = await this.deps.load(controller.signal);
      if (!current()) return;
      if (!Number.isSafeInteger(remote.revision) || remote.revision < 0 || (remote.content !== null && typeof remote.content !== 'string')) throw Error('Invalid layout response');
      this.remote = remote;
      if (!this.base) {
        if (remote.content !== null && !this.edited) {
          if (!this.deps.apply(remote.content)) { this.notify('conflict'); return; }
          this.value = remote.content;
        } else if (remote.content !== null && !this.same(remote.content, this.value)) {
          const merged = this.deps.merge?.({
            local: this.value,
            remote: remote.content,
            base: undefined,
            initialBoot: !this.restoredPending,
          });
          if (merged !== null && merged !== undefined) {
            if (merged !== this.value) {
              if (!this.deps.apply(merged)) { this.notify('conflict'); return; }
              this.value = merged;
            }
            this.base = remote;
            this.restoredPending = false;
            if (this.same(remote.content, merged)) {
              this.edited = false;
              this.checkpoint();
              this.notify('saved');
              this.delay = 15_000;
              return;
            }
            this.edited = true;
          } else {
            this.notify('conflict');
            return;
          }
        }
        this.base = remote;
      }
      if (this.same(remote.content, this.value)) {
        this.base = remote;
        this.edited = false;
        this.restoredPending = false;
        this.checkpoint();
        this.notify('saved');
        this.delay = 15_000;
        return;
      }
      if (remote.revision !== this.base.revision) {
        if (!this.edited && remote.content !== null && this.deps.apply(remote.content)) {
          this.value = remote.content; this.base = remote; this.restoredPending = false; this.notify('saved');
          return;
        }
        if (this.edited && remote.content !== null && this.deps.merge) {
          const merged = this.deps.merge({
            local: this.value,
            remote: remote.content,
            base: this.base.content,
            initialBoot: false,
          });
          if (merged !== null && merged !== undefined) {
            if (merged !== this.value) {
              if (!this.deps.apply(merged)) { this.notify('conflict'); return; }
              this.value = merged;
            }
            this.base = remote;
            this.restoredPending = false;
            if (this.same(remote.content, merged)) {
              this.edited = false;
              this.checkpoint();
              this.notify('saved');
              this.delay = 15_000;
              return;
            }
            this.edited = true;
            this.checkpoint();
          } else {
            this.notify('conflict');
            return;
          }
        } else {
          this.notify('conflict');
          return;
        }
      }
      const value = this.value;
      this.edited = true; this.checkpoint();
      this.notify('saving');
      const saved = await this.deps.save({ revision: remote.revision, content: value }, controller.signal);
      if (!current()) return;
      if (!Number.isSafeInteger(saved.revision) || saved.revision <= 0 || saved.content !== value) throw Error('Invalid layout acknowledgement');
      this.base = saved; this.remote = saved; this.restoredPending = false; this.delay = 15_000;
      if (this.same(value, this.value)) { this.edited = false; this.checkpoint(); this.notify('saved'); }
      else { this.checkpoint(); this.schedule(this.debounceMs); }
    } catch {
      if (this.current() && this.controller === controller) { this.notify('offline'); this.schedule(this.delay); this.delay = Math.min(60_000, this.delay * 2); }
    } finally { clearTimeout(timeout); if (this.controller === controller) this.controller = undefined; }
  }
}
