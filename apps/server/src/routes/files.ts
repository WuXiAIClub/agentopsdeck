import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { access, link, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import type { FileBrowserEntry, FileBrowserListResponse, FileBrowserPreviewResponse, FileBrowserRoot, FileBrowserScope } from '@agentopsdeck/shared';
import { mimeTypeFor } from '../utils/mime.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
import { nativeFileRoots, type NativeFileRoots } from '../config.js';
import { HTTPException } from 'hono/http-exception';

export type FileMutation = Readonly<{
  operation: 'upload' | 'rename' | 'delete'; source: string; target?: string; contentDigest?: string;
}>;
export type FileRoutesOptions = {
  roots?: NativeFileRoots;
  /** Trusted application composition only; not an HTTP-provided grant.
   * The original operation calls check immediately before its FS effect. */
  mutate?<T>(request: Request, mutation: FileMutation, work: (check: () => Promise<void>) => Promise<T>): Promise<T>;
};

const AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/;
const scopeRoots = new WeakMap<FileBrowserScope, NativeFileRoots>();
const TEXT_PREVIEW_MAX_BYTES = 220 * 1024;
const IMAGE_INLINE_MAX_BYTES = 3 * 1024 * 1024;
const UPLOAD_MAX_BYTES = 24 * 1024 * 1024;
const MULTIPART_MAX_BYTES = UPLOAD_MAX_BYTES + 64 * 1024;
const RENAME_MAX_BYTES = 16 * 1024;
const SENSITIVE_EXT_RE = /\.(?:pem|key|p12|pfx)$/i;
const SENSITIVE_NAME_RE = /(?:^|[._-])(?:credential|credentials|secret|secrets|token|tokens|api[_-]?key|private[_-]?key|password|passwd)(?:[._-]|$)/i;
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'json', 'jsonl', 'log', 'csv', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'html', 'xml', 'yaml', 'yml', 'toml', 'ini', 'sh', 'bash', 'zsh', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'dart', 'sql']);

