import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeSourceFiles, parseSourceReference, sourceReferences, type ChatMessage, type ChatMessageMedia, type SourcePreview, type SourceReference } from '@agentopsdeck/shared';
import { mediaResourceId } from './media-resource.js';

export type ApprovedSourceFile = { root?: string; exactFile?: boolean; file: string; dev: number; ino: number };
export type SourcePreviewConfig = { allowedDirs: string[]; approvalDirs?: string[]; approvedFile?: ApprovedSourceFile };
export type SourceApprovalOptions = { roots: string[]; allowAdminExactFile?: boolean };
export type SourcePreviewFailure = 'outside-roots' | 'missing' | 'unsafe-file' | 'too-large' | 'changed' | 'unsupported-text' | 'line-missing';
const MAX_BYTES = 1024 * 1024;
const SENSITIVE_SYSTEM_ROOTS = new Set(['etc', 'proc', 'sys', 'dev', 'boot', 'run']);
const SENSITIVE_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.gcloud', '.kube', '.docker', '.git', '.hg', '.svn', '.npm', '.cargo', '.pypirc', '.password-store', 'node_modules', 'vendor']);
const SENSITIVE_EXACT_NAMES = new Set(['.env', '.netrc', '.npmrc', '.pypirc', '.git-credentials', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'authorized_keys', 'known_hosts', 'start.mjs']);
const SENSITIVE_NAME_RE = /(?:^|[._-])(?:credential|credentials|secret|secrets|token|tokens|api[_-]?key|private[_-]?key|access[_-]?key|password|passwd|passkey|passkeys|auth[_-]?session|vault)(?:[._-]|$)/i;
const SENSITIVE_EXT_RE = /\.(?:pem|key|p12|pfx|kdbx|jks|keystore|der|crt|csr|ovpn|sqlite|sqlite3|db)$/i;

export function sourceReferenceMedia(message: ChatMessage): ChatMessageMedia[] {
  const references = message.role === 'assistant' ? sourceReferences(message.text)
    : message.role === 'tool' && message.toolPhase === 'result' && message.status === 'sent'
      ? normalizeSourceFiles(message.sourceFiles).filter(file => file.kind !== 'deleted').map(file => parseSourceReference(file.path)!) : [];
  return references.map(reference => ({ type: 'file', name: reference.path.split(/[\\/]/).at(-1)!,
    url: `/api/source-previews/${mediaResourceId(reference.href)}`, mimeType: 'application/json', sourceReference: reference }));
}

