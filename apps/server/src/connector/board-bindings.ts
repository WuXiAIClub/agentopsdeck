import { constants } from 'node:fs';
import { link, lstat, open, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assertWindowsPrivatePath, canonicalPrivatePath } from './windows-private-worker.js';
import { syncWorkspaceDirectory } from './workspace-file-platform.js';
import { validBoardUuid } from '@agentopsdeck/shared';
import { validBoardToolCredential, type BoardToolCredential } from '../tools/workspace-board-cli.js';
import { boardBindingFingerprint, validManagedBoardBinding, type ManagedBoardBinding } from '../tools/workspace-board-binding-format.js';

export type BoardBindingRuntime = 'claude-code' | 'ghcp' | 'codex';
export type BoardBindingInput = { id: string; runtime: BoardBindingRuntime; sessionId: string; credential: BoardToolCredential };
export type BoardBindingPolicy = { owner: string; runtime: BoardBindingRuntime; endpoint: string };
type Stored = { runtime: BoardBindingRuntime; sessionId: string; credential: BoardToolCredential; managed: ManagedBoardBinding };
type Tombstone = { id: string; owner: string; runtime: BoardBindingRuntime; sessionId: string; fingerprint: string };
export type BoardBindingView = { id: string; runtime: BoardBindingRuntime; sessionId: string; expiresAt: number; state: 'installed' | 'removed' };
const runtime = (v: unknown): v is BoardBindingRuntime => v === 'claude-code' || v === 'ghcp' || v === 'codex';
const owner = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (status: 403 | 409 | 429 | 503): never => { throw new BoardBindingError(status); };
export class BoardBindingError extends Error {
  constructor(readonly status: 403 | 409 | 429 | 503) { super('Private task binding unavailable; inspect its original receipt'); }
}
export function validBoardBindingInput(v: unknown): v is BoardBindingInput {
  return object(v) && Object.keys(v).length === 4 && validBoardUuid(v.id) && runtime(v.runtime) && validBoardUuid(v.sessionId)
    && validBoardToolCredential(v.credential);
}
/** Operator policy, not request-supplied destinations. No default or wildcard. */
export function parseBoardBindingPolicies(text: string | undefined): BoardBindingPolicy[] {
  if (text === undefined) return [];
  try {
    const rows: unknown = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length > 64) return fail(503);
    const seen = new Set<string>();
    return rows.map(v => {
      if (!object(v) || Object.keys(v).length !== 3 || !owner(v.owner) || !runtime(v.runtime) || typeof v.endpoint !== 'string'
        || !validBoardToolCredential({ endpoint: v.endpoint, token: 'aod_board_' + 'a'.repeat(43), expiresAt: Date.now() + 60_000 })) return fail(503);
      const key = `${v.owner}/${v.runtime}`;
      if (seen.has(key)) return fail(503);
      seen.add(key);
      return { owner: v.owner, runtime: v.runtime, endpoint: v.endpoint };
    });
  } catch { return fail(503); }
}

/** One serialized writer, no worker/Agent config edits. Credentials are never
 * returned. Managed tombstones prevent delayed install retries after removal,
 * including after a process restart. Manual files are never replaced/deleted. */
