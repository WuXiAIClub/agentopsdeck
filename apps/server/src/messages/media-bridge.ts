import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ChatMessage, ChatMessageMedia } from '@agentopsdeck/shared';
import { ALLOWED_MEDIA_MIME_TYPES, MAX_MEDIA_BYTES, MAX_MEDIA_ITEMS, inboundMediaDirectory, persistMediaPayloads } from './send-message.js';
import { mediaFileVersion, openBoundedMediaFile } from './private-media-file.js';
import { rawMediaReferencesFromRow } from './normalize.js';
import { mimeTypeFor } from '../utils/mime.js';

export type MediaBridgeConfig = {
  enabled: boolean;
  allowedDirs: string[];
  maxBytes: number;
  inboundDir?: string | undefined;
};

type CachedBridgeMedia = {
  media: ChatMessageMedia;
  filePath: string;
  version: string;
};

export class MediaBridgeCache {
  private readonly entries = new Map<string, { value: CachedBridgeMedia; expires: number }>();
  constructor(private readonly maxEntries = 256, private readonly ttlMs = 5 * 60 * 1000,
    private readonly now: () => number = Date.now) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('Invalid media cache bounds');
    }
  }
  get size() { this.expire(); return this.entries.size; }
  private expire() {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
  }
  get(key: string) {
    this.expire();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: CachedBridgeMedia) {
    this.expire(); this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
  }
  delete(key: string) { this.entries.delete(key); }
  clear() { this.entries.clear(); }
}

const bridgeCache = new MediaBridgeCache();

export async function bridgeRawMediaDirectives(row: unknown, role: ChatMessage['role'], config: MediaBridgeConfig,
  cache: MediaBridgeCache = bridgeCache): Promise<{ media: ChatMessageMedia[]; bridgedReferences: Set<string> }> {
  const bridgedReferences = new Set<string>();
  const media: ChatMessageMedia[] = [];
  if (!config.enabled || (role !== 'assistant' && role !== 'tool')) return { media, bridgedReferences };

  const references = localMediaReferencesFromRow(row).slice(0, MAX_MEDIA_ITEMS);
  if (references.length === 0) return { media, bridgedReferences };

  const allowedDirs = await realAllowedDirs(config.allowedDirs);
  if (allowedDirs.length === 0) return { media, bridgedReferences };

  for (const reference of references) {
    const bridged = await tryBridgeLocalMedia(reference.path, allowedDirs, config, cache).catch(() => undefined);
    if (!bridged) continue;
    media.push(bridged.media);
    bridgedReferences.add(reference.raw.trim());
    bridgedReferences.add(reference.path);
  }
  return { media, bridgedReferences };
}

async function tryBridgeLocalMedia(reference: string, allowedDirs: string[], config: MediaBridgeConfig, cache: MediaBridgeCache) {
  const filePath = reference.trim();
  if (!path.isAbsolute(filePath)) return undefined;
  const name = path.basename(filePath);
  const mimeType = mimeTypeFor(name);
  if (!ALLOWED_MEDIA_MIME_TYPES.has(mimeType)) return undefined;
  const source = await openBoundedMediaFile(filePath, allowedDirs, Math.min(config.maxBytes, MAX_MEDIA_BYTES));
  try {
    const inboundDir = path.resolve(config.inboundDir ?? inboundMediaDirectory());
    const cacheKey = `${inboundDir}\u0000${source.filePath}\u0000${mediaFileVersion(source.info)}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      const artifact = await openBoundedMediaFile(cached.filePath, [inboundDir], MAX_MEDIA_BYTES).catch(() => undefined);
      if (artifact) {
        try {
          const valid = await artifact.verify().then(() => true, () => false);
          if (valid && mediaFileVersion(artifact.info) === cached.version && (artifact.info.mode & 0o777n) === 0o600n) {
            await source.verify();
            return cached;
          }
        } finally { await artifact.close(); }
      }
      cache.delete(cacheKey);
    }
    const content = await source.read();
    const [published] = await persistMediaPayloads([{ name, mimeType, contentBase64: content.toString('base64') }], { inboundDir });
    if (!published) return undefined;
    const artifact = await openBoundedMediaFile(published.filePath, [inboundDir], MAX_MEDIA_BYTES);
    try {
      const bridged = { media: published.media, filePath: published.filePath, version: mediaFileVersion(artifact.info) };
      cache.set(cacheKey, bridged);
      return bridged;
    } finally { await artifact.close(); }
  } finally { await source.close(); }
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

function stripTrailingSeparator(value: string) {
  return path.resolve(value);
}

type LocalMediaReference = { raw: string; path: string };

function localMediaReferencesFromRow(row: unknown): LocalMediaReference[] {
  const raw = typeof row === 'object' && row !== null ? row as Record<string, any> : {};
  const values = [
    ...rawMediaReferencesFromRow(row),
    ...asArray(raw.MediaPath),
    ...asArray(raw.MediaPaths),
    ...asArray(raw.mediaPaths),
    ...asArray(raw.attachments).flatMap(attachmentReferences),
    ...asArray(raw.media).flatMap(attachmentReferences),
    ...asArray(raw.message?.media).flatMap(attachmentReferences),
    ...asArray(raw.content).flatMap(attachmentReferences),
  ];
  const seen = new Set<string>();
  const result: LocalMediaReference[] = [];
  for (const value of values) {
    const rawReference = typeof value === 'string' ? value : undefined;
    if (!rawReference) continue;
    const localPath = normalizeLocalPathReference(rawReference);
    if (!localPath || seen.has(localPath)) continue;
    seen.add(localPath);
    result.push({ raw: rawReference, path: localPath });
  }
  return result;
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

function normalizeLocalPathReference(reference: string) {
  const unquoted = reference.trim().replace(/^[`"']+|[`"']+$/g, '');
  if (!unquoted) return undefined;
  if (/^https?:\/\//i.test(unquoted)) return undefined;
  if (unquoted.startsWith('/api/media/inbound/')) return undefined;
  let filePath = unquoted;
  if (/^file:\/\//i.test(filePath)) {
    try {
      filePath = fileURLToPath(filePath);
    } catch {
      return undefined;
    }
  }
  return path.isAbsolute(filePath) ? filePath : undefined;
}
