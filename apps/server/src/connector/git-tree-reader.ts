import { constants } from 'node:fs';
import { open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { GitSnapshot, type GitFileState } from './git-snapshot.js';
export class GitTreeReadError extends Error {}
type Registration = { owner: string; repositoryRef: string; authorityEpoch: string; path: string; dev: number; ino: number };
type PathToken = { owner: string; repositoryRef: string; epoch: string; parts: string[]; directory: boolean; file: boolean; expires: number };
type Cursor = { scope: string; snapshot: string; offset: number; expires: number };
export const GIT_TREE_LIMITS = { page: 200, depth: 32, entries: 10000, bytes: 4 * 1024 * 1024, timeout: 5000 };
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const text = (v: string) => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
async function closeHandles(handles: FileHandle[]) {
  const results = await Promise.allSettled(handles.reverse().map(handle => Promise.resolve().then(() => handle.close())));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

/** Descriptor-anchored directory and bounded UTF-8 preview reader. No hook, filter, network,
 * symlink traversal or repository mutation. Linux descriptor-anchored walking
 * fails closed on other systems until an equivalent safe adapter is provided. */
export class GitTreeReader {
  private readonly repositories = new Map<string, Registration>();
  private readonly paths = new Map<string, PathToken>();
  private readonly cursors = new Map<string, Cursor>();
  constructor(private readonly authority: (owner: string, repositoryRef: string) => string | undefined | PromiseLike<string | undefined>, private readonly now = Date.now) {}
  private key(owner: string, ref: string) { if (!text(owner) || !text(ref)) throw new GitTreeReadError('scope'); return JSON.stringify([owner, ref]); }
  /** Reclaim revoked identities, including all issued capabilities. In-flight
   * reads independently recheck authority before returning any content. */
  async pruneRevoked() {
    for (const [key, value] of this.repositories) {
      if (await this.authority(value.owner, value.repositoryRef) === value.authorityEpoch) continue;
      if (this.repositories.get(key) !== value) continue;
      this.repositories.delete(key);
      for (const [token, path] of this.paths) if (path.owner === value.owner && path.repositoryRef === value.repositoryRef) this.paths.delete(token);
      // Cursor scopes are one-way digests: revoke conservatively, not by guessing ownership.
      this.cursors.clear();
    }
  }
  /** Trusted configuration entry, never takes a path from a card/list request. */
  async register(owner: string, repositoryRef: string, authorityEpoch: string, configuredRoot: string, check: () => void = () => {}) {
    check(); await this.pruneRevoked(); check();
    if (process.platform !== 'linux') throw new GitTreeReadError('unsupported-platform');
    const key = this.key(owner, repositoryRef);
    if (!text(authorityEpoch) || await this.authority(owner, repositoryRef) !== authorityEpoch) throw new GitTreeReadError('forbidden');
    check();
    if (this.repositories.has(key)) throw new GitTreeReadError('registration-exists');
    if (this.repositories.size >= 64) throw new GitTreeReadError('registration-capacity');
    const path = await realpath(configuredRoot), handle = await open(path, flags);
    try {
      const stat = await handle.stat();
      if (await this.authority(owner, repositoryRef) !== authorityEpoch) throw new GitTreeReadError('authority-changed');
      check();
      // Other registrations can finish while realpath/open/stat are pending.
      if (this.repositories.has(key)) throw new GitTreeReadError('registration-exists');
      if (this.repositories.size >= 64) throw new GitTreeReadError('registration-capacity');
      this.repositories.set(key, { owner, repositoryRef, authorityEpoch, path, dev: stat.dev, ino: stat.ino });
    } finally { await handle.close(); }
  }
  async list(owner: string, repositoryRef: string, pathToken?: string, cursor?: string, limit = 200, check: () => void = () => {}) {
    const repository = this.repositories.get(this.key(owner, repositoryRef));
    if (!repository || await this.authority(owner, repositoryRef) !== repository.authorityEpoch) throw new GitTreeReadError('forbidden');
    check();
    if (!Number.isInteger(limit) || limit < 1 || limit > GIT_TREE_LIMITS.page) throw new GitTreeReadError('page-limit');
    const started = this.now();
    for (const [key, value] of this.paths) if (value.expires <= started) this.paths.delete(key);
    for (const [key, value] of this.cursors) if (value.expires <= started) this.cursors.delete(key);
    const requested = pathToken ? this.paths.get(pathToken) : undefined;
    if (pathToken && (!requested || requested.owner !== owner || requested.repositoryRef !== repositoryRef || requested.epoch !== repository.authorityEpoch
      || !requested.directory || started < requested.expires - 300000)) throw new GitTreeReadError('path-expired-or-invalid');
    const parts = requested?.parts ?? [];
    if (parts.length > GIT_TREE_LIMITS.depth) throw new GitTreeReadError('depth-limit');
    const scope = digest([owner, repositoryRef, repository.authorityEpoch, parts, limit]), previous = cursor ? this.cursors.get(cursor) : undefined;
    if (cursor && (!previous || previous.scope !== scope || started < previous.expires - 300000)) throw new GitTreeReadError('cursor-expired-or-invalid');
    const handles: FileHandle[] = [];
    try {
      let handle = await open(repository.path, flags); handles.push(handle);
      const root = await handle.stat(); if (root.dev !== repository.dev || root.ino !== repository.ino) throw new GitTreeReadError('root-replaced');
      for (const part of parts) {
        if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\0') || part === '.git') throw new GitTreeReadError('path');
        handle = await open(`/proc/self/fd/${handle.fd}/${part}`, flags); handles.push(handle);
      }
      const before = await handle.stat(), entries: { name: string; kind: 'directory' | 'file' | 'symlink' | 'unsupported' }[] = [];
      const directory = await opendir(`/proc/self/fd/${handle.fd}`);
      let scannedBytes = 0, truncated = false;
      try {
        while (true) {
          check();
          if (this.now() - started >= GIT_TREE_LIMITS.timeout) throw new GitTreeReadError('timeout');
          const entry = await directory.read(); if (!entry) break;
          if (entries.length >= GIT_TREE_LIMITS.entries) { truncated = true; break; }
          if (entry.name.includes('\ufffd')) throw new GitTreeReadError('unsupported-filename-encoding');
          scannedBytes += Buffer.byteLength(entry.name) + 128;
          if (scannedBytes > GIT_TREE_LIMITS.bytes) { truncated = true; break; }
          entries.push({ name: entry.name, kind: entry.name === '.git' ? 'unsupported' : entry.isSymbolicLink() ? 'symlink'
            : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'unsupported' });
        }
      } finally { await directory.close(); }
      const after = await handle.stat();
      if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new GitTreeReadError('directory-changed');
      if (await this.authority(owner, repositoryRef) !== repository.authorityEpoch) throw new GitTreeReadError('authority-changed');
      check();
      if (this.now() - started >= GIT_TREE_LIMITS.timeout) throw new GitTreeReadError('timeout');
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const snapshotId = digest([before.dev, before.ino, before.mtimeMs, before.ctimeMs, entries, truncated]);
      if (previous && previous.snapshot !== snapshotId) throw new GitTreeReadError('cursor-stale');
      const offset = previous?.offset ?? 0, selected = entries.slice(offset, offset + limit), expires = this.now() + 300000;
      if (this.paths.size + selected.length > 20000 || this.cursors.size >= 1024) throw new GitTreeReadError('token-capacity');
      const page = selected.map(entry => {
        const token = randomUUID(); this.paths.set(token, { owner, repositoryRef, epoch: repository.authorityEpoch, parts: [...parts, entry.name],
          directory: entry.kind === 'directory' && parts.length < GIT_TREE_LIMITS.depth, file: entry.kind === 'file', expires });
        return { ...entry, pathToken: token, previewCapability: entry.kind === 'file', ...({ indexStatus: 'unknown', worktreeStatus: 'unknown' } as GitFileState) };
      });
      let gitStatus: 'unsupported' | 'raw-bytes' = 'unsupported';
      let branch: string | undefined;
      const git = await GitSnapshot.read(handles[0]!, () => { check(); return this.now() - started < GIT_TREE_LIMITS.timeout; },
        async () => await this.authority(owner, repositoryRef) === repository.authorityEpoch);
      try {
        for (const entry of page) if (entry.kind === 'file') Object.assign(entry, await git.state([...parts, entry.name]));
        if (git.supported && await git.valid()) { gitStatus = 'raw-bytes'; branch = git.branch; }
        else for (const entry of page) Object.assign(entry, { indexStatus: 'unknown', worktreeStatus: 'unknown' });
      } finally { await git.close(); }
      if (await this.authority(owner, repositoryRef) !== repository.authorityEpoch) throw new GitTreeReadError('authority-changed');
      check();
      let nextCursor: string | null = null;
      if (offset + limit < entries.length) { nextCursor = randomUUID(); this.cursors.set(nextCursor, { scope, snapshot: snapshotId, offset: offset + limit, expires }); }
      return { repositoryRef, snapshotId, observedAt: this.now(), entries: page, nextCursor, consistency: 'best_effort' as const,
        truncationReason: truncated ? 'scan-budget' : null, gitStatus, branch };
    } finally { await closeHandles(handles); }
  }
  async preview(owner: string, repositoryRef: string, pathToken: string, check: () => void = () => {}) {
    const repository = this.repositories.get(this.key(owner, repositoryRef)), token = this.paths.get(pathToken), started = this.now();
    if (!repository || await this.authority(owner, repositoryRef) !== repository.authorityEpoch) throw new GitTreeReadError('forbidden');
    check();
    if (!token || token.owner !== owner || token.repositoryRef !== repositoryRef || token.epoch !== repository.authorityEpoch
      || !token.file || token.expires <= started || started < token.expires - 300000 || token.parts.length > GIT_TREE_LIMITS.depth + 1) throw new GitTreeReadError('path-expired-or-invalid');
    const handles: FileHandle[] = [], limit = 128 * 1024;
    try {
      let handle = await open(repository.path, flags); handles.push(handle);
      const root = await handle.stat();
      if (root.dev !== repository.dev || root.ino !== repository.ino) throw new GitTreeReadError('root-replaced');
      for (const [index,part] of token.parts.entries()) {
        if (!part || ['.','..','.git'].includes(part) || /[/\x00]/.test(part)) throw new GitTreeReadError('path');
        // O_NONBLOCK avoids hanging on a regular file replaced by a FIFO/device.
        handle = await open(`/proc/self/fd/${handle.fd}/${part}`, index === token.parts.length - 1
          ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK : flags); handles.push(handle);
      }
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(limit)) throw new GitTreeReadError('preview-unsupported-or-large');
      const buffer = Buffer.alloc(limit + 1); let bytes = 0;
      while (bytes <= limit) {
        if (this.now() - started >= GIT_TREE_LIMITS.timeout || await this.authority(owner, repositoryRef) !== repository.authorityEpoch) throw new GitTreeReadError('preview-interrupted');
        check();
        const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!read.bytesRead) break; bytes += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (bytes > limit || before.size !== BigInt(bytes) || before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs) throw new GitTreeReadError('preview-changed-or-large');
      const body = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body)) throw new GitTreeReadError('preview-binary');
      if (this.now() - started >= GIT_TREE_LIMITS.timeout || await this.authority(owner, repositoryRef) !== repository.authorityEpoch) throw new GitTreeReadError('preview-interrupted');
      check();
      const git = await GitSnapshot.read(handles[0]!, () => { check(); return this.now() - started < GIT_TREE_LIMITS.timeout; },
        async () => await this.authority(owner, repositoryRef) === repository.authorityEpoch);
      let comparison: (GitFileState & { diff: string | null }) | undefined;
      try { const result = await git.comparison(token.parts, body); if (git.supported && await git.valid()) comparison = result; }
      finally { await git.close(); }
      if (await this.authority(owner, repositoryRef) !== repository.authorityEpoch) throw new GitTreeReadError('authority-changed');
      check();
      return { repositoryRef, pathToken, name: token.parts.at(-1)!, text: body, bytes, comparison,
        contentHash: createHash('sha256').update(buffer.subarray(0, bytes)).digest('hex'), observedAt: this.now(), consistency: 'best_effort' as const };
    } finally { await closeHandles(handles); }
  }
}