export class ConnectorBoardBindings {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  constructor(private readonly directories: Partial<Record<BoardBindingRuntime, string>>,
    private readonly policies: readonly BoardBindingPolicy[], private readonly authorized: (owner: string) => boolean | PromiseLike<boolean>) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.waiting >= 64) return Promise.reject(new BoardBindingError(429));
    this.waiting++;
    const task = this.tail.then(fn).finally(() => { this.waiting--; });
    this.tail = task.catch(() => {});
    return task;
  }
  private async root(actor: string, kind: BoardBindingRuntime) {
    const directory = this.directories[kind], policy = this.policies.find(p => p.owner === actor && p.runtime === kind);
    if (!owner(actor) || !runtime(kind) || !directory || !policy || await this.authorized(actor) !== true) return fail(403);
    return { ...await this.inspectDirectory(directory), endpoint: policy.endpoint };
  }
  private async inspectDirectory(directory: string) {
    try {
      const info = await lstat(directory);
      if (!['linux', 'win32'].includes(process.platform) || process.platform === 'linux' && process.getuid?.() === undefined
        || !info.isDirectory() || info.isSymbolicLink() || !canonicalPrivatePath(directory)) return fail(503);
      if (process.platform === 'win32') assertWindowsPrivatePath(directory);
      else if (info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700) return fail(503);
      return { directory, ino: info.ino, dev: info.dev };
    } catch { return fail(503); }
  }
  /** Called before workers activate, and after token changes. Manual files stay
   * outside managed lifecycle. Revocation never deletes another request's data. */
  reconcile(): Promise<void> {
    return this.serial(async () => {
      let failure: unknown;
      for (const kind of ['claude-code', 'ghcp', 'codex'] as const) {
        const directory = this.directories[kind];
        if (!directory) continue;
        try {
        const root = await this.inspectDirectory(directory), names = await readdir(directory);
        if (names.length > 1024) return fail(429);
        for (const name of names) {
          if (!name.startsWith(`${kind}-`) || !name.endsWith('.json')) continue;
          const sessionId = name.slice(kind.length + 1, -5);
          if (!validBoardUuid(sessionId)) continue;
          try {
          const path = join(directory, name), value = await this.read(path);
          if (!value || !('managed' in value)) continue;
          if (!validManagedBoardBinding(value.managed)) return fail(503);
          const current = this.managed(value, value.managed.owner, kind, sessionId), m = current.managed;
          const tombName = this.tombName(kind, m.id), tomb = await this.read(join(directory, tombName));
          const policy = this.policies.find(p => p.owner === m.owner && p.runtime === kind);
          if (!tomb && await this.authorized(m.owner) === true && policy?.endpoint === current.credential.endpoint && validBoardToolCredential(current.credential)) continue;
          if (tomb) this.checkTombstone(tomb, m.owner, kind, sessionId, m.id);
          const checked = await this.inspectDirectory(directory);
          if (root.ino !== checked.ino || root.dev !== checked.dev) return fail(503);
          if (!tomb) await this.create(directory, tombName, { id: m.id, owner: m.owner, runtime: kind, sessionId, fingerprint: m.fingerprint });
          await unlink(path); await this.sync(directory);
          } catch (error) { failure ??= error; }
        }
        } catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
    });
  }
  private async read(path: string): Promise<Record<string, unknown> | undefined> {
    let file;
    try { file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; return fail(503); }
    try {
      const info = await file.stat(), named = await lstat(path);
      if (!info.isFile() || named.isSymbolicLink() || info.dev !== named.dev || info.ino !== named.ino
        || !canonicalPrivatePath(path) || info.nlink !== 1 || info.size > 4096) return fail(503);
      if (process.platform === 'win32') assertWindowsPrivatePath(path);
      else if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) return fail(503);
      const bytes = Buffer.alloc(4097), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 4096) return fail(503);
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
      return object(value) ? value : fail(503);
    } catch { return fail(503); }
    finally { await file.close(); }
  }
  private managed(value: Record<string, unknown>, actor: string, kind: BoardBindingRuntime, sessionId: string): Stored {
    if (Object.keys(value).length !== 4 || value.runtime !== kind || value.sessionId !== sessionId
      || !validManagedBoardBinding(value.managed) || value.managed.owner !== actor || !object(value.credential)) return fail(409);
    // Expired credentials still have an inspectable/removable binding. Never use
    // this structural path to authorize an invocation or a new install.
    const c = value.credential;
    if (Object.keys(c).length !== 3 || typeof c.endpoint !== 'string' || typeof c.token !== 'string' || !/^aod_board_[A-Za-z0-9_-]{43}$/.test(c.token)
      || !Number.isSafeInteger(c.expiresAt)) return fail(503);
    const stored = value as unknown as Stored;
    if (stored.managed.fingerprint !== boardBindingFingerprint(kind, sessionId, stored.credential)) return fail(503);
    return stored;
  }
  private view(v: Stored): BoardBindingView {
    return { id: v.managed.id, runtime: v.runtime, sessionId: v.sessionId, expiresAt: v.credential.expiresAt, state: 'installed' };
  }
  private async sync(directory: string) { await syncWorkspaceDirectory(directory); }
  private async create(directory: string, name: string, value: unknown) {
    const temporary = join(directory, `.binding-${randomUUID()}.pending`), target = join(directory, name);
    const file = await open(temporary, 'wx', 0o600);
    let linked = false;
    try {
      await file.writeFile(JSON.stringify(value)); await file.sync(); await file.close();
      // Hard-link promotion is atomic and no-replace; remove the temporary name
      // before making the file usable by the worker's nlink===1 check.
      await link(temporary, target); linked = true;
    } catch (e) {
      await file.close().catch(() => {});
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return fail(409);
      return fail(503);
    } finally {
      try { await unlink(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') fail(503); }
      if (linked) {
        await this.sync(directory);
        if ((await lstat(target)).nlink !== 1) fail(503);
      }
    }
  }
  private tombName(kind: BoardBindingRuntime, id: string) { return `.removed-${kind}-${id}.json`; }
  private checkTombstone(value: Record<string, unknown>, actor: string, kind: BoardBindingRuntime, sessionId: string, id: string): Tombstone {
    if (Object.keys(value).length !== 5 || value.id !== id || value.owner !== actor || value.runtime !== kind || value.sessionId !== sessionId
      || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)) return fail(409);
    return value as unknown as Tombstone;
  }
  install(actor: string, input: BoardBindingInput, check: () => void = () => {}): Promise<BoardBindingView> {
    return this.serial(async () => {
      check();
      if (!validBoardBindingInput(input)) return fail(403);
      const r = await this.root(actor, input.runtime);
      if (input.credential.endpoint !== r.endpoint) return fail(403);
      const fingerprint = boardBindingFingerprint(input.runtime, input.sessionId, input.credential);
      const tomb = await this.read(join(r.directory, this.tombName(input.runtime, input.id)));
      if (tomb) { this.checkTombstone(tomb, actor, input.runtime, input.sessionId, input.id); return fail(409); }
      const name = `${input.runtime}-${input.sessionId}.json`, existing = await this.read(join(r.directory, name));
      const intentName = `.binding-${input.runtime}-${input.id}.json`, intent = await this.read(join(r.directory, intentName));
      if (intent && this.checkTombstone(intent, actor, input.runtime, input.sessionId, input.id).fingerprint !== fingerprint) return fail(409);
      if (existing) {
        const current = this.managed(existing, actor, input.runtime, input.sessionId);
        if (!intent || current.managed.id !== input.id || current.managed.fingerprint !== fingerprint) return fail(409);
        await this.root(actor, input.runtime);
        check();
        return this.view(current);
      }
      // Hard quota includes retained tombstones; no unsafe automatic pruning that
      // could resurrect a previously removed request. Operator migration is explicit.
      if ((await readdir(r.directory)).length > 1021) return fail(429);
      const checked = await this.root(actor, input.runtime);
      if (r.ino !== checked.ino || r.dev !== checked.dev) return fail(503);
      const stored: Stored = { runtime: input.runtime, sessionId: input.sessionId, credential: { ...input.credential }, managed: { id: input.id, owner: actor, fingerprint } };
      // Reserve request identity before publishing credentials. A crash leaves an
      // inspectable intent; only the identical request can finish that install.
      if (!intent) await this.create(r.directory, intentName, { id: input.id, owner: actor, runtime: input.runtime, sessionId: input.sessionId, fingerprint });
      check();
      await this.create(r.directory, name, stored);
      try {
        if (await this.authorized(actor) !== true) return fail(403);
        const final = await this.root(actor, input.runtime);
        if (final.ino !== r.ino || final.dev !== r.dev) return fail(503);
        check();
      } catch (error) {
        await this.create(r.directory, this.tombName(input.runtime, input.id), { id: input.id, owner: actor, runtime: input.runtime, sessionId: input.sessionId, fingerprint });
        await unlink(join(r.directory, name)); await this.sync(r.directory);
        throw error;
      }
      return this.view(stored);
    });
  }
  get(actor: string, kind: BoardBindingRuntime, sessionId: string): Promise<BoardBindingView | undefined> {
    return this.serial(async () => {
      if (!validBoardUuid(sessionId)) return fail(403);
      const r = await this.root(actor, kind), value = await this.read(join(r.directory, `${kind}-${sessionId}.json`));
      if (!value) return;
      const stored = this.managed(value, actor, kind, sessionId), result = this.view(stored);
      const tomb = await this.read(join(r.directory, this.tombName(kind, stored.managed.id)));
      if (tomb) { this.checkTombstone(tomb, actor, kind, sessionId, stored.managed.id); result.state = 'removed'; }
      await this.root(actor, kind);
      return result;
    });
  }
  remove(actor: string, kind: BoardBindingRuntime, sessionId: string, id: string): Promise<{ id: string; state: 'removed' }> {
    return this.serial(async () => {
      if (!validBoardUuid(sessionId) || !validBoardUuid(id)) return fail(403);
      const r = await this.root(actor, kind), tombPath = this.tombName(kind, id), oldTomb = await this.read(join(r.directory, tombPath));
      if (oldTomb) this.checkTombstone(oldTomb, actor, kind, sessionId, id);
      const path = join(r.directory, `${kind}-${sessionId}.json`), value = await this.read(path);
      if (!value) {
        if (!oldTomb) {
          const intent = await this.read(join(r.directory, `.binding-${kind}-${id}.json`));
          if (!intent) return fail(409);
          const validated = this.checkTombstone(intent, actor, kind, sessionId, id);
          const checked = await this.root(actor, kind);
          if (r.ino !== checked.ino || r.dev !== checked.dev) return fail(503);
          await this.create(r.directory, tombPath, validated);
        }
        return { id, state: 'removed' };
      }
      const current = this.managed(value, actor, kind, sessionId);
      if (current.managed.id !== id) {
        if (oldTomb) return { id, state: 'removed' }; // Delayed old DELETE cannot remove a newer binding.
        return fail(409);
      }
      const checked = await this.root(actor, kind);
      if (r.ino !== checked.ino || r.dev !== checked.dev) return fail(503);
      if (!oldTomb) await this.create(r.directory, tombPath, { id, owner: actor, runtime: kind, sessionId, fingerprint: current.managed.fingerprint });
      await unlink(path); await this.sync(r.directory);
      return { id, state: 'removed' };
    });
  }
}
