import { MAX_MESSAGE_CHARS, type SendMessageRequest } from '@agentopsdeck/shared';

/** Inline native input only, never an eager history/queue representation.
 * No caller paths, remote URLs, HTML, archives or arbitrary file-tool grants. */
export type SdkInputAttachment = { name: string; mimeType: string; data: string };
export const SDK_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const SDK_ATTACHMENTS_MAX_BYTES = 20 * 1024 * 1024;
export const SDK_ATTACHMENT_MAX_ITEMS = 8;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const textTypes = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/yaml', 'application/xml']);
const invalid = () => new Error('Unsupported or invalid SDK attachment');

export function validateSdkAttachments(value: unknown): asserts value is SdkInputAttachment[] {
  if (!Array.isArray(value) || value.length > SDK_ATTACHMENT_MAX_ITEMS) throw invalid();
  let total = 0, textChars = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['name', 'mimeType', 'data'].includes(key))
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(item.name)
      || typeof item.mimeType !== 'string' || !imageTypes.has(item.mimeType) && !textTypes.has(item.mimeType)
      || typeof item.data !== 'string' || !item.data.length || item.data.length > Math.ceil(SDK_ATTACHMENT_MAX_BYTES / 3) * 4
      || item.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(item.data)) throw invalid();
    const bytes = Buffer.from(item.data, 'base64');
    if (!bytes.length || bytes.length > SDK_ATTACHMENT_MAX_BYTES || bytes.toString('base64') !== item.data
      || (total += bytes.length) > SDK_ATTACHMENTS_MAX_BYTES) throw invalid();
    if (textTypes.has(item.mimeType)) {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid(); }
      if (text.includes('\0') || (textChars += text.length) > MAX_MESSAGE_CHARS) throw invalid();
    } else if (!imageSignature(bytes, item.mimeType)) throw invalid();
  }
}

function imageSignature(bytes: Buffer, type: string) {
  if (type === 'image/png') return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (type === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === 'image/gif') return bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
  return bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

export function prepareSdkAttachments(items: NonNullable<SendMessageRequest['media']>): SdkInputAttachment[] {
  const result = items.map(item => {
    const parsed = /^data:([^;,]+);base64,(.+)$/.exec(item.dataUrl);
    if (!parsed || item.mimeType !== undefined && item.mimeType !== parsed[1]) throw invalid();
    const result = { name: item.name ?? 'attachment', mimeType: parsed[1]!, data: parsed[2]! };
    if (item.size !== undefined && item.size !== Buffer.byteLength(result.data, 'base64')) throw invalid();
    return result;
  });
  validateSdkAttachments(result); return result;
}

function textContent(item: SdkInputAttachment) {
  return `Attachment: ${item.name}\n${Buffer.from(item.data, 'base64').toString('utf8')}`;
}

export function claudeAttachmentPrompt(text: string, attachments: SdkInputAttachment[] = [], context?: string) {
  validateSdkAttachments(attachments);
  if (!attachments.length && !context) return text;
  return [{ type: 'text', text: text || 'Please review the attached files.' }, ...(context ? [{ type: 'text', text: context }] : []), ...attachments.map(item => imageTypes.has(item.mimeType)
    ? { type: 'image', source: { type: 'base64', media_type: item.mimeType, data: item.data } }
    : { type: 'text', text: textContent(item) })];
}

export function copilotAttachmentPrompt(text: string, attachments: SdkInputAttachment[] = [], context?: string) {
  validateSdkAttachments(attachments);
  if (!attachments.length && !context) return text;
  const images = attachments.filter(item => imageTypes.has(item.mimeType));
  return { prompt: [text || 'Please review the attached files.', ...(context ? [context] : []), ...attachments.filter(item => textTypes.has(item.mimeType)).map(textContent)].join('\n\n'),
    ...(images.length ? { attachments: images.map(item => ({ type: 'blob' as const, data: item.data, mimeType: item.mimeType, displayName: item.name })) } : {}) };
}

/** Normalize only a correlated, verified native input echo. Attachment bodies
 * remain native input, not projected chat text. Never fabricate an ACK. */
export function normalizeClaudeAttachmentEcho(event: unknown, execution: { id: string; nativeSessionId: string }, text: string, attachments: SdkInputAttachment[], context?: string) {
  const value = event as { type?: string; uuid?: string; session_id?: string; parent_tool_use_id?: unknown; message?: { content?: unknown } };
  if (!attachments.length && !context || value?.type !== 'user' || value.parent_tool_use_id != null) return event;
  // Tool results and native interruption notices also use role=user, with
  // their own UUID. Leave them to normal projection/lifecycle validation;
  // they must never become an acknowledgement of our attachment admission.
  if (value.uuid !== execution.id) return event;
  if (value.session_id !== execution.nativeSessionId) throw invalid();
  const content = value.message?.content;
  if (!Array.isArray(content)) throw invalid();
  const expected = claudeAttachmentPrompt(text, attachments, context) as Array<{ type: string; text?: string }>;
  if (JSON.stringify(content.filter(row => row.type === 'text').map(row => row.text)) !==
      JSON.stringify(expected.filter(row => row.type === 'text').map(row => row.text))) throw invalid();
  return { ...value, message: { ...value.message, content: text } };
}

export function normalizeCopilotAttachmentEcho(event: unknown, text: string, attachments: SdkInputAttachment[], context?: string) {
  const value = event as { type?: string; agentId?: unknown; data?: { parentToolCallId?: unknown; content?: unknown } };
  if (!attachments.length && !context || value?.type !== 'user.message' || value.agentId !== undefined || value.data?.parentToolCallId !== undefined) return event;
  const input = copilotAttachmentPrompt(text, attachments, context);
  if (typeof input === 'string' || value.data?.content !== input.prompt) throw invalid();
  return { ...value, data: { ...value.data, content: text } };
}