function inside(root: string, file: string) {
  const relative = path.relative(root, file);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function safeParts(root: string, file: string) {
  return path.relative(root, file).split(path.sep).every(part => part && !part.startsWith('.') && !['node_modules', 'vendor'].includes(part));
}
export function isSensitiveSourcePath(filePath: string) {
  const resolved = path.resolve(filePath);
  const parts = resolved.split(/[\\/]/).filter(Boolean).map(part => part.toLowerCase());
  if (!parts.length) return true;
  if (resolved.startsWith('/') && (SENSITIVE_SYSTEM_ROOTS.has(parts[0]!)
    || parts[0] === 'var' && parts[1] !== undefined && ['run', 'lib', 'log', 'backups', 'spool', 'mail'].includes(parts[1]))) return true;
  const base = parts.at(-1)!;
  if (base.startsWith('.env.') || SENSITIVE_EXACT_NAMES.has(base) || SENSITIVE_EXT_RE.test(base) || SENSITIVE_NAME_RE.test(base)) return true;
  return parts.some(part => SENSITIVE_SEGMENTS.has(part));
}
/** Approval never expands the Connector's operator-defined project boundary. */
export async function sourceApprovalRoot(reference: SourceReference, roots: string[], authorize: () => void | Promise<void>) {
  await authorize();
  if (!path.isAbsolute(reference.path) || !parseSourceReference(reference.path)) return undefined;
  for (const configured of roots) {
    const lexical = path.resolve(configured);
    if (!path.isAbsolute(configured) || lexical === path.parse(lexical).root || !inside(lexical, reference.path) || !safeParts(lexical, reference.path)) continue;
    const root = await realpath(configured).catch(() => undefined), file = await realpath(reference.path).catch(() => undefined);
    await authorize();
    if (!root || !file || !inside(root, file) || !safeParts(root, file) || !parseSourceReference(file)) continue;
    const info = await stat(file).catch(() => undefined); await authorize();
    if (info?.isFile() && info.nlink === 1 && info.size <= MAX_BYTES) return { root: configured, file, dev: info.dev, ino: info.ino };
  }
  return undefined;
}
/** Explicit Connector-admin exact-file approval when outside configured roots.
 * Rejects symlinks, hardlinks, sensitive paths/names, and non-source extensions. */
export async function sourceApprovalTarget(reference: SourceReference, options: SourceApprovalOptions, authorize: () => void | Promise<void>): Promise<ApprovedSourceFile | undefined> {
  const rooted = await sourceApprovalRoot(reference, options.roots, authorize);
  if (rooted) return rooted;
  if (!options.allowAdminExactFile) return undefined;
  await authorize();
  if (!path.isAbsolute(reference.path) || !parseSourceReference(reference.path) || isSensitiveSourcePath(reference.path)) return undefined;
  const lexical = path.resolve(reference.path);
  const file = await realpath(reference.path).catch(() => undefined);
  await authorize();
  if (!file || file !== lexical || !parseSourceReference(file) || isSensitiveSourcePath(file)) return undefined;
  const info = await stat(file).catch(() => undefined);
  await authorize();
  if (info?.isFile() && info.nlink === 1 && info.size <= MAX_BYTES) return { exactFile: true, file, dev: info.dev, ino: info.ino };
  return undefined;
}

async function readVerifiedRegularFile(reference: SourceReference, file: string, config: SourcePreviewConfig,
  verifyCurrentLocation: (current: string) => boolean | Promise<boolean>,
  authorize: () => void | Promise<void>, failure: (reason: SourcePreviewFailure) => void): Promise<SourcePreview | undefined> {
  const before = await stat(file);
  await authorize();
  if (config.approvedFile && (file !== config.approvedFile.file || before.dev !== config.approvedFile.dev || before.ino !== config.approvedFile.ino)) { failure('changed'); return undefined; }
  if (!before.isFile() || before.nlink !== 1) { failure('unsafe-file'); return undefined; }
  if (before.size > MAX_BYTES) { failure('too-large'); return undefined; }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    await authorize();
    if (!opened.isFile() || opened.size > MAX_BYTES || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) { failure('changed'); return undefined; }
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      await authorize();
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat(), current = await realpath(reference.path);
    await authorize();
    const locationOk = await verifyCurrentLocation(current);
    if (length > MAX_BYTES || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || current !== file || !locationOk) { failure('changed'); return undefined; }
    const content = bytes.subarray(0, length);
    if (content.includes(0)) { failure('unsupported-text'); return undefined; }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); } catch { failure('unsupported-text'); return undefined; }
    const lines = text.split(/\r?\n/);
    if (reference.line > lines.length) { failure('line-missing'); return undefined; }
    // Markdown needs its document structure (fences, tables, link definitions).
    // Return the complete document within the existing response budget; larger
    // files remain explicitly labeled excerpts, not misleading full previews.
    const fullMarkdown = /\.(md|markdown)$/i.test(file) && length <= 96 * 1024;
    const startLine = fullMarkdown ? 1 : Math.max(1, reference.line - 12);
    const end = fullMarkdown ? lines.length : Math.min(lines.length, reference.line + 32);
    text = lines.slice(startLine - 1, end).join('\n');
    if (Buffer.byteLength(text) > 96 * 1024) { failure('too-large'); return undefined; }
    await authorize();
    return { path: reference.path, line: reference.line, startLine, totalLines: lines.length, text, modifiedAt: after.mtimeMs };
  } finally { await handle.close(); }
}

/** Opt-in project roots or pinned exact-file admin grant. Current on-disk text, never a historical snapshot. */
export async function readSourcePreview(reference: SourceReference, config: SourcePreviewConfig, authorize: () => void | Promise<void>, failure: (reason: SourcePreviewFailure) => void = () => {}): Promise<SourcePreview | undefined> {
  await authorize();
  if (!path.isAbsolute(reference.path)) { failure('unsafe-file'); return undefined; }
  if (config.approvedFile?.exactFile) {
    if (!parseSourceReference(reference.path) || isSensitiveSourcePath(reference.path)) { failure('unsafe-file'); return undefined; }
    const lexical = path.resolve(reference.path);
    const file = await realpath(reference.path).catch(() => undefined);
    await authorize();
    if (!file) { failure('missing'); return undefined; }
    if (file !== lexical || !parseSourceReference(file) || isSensitiveSourcePath(file)) { failure('unsafe-file'); return undefined; }
    return readVerifiedRegularFile(reference, file, config, current => current === lexical && !isSensitiveSourcePath(current), authorize, failure);
  }
  let matched = false;
  for (const configured of config.allowedDirs) {
    if (!path.isAbsolute(configured) || path.resolve(configured) === path.parse(configured).root
      || !inside(path.resolve(configured), reference.path) || !safeParts(path.resolve(configured), reference.path)) continue;
    matched = true;
    const root = await realpath(configured).catch(() => undefined);
    const file = await realpath(reference.path).catch(() => undefined);
    await authorize();
    if (!root || !file) { failure('missing'); continue; }
    if (!inside(root, file) || !safeParts(root, file) || !parseSourceReference(file)) { failure('unsafe-file'); continue; }
    // Resolve first, then pin an opened regular file; never follow a swapped final symlink.
    return readVerifiedRegularFile(reference, file, config, async current => {
      const currentRoot = await realpath(configured);
      await authorize();
      return inside(root, current) && currentRoot === root;
    }, authorize, failure);
  }
  if (!matched) failure('outside-roots');
  return undefined;
}
