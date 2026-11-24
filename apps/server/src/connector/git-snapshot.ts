import { constants } from 'node:fs';
import { open, readlink, realpath, opendir, type FileHandle } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { PackedObjectReader } from './git-packed-object.js';

export type GitFileState = { indexStatus: 'unchanged' | 'added' | 'modified' | 'conflicted' | 'unknown';
  worktreeStatus: 'matches-index' | 'differs-from-index' | 'not-in-index' | 'unknown' };
type Entry = { path: string; oid: string; mode: number; stage: number; assumed: boolean };
const unknown = (): GitFileState => ({ indexStatus: 'unknown', worktreeStatus: 'unknown' });
const sha1 = (body: Uint8Array) => createHash('sha1').update(body).digest('hex');
const oid = (value: string) => /^[a-f0-9]{40}$/.test(value);
const decode = (body: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(body);
const safe = (name: string) => !!name && !['.', '..'].includes(name) && !/[\x00-\x1f\x7f/\\]/.test(name);
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Read-only SHA-1/index-v2 adapter. Worktree metadata requires a verified
 * standard layout and backlink. Packed objects use a config-free Git object reader.
 * Never reads repository config, follows alternates, runs filters/hooks or fetches.
 * Unsupported formats are unknown, NOT clean. Status compares raw bytes, not
 * attribute/filter-normalized content. Returned metadata/object data shares a
 * 4 MiB/5s budget; Git's pack-file I/O is not part of that byte counter. */
export class GitSnapshot {
  private bytes = 0;
  private readonly started = performance.now();
  private readonly guards: { handle: FileHandle; signature: string }[] = [];
  private readonly objects = new Map<string, { type: string; body: Buffer }>();
  private index: Entry[] = [];
  private headTree: string | undefined;
  private available = false;
  private git: FileHandle | undefined;
  private commonGit: FileHandle | undefined;
  private packed: PackedObjectReader | undefined;
  branch: string | undefined;
  private readonly handles: FileHandle[] = [];
  private constructor(private readonly root: FileHandle, private readonly authorized: () => boolean,
    private readonly currentAuthority: () => boolean | PromiseLike<boolean>) {}
  static async read(root: FileHandle, authorized: () => boolean, currentAuthority: () => boolean | PromiseLike<boolean> = () => true) {
    const result = new GitSnapshot(root, authorized, currentAuthority);
    try { await result.initialize(); result.available = true; } catch { /* Report unsupported/unknown. */ }
    return result;
  }
  private check() {
    if (this.authorized() !== true || performance.now() - this.started >= 5000 || this.bytes > 4 * 1024 * 1024) throw Error('snapshot-budget');
  }
  private async current() {
    this.check();
    if (await this.currentAuthority() !== true) throw Error('snapshot-authority');
    this.check();
  }
  private async signature(handle: FileHandle) {
    const s = await handle.stat({ bigint: true }); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
  }
  private async guardDirectory(handle: FileHandle) {
    if (!this.guards.some(g => g.handle === handle)) this.guards.push({ handle, signature: await this.signature(handle) });
  }
  private capacity() { this.check(); if (this.handles.length >= 256) throw Error('descriptor-budget'); }
  private async readFile(parent: FileHandle, parts: string[], limit: number): Promise<Buffer> {
    await this.current(); if (!parts.length || parts.length > 34 || parts.some(p => !safe(p))) throw Error('path');
    let directory = parent;
    await this.guardDirectory(directory);
    for (const part of parts.slice(0, -1)) {
      this.capacity();
      directory = await open(`/proc/self/fd/${directory.fd}/${part}`, directoryFlags); this.handles.push(directory);
      await this.guardDirectory(directory);
    }
    this.capacity();
    const handle = await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    this.handles.push(handle);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit || this.bytes + stat.size > 4 * 1024 * 1024) throw Error('file-budget');
    const signature = await this.signature(handle), buffer = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buffer.length) {
      await this.current(); const read = await handle.read(buffer, used, buffer.length - used, used);
      if (!read.bytesRead) break; used += read.bytesRead;
    }
    this.bytes += used;
    if (used !== stat.size || signature !== await this.signature(handle)) throw Error('changed');
    this.guards.push({ handle, signature }); return buffer.subarray(0, used);
  }
  private async object(id: string) {
    if (!oid(id)) throw Error('object-id');
    const cached = this.objects.get(id); if (cached) return cached;
    if (this.objects.size >= 256) throw Error('object-count');
    let raw: Buffer;
    try {
      const compressed = await this.readFile(this.commonGit!, ['objects', id.slice(0, 2), id.slice(2)], 1024 * 1024);
      raw = inflateSync(compressed, { maxOutputLength: Math.min(2 * 1024 * 1024, 4 * 1024 * 1024 - this.bytes) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!this.packed) {
        this.capacity();
        const objects = await open(`/proc/self/fd/${this.commonGit!.fd}/objects`, directoryFlags); this.handles.push(objects);
        this.capacity();
        const pack = await open(`/proc/self/fd/${objects.fd}/pack`, directoryFlags); this.handles.push(pack);
        await this.guardDirectory(pack);
        let count = 0;
        for await (const entry of await opendir(`/proc/self/fd/${pack.fd}`)) {
          this.check();
          if (++count > 256 || !entry.isFile()) throw Error('pack-layout');
        }
        this.packed = await PackedObjectReader.create(pack);
      }
      await this.current();
      raw = await this.packed.read(id, Math.min(2 * 1024 * 1024, 4 * 1024 * 1024 - this.bytes), 5000 - (performance.now() - this.started));
    }
    this.bytes += raw.length; this.check(); if (sha1(raw) !== id) throw Error('object-hash');
    const zero = raw.indexOf(0), header = raw.subarray(0, zero).toString('ascii'), match = /^(blob|tree|commit) (0|[1-9][0-9]*)$/.exec(header);
    if (zero < 0 || !match || Number(match[2]) !== raw.length - zero - 1) throw Error('object-header');
    const result = { type: match[1]!, body: raw.subarray(zero + 1) }; this.objects.set(id, result); return result;
  }
  private async initialize() {
    await this.current();
    await this.guardDirectory(this.root);
    try { this.git = await open(`/proc/self/fd/${this.root.fd}/.git`, directoryFlags); this.handles.push(this.git); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
      const rootPath = await readlink(`/proc/self/fd/${this.root.fd}`);
      const pointer = decode(await this.readFile(this.root, ['.git'], 4096)).trim();
      if (!pointer.startsWith('gitdir: ')) throw Error('gitdir');
      const target = resolve(rootPath, pointer.slice(8));
      // Only standard linked worktrees, never arbitrary gitdir redirection.
      if (basename(dirname(target)) !== 'worktrees' || basename(dirname(dirname(target))) !== '.git'
        || target !== await realpath(target)) throw Error('worktree-layout');
      this.git = await open(target, directoryFlags); this.handles.push(this.git);
      const backlink = decode(await this.readFile(this.git, ['gitdir'], 4096)).trim();
      const common = decode(await this.readFile(this.git, ['commondir'], 128)).trim();
      if (resolve(target, backlink) !== resolve(rootPath, '.git') || common !== '../..') throw Error('worktree-backlink');
      this.commonGit = await open(dirname(dirname(target)), directoryFlags); this.handles.push(this.commonGit);
    }
    this.commonGit ??= this.git;
    const data = await this.readFile(this.git, ['index'], 2 * 1024 * 1024);
    if (data.length < 32 || data.toString('ascii', 0, 4) !== 'DIRC' || data.readUInt32BE(4) !== 2
      || sha1(data.subarray(0, -20)) !== data.subarray(-20).toString('hex')) throw Error('index-format');
    const count = data.readUInt32BE(8); if (count > 10000) throw Error('index-count');
    let offset = 12; const names = new Set<string>();
    for (let i = 0; i < count; i++) {
      this.check(); const start = offset;
      if (offset + 62 >= data.length - 20) throw Error('index-entry');
      const flags = data.readUInt16BE(offset + 60), end = data.indexOf(0, offset + 62);
      if (flags & 0x4000 || end < 0 || end >= data.length - 20) throw Error('index-flags');
      const path = decode(data.subarray(offset + 62, end));
      if (path.length > 4096 || path.split('/').some(part => !safe(part) || part === '.git')
        || ((flags & 4095) < 4095 && end - offset - 62 !== (flags & 4095))) throw Error('index-path');
      const stage = (flags >> 12) & 3, identity = `${stage}:${path}`;
      if (names.has(identity)) throw Error('index-duplicate'); names.add(identity);
      this.index.push({ path, stage, oid: data.subarray(offset + 40, offset + 60).toString('hex'),
        mode: data.readUInt32BE(offset + 24), assumed: !!(flags & 0x8000) });
      offset = start + Math.ceil((end + 1 - start) / 8) * 8;
    }
    while (offset < data.length - 20) {
      if (offset + 8 > data.length - 20 || data[offset]! < 65 || data[offset]! > 90) throw Error('index-required-extension');
      const size = data.readUInt32BE(offset + 4); offset += 8 + size;
    }
    if (offset !== data.length - 20) throw Error('index-size');
    const head = decode(await this.readFile(this.git, ['HEAD'], 1024)).trim(); let commit: string;
    if (head.startsWith('ref: refs/')) {
      const ref = head.slice(5), parts = ref.split('/');
      this.branch = ref.startsWith('refs/heads/') ? ref.slice(11) : ref;
      try { commit = decode(await this.readFile(this.commonGit, parts, 128)).trim(); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        // No loose ref is NOT proof of an unborn branch. Check packed refs.
        let packed = '';
        try { packed = decode(await this.readFile(this.commonGit, ['packed-refs'], 256 * 1024)); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        const line = packed.split('\n').find(line => line.endsWith(` ${ref}`));
        if (!line) { this.headTree = undefined; return; }
        commit = line.split(' ')[0]!;
      }
    } else { commit = head; this.branch = `detached · ${head.slice(0, 12)}`; }
    const object = await this.object(commit); if (object.type !== 'commit') throw Error('commit');
    const match = /^tree ([0-9a-f]{40})\n/.exec(decode(object.body)); if (!match) throw Error('commit-tree'); this.headTree = match[1];
  }
  private async treeEntry(parts: string[]): Promise<{ oid: string; mode: number } | undefined> {
    if (!this.headTree) return undefined;
    let treeId = this.headTree;
    for (const [i, part] of parts.entries()) {
      const tree = await this.object(treeId); if (tree.type !== 'tree') throw Error('tree');
      let offset = 0, found: { oid: string; mode: number } | undefined;
      const names = new Set<string>();
      while (offset < tree.body.length) {
        const space = tree.body.indexOf(32, offset), zero = tree.body.indexOf(0, space);
        if (space < offset || zero < space || zero + 21 > tree.body.length) throw Error('tree-entry');
        const mode = tree.body.toString('ascii', offset, space), name = decode(tree.body.subarray(space + 1, zero));
        if (!/^(40000|100644|100755|120000|160000)$/.test(mode) || !safe(name) || names.has(name)) throw Error('tree-mode');
        names.add(name);
        if (name === part) found = { oid: tree.body.subarray(zero + 1, zero + 21).toString('hex'), mode: parseInt(mode, 8) };
        offset = zero + 21;
      }
      if (!found) return undefined;
      if (i === parts.length - 1) return found;
      if (found.mode !== 0o40000) throw Error('not-tree'); treeId = found.oid;
    }
    return undefined;
  }
  get supported() { return this.available; }
  async state(parts: string[], working?: Buffer): Promise<GitFileState> {
    if (!this.available) return unknown();
    try {
      this.check(); const entries = this.index.filter(e => e.path === parts.join('/'));
      if (entries.some(e => e.stage !== 0)) return { indexStatus: 'conflicted', worktreeStatus: 'unknown' };
      const entry = entries[0]; if (!entry) return { indexStatus: 'unknown', worktreeStatus: 'not-in-index' };
      if (entry.assumed || ![0o100644, 0o100755].includes(entry.mode)) return unknown();
      const base = await this.treeEntry(parts);
      const bytes = working ?? await this.readFile(this.root, parts, 128 * 1024);
      const actual = sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
      return { indexStatus: !base ? 'added' : base.oid === entry.oid && base.mode === entry.mode ? 'unchanged' : 'modified',
        worktreeStatus: actual === entry.oid ? 'matches-index' : 'differs-from-index' };
    } catch { return unknown(); }
  }
  async comparison(parts: string[], text: string) {
    const status = await this.state(parts, Buffer.from(text));
    if (status.worktreeStatus === 'unknown' || status.worktreeStatus === 'not-in-index') return { ...status, diff: null };
    try {
      const entry = this.index.find(e => e.path === parts.join('/') && e.stage === 0)!, object = await this.object(entry.oid);
      if (object.type !== 'blob' || object.body.length > 128 * 1024) throw Error('blob');
      const base = decode(object.body); if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(base)) throw Error('binary');
      return { ...status, diff: boundedTextDiff(base, text) };
    } catch { return { ...status, diff: null }; }
  }
  async valid() {
    try { await this.current(); for (const guard of this.guards) if (guard.signature !== await this.signature(guard.handle)) return false; await this.current(); return true; }
    catch { return false; }
  }
  async close() {
    // Retain every close even when a packed-reader or descriptor close fails.
    const results = await Promise.allSettled([Promise.resolve().then(() => this.packed?.close()),
      ...this.handles.reverse().map(handle => Promise.resolve().then(() => handle.close()))]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}

/** Single trimmed replacement hunk, not an executable patch or a minimal diff.
 * Explicit newline markers preserve trailing-newline differences. */
export function boundedTextDiff(before: string, after: string): string | null {
  if (before === after) return '';
  const a = before.match(/[^\n]*\n|[^\n]+$/g) ?? [], b = after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (a.length + b.length > 4000) return null;
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
  const lines = (values: string[], sign: string) => values.map(v => sign + v + (v.endsWith('\n') ? '' : '\n\\ No newline at end of file\n')).join('');
  const oldCount = a.length - start - end, newCount = b.length - start - end;
  const result = `@@ -${start + (oldCount ? 1 : 0)},${oldCount} +${start + (newCount ? 1 : 0)},${newCount} @@\n`
    + lines(a.slice(start, a.length - end), '-') + lines(b.slice(start, b.length - end), '+');
  return Buffer.byteLength(result) <= 128 * 1024 ? result : null;
}
