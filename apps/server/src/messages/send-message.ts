import { agentOpsDeckDataDirectory } from '../config.js';
import { openPrivateMediaDirectory } from './private-media-file.js';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { ChatMessageMedia, SendMessageRequest } from '@agentopsdeck/shared';
import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';

export type NormalizedSendMessageRequest = {
  expectedRunId?: string;
  message: string;
  deliveryMode: 'web-only' | 'mirror';
  media: NonNullable<SendMessageRequest['media']>;
};

export const MAX_MEDIA_ITEMS = 8;
export const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
export const MAX_TOTAL_MEDIA_BYTES = 24 * 1024 * 1024;
export const ALLOWED_MEDIA_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/yaml',
  'application/xml',
  'application/json',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-tar',
]);

// Runtime validation mirrors frontend constraints; never forward malformed browser payloads to Gateway.
export function normalizeSendMessageRequest(value: unknown): NormalizedSendMessageRequest | { error: string } {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const rawMessage = record.message;
  if (rawMessage !== undefined && typeof rawMessage !== 'string') return { error: 'message must be a string' };
  const message = (rawMessage ?? '').trim();
  if (message.length > MAX_MESSAGE_CHARS) return { error: `message is too long; max ${MAX_MESSAGE_CHARS} characters` };
  const expectedRunId = record.expectedRunId;
  if (expectedRunId !== undefined && (message !== '/stop' || typeof expectedRunId !== 'string'
    || !expectedRunId.length || expectedRunId.length > 256 || /[\x00-\x1f\x7f]/.test(expectedRunId))) return { error: 'expectedRunId must identify the run targeted by /stop' };

  const rawDeliveryMode = record.deliveryMode;
  if (rawDeliveryMode !== undefined && rawDeliveryMode !== 'web-only' && rawDeliveryMode !== 'mirror') return { error: 'deliveryMode must be web-only or mirror' };
  const deliveryMode = rawDeliveryMode === 'mirror' ? 'mirror' : 'web-only';

  const rawMedia = record.media;
  if (rawMedia !== undefined && !Array.isArray(rawMedia)) return { error: 'media must be an array' };
  if (Array.isArray(rawMedia) && rawMedia.length > MAX_MEDIA_ITEMS) return { error: `max ${MAX_MEDIA_ITEMS} media items per message` };
  const media = Array.isArray(rawMedia) ? rawMedia : [];
  for (const item of media) {
    if (!item || typeof item !== 'object') return { error: 'media item must be an object' };
    const mediaRecord = item as Record<string, unknown>;
    if (typeof mediaRecord.dataUrl !== 'string') return { error: 'media item dataUrl must be a string' };
    if (mediaRecord.name !== undefined && typeof mediaRecord.name !== 'string') return { error: 'media item name must be a string' };
    if (mediaRecord.mimeType !== undefined && typeof mediaRecord.mimeType !== 'string') return { error: 'media item mimeType must be a string' };
    if (mediaRecord.size !== undefined && (typeof mediaRecord.size !== 'number' || !Number.isFinite(mediaRecord.size) || mediaRecord.size < 0)) return { error: 'media item size must be a positive number' };
  }
  if (!message && media.length === 0) return { error: 'message or media is required' };
  return { message, deliveryMode, media: media as NonNullable<SendMessageRequest['media']>, ...(typeof expectedRunId === 'string' ? { expectedRunId } : {}) };
}

export type PersistedUpload = {
  filePath: string;
  media: ChatMessageMedia;
  gatewayAttachment: {
    fileName: string;
    mimeType: string;
    content: string;
  };
};

export type PersistMediaPayload = {
  name?: string;
  mimeType?: string;
  contentBase64: string;
};

export async function persistUploadedMedia(items: SendMessageRequest['media'] = [], options: { inboundDir?: string | undefined; check?: () => Promise<void> } = {}): Promise<PersistedUpload[]> {
  if (items.length > MAX_MEDIA_ITEMS) throw new Error('too many media items');
  return persistMediaPayloads(items.map((item) => {
    const parsed = item.dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (!parsed) throw new Error(`invalid media dataUrl: ${item.name}`);
    const parsedMimeType = parsed[1];
    const contentBase64 = parsed[2];
    if (!contentBase64) throw new Error(`empty media payload: ${item.name}`);
    return {
      name: item.name,
      mimeType: item.mimeType || parsedMimeType || 'application/octet-stream',
      contentBase64,
    };
  }), options);
}

