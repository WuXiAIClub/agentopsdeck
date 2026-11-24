import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalPrivatePath } from './windows-private-worker.js';
import { normalizeWorkspaceFileRoot } from './workspace-file-platform.js';
import type { DatabaseSync } from 'node:sqlite';
import type { BoardContent } from '@agentopsdeck/shared';
import { WorkspaceFileSource, readWorkspaceFile } from './workspace-board-file-source.js';
import { boardFileCodec } from './workspace-board-file-format.js';
import type { WorkspaceFileCodec, WorkspaceFileSnapshot } from './workspace-file-codec.js';
import { ChangeSignal } from '../utils/change-signal.js';
import { writeWorkspaceFile, retainedWorkspaceFileBytes, type FileWriteOutcome } from './workspace-file-write.js';
import { WorkspaceFileMetadata, FileBoardError, type WorkspaceFileBinding } from './workspace-file-metadata.js';
export { FileBoardError } from './workspace-file-metadata.js';

export type ConnectorFileBoardIntent<T = BoardContent> = { id: string; sessionKey: string; content: T };
export type FileBoardWrite<T = BoardContent> = { mutationId: string; expectedHash: string; content: T };
export type FileBoardWriteReceipt<T = BoardContent> = { mutationId: string; state: FileWriteOutcome; snapshot?: WorkspaceFileSnapshot<T> };
type Stored = WorkspaceFileBinding;
export type ConnectorFileBoardView = Pick<Stored, 'id' | 'sessionKey' | 'state'> & { path: string; context: string };
type Awaitable<T> = T | Promise<T>;
export type WorkspaceFileMetadataPort<T, Actor> = {
  guard(owner: Actor, key: string): Awaitable<void>;
  owned(owner: Actor, id: string): Awaitable<Stored>;
  boundCodec(owner: Actor, id: string): Awaitable<WorkspaceFileCodec<T>>;
  installation(owner: Actor, input: ConnectorFileBoardIntent<T>, reserve?: boolean): Awaitable<ReturnType<WorkspaceFileMetadata<T>['installation']>>;
  installed(owner: Actor, id: string, fingerprint: string): Awaitable<void>;
  receipt(owner: Actor, id: string, mutationId: string): Awaitable<FileBoardWriteReceipt<T>>;
  writeIntent(owner: Actor, id: string, input: FileBoardWrite<T>, retained?: number): Awaitable<ReturnType<WorkspaceFileMetadata<T>['writeIntent']>>;
  settleWrite(owner: Actor, id: string, mutationId: string, fingerprint: string, state: FileWriteOutcome): Awaitable<void>;
  revoke(owner: Actor, id: string, key?: string): Awaitable<Stored>;
  reconcile(): Awaitable<string[]>;
  filesForSession(owner: Actor, key: string): Awaitable<Stored[]>;
  close(): Awaitable<void>;
};

/** Dedicated data directory, separate from credentials. All IDs/ownership live
 * in Connector metadata, never trusted from Agent-editable progress files.
 * No file deletion on revoke; no source watchers until explicitly subscribed. */
