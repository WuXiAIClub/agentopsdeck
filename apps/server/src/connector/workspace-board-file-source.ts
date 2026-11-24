import { constants, watch, type FSWatcher } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalPrivatePath } from './windows-private-worker.js';
import { normalizeWorkspaceFileRoot } from './workspace-file-platform.js';
import { validBoardUuid } from '@agentopsdeck/shared';
import { boardFileCodec, type BoardFileSnapshot } from './workspace-board-file-format.js';
import type { WorkspaceFileCodec, WorkspaceFileSnapshot } from './workspace-file-codec.js';

type Identity = { dev: number; ino: number };
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
class FileProblem extends Error {
  constructor(readonly state: 'unsafe' | 'too-large' | 'unavailable') { super(state); }
}
async function checkDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !canonicalPrivatePath(path)
    || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0))) throw new FileProblem('unsafe');
  return info;
}

/** A single, operator-provisioned root plus an opaque binding UUID. Never a
 * browser-supplied filename. Existing Agent files are not modified here. */
export async function readBoardFile(root: string, bindingId: string): Promise<BoardFileSnapshot> {
  return readWorkspaceFile(root, bindingId, boardFileCodec);
}
export async function readWorkspaceFile<T>(root: string, bindingId: string, codec: WorkspaceFileCodec<T>): Promise<WorkspaceFileSnapshot<T>> {
  if (!validBoardUuid(bindingId) || normalizeWorkspaceFileRoot(root) !== root) return { state: 'unsafe' };
  const directory = join(root, bindingId), path = join(directory, codec.name);
  try {
    const rootBefore = await checkDirectory(root), directoryBefore = await checkDirectory(directory);
    // NONBLOCK prevents a malicious FIFO replacement from hanging open before
    // fstat rejects it. O_NOFOLLOW is supported on the production POSIX targets.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || (process.getuid && before.uid !== process.getuid())) throw new FileProblem('unsafe');
      if (before.size > codec.maxBytes) throw new FileProblem('too-large');
      const bytes = Buffer.allocUnsafe(codec.maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const chunk = await handle.read(bytes, length, bytes.length - length, length);
        if (!chunk.bytesRead) break;
        length += chunk.bytesRead;
      }
      if (length > codec.maxBytes) throw new FileProblem('too-large');
      const after = await handle.stat(), named = await lstat(path);
      if (!after.isFile() || after.nlink !== 1 || (process.getuid && after.uid !== process.getuid())) throw new FileProblem('unsafe');
      if (named.isSymbolicLink() || !same(before, named) || !same(before, after)
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || length !== after.size || !same(rootBefore, await checkDirectory(root))
        || !same(directoryBefore, await checkDirectory(directory))) throw new FileProblem('unavailable');
      const value = codec.parse(bytes.subarray(0, length));
      return value ? { state: 'ready', value } : { state: 'invalid' };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof FileProblem) return { state: error.state };
    const code = (error as NodeJS.ErrnoException).code;
    return { state: code === 'ENOENT' ? 'missing' : code === 'ELOOP' || code === 'ENOTDIR' ? 'unsafe' : 'unavailable' };
  }
}

/** Directory watch survives atomic file replacement. Watch is only a hint:
 * bounded reconciliation repairs dropped events and reattaches replaced dirs.
 * At most one read plus one coalesced successor; no unbounded Promise queue. */
export class WorkspaceFileSource<T> {
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private safety: ReturnType<typeof setInterval> | undefined;
  private reading: Promise<void> | undefined;
  private attaching: Promise<void> | undefined;
  private again = false;
  private closed = false;
  private started = false;
  private snapshot: WorkspaceFileSnapshot<T> = { state: 'missing' };
  private published = '';
  private readonly listeners = new Set<(snapshot: WorkspaceFileSnapshot<T>) => void>();
  readonly path: string;
  constructor(private readonly root: string, private readonly bindingId: string, private readonly codec: WorkspaceFileCodec<T>,
    private readonly timing: { debounceMs?: number; reconcileMs?: number } = {}) {
    if (!validBoardUuid(bindingId) || normalizeWorkspaceFileRoot(root) !== root) throw new Error('Invalid board file location');
    this.path = join(root, bindingId, codec.name);
  }
  current(): WorkspaceFileSnapshot<T> { return structuredClone(this.snapshot); }
  subscribe(listener: (snapshot: WorkspaceFileSnapshot<T>) => void): () => void {
    if (this.closed) throw new Error('Board file source is closed');
    if (this.listeners.size >= 64) throw new Error('Board file subscriber limit');
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async start(): Promise<void> {
    if (this.closed || this.started) return;
    this.started = true;
    await this.attach();
    if (this.closed) return;
    this.safety = setInterval(() => { void this.attach(); void this.refresh(); }, Math.max(20, this.timing.reconcileMs ?? 60_000));
    this.safety.unref();
    await this.refresh();
  }
  private attach(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.attaching) return this.attaching;
    this.attaching = this.attachChecked().finally(() => { this.attaching = undefined; });
    return this.attaching;
  }
  private async attachChecked() {
    // Reattach even if fs.watch didn't report a directory being replaced.
    this.watcher?.close(); this.watcher = undefined;
    try {
      const directory = join(this.root, this.bindingId);
      const root = await checkDirectory(this.root), before = await checkDirectory(directory);
      if (this.closed) return;
      const watcher = watch(directory, { persistent: false }, (_event, name) => {
        if (name && name.toString() !== this.codec.name) return;
        if (this.timer || this.closed) return;
        this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, Math.max(0, this.timing.debounceMs ?? 120));
        this.timer.unref();
      });
      this.watcher = watcher;
      watcher.on('error', () => { watcher.close(); if (this.watcher === watcher) this.watcher = undefined; });
      if (this.closed || !same(root, await checkDirectory(this.root)) || !same(before, await checkDirectory(directory))) {
        watcher.close(); if (this.watcher === watcher) this.watcher = undefined;
      }
    } catch { this.watcher?.close(); this.watcher = undefined; /* Reconciliation retries safely. */ }
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.reading) { this.again = true; return this.reading; }
    this.reading = (async () => {
      do {
        this.again = false;
        const next = await readWorkspaceFile(this.root, this.bindingId, this.codec);
        if (this.closed) return;
        if (next.state !== 'ready' && this.snapshot.value) next.value = this.snapshot.value;
        this.snapshot = next;
        const identity = JSON.stringify([next.state, next.value?.hash]);
        if (identity !== this.published) {
          this.published = identity;
          for (const listener of this.listeners) {
            try { listener(this.current()); } catch { /* Isolate observers; state is available for resync. */ }
          }
        }
      } while (this.again && !this.closed);
    })().finally(() => { this.reading = undefined; });
    return this.reading;
  }
  async close(): Promise<void> {
    this.closed = true; this.again = false;
    this.watcher?.close(); this.watcher = undefined;
    if (this.timer) clearTimeout(this.timer);
    if (this.safety) clearInterval(this.safety);
    this.listeners.clear();
    await Promise.all([this.reading, this.attaching]);
  }
}

/** Backwards-compatible tasks.json source; same watchers and reconciliation. */
export class BoardFileSource extends WorkspaceFileSource<import('@agentopsdeck/shared').BoardContent> {
  constructor(root: string, bindingId: string, timing: { debounceMs?: number; reconcileMs?: number } = {}) {
    super(root, bindingId, boardFileCodec, timing);
  }
}
