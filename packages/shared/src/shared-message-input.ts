import { MAX_MESSAGE_CHARS, MAX_TEXT_MESSAGE_BODY_BYTES } from './message-limits.js';
import type { SendMessageUpload } from './index.js';

// Native-compatible inline input. Upload authority is messages:send, not
// media:read or a host-file capability. Bodies never enter recovery journals.
export const SHARED_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const SHARED_ATTACHMENTS_MAX_BYTES = 20 * 1024 * 1024;
export const SHARED_MESSAGE_BODY_BYTES = Math.ceil(SHARED_ATTACHMENTS_MAX_BYTES / 3) * 4 + MAX_TEXT_MESSAGE_BODY_BYTES;
export const SHARED_MESSAGE_FLIGHT_BYTES = 2 * SHARED_MESSAGE_BODY_BYTES;
const images = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const texts = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/yaml', 'application/xml']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('Invalid shared message or attachment');

/** Validate and own the exact payload before any authority await. No paths,
 * remote URLs, inferred MIME/size, controls or unknown fields are admitted. */
export function copySharedMessageInput(value: unknown, runtimeId?: string) {
  if (!record(value) || Object.keys(value).some(key => !['message', 'deliveryMode', 'media'].includes(key))
    || typeof value.message !== 'string' || value.message.length > MAX_MESSAGE_CHARS
    || ['/stop', '/status', '/compact'].includes(value.message.trim())
    || value.deliveryMode !== undefined && !['web-only', 'mirror'].includes(value.deliveryMode as string)
    || value.media !== undefined && !Array.isArray(value.media)) throw invalid();
  const uploads = (value.media ?? []) as unknown[];
  if (uploads.length > 8 || !value.message.trim() && !uploads.length) throw invalid();
  let total = 0, textChars = 0;
  const media: SendMessageUpload[] = uploads.map(item => {
    if (!record(item) || Object.keys(item).some(key => !['type', 'name', 'mimeType', 'size', 'dataUrl'].includes(key))
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(item.name)
      || typeof item.mimeType !== 'string' || !(images.has(item.mimeType) || texts.has(item.mimeType))
      || item.type !== (images.has(item.mimeType) ? 'image' : 'file')
      || runtimeId === 'codex' && item.type !== 'image'
      || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > SHARED_ATTACHMENT_MAX_BYTES
      || typeof item.dataUrl !== 'string') throw invalid();
    const prefix = `data:${item.mimeType};base64,`;
    if (!item.dataUrl.startsWith(prefix)) throw invalid();
    const data = item.dataUrl.slice(prefix.length);
    if (data.length !== Math.ceil(item.size / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
      || (total += item.size) > SHARED_ATTACHMENTS_MAX_BYTES) throw invalid();
    let raw: string;
    try { raw = atob(data); } catch { throw invalid(); }
    if (raw.length !== item.size || btoa(raw) !== data) throw invalid();
    if (texts.has(item.mimeType)) {
      const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid(); }
      if (text.includes('\0') || (textChars += text.length) > MAX_MESSAGE_CHARS) throw invalid();
    } else {
      const valid = item.mimeType === 'image/png' ? raw.length >= 24 && raw.startsWith('\x89PNG\r\n\x1a\n')
        : item.mimeType === 'image/jpeg' ? raw.length >= 4 && raw.startsWith('\xff\xd8\xff')
        : item.mimeType === 'image/gif' ? raw.length >= 13 && ['GIF87a', 'GIF89a'].includes(raw.slice(0, 6))
        : raw.length >= 16 && raw.startsWith('RIFF') && raw.slice(8, 12) === 'WEBP';
      if (!valid) throw invalid();
    }
    return { type: item.type, name: item.name, mimeType: item.mimeType, size: item.size, dataUrl: item.dataUrl } as SendMessageUpload;
  });
  return { message: value.message, deliveryMode: value.deliveryMode === 'mirror' ? 'mirror' as const : 'web-only' as const,
    ...(media.length ? { media } : {}) };
}
