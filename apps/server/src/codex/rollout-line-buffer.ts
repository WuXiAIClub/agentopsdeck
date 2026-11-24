/** Split borrowed/reusable read buffers without copying complete records or
 * repeatedly copying/scanning an unfinished record. Only trailing fragments
 * survive the caller's next read. Consumers must finish using each yielded
 * view before advancing; raw byte offsets and invalid UTF-8 are preserved. */
export class RolloutLineBuffer {
  private fragments: Buffer[] = [];
  private bytes = 0;
  constructor(private readonly maxBytes = Infinity) {}

  private check(bytes: number) {
    if (bytes > this.maxBytes) throw new Error('Rollout record budget exceeded');
  }

  *push(chunk: Buffer): Generator<Buffer> {
    let start = 0;
    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
      const part = chunk.subarray(start, end);
      this.check(this.bytes + part.length);
      const line = this.fragments.length
        ? Buffer.concat([...this.fragments, part], this.bytes + part.length) : part;
      this.fragments = []; this.bytes = 0;
      yield line;
      start = end + 1;
    }
    if (start < chunk.length) {
      const tail = chunk.subarray(start);
      this.check(this.bytes + tail.length);
      this.fragments.push(Buffer.from(tail));
      this.bytes += tail.length;
    }
  }

  finish(): Buffer {
    const tail = !this.bytes ? Buffer.alloc(0) : this.fragments.length === 1 ? this.fragments[0]!
      : Buffer.concat(this.fragments, this.bytes);
    this.fragments = []; this.bytes = 0;
    return tail;
  }
}
