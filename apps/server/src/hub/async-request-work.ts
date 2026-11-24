import { HubMemberRequestError } from './async-member-request.js';

/** Own the complete original operation, including non-SQL waits. This is not
 * a mutation ACK, timeout, authorization grant or database owner. The caller
 * must still check original authority at each effect and delivery boundary.
 * A returned ConnectorClient has its separate transport/request ownership. */
export class HubRequestWork {
  private readonly originals = new Set<Promise<void>>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private bytes = 0;
  constructor(private readonly capacity = 256, private readonly byteCapacity = Number.MAX_SAFE_INTEGER) {}
  get pending() { return this.originals.size; }
  get pendingBytes() { return this.bytes; }
  check() { if (this.closed) throw new HubMemberRequestError(503); }
  async run<T>(work: () => T | PromiseLike<T>, bytes = 0): Promise<T> {
    this.check();
    if (this.pending >= this.capacity || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.byteCapacity - this.bytes) throw new HubMemberRequestError(503);
    let complete!: () => void;
    const original = new Promise<void>(resolve => { complete = resolve; });
    // Publish before invoking code that could synchronously reenter close().
    this.originals.add(original);
    this.bytes += bytes;
    try {
      const value = await work();
      this.check();
      return value;
    } catch (error) {
      this.check(); // Closed delivery must not publish a late upstream error.
      throw error;
    } finally { this.originals.delete(original); this.bytes -= bytes; complete(); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.all([...this.originals]).then(() => {});
    return this.closing;
  }
}
