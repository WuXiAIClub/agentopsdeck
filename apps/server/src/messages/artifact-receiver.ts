import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export { fileResponse as artifactResponse } from '../utils/file-response.js';
import type { ChatMessage, ChatMessageMedia } from '@agentopsdeck/shared';
import { mimeTypeFor } from '../utils/mime.js';

export type ArtifactReceiverConfig = {
  enabled: boolean;
  allowedDirs: string[];
  allowedDirectChildDirs?: string[];
  directChildAllowedExtensions?: string[];
  maxBytes: number;
  indexFile: string;
  injectCapability: boolean;
  allowGatewayClient: boolean;
  urlWrappedOrigins?: string[];
};

export type ArtifactRecord = {
  id: string;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  mtimeMs: number;
  createdAt: number;
};

type ArtifactIndexFile = {
  artifacts?: ArtifactRecord[];
};

type ArtifactPathPolicy = {
  recursiveDirs: string[];
  directChildDirs: string[];
  directChildExtensions: Set<string>;
};

export interface ArtifactRegistryAccess {
  get(id: string): ArtifactRecord | undefined;
  upsert(record: ArtifactRecord): ArtifactRecord | Promise<ArtifactRecord>;
  reload(): void | Promise<void>;
}

export class ArtifactRegistry implements ArtifactRegistryAccess {
  private records = new Map<string, ArtifactRecord>();

  constructor(private readonly file: string) {
    this.load();
  }

  upsert(record: ArtifactRecord) {
    this.records.set(record.id, record);
    this.save();
    return record;
  }

  get(id: string) {
    return this.records.get(id);
  }

  reload() {
    this.load();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as ArtifactIndexFile;
      for (const record of parsed.artifacts ?? []) {
        if (!record?.id || !record.path || !record.name) continue;
        this.records.set(record.id, record);
      }
    } catch {
      this.records.clear();
    }
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const artifacts = [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 2_000);
    writeFileSync(this.file, `${JSON.stringify({ artifacts }, null, 2)}\n`, { mode: 0o600 });
  }
}

export async function bridgeArtifactReferences(row: unknown, role: ChatMessage['role'], config: ArtifactReceiverConfig, registry: ArtifactRegistryAccess): Promise<{ media: ChatMessageMedia[]; bridgedReferences: Set<string> }> {
  const bridgedReferences = new Set<string>();
  const media: ChatMessageMedia[] = [];
  if (!config.enabled || !isArtifactTrustedRow(row, role, config)) return { media, bridgedReferences };

  const references = artifactReferencesFromRow(row, config.urlWrappedOrigins ?? []).slice(0, 24);
  if (references.length === 0) return { media, bridgedReferences };

  const policy = await realArtifactPathPolicy(config);
  if (policy.recursiveDirs.length === 0 && policy.directChildDirs.length === 0) return { media, bridgedReferences };

  const seenIds = new Set<string>();
  for (const reference of references) {
    const record = await tryRegisterArtifact(reference.path, policy, config.maxBytes, registry).catch(() => undefined);
    if (!record || seenIds.has(record.id)) continue;
    seenIds.add(record.id);
    media.push({
      type: record.mimeType.startsWith('image/') ? 'image' : 'file',
      url: `/api/artifacts/${encodeURIComponent(record.id)}`,
      name: record.name,
      mimeType: record.mimeType,
      size: record.size,
    });
    bridgedReferences.add(reference.raw.trim());
    bridgedReferences.add(reference.path);
  }

  return { media, bridgedReferences };
}

export async function openArtifactDownload(id: string, config: ArtifactReceiverConfig, registry: ArtifactRegistryAccess) {
  if (!/^[a-f0-9]{24,64}$/i.test(id)) return undefined;
  let record = registry.get(id);
  if (!record) {
    await registry.reload();
    record = registry.get(id);
  }
  if (!record) return undefined;
  const policy = await realArtifactPathPolicy(config);
  const resolved = await realpath(record.path).catch(() => undefined);
  if (!resolved || !isAllowedArtifactPath(resolved, policy)) return undefined;
  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isFile() || info.size <= 0 || info.size > config.maxBytes) return undefined;
  if (info.size !== record.size || Math.trunc(info.mtimeMs) !== Math.trunc(record.mtimeMs)) return undefined;
  return { record, path: resolved, info };
}