export class WorkspaceFileEffects<T, Actor = string> {
  readonly changes = new ChangeSignal();
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private closed = false;
  private readonly sources = new Map<string, { source: WorkspaceFileSource<T>; references: number }>();
  constructor(private readonly metadata: WorkspaceFileMetadataPort<T, Actor>, private readonly root: string,
    readonly codec: WorkspaceFileCodec<T>) {
    if (normalizeWorkspaceFileRoot(root) !== root) throw new Error('Invalid file panel root');
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new FileBoardError(503));
    if (this.waiting >= 64) return Promise.reject(new FileBoardError(429));
    this.waiting++;
    const task = this.tail.then(() => { if (this.closed) throw new FileBoardError(503); return fn(); }).finally(() => { this.waiting--; });
    this.tail = task.catch(() => {}); return task;
  }
  private async guard(owner: Actor, sessionKey: string) {
    await this.metadata.guard(owner, sessionKey);
  }
  private async owned(owner: Actor, id: string): Promise<Stored> {
    return this.metadata.owned(owner, id);
  }
  private async boundCodec(owner: Actor, id: string): Promise<WorkspaceFileCodec<T>> {
    return this.metadata.boundCodec(owner, id);
  }
  private view(row: Stored): ConnectorFileBoardView {
    const path = join(this.root, row.id, this.codec.name);
    return { id: row.id, sessionKey: row.sessionKey, state: row.state, path, context: this.codec.context([path]) };
  }
  async get(owner: Actor, id: string): Promise<ConnectorFileBoardView> { return this.view(await this.owned(owner, id)); }
  async snapshot(owner: Actor, id: string) {
    if ((await this.owned(owner, id)).state !== 'installed') throw new FileBoardError(409);
    const value = await readWorkspaceFile(this.root, id, await this.boundCodec(owner, id));
    if ((await this.owned(owner, id)).state !== 'installed') throw new FileBoardError(409);
    return value;
  }
  async receipt(owner: Actor, id: string, mutationId: string): Promise<FileBoardWriteReceipt<T>> {
    return this.metadata.receipt(owner, id, mutationId);
  }
  write(owner: Actor, id: string, input: FileBoardWrite<T>): Promise<FileBoardWriteReceipt<T>> {
    return this.serial(async () => {
      const inspected = await this.metadata.writeIntent(owner, id, input);
      if (inspected.existing) return inspected.receipt;
      const retained = await retainedWorkspaceFileBytes(this.root, id, 64 * 1024 * 1024);
      const admitted = await this.metadata.writeIntent(owner, id, input, retained);
      if (admitted.existing) return admitted.receipt; // Another owner may have reserved during I/O.
      const codec = await this.boundCodec(owner, id), { text, fingerprint } = admitted;
      const state = await writeWorkspaceFile({ root: this.root, bindingId: id, mutationId: input.mutationId,
        expectedHash: input.expectedHash, text, codec,
        authorized: async () => { if ((await this.owned(owner, id)).state !== 'installed') throw new FileBoardError(403); } });
      await this.metadata.settleWrite(owner, id, input.mutationId, fingerprint, state);
      // Snapshot is advisory/current, not part of the durable write receipt.
      const snapshot = await readWorkspaceFile(this.root, id, codec);
      await this.owned(owner, id);
      void this.sources.get(id)?.source.refresh();
      return { mutationId: input.mutationId, state, snapshot };
    });
  }
  install(owner: Actor, input: ConnectorFileBoardIntent<T>): Promise<ConnectorFileBoardView> {
    return this.serial(async () => {
      const inspected = await this.metadata.installation(owner, input);
      if (inspected.existing) return this.view(inspected.row);
      const root = await lstat(this.root);
      if (!root.isDirectory() || root.isSymbolicLink() || !canonicalPrivatePath(this.root)
        || (process.getuid && (root.uid !== process.getuid() || (root.mode & 0o077) !== 0))) throw new FileBoardError(503);
      const admitted = await this.metadata.installation(owner, input, true);
      if (admitted.existing) return this.view(admitted.row);
      const { text, fingerprint } = admitted;
      const directory = join(this.root, input.id);
      // mkdir + exclusive create. A pre-existing file or directory is NEVER
      // adopted, overwritten or deleted to make a failed installation succeed.
      await mkdir(directory, { mode: 0o700 });
      const after = await lstat(this.root), directoryBefore = await lstat(directory);
      if (!canonicalPrivatePath(directory) || root.dev !== after.dev || root.ino !== after.ino) throw new FileBoardError(503);
      await this.guard(owner, input.sessionKey);
      const handle = await open(join(directory, this.codec.name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      const rootAfter = await lstat(this.root), directoryAfter = await lstat(directory);
      const written = await readWorkspaceFile(this.root, input.id, this.codec);
      if (root.dev !== rootAfter.dev || root.ino !== rootAfter.ino
        || directoryBefore.dev !== directoryAfter.dev || directoryBefore.ino !== directoryAfter.ino
        || written.state !== 'ready' || this.codec.serialize(written.value.content) !== text) throw new FileBoardError(503);
      await this.metadata.installed(owner, input.id, fingerprint);
      this.changes.notify();
      return this.get(owner, input.id);
    });
  }
  async revoke(owner: Actor, id: string, sessionKey?: string): Promise<ConnectorFileBoardView> {
    return this.serial(async () => {
      const row = await this.metadata.revoke(owner, id, sessionKey);
      this.changes.notify();
      const entry = this.sources.get(id); this.sources.delete(id); await entry?.source.close();
      return this.view({ ...row, state: 'revoked' });
    });
  }
  /** Call on policy/token changes and startup, before rebuilding subscriptions.
   * Revoked grants remain tombstones, even if permission is later restored. */
  reconcile(): Promise<void> {
    return this.serial(async () => {
      for (const id of await this.metadata.reconcile()) {
        this.changes.notify();
        const entry = this.sources.get(id); this.sources.delete(id); await entry?.source.close();
      }
    });
  }
  /** Ordinary text context for a FUTURE admitted turn. Merely binding a panel
   * never sends a message or starts a worker. Caller must retain queue identity. */
  async contextForSession(owner: Actor, sessionKey: string): Promise<string> {
    return this.codec.context(await this.filesForSession(owner, sessionKey));
  }
  async filesForSession(owner: Actor, sessionKey: string): Promise<string[]> {
    return (await this.metadata.filesForSession(owner, sessionKey)).map(row => this.view(row).path);
  }
  async subscribe(owner: Actor, id: string, listener: (snapshot: WorkspaceFileSnapshot<T>) => void) {
    return this.serial(async () => {
      const row = await this.owned(owner, id);
      if (row.state !== 'installed') throw new FileBoardError(409);
      let entry = this.sources.get(id);
      if (!entry) {
        if (this.sources.size >= 64) throw new FileBoardError(429);
        entry = { source: new WorkspaceFileSource(this.root, id, await this.boundCodec(owner, id)), references: 0 }; this.sources.set(id, entry);
      }
      const selected = entry;
      if (selected.references >= 4) throw new FileBoardError(429);
      selected.references++;
      // Async consumers use this as a dirty hint only and await current() before
      // disclosure. The legacy facade supplies its own synchronous guard.
      const unsubscribe = selected.source.subscribe(listener);
      let released = false;
      const release = async () => {
        if (released) return; released = true; unsubscribe(); selected.references--;
        if (!selected.references) { if (this.sources.get(id) === selected) this.sources.delete(id); await selected.source.close(); }
      };
      try {
        await selected.source.start();
        if ((await this.owned(owner, id)).state !== 'installed') throw new FileBoardError(409);
        return { current: async () => {
          if (released || (await this.owned(owner, id)).state !== 'installed' || released || this.closed) throw new FileBoardError(409);
          return selected.source.current();
        }, cachedSnapshot: () => {
          if (released || this.closed) throw new FileBoardError(409);
          return selected.source.current();
        }, release };
      } catch (error) { await release(); throw error; }
    });
  }
  async close(): Promise<void> {
    this.closed = true; await this.metadata.close(); await this.tail;
    const entries = [...this.sources.values()]; this.sources.clear();
    await Promise.all(entries.map(entry => entry.source.close()));
  }
}

/** Legacy synchronous reads, sharing every physical effect with the async port. */
export class ConnectorWorkspaceFiles<T> {
  private readonly metadata: WorkspaceFileMetadata<T>;
  private readonly effects: WorkspaceFileEffects<T>;
  readonly changes: ChangeSignal;
  constructor(db: DatabaseSync, private readonly root: string,
    authorized: (owner: string, sessionKey: string) => boolean, readonly codec: WorkspaceFileCodec<T>) {
    if (normalizeWorkspaceFileRoot(root) !== root) throw new Error('Invalid file panel root');
    const metadata = this.metadata = new WorkspaceFileMetadata(db, authorized, codec);
    this.effects = new WorkspaceFileEffects({
      guard: (a,k) => metadata.guard(a,k), owned: (a,id) => metadata.owned(a,id),
      boundCodec: (_a,id) => metadata.boundCodec(id), installation: (a,i,r) => metadata.installation(a,i,r),
      installed: (a,id,f) => metadata.installed(a,id,f), receipt: (a,id,m) => metadata.receipt(a,id,m),
      writeIntent: (a,id,i,r) => metadata.writeIntent(a,id,i,r), settleWrite: (a,id,m,f,s) => metadata.settleWrite(a,id,m,f,s),
      revoke: (a,id,k) => metadata.revoke(a,id,k), reconcile: () => metadata.reconcile(),
      filesForSession: (a,k) => metadata.filesForSession(a,k), close: () => metadata.close(),
    }, root, codec);
    this.changes = this.effects.changes;
  }
  get(owner: string,id: string): ConnectorFileBoardView {
    const row = this.metadata.owned(owner,id), path = join(this.root,row.id,this.codec.name);
    return { id: row.id, sessionKey: row.sessionKey, state: row.state, path, context: this.codec.context([path]) };
  }
  receipt(owner: string,id: string,mutation: string) { return this.metadata.receipt(owner,id,mutation); }
  filesForSession(owner: string,key: string) { return this.metadata.filesForSession(owner,key).map(r => this.get(owner,r.id).path); }
  contextForSession(owner: string,key: string) { return this.codec.context(this.filesForSession(owner,key)); }
  snapshot(owner: string,id: string) { return this.effects.snapshot(owner,id); }
  install(owner: string,input: ConnectorFileBoardIntent<T>) { return this.effects.install(owner,input); }
  write(owner: string,id: string,input: FileBoardWrite<T>) { return this.effects.write(owner,id,input); }
  revoke(owner: string,id: string,key?: string) { return this.effects.revoke(owner,id,key); }
  reconcile() { return this.effects.reconcile(); }
  async subscribe(owner: string,id: string,listener: (snapshot: WorkspaceFileSnapshot<T>) => void) {
    const subscription = await this.effects.subscribe(owner,id,value => {
      if (this.metadata.owned(owner,id).state === 'installed') listener(value);
    });
    return { current: () => {
      if (this.metadata.owned(owner,id).state !== 'installed') throw new FileBoardError(409);
      return subscription.cachedSnapshot();
    }, release: subscription.release };
  }
  close() { return this.effects.close(); }
}

export class ConnectorFileBoards extends ConnectorWorkspaceFiles<BoardContent> {
  constructor(db: DatabaseSync, root: string, authorized: (owner: string, sessionKey: string) => boolean) {
    super(db, root, authorized, boardFileCodec);
  }
}