export function registerFileRoutes(app: Hono, options: FileRoutesOptions = {}) {
  const roots = Object.freeze({ ...(options.roots ?? nativeFileRoots(process.env)) });
  const gateway = () => gatewayScope(roots);
  const agent = (context: Context) => agentScope(context, roots);
  const tasks = createTaskDrain(); let closed = false;
  let bodyReaders = 0, downloads = 0;
  const bodyCancellations = new Set<Promise<void>>();
  const retainBody = (pending: Promise<unknown>) => {
    bodyReaders++;
    const cancellation = pending.then(() => {}, () => {}).finally(() => {
      bodyReaders--; bodyCancellations.delete(cancellation);
    });
    bodyCancellations.add(cancellation);
  };
  const bodyWork = async <T>(work: () => Promise<T>) => {
    if (bodyReaders >= 4) throw new HTTPException(429);
    bodyReaders++;
    try { return await work(); } finally { bodyReaders--; }
  };
  app.use('/api/files/*', async (c, next) => {
    if (closed) return c.json({ error: 'server_draining' }, 503);
    return tasks.run(() => next());
  });
  const mutate = <T>(c: Context, mutation: FileMutation, work: (check: () => Promise<void>) => Promise<T>) =>
    options.mutate ? options.mutate(c.req.raw, Object.freeze(mutation), work) : work(async () => {});
  app.get('/api/files/roots', async (c) => routeJson(c, async () => ({ roots: await listRoots(roots) })));

  app.get('/api/files/gateway/preview', async (c) => routeJson(c, () => previewFile(gateway(), queryPath(c))));
  app.get('/api/files/agents/:agentId/preview', async (c) => routeJson(c, () => previewFile(agent(c), queryPath(c))));

  const downloadHandler = async (c: Context, scope: FileBrowserScope) => {
    if (downloads >= 4) return c.json({ error: 'file_capacity_exceeded' }, 429);
    downloads++;
    try {
      const resolved = await resolveExisting(scope, queryPath(c));
      assertReadableFile(resolved);
      if (resolved.protection.sensitive) throw Object.assign(new Error('This path is hidden because it looks sensitive.'), { status: 403 });
      if (resolved.protection.openclawConfig) throw Object.assign(new Error('openclaw.json files are read-only and cannot be downloaded.'), { status: 403 });
      const bytes = await readCheckedFile(resolved, UPLOAD_MAX_BYTES);
      const mimeType = mimeTypeFor(path.basename(resolved.realPath));
      const inline = c.req.query('inline') === '1' && (mimeType.startsWith('image/') || mimeType === 'application/pdf' || mimeType.startsWith('text/'));
      c.header('content-type', mimeType);
      c.header('content-length', String(bytes.length));
      const filename = path.basename(resolved.realPath);
      const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
      const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      c.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`);
      return c.body(bytes);
    } catch (error) {
      return errorResponse(c, error);
    } finally { downloads--; }
  };
  app.get('/api/files/gateway/download', (c) => downloadHandler(c, gateway()));
  app.get('/api/files/agents/:agentId/download', (c) => downloadHandler(c, agent(c)));

  app.get('/api/files/gateway', async (c) => routeJson(c, () => listDirectory(gateway(), queryPath(c))));
  app.get('/api/files/agents/:agentId', async (c) => routeJson(c, () => listDirectory(agent(c), queryPath(c))));

  const uploadHandler = async (c: Context, scope: FileBrowserScope) => routeJson(c, () => bodyWork(async () => {
    const dirPath = String(c.req.query('path') ?? '');
    if (!c.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data;')) throw new HTTPException(400);
    const bytesBody = await readFileBody(c.req.raw, MULTIPART_MAX_BYTES, retainBody);
    let body: FormData;
    try { body = await new Response(bytesBody, { headers: { 'content-type': c.req.header('content-type') ?? '' } }).formData(); }
    catch { throw new HTTPException(400); }
    const upload = body.get('file');
    if (body.getAll('file').length !== 1) throw new HTTPException(400);
    if (!(upload instanceof File)) throw Object.assign(new Error('file upload is required'), { status: 400 });
    if (upload.size > UPLOAD_MAX_BYTES) throw Object.assign(new Error(`file too large; max ${formatBytes(UPLOAD_MAX_BYTES)}`), { status: 413 });
    const filename = safeBasename(String(upload.name || 'upload.bin'));
    const parent = await resolveExisting(scope, dirPath || '.');
    if (!parent.stats.isDirectory()) throw Object.assign(new Error('upload target must be a directory'), { status: 400 });
    await assertOriginalPathIdentity(parent.rootRealPath, dirPath || '.', parent.realPath, parent.stats);
    const target = await resolveNewChild(parent, filename);
    await assertNoExistingTarget(target.realPath);
    const bytes = Buffer.from(await upload.arrayBuffer());
    return mutate(c, { operation: 'upload', source: target.realPath,
      contentDigest: createHash('sha256').update(bytes).digest('hex') }, async check => {
      await check();
      await verifyConfinedParent(scope, parent.rootRealPath, dirPath || '.', parent.realPath, parent.stats);
      let createdStats: Awaited<ReturnType<typeof stat>>;
      const handle = await open(
        target.realPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
        0o644,
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') throw Object.assign(new Error('target already exists'), { status: 409 });
        if (error.code === 'ELOOP') throw Object.assign(new Error('path escape is not allowed'), { status: 403 });
        throw error;
      });
      try {
        await handle.writeFile(bytes);
        createdStats = await handle.stat();
      } finally {
        await handle.close();
      }
      logFileMutation('upload', scope, target.realPath, { bytes: bytes.length });
      return { ok: true, entry: await entryFor(parent.rootRealPath, target.realPath, createdStats, path.dirname(target.relativePath)) };
    });
  }));
  app.post('/api/files/gateway/upload', (c) => uploadHandler(c, gateway()));
  app.post('/api/files/agents/:agentId/upload', (c) => uploadHandler(c, agent(c)));

  const renameHandler = async (c: Context, scope: FileBrowserScope) => routeJson(c, () => bodyWork(async () => {
    const bytesBody = await readFileBody(c.req.raw, RENAME_MAX_BYTES, retainBody);
    let payload: { path?: unknown; name?: unknown };
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytesBody)); }
    catch { throw new HTTPException(400); }
    if (!payload || typeof payload.path !== 'string' || typeof payload.name !== 'string') throw new HTTPException(400);
    const nextName = safeBasename(String(payload.name ?? ''));
    const requestedPath = String(payload.path ?? '');
    const existing = await resolveExisting(scope, requestedPath);
    assertWritable(existing, 'rename');
    if (existing.relativePath === '.') throw Object.assign(new Error('root cannot be renamed'), { status: 400 });
    await assertOriginalPathIdentity(existing.rootRealPath, requestedPath, existing.realPath, existing.stats);
    if (existing.stats.isFile() && existing.stats.nlink !== 1) throw Object.assign(new Error('Hard-linked files cannot be renamed.'), { status: 403 });
    const parentRealPath = path.dirname(existing.realPath);
    assertInside(existing.rootRealPath, parentRealPath);
    const parentRelativePath = normalizeRelative(path.dirname(existing.relativePath));
    const parentStats = await assertOriginalDirectoryIdentity(existing.rootRealPath, parentRelativePath, parentRealPath);
    const parent = { ...existing, realPath: parentRealPath, relativePath: parentRelativePath, stats: parentStats, protection: protectionForRelativePath(parentRelativePath) };
    const target = await resolveNewChild(parent, nextName);
    await assertNoExistingTarget(target.realPath);
    return mutate(c, { operation: 'rename', source: existing.realPath, target: target.realPath }, async check => {
      await check();
      await verifyConfinedParent(scope, existing.rootRealPath, parentRelativePath, parentRealPath, parentStats);
      const sourceNow = await assertCurrentSubjectIdentity(existing.realPath, existing.stats);
      if (existing.stats.isFile() && sourceNow.nlink !== 1) throw Object.assign(new Error('File changed; refresh before renaming.'), { status: 409 });
      await assertNoExistingTarget(target.realPath);
      if (existing.stats.isFile()) {
        await link(existing.realPath, target.realPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'EEXIST') throw Object.assign(new Error('target already exists'), { status: 409 });
          if (error.code === 'ELOOP') throw Object.assign(new Error('path escape is not allowed'), { status: 403 });
          throw error;
        });
        await unlink(existing.realPath);
      } else {
        await rename(existing.realPath, target.realPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') throw Object.assign(new Error('target already exists'), { status: 409 });
          throw error;
        });
      }
      const renamedStats = await lstat(target.realPath);
      if (renamedStats.isSymbolicLink() || renamedStats.dev !== existing.stats.dev || renamedStats.ino !== existing.stats.ino) {
        throw Object.assign(new Error('Renamed entry changed unexpectedly.'), { status: 409 });
      }
      logFileMutation('rename', scope, existing.realPath, { to: target.realPath });
      return { ok: true, entry: await entryFor(existing.rootRealPath, target.realPath, renamedStats, path.dirname(target.relativePath)) };
    });
  }));
  app.patch('/api/files/gateway/rename', (c) => renameHandler(c, gateway()));
  app.patch('/api/files/agents/:agentId/rename', (c) => renameHandler(c, agent(c)));

  const deleteHandler = async (c: Context, scope: FileBrowserScope) => routeJson(c, async () => {
    const requestedPath = queryPath(c);
    const existing = await resolveExisting(scope, requestedPath);
    assertWritable(existing, 'delete');
    if (existing.relativePath === '.') throw Object.assign(new Error('root cannot be deleted'), { status: 400 });
    await assertOriginalPathIdentity(existing.rootRealPath, requestedPath, existing.realPath, existing.stats);
    if (existing.stats.isFile() && existing.stats.nlink !== 1) throw Object.assign(new Error('Hard-linked files cannot be deleted.'), { status: 403 });
    const parentRealPath = path.dirname(existing.realPath);
    assertInside(existing.rootRealPath, parentRealPath);
    const parentRelativePath = normalizeRelative(path.dirname(existing.relativePath));
    const parentStats = await assertOriginalDirectoryIdentity(existing.rootRealPath, parentRelativePath, parentRealPath);
    return mutate(c, { operation: 'delete', source: existing.realPath }, async check => {
      await check();
      await verifyConfinedParent(scope, existing.rootRealPath, parentRelativePath, parentRealPath, parentStats);
      const targetNow = await assertCurrentSubjectIdentity(existing.realPath, existing.stats);
      if (existing.stats.isDirectory()) {
        if (!targetNow.isDirectory()) throw Object.assign(new Error('Target changed; refresh before deleting.'), { status: 409 });
        const children = await readdir(existing.realPath);
        if (children.length > 0) throw Object.assign(new Error('only empty directories can be deleted'), { status: 400 });
        await rmdir(existing.realPath);
      } else {
        if (!targetNow.isFile() || targetNow.nlink !== 1) throw Object.assign(new Error('File changed; refresh before deleting.'), { status: 409 });
        await unlink(existing.realPath);
      }
      logFileMutation('delete', scope, existing.realPath);
      return { ok: true };
    });
  });
  app.delete('/api/files/gateway', (c) => deleteHandler(c, gateway()));
  app.delete('/api/files/agents/:agentId', (c) => deleteHandler(c, agent(c)));
  return Object.freeze({ close: () => {
    closed = true;
    return tasks.close().then(() => Promise.all([...bodyCancellations])).then(() => {});
  } });
}

async function listRoots(roots: NativeFileRoots): Promise<FileBrowserRoot[]> {
  const openClawHome = roots.home;
  const gatewayRoot = await safeRoot('gateway', 'Gateway / OpenClaw', openClawHome);
  const parent = await safeRealpath(openClawHome);
  const workspaces = await configuredWorkspaces(roots);
  if (parent) {
    const children = await readdir(parent, { withFileTypes: true }).catch(() => []);
    for (const entry of children) {
      const agentId = entry.name.replace(/^workspace-/, '');
      if (entry.isDirectory() && entry.name.startsWith('workspace-') && AGENT_ID_RE.test(agentId)
        && !isSensitiveName(entry.name) && !workspaces.has(agentId)) workspaces.set(agentId, path.join(parent, entry.name));
    }
  }
  const agentRoots = (await Promise.all([...workspaces].map(([agentId, workspace]) =>
    safeRoot('agent', agentId, workspace)))).filter(Boolean) as FileBrowserRoot[];
  return [gatewayRoot, ...agentRoots].filter(Boolean) as FileBrowserRoot[];
}

export async function listDirectory(scope: FileBrowserScope, requestedPath: string, explicitRoot?: string): Promise<FileBrowserListResponse> {
  const resolved = await resolveExisting(scope, requestedPath || '.', explicitRoot);
  if (!resolved.stats.isDirectory()) throw Object.assign(new Error('path is not a directory'), { status: 400 });
  if (resolved.protection.sensitive) throw Object.assign(new Error('This path is hidden because it looks sensitive.'), { status: 403 });
  const rows = await readdir(resolved.realPath, { withFileTypes: true });
  const entries: FileBrowserEntry[] = [];
  let hiddenCount = 0;
  // Bound filesystem work instead of paying realpath/stat latency serially.
  let cursor = 0;
  async function inspect(row: typeof rows[number]) {
    try { safeBasename(row.name); } catch { hiddenCount += 1; return; }
    const childPath = path.join(resolved.realPath, row.name);
    const relativeParent = resolved.relativePath === '.' ? '' : resolved.relativePath;
    const relativePath = normalizeRelative(path.join(relativeParent, row.name));
    const protection = protectionForRelativePath(relativePath);
    if (protection.sensitive) {
      hiddenCount += 1;
      return;
    }
    try {
      const childRealPath = await realpath(childPath);
      assertInside(resolved.rootRealPath, childRealPath);
      const childStats = await stat(childPath);
      const actualProtection = protectionForRelativePath(normalizeRelative(path.relative(resolved.rootRealPath, childRealPath)));
      if (actualProtection.sensitive || (actualProtection.openclawConfig && childRealPath !== childPath) || (childStats.isFile() && childStats.nlink !== 1)) { hiddenCount += 1; return; }
      entries.push(await entryFor(resolved.rootRealPath, childPath, childStats, relativeParent));
    } catch {
      hiddenCount += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, rows.length) }, async () => {
    while (cursor < rows.length) await inspect(rows[cursor++]!);
  }));
  entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
  return { scope, root: scope.rootLabel, path: resolved.relativePath === '.' ? '' : resolved.relativePath, entries, hiddenCount, updatedAt: Date.now() };
}

/** Native tool paths are not browser paths. Map only an existing, unprotected
 * file inside this explicitly authorized root; never infer a wider workspace. */
export async function listSourceDirectory(scope: FileBrowserScope, sourcePath: string, explicitRoot: string) {
  if (!sourcePath || sourcePath.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(sourcePath)
    || sourcePath.split('/').includes('..')) throw Object.assign(new Error('Invalid source path'), { status: 400 });
  const rootReal = await realpath(explicitRoot);
  let relative = sourcePath;
  if (path.isAbsolute(sourcePath)) {
    const configured = path.resolve(explicitRoot);
    const base = sourcePath === configured || sourcePath.startsWith(configured + path.sep) ? configured : rootReal;
    assertInside(base, sourcePath);
    relative = normalizeRelative(path.relative(base, sourcePath));
  }
  const lexical = protectionForRelativePath(sanitizeRelative(relative));
  const resolved = await resolveExisting(scope, relative, explicitRoot);
  assertReadableFile(resolved);
  if (lexical.sensitive || lexical.openclawConfig || resolved.protection.sensitive || resolved.protection.openclawConfig)
    throw Object.assign(new Error('This file is protected.'), { status: 403 });
  return listDirectory(scope, path.dirname(resolved.relativePath), explicitRoot);
}

export async function previewFile(scope: FileBrowserScope, requestedPath: string, explicitRoot?: string): Promise<FileBrowserPreviewResponse> {
  const resolved = await resolveExisting(scope, requestedPath, explicitRoot);
  assertReadableFile(resolved);
  if (resolved.protection.sensitive) throw Object.assign(new Error('This path is hidden because it looks sensitive.'), { status: 403 });
  if (resolved.protection.openclawConfig) throw Object.assign(new Error('openclaw.json files are read-only and cannot be previewed.'), { status: 403 });
  const name = path.basename(resolved.realPath);
  const mimeType = mimeTypeFor(name);
  const base = { scope, path: resolved.relativePath, name, size: resolved.stats.size, mimeType };
  if (isTextLike(name, mimeType)) {
    if (resolved.stats.size > TEXT_PREVIEW_MAX_BYTES) return { ...base, kind: 'too_large', capped: true, maxPreviewBytes: TEXT_PREVIEW_MAX_BYTES };
    const bytes = await readCheckedFile(resolved, TEXT_PREVIEW_MAX_BYTES);
    const text = bytes.toString('utf8');
    const utf8 = Buffer.from(text).equals(bytes) && !text.includes('\0');
    return { ...base, kind: 'text', text, ...(utf8 ? { revision: textRevision(bytes) } : {}), capped: false, maxPreviewBytes: TEXT_PREVIEW_MAX_BYTES };
  }
  if (mimeType.startsWith('image/')) {
    if (resolved.stats.size > IMAGE_INLINE_MAX_BYTES) return { ...base, kind: 'too_large', capped: true, maxPreviewBytes: IMAGE_INLINE_MAX_BYTES };
    const data = await readCheckedFile(resolved, IMAGE_INLINE_MAX_BYTES);
    return { ...base, kind: 'image', dataUrl: `data:${mimeType};base64,${data.toString('base64')}`, capped: false, maxPreviewBytes: IMAGE_INLINE_MAX_BYTES };
  }
  if (mimeType === 'application/pdf') return { ...base, kind: 'pdf', downloadUrl: downloadUrl(scope, resolved.relativePath, true) };
  return { ...base, kind: 'binary', downloadUrl: downloadUrl(scope, resolved.relativePath, false) };
}

const textRevision = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const textWrites = new Set<string>();
/** Explicit-root only. Serialized within this process, optimistic against external
 * editors. No delete/create, no encoding conversion and no automatic retry. */
export async function saveWorkspaceText(scope: FileBrowserScope, input: unknown, root: string,
  authorize: () => boolean | PromiseLike<boolean>, check: () => void = () => {}) {
  check();
  const v = input as { path?: unknown; text?: unknown; revision?: unknown } | null;
  if (!v || typeof v.path !== 'string' || typeof v.text !== 'string' || typeof v.revision !== 'string'
    || !/^[a-f0-9]{64}$/.test(v.revision) || v.text.includes('\0') || Buffer.byteLength(v.text) > TEXT_PREVIEW_MAX_BYTES
    || Buffer.from(v.text).toString('utf8') !== v.text) throw Object.assign(Error('Invalid UTF-8 text write (maximum 220 KiB).'), { status: 400 });
  const requestedPath = v.path;
  const resolved = await resolveExisting(scope, requestedPath, root);
  assertReadableFile(resolved); assertWritable(resolved, 'edit');
  if (!isTextLike(resolved.realPath, mimeTypeFor(resolved.realPath))) throw Object.assign(Error('Only UTF-8 text files can be edited.'), { status: 415 });
  const key = resolved.realPath;
  if (textWrites.has(key)) throw Object.assign(Error('File is being saved; refresh before retrying.'), { status: 409 });
  textWrites.add(key);
  const temporary = path.join(path.dirname(key), `.agentopsdeck-edit-${randomUUID()}.tmp`);
  let created = false;
  try {
    const before = await readCheckedFile(resolved, TEXT_PREVIEW_MAX_BYTES);
    if (before.includes(0) || !Buffer.from(before.toString('utf8')).equals(before)) throw Object.assign(Error('Only UTF-8 text files can be edited.'), { status: 415 });
    if (textRevision(before) !== v.revision) throw Object.assign(Error('File changed; your draft was not saved. Reload and merge.'), { status: 409 });
    const bytes = Buffer.from(v.text);
    const handle = await open(temporary, 'wx', resolved.stats.mode & 0o777);
    created = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    const finalCas = async () => {
      // Resolve the user-visible path again, including parent/symlink and hardlink checks.
      const again = await resolveExisting(scope, requestedPath, root);
      assertReadableFile(again); assertWritable(again, 'edit');
      if (again.realPath !== key || again.stats.ino !== resolved.stats.ino || again.stats.dev !== resolved.stats.dev
        || textRevision(await readCheckedFile(again, TEXT_PREVIEW_MAX_BYTES)) !== v.revision) throw Object.assign(Error('File changed; reload and merge.'), { status: 409 });
    };
    await finalCas(); check();
    const permission = authorize();
    if (typeof permission === 'boolean') {
      // Preserve the original synchronous final guard without adding a yield.
      if (permission !== true) throw Object.assign(Error('File edit access was revoked.'), { status: 403 });
    } else {
      if (await permission !== true) throw Object.assign(Error('File edit access was revoked.'), { status: 403 });
      check();
      // Worker authority may wait while another editor replaces the file.
      // Recheck CAS after that wait, not just against the earlier snapshot.
      await finalCas();
    }
    check();
    await rename(temporary, key); created = false;
    return { revision: textRevision(bytes) };
  } finally { textWrites.delete(key); if (created) await rm(temporary, { force: true }); }
}

function gatewayScope(roots: NativeFileRoots): FileBrowserScope {
  const scope: FileBrowserScope = { type: 'gateway', rootLabel: 'Gateway / OpenClaw' };
  scopeRoots.set(scope, roots);
  return scope;
}

function agentScope(c: Context, roots: NativeFileRoots): FileBrowserScope {
  const agentId = c.req.param('agentId') || '';
  if (!AGENT_ID_RE.test(agentId)) throw Object.assign(new Error('invalid agent id'), { status: 400 });
  const scope: FileBrowserScope = { type: 'agent', agentId, rootLabel: `Agent ${agentId}` };
  scopeRoots.set(scope, roots);
  return scope;
}

function queryPath(c: Context) {
  return String(c.req.query('path') ?? '');
}

async function resolveExisting(scope: FileBrowserScope, requestedPath: string, explicitRoot?: string) {
  const root = explicitRoot ?? await rootPath(scope);
  const rootRealPath = await realpath(root).catch(() => undefined);
  if (!rootRealPath) throw Object.assign(new Error('file root is not available'), { status: 404 });
  const relativePath = sanitizeRelative(requestedPath);
  const target = path.resolve(rootRealPath, relativePath);
  assertInside(rootRealPath, target);
  const realTarget = await realpath(target).catch(() => undefined);
  if (!realTarget) throw Object.assign(new Error('path not found'), { status: 404 });
  assertInside(rootRealPath, realTarget);
  const stats = await stat(realTarget);
  const actualRelativePath = normalizeRelative(path.relative(rootRealPath, realTarget) || '.');
  return { scope, rootRealPath, realPath: realTarget, relativePath: actualRelativePath, stats, protection: protectionForRelativePath(actualRelativePath) };
}

export async function readWorkspaceFile(scope: FileBrowserScope, requestedPath: string, explicitRoot: string) {
  const resolved = await resolveExisting(scope, requestedPath, explicitRoot);
  assertReadableFile(resolved);
  if (resolved.protection.sensitive || resolved.protection.openclawConfig) throw Object.assign(new Error('This file is protected.'), { status: 403 });
  if (resolved.stats.size > 24 * 1024 * 1024) throw Object.assign(new Error('Workspace downloads are limited to 24 MiB.'), { status: 413 });
  const bytes = await readCheckedFile(resolved, 24 * 1024 * 1024);
  return { bytes, name: path.basename(resolved.realPath), mimeType: mimeTypeFor(resolved.realPath) };
}

async function resolveNewChild(parent: Awaited<ReturnType<typeof resolveExisting>>, unsafeName: string) {
  if (!parent.stats.isDirectory()) throw Object.assign(new Error('parent must be a directory'), { status: 400 });
  const name = safeBasename(unsafeName);
  const relativePath = normalizeRelative(path.join(parent.relativePath === '.' ? '' : parent.relativePath, name));
  const protection = protectionForRelativePath(relativePath);
  if (protection.sensitive || protection.openclawConfig) throw Object.assign(new Error('target name is protected'), { status: 403 });
  const target = path.resolve(parent.realPath, name);
  assertInside(parent.rootRealPath, target);
  return { realPath: target, relativePath };
}

async function rootPath(scope: FileBrowserScope) {
  const roots = scopeRoots.get(scope) ?? nativeFileRoots(process.env);
  const openClawHome = roots.home;
  if (scope.type === 'gateway') return openClawHome;
  return (await configuredWorkspaces(roots)).get(scope.agentId) ?? path.join(openClawHome, `workspace-${scope.agentId}`);
}

// Read only workspace metadata, never expose native configuration through the API.
// Invalid configuration fails closed instead of silently selecting another directory.
async function configuredWorkspaces(roots: NativeFileRoots) {
  const openClawHome = roots.home;
  const configFile = roots.configFile;
  const unavailable = () => Object.assign(new Error('Unable to read OpenClaw workspace configuration'), { status: 503 });
  let config;
  try {
    const realPath = await realpath(configFile);
    const stats = await stat(realPath);
    const bytes = await readCheckedFile({ realPath, stats, rootRealPath: path.dirname(realPath) } as Awaited<ReturnType<typeof resolveExisting>>, TEXT_PREVIEW_MAX_BYTES);
    config = JSON.parse(bytes.toString('utf8'));
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !roots.configRequired) config = {};
    else throw unavailable();
  }
  const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  if (!object(config) || (config.agents !== undefined && !object(config.agents))) throw unavailable();
  const agents = config.agents ?? {};
  if ((agents.defaults !== undefined && !object(agents.defaults))
    || (agents.list !== undefined && !Array.isArray(agents.list))) throw unavailable();
  const workspacePath = (value: unknown) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw unavailable();
    const workspace = value.trim();
    const expanded = workspace === '~' ? homedir() : /^~[\\/]/.test(workspace) ? path.join(homedir(), workspace.slice(2)) : workspace;
    // Relative configuration is anchored to its config file, never the service cwd.
    return path.resolve(path.dirname(configFile), expanded);
  };
  const workspaces = new Map<string, string>();
  workspaces.set('main', workspacePath(agents.defaults?.workspace)
    ?? await safeRealpath(path.join(openClawHome, 'workspace')) ?? path.join(openClawHome, 'workspace-main'));
  for (const agent of agents.list ?? []) {
    if (!object(agent) || typeof agent.id !== 'string' || !AGENT_ID_RE.test(agent.id)) throw unavailable();
    const workspace = workspacePath(agent.workspace);
    if (workspace) workspaces.set(agent.id, workspace);
  }
  return workspaces;
}

async function safeRoot(type: 'gateway' | 'agent', label: string, rootPath: string): Promise<FileBrowserRoot | undefined> {
  const real = await safeRealpath(rootPath);
  if (!real) return undefined;
  return type === 'gateway'
    ? { type: 'gateway', label, path: real, readOnly: false }
    : { type: 'agent', agentId: label, label, path: real, readOnly: false };
}

async function safeRealpath(target: string) {
  try { return await realpath(target); } catch { return undefined; }
}

async function entryFor(rootRealPath: string, realPath: string, stats: Awaited<ReturnType<typeof stat>>, parentRelative: string): Promise<FileBrowserEntry> {
  const relativePath = normalizeRelative(path.relative(rootRealPath, realPath) || path.join(parentRelative, path.basename(realPath)));
  const protection = protectionForRelativePath(relativePath);
  const kind = stats.isDirectory() ? 'directory' : 'file';
  const mimeType = kind === 'file' ? mimeTypeFor(path.basename(realPath)) : undefined;
  return {
    name: path.basename(realPath),
    path: relativePath === '.' ? '' : relativePath,
    kind,
    ...(kind === 'file' ? { size: Number(stats.size) } : {}),
    modifiedAt: Number(stats.mtimeMs),
    ...(mimeType ? { mimeType } : {}),
    protected: protection.sensitive || protection.openclawConfig,
    ...(protection.sensitive ? { reason: 'hidden_sensitive' as const } : protection.openclawConfig ? { reason: 'openclaw_config_read_only' as const } : {}),
    canPreview: kind === 'file' && !protection.sensitive && !protection.openclawConfig,
    canDownload: kind === 'file' && !protection.sensitive && !protection.openclawConfig,
    canRename: relativePath !== '.' && !protection.sensitive && !protection.openclawConfig,
    canDelete: relativePath !== '.' && !protection.sensitive && !protection.openclawConfig,
    canUpload: kind === 'directory' && !protection.sensitive && !protection.openclawConfig,
  };
}

function assertReadableFile(resolved: Awaited<ReturnType<typeof resolveExisting>>) {
  if (!resolved.stats.isFile()) throw Object.assign(new Error('path is not a file'), { status: 400 });
  if (resolved.stats.nlink !== 1) throw Object.assign(new Error('Hard-linked files cannot be read.'), { status: 403 });
}

async function readCheckedFile(resolved: Awaited<ReturnType<typeof resolveExisting>>, limit: number) {
  const handle = await open(resolved.realPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.ino !== resolved.stats.ino || before.dev !== resolved.stats.dev) throw Object.assign(new Error('File changed; refresh before reading.'), { status: 409 });
    if (before.size > limit) throw Object.assign(new Error('File exceeds the read limit.'), { status: 413 });
    const buffer = Buffer.alloc(Math.min(before.size, limit) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw Object.assign(new Error('File exceeds the read limit.'), { status: 413 });
    const after = await handle.stat();
    const currentPath = await realpath(resolved.realPath);
    const current = await stat(currentPath);
    assertInside(resolved.rootRealPath, currentPath);
    if (length !== before.size || currentPath !== resolved.realPath || after.nlink !== 1 || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || current.ino !== after.ino || current.dev !== after.dev) throw Object.assign(new Error('File changed; refresh before reading.'), { status: 409 });
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

function assertWritable(resolved: Awaited<ReturnType<typeof resolveExisting>>, operation: string) {
  if (resolved.protection.sensitive) throw Object.assign(new Error(`cannot ${operation} hidden sensitive path`), { status: 403 });
  if (resolved.protection.openclawConfig) throw Object.assign(new Error(`cannot ${operation} openclaw.json files`), { status: 403 });
}

async function assertNoExistingTarget(targetPath: string) {
  const found = await lstat(targetPath).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    if (error.code === 'ELOOP') throw Object.assign(new Error('path escape is not allowed'), { status: 403 });
    throw error;
  });
  if (found) throw Object.assign(new Error('target already exists'), { status: 409 });
}

async function assertOriginalPathIdentity(
  rootRealPath: string,
  requestedPath: string,
  expectedRealPath: string,
  expectedStats: Awaited<ReturnType<typeof stat>>,
) {
  const relativePath = sanitizeRelative(requestedPath);
  const parts = relativePath === '.' ? [] : relativePath.split('/').filter(Boolean);
  let cursor = rootRealPath;
  const rootStats = await lstat(rootRealPath);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw Object.assign(new Error('path escape is not allowed'), { status: 403 });
  }
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.resolve(cursor, parts[index]!);
    assertInside(rootRealPath, cursor);
    const segmentStats = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw Object.assign(new Error('path not found'), { status: 404 });
      if (error.code === 'ELOOP') throw Object.assign(new Error('path escape is not allowed'), { status: 403 });
      throw error;
    });
    if (segmentStats.isSymbolicLink()) {
      throw Object.assign(new Error('Symbolic-link mutation paths are not allowed.'), { status: 403 });
    }
    if (index < parts.length - 1 && !segmentStats.isDirectory()) {
      throw Object.assign(new Error('parent must be a directory'), { status: 400 });
    }
    if (index === parts.length - 1) {
      if (cursor !== expectedRealPath || segmentStats.dev !== expectedStats.dev || segmentStats.ino !== expectedStats.ino) {
        throw Object.assign(new Error('Symbolic-link mutation paths are not allowed.'), { status: 403 });
      }
    }
  }
}

async function assertOriginalDirectoryIdentity(rootRealPath: string, relativePath: string, expectedRealPath: string) {
  const stats = await lstat(expectedRealPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw Object.assign(new Error('path not found'), { status: 404 });
    throw error;
  });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw Object.assign(new Error('Symbolic-link mutation paths are not allowed.'), { status: 403 });
  }
  await assertOriginalPathIdentity(rootRealPath, relativePath, expectedRealPath, stats);
  return stats;
}

async function verifyConfinedParent(
  scope: FileBrowserScope,
  expectedRootRealPath: string,
  parentRelativePath: string,
  parentPath: string,
  expectedParentStats: Awaited<ReturnType<typeof stat>>,
) {
  const currentRoot = await safeRealpath(await rootPath(scope));
  if (!currentRoot || currentRoot !== expectedRootRealPath) {
    throw Object.assign(new Error('File root changed; refresh before mutating.'), { status: 409 });
  }
  const rootStats = await lstat(expectedRootRealPath).catch(() => undefined);
  if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw Object.assign(new Error('File root changed; refresh before mutating.'), { status: 409 });
  }
  const parts = sanitizeRelative(parentRelativePath) === '.' ? [] : sanitizeRelative(parentRelativePath).split('/').filter(Boolean);
  let cursor = expectedRootRealPath;
  for (const part of parts) {
    cursor = path.resolve(cursor, part);
    assertInside(expectedRootRealPath, cursor);
    const segmentStats = await lstat(cursor).catch(() => undefined);
    if (!segmentStats || segmentStats.isSymbolicLink() || !segmentStats.isDirectory()) {
      throw Object.assign(new Error('Parent directory changed; refresh before mutating.'), { status: 409 });
    }
  }
  const parentLstat = await lstat(parentPath).catch(() => undefined);
  if (
    !parentLstat
    || parentLstat.isSymbolicLink()
    || !parentLstat.isDirectory()
    || parentLstat.dev !== expectedParentStats.dev
    || parentLstat.ino !== expectedParentStats.ino
  ) {
    throw Object.assign(new Error('Parent directory changed; refresh before mutating.'), { status: 409 });
  }
  const parentReal = await realpath(parentPath).catch(() => undefined);
  if (!parentReal) throw Object.assign(new Error('Parent directory changed; refresh before mutating.'), { status: 409 });
  assertInside(expectedRootRealPath, parentReal);
  if (parentReal !== parentPath || cursor !== parentPath) {
    throw Object.assign(new Error('Parent directory changed; refresh before mutating.'), { status: 409 });
  }
}

async function assertCurrentSubjectIdentity(subjectPath: string, expectedStats: Awaited<ReturnType<typeof stat>>) {
  const current = await lstat(subjectPath).catch(() => undefined);
  if (!current || current.isSymbolicLink() || current.dev !== expectedStats.dev || current.ino !== expectedStats.ino) {
    throw Object.assign(new Error('Target changed; refresh before mutating.'), { status: 409 });
  }
  return current;
}

function sanitizeRelative(input: string) {
  if (input.includes('\0')) throw Object.assign(new Error('invalid path'), { status: 400 });
  const trimmed = input;
  if (!trimmed || trimmed === '/' || trimmed === '.') return '.';
  if (path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed) || /^[a-z]:/i.test(trimmed)) throw Object.assign(new Error('absolute paths are not allowed'), { status: 400 });
  // Wire paths always use slash separators, independent of the Connector OS.
  // Reject aliases (ADS, device names, trailing dot/space) consistently.
  for (const part of trimmed.split(/[\\/]/)) {
    if (part && part !== '.' && part !== '..') safeBasename(part);
  }
  const normalized = normalizeRelative(trimmed);
  if (normalized === '..' || normalized.startsWith('../')) throw Object.assign(new Error('path escape is not allowed'), { status: 403 });
  return normalized;
}

function normalizeRelative(value: string) {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  return normalized === '' ? '.' : normalized;
}

function assertInside(rootRealPath: string, targetPath: string) {
  const relative = path.relative(rootRealPath, targetPath);
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) return;
  throw Object.assign(new Error('path escape is not allowed'), { status: 403 });
}

function safeBasename(name: string) {
  const base = name;
  if (!base || base === '.' || base === '..' || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(base) || /[. ]$/.test(base)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(base)) throw Object.assign(new Error('invalid portable filename'), { status: 400 });
  return base;
}

function protectionForRelativePath(relativePath: string) {
  const parts = normalizeRelative(relativePath).split('/').filter(Boolean);
  const openclawConfig = parts.some((part) => /^openclaw\.json(?:$|[.-])/i.test(part));
  const sensitive = parts.some(isSensitiveName);
  return { sensitive, openclawConfig };
}

function isSensitiveName(name: string) {
  const lower = name.toLowerCase();
  return lower === '.env'
    || lower.startsWith('.env.')
    || lower === 'id_rsa'
    || lower === 'id_dsa'
    || lower === 'id_ecdsa'
    || lower === 'id_ed25519'
    || SENSITIVE_EXT_RE.test(lower)
    || SENSITIVE_NAME_RE.test(lower);
}

function isTextLike(name: string, mimeType: string) {
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : '';
  // Recognize common extensionless project files without guessing that arbitrary
  // binaries or credential dotfiles are text. Existing sensitive-path guards apply.
  const basename = path.basename(name).toLowerCase();
  return mimeType.startsWith('text/') || mimeType === 'application/json' || Boolean(ext && TEXT_EXTENSIONS.has(ext))
    || ['.gitignore', '.gitattributes', '.gitmodules', '.dockerignore', '.editorconfig', '.npmignore', '.prettierignore', 'makefile', 'dockerfile', 'readme', 'license'].includes(basename);
}

function downloadUrl(scope: FileBrowserScope, filePath: string, inline: boolean) {
  const base = scope.type === 'gateway' ? '/api/files/gateway/download' : `/api/files/agents/${encodeURIComponent(scope.agentId)}/download`;
  const params = new URLSearchParams({ path: filePath });
  if (inline) params.set('inline', '1');
  return `${base}?${params.toString()}`;
}

async function routeJson(c: Context, fn: () => Promise<unknown>) {
  try {
    return c.json(await fn());
  } catch (error) {
    return errorResponse(c, error);
  }
}

function errorResponse(c: Context, error: unknown) {
  const candidate = (error as { status?: unknown } | null)?.status;
  const status = typeof candidate === 'number' && [400, 403, 404, 408, 409, 413, 415, 429, 503].includes(candidate) ? candidate : 500;
  const messages: Record<number, string> = { 400: 'invalid_file_request', 403: 'file_access_denied',
    404: 'file_not_found', 408: 'file_request_interrupted', 409: 'file_conflict', 413: 'file_size_limit',
    415: 'unsupported_file_type', 429: 'file_capacity_exceeded', 503: 'file_operation_unavailable' };
  return c.json({ error: messages[status] ?? 'file_operation_failed' }, status as 400 | 403 | 404 | 408 | 409 | 413 | 415 | 429 | 500 | 503);
}

function logFileMutation(action: string, scope: FileBrowserScope, _realPath: string, detail: Record<string, unknown> = {}) {
  console.info('[file-browser]', JSON.stringify({ action, scope: scope.type,
    ...(typeof detail.bytes === 'number' ? { bytes: detail.bytes } : {}), at: new Date().toISOString() }));
}

async function readFileBody(request: Request, maxBytes: number, retain: (pending: Promise<unknown>) => void) {
  if (!request.body) throw new HTTPException(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, stopped = false, finished = false;
  let reject!: (error: HTTPException) => void;
  const interrupted = new Promise<never>((_, fail) => { reject = fail; });
  const abort = () => reject(new HTTPException(408));
  const timer = setTimeout(abort, 10_000);
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  try {
    return await Promise.race([interrupted, (async () => {
      while (!stopped) {
        const next = await reader.read();
        if (stopped) throw new HTTPException(408);
        if (next.done) { finished = true; return Buffer.concat(chunks, size); }
        size += next.value.byteLength;
        if (size > maxBytes) throw new HTTPException(413);
        chunks.push(next.value);
      }
      throw new HTTPException(408);
    })()]);
  } finally {
    stopped = true; clearTimeout(timer); request.signal.removeEventListener('abort', abort);
    if (!finished) retain(reader.cancel());
    reader.releaseLock();
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