function isArtifactTrustedRow(row: unknown, role: ChatMessage['role'], config: ArtifactReceiverConfig) {
  if (role === 'assistant' || role === 'tool') return true;
  if (!config.allowGatewayClient) return false;
  return isGatewayClientSender(row);
}

function isGatewayClientSender(row: unknown) {
  if (!row || typeof row !== 'object') return false;
  const record = row as Record<string, any>;
  const candidates = [
    record.sender,
    record.from,
    record.client,
    record.source,
    record.author,
    record.metadata?.sender,
    record.payload?.sender,
    record.message?.sender,
  ];
  return candidates.some((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const id = typeof candidate.id === 'string' ? candidate.id : undefined;
    const label = typeof candidate.label === 'string' ? candidate.label : undefined;
    return id === 'gateway-client' || label === 'gateway-client';
  });
}

export function artifactCapabilityPreamble(maxBytes: number) {
  const maxMb = Math.max(1, Math.floor(maxBytes / (1024 * 1024)));
  return [
    '<agentopsdeck_client_capability>',
    'AgentOpsDeck supports local artifact download cards for files generated in this session.',
    'When you create files for the user:',
    '- Do not inline/base64 large file contents.',
    '- For files larger than 10MB, do not use MEDIA:, mediaUrl, mediaUrls, path, or filePath as attachment metadata.',
    '- Prefer writing the absolute local file path in plain text, e.g. File ready: /absolute/path/to/output.zip',
    `- AgentOpsDeck will detect safe local paths up to ${maxMb}MB and render download cards.`,
    '</agentopsdeck_client_capability>',
  ].join('\n');
}

export function withArtifactCapability(message: string, enabled: boolean, maxBytes: number) {
  if (!enabled) return message;
  return `${artifactCapabilityPreamble(maxBytes)}\n\n${message}`;
}

async function tryRegisterArtifact(reference: string, policy: ArtifactPathPolicy, maxBytes: number, registry: ArtifactRegistryAccess) {
  const filePath = normalizeLocalPathReference(reference);
  if (!filePath || !path.isAbsolute(filePath)) return undefined;
  const resolvedFile = await realpath(filePath);
  if (!isAllowedArtifactPath(resolvedFile, policy)) return undefined;
  const info = await stat(resolvedFile);
  if (!info.isFile()) return undefined;
  if (info.size <= 0 || info.size > maxBytes) return undefined;
  const name = path.basename(resolvedFile).replace(/[\r\n]/g, '') || 'artifact';
  const mimeType = mimeTypeFor(name);
  const id = createHash('sha256').update(`${resolvedFile}\0${info.size}\0${Math.trunc(info.mtimeMs)}`).digest('hex').slice(0, 32);
  return registry.upsert({ id, path: resolvedFile, name, mimeType, size: info.size, mtimeMs: info.mtimeMs, createdAt: Date.now() });
}

async function realAllowedDirs(dirs: string[]) {
  const result: string[] = [];
  for (const dir of dirs) {
    if (!dir.trim()) continue;
    const resolved = await realpath(dir).catch(() => undefined);
    if (resolved) result.push(stripTrailingSeparator(resolved));
  }
  return [...new Set(result)];
}

async function realArtifactPathPolicy(config: ArtifactReceiverConfig): Promise<ArtifactPathPolicy> {
  return {
    recursiveDirs: await realAllowedDirs(config.allowedDirs),
    directChildDirs: await realAllowedDirs(config.allowedDirectChildDirs ?? []),
    directChildExtensions: normalizeExtensions(config.directChildAllowedExtensions ?? []),
  };
}

