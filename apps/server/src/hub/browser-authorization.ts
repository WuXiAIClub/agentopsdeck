/** Current authority, not an already resolved permission boolean. current is
 * only a synchronous local closed/cancel fence; it never grants authority. */
export type BrowserAuthorize = (() => boolean | Promise<boolean>) & { current?: () => boolean };

/** Install ownership before callbacks (which may synchronously request close). */
export class BrowserWork {
  private readonly pending = new Set<Promise<void>>();
  track<T>(run: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const original = new Promise<void>(resolve => { release = resolve; });
    this.pending.add(original);
    const finish = () => { this.pending.delete(original); release(); };
    try { return Promise.resolve(run()).then(value => { finish(); return value; }, error => { finish(); throw error; }); }
    catch (error) { finish(); return Promise.reject(error); }
  }
  async drain() { while (this.pending.size) await Promise.all([...this.pending]); }
}

/** Keep the synchronous legacy path synchronous, but coalesce real asynchronous
 * checks. A denial is sticky for this original identity, never a cached grant. */
export class BrowserAuthorization {
  private pending: Promise<void> | undefined;
  private denied = false;
  constructor(private readonly authorize: BrowserAuthorize,
    private readonly retain: <T>(run: () => Promise<T>) => Promise<T>) {}
  current() {
    if (this.denied || (this.authorize.current && this.authorize.current() !== true)) throw Error('browser_revoked');
  }
  check(): void | Promise<void> {
    this.current();
    if (this.pending) return this.pending;
    const reject = (): never => { this.denied = true; throw Error('browser_revoked'); };
    const assert = (value: unknown) => { if (value !== true) reject(); this.current(); };
    let value: boolean | Promise<boolean>;
    try { value = this.authorize(); } catch { return reject(); }
    if (typeof value === 'boolean') return assert(value);
    const checked = this.retain(() => value).then(assert, reject);
    this.pending = checked;
    void checked.then(() => { if (this.pending === checked) this.pending = undefined; },
      () => { if (this.pending === checked) this.pending = undefined; });
    return checked;
  }
}
