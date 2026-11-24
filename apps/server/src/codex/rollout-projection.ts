import { mkdtemp, open, rm, unlink, rmdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { temporaryProjectionSpaceBudget, withTemporaryProjectionWrite, type ProjectionSpaceBudget } from '../storage/space-budget.js';
import { HistoryYield } from './history-yield.js';
import { RolloutLineBuffer } from './rollout-line-buffer.js';

const chunkBytes = 1024 * 1024;
const defaultMemoryBytes = 8 * chunkBytes;
type Block = { bytes: number; memoryBytes: number; refs: number; lines: () => AsyncGenerator<string>; close: () => Promise<void> };

/** Immutable, repeatable projection. Leases keep shared append segments alive
 * while another refresh evicts/replaces its cache entry. Private spill files
 * are disposable projections, never native history or execution evidence. */
export class RolloutProjection implements AsyncIterable<string> {
  private disposed = false;
  private disposing: Promise<void> | undefined;
  readonly bytes: number;
  readonly memoryBytes: number;
  constructor(private readonly blocks: readonly Block[]) {
    this.bytes = blocks.reduce((sum, block) => sum + block.bytes, 0);
    this.memoryBytes = blocks.reduce((sum, block) => sum + block.memoryBytes, 0);
    for (const block of blocks) block.refs++;
  }
  get segments() { return this.blocks.length; }
  fork() {
    if (this.disposed) throw Error('Rollout projection was released');
    return new RolloutProjection(this.blocks);
  }
  append(tail: RolloutProjection) {
    if (this.disposed || tail.disposed) throw Error('Rollout projection was released');
    return new RolloutProjection([...this.blocks, ...tail.blocks]);
  }
  async *[Symbol.asyncIterator]() {
    const lease = this.fork();
    const fairness = new HistoryYield();
    try {
      for (const block of this.blocks) for await (const line of block.lines()) {
        const pause = fairness.checkpoint(line.length);
        if (pause) await pause;
        yield line;
      }
    }
    finally { await lease.dispose(); }
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    // Retire this lease exactly once. Repeated calls observe the same original
    // block cleanup, including a rejection; a flag is not close completion.
    this.disposing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(this.blocks.map(async block => {
        if (--block.refs === 0) await block.close();
      }));
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    });
    return this.disposing;
  }
}

/** Build bounded chunks, spilling to a 0700 temporary directory / 0600 file.
 * No giant join(), no whole-file split(), no per-record disk write. */
export class RolloutProjectionBuilder {
  private rows: string[] = [];
  private bufferedBytes = 0;
  private bytes = 0;
  private directory: string | undefined;
  private handle: FileHandle | undefined;
  private transferred = false;
  constructor(private readonly memoryLimit = defaultMemoryBytes,
    private readonly space: Pick<ProjectionSpaceBudget, 'consume'> = temporaryProjectionSpaceBudget) {}
  private async flush() {
    if (!this.rows.length || !this.handle) return;
    const buffer = Buffer.from(this.rows.join(''));
    await this.space.consume(buffer.length);
    await withTemporaryProjectionWrite(buffer.length, async () => {
      let at = 0;
      while (at < buffer.length) {
        const { bytesWritten } = await this.handle!.write(buffer, at, buffer.length - at);
        if (!bytesWritten) throw Error('Rollout projection write incomplete');
        at += bytesWritten;
      }
    });
    this.rows = []; this.bufferedBytes = 0;
  }
  async add(line: string) {
    if (!line) return;
    if (this.transferred) throw Error('Rollout projection builder closed');
    const bytes = Buffer.byteLength(line);
    this.bytes += bytes; this.bufferedBytes += bytes; this.rows.push(line);
    if (!this.handle && this.bufferedBytes > this.memoryLimit) {
      this.directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-rollout-projection-'));
      this.handle = await open(join(this.directory, 'records.jsonl'), 'wx+', 0o600);
      // POSIX keeps the open descriptor alive without a directory entry. A
      // crash then releases the space too; never scavenge another process's
      // temporary files. Windows retains the private path until final dispose.
      if (process.platform !== 'win32') {
        await unlink(join(this.directory, 'records.jsonl'));
        await rmdir(this.directory);
        this.directory = undefined;
      }
    }
    if (this.handle && this.bufferedBytes >= chunkBytes) await this.flush();
  }
  async finish() {
    if (this.transferred) throw Error('Rollout projection builder closed');
    await this.flush();
    const bytes = this.bytes, handle = this.handle, directory = this.directory;
    const rows = this.rows;
    const block: Block = { bytes, memoryBytes: handle ? 0 : bytes, refs: 0,
      lines: async function* () {
        if (!handle) { for (const row of rows) yield row.endsWith('\n') ? row.slice(0, -1) : row; return; }
        const buffer = Buffer.allocUnsafe(chunkBytes);
        let position = 0;
        const lines = new RolloutLineBuffer();
        while (position < bytes) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, bytes - position), position);
          if (!bytesRead) throw Error('Rollout projection truncated');
          position += bytesRead;
          for (const line of lines.push(buffer.subarray(0, bytesRead))) yield line.toString('utf8');
        }
        if (lines.finish().length) throw Error('Rollout projection incomplete');
      },
      close: async () => {
        try { await handle?.close(); }
        finally { if (directory) await rm(directory, { recursive: true, force: true }); }
      },
    };
    this.transferred = true; this.rows = [];
    return new RolloutProjection(bytes ? [block] : []);
  }
  async abort() {
    if (this.transferred) return;
    this.transferred = true; this.rows = [];
    try { await this.handle?.close(); }
    finally { if (this.directory) await rm(this.directory, { recursive: true, force: true }); }
  }
}

export type RolloutSource = string | RolloutProjection;
export function visitRollout<T>(source: string, visit: (line: string) => void, finish: () => T): T;
export function visitRollout<T>(source: RolloutSource, visit: (line: string) => void, finish: () => T): T | Promise<T>;
export function visitRollout<T>(source: RolloutSource, visit: (line: string) => void, finish: () => T): T | Promise<T> {
  if (typeof source !== 'string') return (async () => { for await (const line of source) visit(line); return finish(); })();
  let start = 0;
  for (let end = source.indexOf('\n'); end >= 0; end = source.indexOf('\n', start)) {
    visit(source.slice(start, end)); start = end + 1;
  }
  if (start < source.length) visit(source.slice(start));
  return finish();
}
export async function* rolloutLines(source: RolloutSource): AsyncGenerator<string> {
  if (typeof source !== 'string') { yield* source; return; }
  let start = 0;
  for (let end = source.indexOf('\n'); end >= 0; end = source.indexOf('\n', start)) {
    yield source.slice(start, end); start = end + 1;
  }
  if (start < source.length) yield source.slice(start);
}