function isAllowedArtifactPath(filePath: string, policy: ArtifactPathPolicy) {
  if (isUnderAllowedDir(filePath, policy.recursiveDirs)) return true;
  return isDirectChildArtifact(filePath, policy.directChildDirs, policy.directChildExtensions);
}

function isUnderAllowedDir(filePath: string, allowedDirs: string[]) {
  const normalizedFile = stripTrailingSeparator(filePath);
  return allowedDirs.some((dir) => normalizedFile === dir || normalizedFile.startsWith(`${dir}${path.sep}`));
}

function isDirectChildArtifact(filePath: string, allowedDirectChildDirs: string[], allowedExtensions: Set<string>) {
  if (allowedExtensions.size === 0) return false;
  const normalizedFile = stripTrailingSeparator(filePath);
  const extension = path.extname(normalizedFile).toLowerCase();
  if (!allowedExtensions.has(extension)) return false;
  const parent = stripTrailingSeparator(path.dirname(normalizedFile));
  return allowedDirectChildDirs.some((dir) => parent === dir);
}

function normalizeExtensions(extensions: string[]) {
  const result = new Set<string>();
  for (const extension of extensions) {
    const trimmed = extension.trim().toLowerCase();
    if (!trimmed) continue;
    result.add(trimmed.startsWith('.') ? trimmed : `.${trimmed}`);
  }
  return result;
}

function stripTrailingSeparator(value: string) {
  return value.replace(/[\\/]+$/, '');
}

type ArtifactReference = { raw: string; path: string };

function artifactReferencesFromRow(row: unknown, urlWrappedOrigins: string[]): ArtifactReference[] {
  const values = [
    ...structuredReferencesFromRow(row),
    ...textReferencesFromRow(row),
  ];
  const normalizedUrlWrappedOrigins = normalizeUrlWrappedOrigins(urlWrappedOrigins);
  const seen = new Set<string>();
  const result: ArtifactReference[] = [];
  for (const value of values) {
    const raw = value.raw.trim();
    const normalized = normalizeLocalPathReference(value.path, normalizedUrlWrappedOrigins);
    if (!raw || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ raw, path: normalized });
  }
  return result;
}

function structuredReferencesFromRow(row: unknown): ArtifactReference[] {
  const raw = typeof row === 'object' && row !== null ? row as Record<string, any> : {};
  const candidates = [
    raw.MediaPath,
    ...asArray(raw.MediaPaths),
    ...asArray(raw.mediaPaths),
    ...asArray(raw.attachments).flatMap(attachmentReferences),
    ...asArray(raw.media).flatMap(attachmentReferences),
    ...asArray(raw.message?.media).flatMap(attachmentReferences),
    ...asArray(raw.content).flatMap(attachmentReferences),
  ];
  return candidates.filter((item): item is string => typeof item === 'string').map((item) => ({ raw: item, path: item }));
}