export function inboundMediaDirectory() {
  return path.join(agentOpsDeckDataDirectory(process.env), 'media', 'inbound');
}

export function inboundMediaReadDirectory(_name: string) {
  return inboundMediaDirectory();
}

export async function persistMediaPayloads(items: PersistMediaPayload[] = [], options: {
  inboundDir?: string | undefined; check?: () => Promise<void>;
} = {}): Promise<PersistedUpload[]> {
  const result: PersistedUpload[] = [];
  if (items.length === 0) return result;
  if (items.length > MAX_MEDIA_ITEMS) throw new Error('too many media items');
  let totalBytes = 0;
  const mediaDir = options.inboundDir ? path.resolve(options.inboundDir) : inboundMediaDirectory();
  const prepared = items.map(item => {
    const mimeType = item.mimeType || 'application/octet-stream';
    if (!ALLOWED_MEDIA_MIME_TYPES.has(mimeType)) throw new Error(`unsupported media type: ${mimeType}`);
    const base64 = normalizeBase64(item.contentBase64, item.name);
    const size = Buffer.byteLength(base64, 'base64');
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_MEDIA_BYTES) throw new Error('media payload is too large');
    const safeName = sanitizeUploadName(item.name || `upload.${extensionForMime(mimeType)}`);
    if (Buffer.byteLength(safeName) > 200) throw new Error('media name is too long');
    return { mimeType, base64, size, safeName };
  });
  await options.check?.();
  const directory = await openPrivateMediaDirectory(mediaDir);
  try {
    for (const { mimeType, base64, size, safeName } of prepared) {
      const filename = `agentopsdeck-${Date.now()}-${nanoid(8)}-${safeName}`;
      await options.check?.();
      const filePath = await directory.write(filename, Buffer.from(base64, 'base64'));
      result.push({
        filePath,
        media: {
          type: mimeType.startsWith('image/') ? 'image' : 'file',
          url: `/api/media/inbound/${encodeURIComponent(filename)}`,
          name: safeName,
          mimeType,
          size,
        },
        gatewayAttachment: {
          fileName: safeName,
          mimeType,
          content: base64,
        },
      });
    }
  } finally { await directory.close(); }
  return result;
}

export function gatewayAttachmentsForMedia(media: PersistedUpload[]) {
  return media.map((item) => item.gatewayAttachment);
}

function normalizeBase64(value: string, name?: string) {
  const base64 = value.trim();
  if (!base64) throw new Error(`empty media payload: ${name}`);
  if (base64.length % 4 !== 0) throw new Error(`invalid media base64: ${name}`);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  for (let index = 0; index < base64.length; index += 1) {
    const code = base64.charCodeAt(index);
    const isBase64Char =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    const isPadding = code === 61;
    if (!isBase64Char && !isPadding) throw new Error(`invalid media base64: ${name}`);
    if (isPadding && index < base64.length - padding) throw new Error(`invalid media base64: ${name}`);
  }
  const decodedBytes = (base64.length / 4) * 3 - padding;
  if (Number.isNaN(decodedBytes) || decodedBytes < 0) throw new Error(`invalid media base64: ${name}`);
  if (decodedBytes > MAX_MEDIA_BYTES) throw new Error(`media too large: ${name}`);
  return base64;
}

function sanitizeUploadName(name: string) {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return base || `upload.${extensionForMime('application/octet-stream')}`;
}

function extensionForMime(mimeType: string) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/gif') return 'gif';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'video/mp4') return 'mp4';
  if (mimeType === 'audio/mpeg') return 'mp3';
  if (mimeType === 'audio/mp4') return 'm4a';
  if (mimeType === 'audio/wav') return 'wav';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'text/plain') return 'txt';
  if (mimeType === 'text/markdown') return 'md';
  if (mimeType === 'text/csv') return 'csv';
  if (mimeType === 'application/json') return 'json';
  if (mimeType === 'application/yaml') return 'yaml';
  if (mimeType === 'application/xml') return 'xml';
  if (mimeType === 'application/msword') return 'doc';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (mimeType === 'application/vnd.ms-excel') return 'xls';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (mimeType === 'application/vnd.ms-powerpoint') return 'ppt';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  if (mimeType === 'application/zip' || mimeType === 'application/x-zip-compressed') return 'zip';
  if (mimeType === 'application/gzip') return 'gz';
  if (mimeType === 'application/x-tar') return 'tar';
  return 'bin';
}
