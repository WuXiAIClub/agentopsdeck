import { ResearchError } from './workspace-search-provider.js';

export type ResearchAuthorize = (() => boolean | Promise<boolean>) & {
  /** Optional synchronous LOCAL snapshot/closed fence, never identity evidence
   * or SQL permission. True here cannot authorize anything on its own. */
  current?: () => boolean;
};

/** Caller deadlines never settle original IO. Retain before invoking callbacks,
 * including reentrant close; all retained completions are rejection-safe. */
export class ResearchWork {
  private readonly pending = new Set<Promise<void>>();
  track<T>(run: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const original = new Promise<void>(resolve => { release = resolve; });
    this.pending.add(original);
    const finish = () => { this.pending.delete(original); release(); };
    try { return Promise.resolve(run()).then(value => { finish(); return value; }, error => { finish(); throw error; }); }
    catch (error) { finish(); return Promise.reject(error); }
  }
  async drain(): Promise<void> { while (this.pending.size) await Promise.all([...this.pending]); }
}

/** One original current-authority check at a time, including stream reads and
 * periodic checks. No cached true, interval fan-out or permission on rejection. */
export class ResearchAuthorization {
  private pending: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  constructor(private readonly authorized: ResearchAuthorize, private readonly controller: AbortController,
    private readonly originals: ResearchWork) {}
  assertActive() {
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
    if (this.authorized.current && this.authorized.current() !== true) throw new ResearchError(401, 'authorization_changed');
  }
  check(): void | Promise<void> {
    this.assertActive();
    if (this.pending) return this.pending;
    const assert = (value: unknown) => {
      this.assertActive();
      if (value !== true) throw new ResearchError(401, 'authorization_changed');
    };
    let result: boolean | Promise<boolean>;
    try { result = this.authorized(); } catch { assert(false); return; }
    if (typeof result === 'boolean') return assert(result);
    const original = this.originals.track(() => result);
    const checked = original.then(assert, () => assert(false));
    this.pending = checked;
    void checked.then(() => { if (this.pending === checked) this.pending = undefined; },
      () => { if (this.pending === checked) this.pending = undefined; });
    return checked;
  }
  watch() {
    const schedule = () => {
      if (this.stopped || this.controller.signal.aborted) return;
      this.timer = setTimeout(() => {
        try {
          const checked = this.check();
          if (checked) void checked.then(schedule, error => this.controller.abort(error));
          else schedule();
        } catch (error) { this.controller.abort(error); }
      }, 250);
      this.timer.unref();
    };
    schedule();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
}