function textReferencesFromRow(row: unknown): ArtifactReference[] {
  const text = collectText(row);
  if (!text) return [];
  const result: ArtifactReference[] = [];

  for (const match of text.matchAll(/\[\[deck_(?:download|file):([^\]\r\n]+)\]\]/gi)) {
    const raw = match[0];
    const pathPart = String(match[1] ?? '').split('|')[0]?.trim();
    if (pathPart) result.push({ raw, path: pathPart });
  }
  for (const match of text.matchAll(/(?:^|\n)\s*MEDIA:([^\r\n]+)/gi)) {
    const pathPart = match[1]?.trim();
    if (pathPart) result.push({ raw: match[0], path: pathPart });
  }
  for (const match of text.matchAll(/file:\/\/[^\s)'"<>]+/gi)) {
    result.push({ raw: match[0], path: match[0] });
  }
  for (const match of text.matchAll(/sandbox:(?:\/|[A-Za-z]:[\\/])[^\s)'"<>]+/gi)) {
    result.push({ raw: match[0], path: match[0] });
  }
  for (const match of text.matchAll(/https?:\/\/[^\s)'"<>]+/gi)) {
    result.push({ raw: match[0], path: match[0] });
  }
  const localText = text.replace(/(?:https?:\/\/|file:\/\/|sandbox:)[^\s'"<>]+/gi, '');
  // A standalone native path may contain spaces and balanced parentheses.
  // Keep this anchored to a full line; ordinary prose and rejected URLs must
  // not become additional local-file candidates.
  for (const line of localText.split(/\r?\n/)) {
    const raw = line.trim();
    if (/^(?:\/|~\/)[^\r\n<>"|?*]+\.[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(raw)) {
      result.push({ raw, path: raw });
    }
  }
  for (const match of localText.matchAll(/([A-Za-z]:[\\/][^\r\n<>"|?*]*?\.[A-Za-z0-9][A-Za-z0-9._-]{0,15})(?=$|[\s)\]}>.,;:!?])/g)) {
    const raw = trimTrailingPunctuation(match[1] ?? '');
    if (raw) result.push({ raw, path: raw });
  }
  for (const match of localText.matchAll(/(?:^|[\s([{<:：])((?:(?:~|\/)[^\s)'"<>]+|[A-Za-z]:[\\/][^\s)'"<>]+)\.[A-Za-z0-9][A-Za-z0-9._-]{0,15})(?=$|[\s)\]}>.,;:!?。；，、])/g)) {
    const raw = trimTrailingPunctuation(match[1] ?? '');
    if (raw) result.push({ raw, path: raw });
  }
  return result;
}

function collectText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, any>;
  const parts: string[] = [];
  for (const key of ['text', 'content', 'message', 'transcriptText', 'output', 'result']) {
    const item = record[key];
    if (typeof item === 'string') parts.push(item);
    else if (key === 'message' && item && typeof item === 'object') parts.push(collectText(item));
  }
  if (Array.isArray(record.content)) {
    for (const item of record.content) parts.push(collectText(item));
  }
  if (record.payload && typeof record.payload === 'object') parts.push(collectText(record.payload));
  return parts.filter(Boolean).join('\n');
}

function attachmentReferences(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, any>;
  const attachment = record.attachment && typeof record.attachment === 'object' ? record.attachment as Record<string, any> : record;
  return [attachment.path, attachment.filePath, attachment.url, attachment.mediaRef].filter((item): item is string => typeof item === 'string');
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function normalizeLocalPathReference(reference: string, urlWrappedOrigins: Set<string> = new Set()) {
  const unquoted = trimTrailingPunctuation(reference.trim().replace(/^[`"']+|[`"']+$/g, ''));
  if (!unquoted) return undefined;
  let filePath = unquoted;
  if (/^sandbox:(?:\/|[A-Za-z]:[\\/])/i.test(filePath)) filePath = filePath.slice('sandbox:'.length);
  if (/^https?:\/\//i.test(filePath)) {
    filePath = localPathFromUrlWrappedReference(filePath, urlWrappedOrigins) ?? '';
    if (!filePath) return undefined;
  }
  if (/^file:\/\//i.test(filePath)) {
    try {
      filePath = fileURLToPath(filePath);
    } catch {
      return undefined;
    }
  }
  if (filePath.startsWith('~/')) filePath = path.join(process.env.HOME ?? '', filePath.slice(2));
  return path.isAbsolute(filePath) ? filePath : undefined;
}

function normalizeUrlWrappedOrigins(origins: string[]) {
  const result = new Set<string>();
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') result.add(parsed.origin);
    } catch {
      // Ignore malformed optional origins.
    }
  }
  return result;
}

function localPathFromUrlWrappedReference(reference: string, allowedOrigins: Set<string>) {
  if (allowedOrigins.size === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(reference);
  } catch {
    return undefined;
  }
  if (!allowedOrigins.has(parsed.origin)) return undefined;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
  if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
  return path.isAbsolute(pathname) ? pathname : undefined;
}

function trimTrailingPunctuation(value: string) {
  return value.replace(/[),.;:!?]+$/g, '');
}
