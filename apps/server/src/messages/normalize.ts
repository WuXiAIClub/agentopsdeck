import path from 'node:path';
import type { ChatMessage, ChatMessageMedia } from '@agentopsdeck/shared';
import { mimeTypeFor } from '../utils/mime.js';

export type NormalizeMessageOptions = {
  bridgedRawMediaReferences?: Set<string>;
};

// Display-only dedupe: collapse adjacent Gateway/Feishu replay duplicates without deleting legitimate repeated user messages.
export function dedupeDisplayMessages(messages: ChatMessage[]) {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    const previous = result[result.length - 1];
    if (previous && isLikelyDuplicateMessage(previous, message)) continue;
    result.push(message);
  }
  return result;
}

function isLikelyDuplicateMessage(previous: ChatMessage, current: ChatMessage) {
  if (previous.role === 'tool' || current.role === 'tool') return false;
  if (displayMessageDedupeKey(previous) !== displayMessageDedupeKey(current)) return false;
  const delta = Math.abs((current.createdAt ?? 0) - (previous.createdAt ?? 0));
  return delta <= 5_000;
}

function displayMessageDedupeKey(message: ChatMessage) {
  if (message.role === 'tool') return undefined;
  const text = message.text.trim();
  if (!text) return undefined;
  const mediaKey = (message.media ?? []).map((item) => item.type + ':' + item.url + ':' + item.name).join('|');
  return message.sessionKey + '\u0000' + message.role + '\u0000' + text + '\u0000' + mediaKey;
}


export function normalizeRole(role: unknown): ChatMessage['role'] {
  if (role === 'toolResult' || role === 'toolCall') return 'tool';
  return role === 'user' || role === 'assistant' || role === 'system' || role === 'tool' ? role : 'unknown';
}

export function normalizeMessageText(row: any, options: NormalizeMessageOptions = {}) {
  const value = rowMessageValue(row);
  let text = extractText(value).trim();
  const media = normalizeMessageMedia(row, options);
  if (media.length > 0) {
    text = text.replace(/^.*?:\s*<media:image>\s*$/i, '').trim();
    text = text.replace(/^<media:image>\s*$/i, '').trim();
  }
  text = replaceRawMediaDirectives(text, options, media);
  text = removeBridgedArtifactReferences(text, options);
  text = stripAgentOpsDeckCapabilityBlocks(text);
  text = stripOpenClawDisplayEnvelope(text);
  return collapseRepeatedMessageText(text);
}

function stripAgentOpsDeckCapabilityBlocks(text: string) {
  return text.replace(/<agentopsdeck_client_capability>[\s\S]*?<\/agentopsdeck_client_capability>/gi, '').trim();
}

function stripOpenClawDisplayEnvelope(text: string) {
  let current = text.trim();
  current = current.replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/g, '').trim();
  current = current.replace(/^\[[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(?:UTC|GMT[+-]\d{1,2}|GMT[+-]\d{2}:?\d{2})\]\s*/i, '').trim();
  current = current.replace(/^(?:Conversation info|Sender) \(untrusted metadata\):\s*```(?:json)?\s*[\s\S]*?```\s*/gim, '').trim();
  current = current.replace(/^\[message_id:[^\]\n]+\]\s*/gim, '').trim();
  current = current.replace(/^(?:ou|oc|om|cli|gateway-client|[a-z][\w.-]{1,64})_[\w-]{8,}:\s*/i, '').trim();
  current = current.replace(/^gateway-client:\s*/i, '').trim();
  return current;
}

// Feishu replay bug guard: some payloads arrive as repeated blocks separated by a standalone "U" marker.
function collapseRepeatedMessageText(text: string) {
  const parts = text.split(/\n+U\n+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return text;
  const unique: string[] = [];
  const seen = new Set<string>();
  for (let part of parts) {
    const repeatedPrefix = unique.find((item) => part !== item && part.startsWith(item));
    if (repeatedPrefix) part = part.slice(repeatedPrefix.length).trim();
    if (!part) continue;
    const key = normalizeRepeatedTextKey(part);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(part);
  }
  if (unique.length === parts.length) return text;
  if (unique.length <= Math.max(3, Math.ceil(parts.length / 3))) return unique.join('\n\n');
  return text;
}

function normalizeRepeatedTextKey(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

export function normalizeMessageMedia(row: any, _options: NormalizeMessageOptions = {}): ChatMessageMedia[] {
  const paths = asArray(row?.MediaPaths ?? row?.mediaPaths ?? row?.attachments)
    .map((item) => typeof item === 'string' ? item : (item?.path ?? item?.filePath ?? item?.url))
    .filter((item): item is string => typeof item === 'string');
  const single = typeof row?.MediaPath === 'string' ? [row.MediaPath] : [];
  const structured = structuredMediaItems(row);
  const value = rowMessageValue(row);
  const rawMediaReferences = rawMediaDirectives(extractText(value)).filter(isRenderableRawMediaReference);
  const mimeTypes = asArray(row?.MediaTypes ?? row?.mediaTypes);
  const media: ChatMessageMedia[] = [];
  for (const [index, reference] of [...single, ...paths].entries()) {
    const item = mediaFromReference(reference, typeof mimeTypes[index] === 'string' ? mimeTypes[index] : (typeof row?.MediaType === 'string' ? row.MediaType : undefined), 'structured');
    if (item) media.push(item);
  }
  media.push(...structured);
  for (const reference of rawMediaReferences) {
    const item = mediaFromReference(reference, undefined, 'raw');
    if (item) media.push(item);
  }
  for (const item of attachedMediaItemsFromText(extractText(value))) media.push(item);
  return media.filter((item, index, array) => array.findIndex((candidate) => candidate.url === item.url && candidate.name === item.name) === index);
}


const RAW_MEDIA_DIRECTIVE = /(?:^|\n)\s*MEDIA:([^\r\n]+)/gi;

export function rawMediaReferencesFromRow(row: any) {
  return rawMediaDirectives(extractText(rowMessageValue(row)));
}

function rawMediaDirectives(text: string) {
  const references: string[] = [];
  for (const match of text.matchAll(RAW_MEDIA_DIRECTIVE)) {
    const reference = match[1]?.trim();
    if (reference) references.push(reference);
  }
  return references;
}

function replaceRawMediaDirectives(text: string, options: NormalizeMessageOptions, structuredMedia: ChatMessageMedia[] = []) {
  return text.replace(RAW_MEDIA_DIRECTIVE, (match, reference: string) => {
    const trimmed = reference.trim();
    if (!trimmed) return '';
    if (isRenderableRawMediaReference(trimmed) || options.bridgedRawMediaReferences?.has(trimmed) || matchesStructuredMediaReference(trimmed, structuredMedia)) return match.startsWith('\n') ? '\n' : '';
    const name = basenameFromReference(trimmed);
    return `${match.startsWith('\n') ? '\n' : ''}[media unavailable: local file ${name ? `“${name}” ` : ''}is not available in AgentOpsDeck. Ask the sender to attach or upload the file.]`;
  }).trim();
}

function removeBridgedArtifactReferences(text: string, options: NormalizeMessageOptions) {
  const references = [...(options.bridgedRawMediaReferences ?? [])]
    .map((reference) => reference.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (references.length === 0) return text;
  let next = text;
  for (const reference of references) {
    next = next.replace(new RegExp(escapeRegExp(reference), 'g'), '');
  }
  return next
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function structuredMediaItems(row: any): ChatMessageMedia[] {
  const candidates = [
    ...asArray(row?.media),
    ...asArray(row?.message?.media),
    ...asArray(row?.content).filter((item) => item?.type === 'attachment' || item?.type === 'media' || item?.type === 'image' || item?.type === 'file'),
  ];
  const result: ChatMessageMedia[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, any>;
    const attachment = record.attachment && typeof record.attachment === 'object' ? record.attachment as Record<string, any> : record;
    const reference = stringValue(attachment.url ?? attachment.path ?? attachment.filePath ?? attachment.mediaRef);
    if (!reference) continue;
    const explicitName = stringValue(attachment.name ?? attachment.fileName ?? attachment.filename ?? attachment.label);
    const mimeType = stringValue(attachment.mimeType ?? attachment.contentType ?? attachment.content_type);
    const item = mediaFromReference(reference, mimeType, 'structured');
    if (!item) continue;
    result.push({
      ...item,
      ...(explicitName ? { name: sanitizeDisplayName(explicitName) || item.name } : {}),
      ...(typeof attachment.size === 'number' && Number.isFinite(attachment.size) ? { size: attachment.size } : {}),
    });
  }
  return result;
}

const ATTACHED_MEDIA_LINE = /\[media attached:\s*([^\]\n]+)\]/gi;

function attachedMediaItemsFromText(text: string): ChatMessageMedia[] {
  const result: ChatMessageMedia[] = [];
  for (const match of text.matchAll(ATTACHED_MEDIA_LINE)) {
    const body = match[1]?.trim();
    if (!body) continue;
    const [referencePart, mimeTypePart] = body.split('|', 2).map((part) => part.trim());
    const reference = referencePart?.split(/\s+\(/, 1)[0]?.trim();
    if (!reference) continue;
    const explicitMimeType = mimeTypePart?.match(/^[\w.+-]+\/[\w.+-]+/)?.[0];
    const item = mediaFromAttachedReference(reference, explicitMimeType);
    if (item) result.push(item);
  }
  return result;
}

function mediaFromAttachedReference(reference: string, explicitMimeType: string | undefined) {
  const item = mediaFromReference(reference, explicitMimeType, 'structured');
  if (item) return item;
  const name = basenameFromReference(reference);
  if (!isSafeMediaName(name)) return undefined;
  const mimeType = explicitMimeType ?? mimeTypeFor(name);
  return { type: mimeType.startsWith('image/') ? 'image' : 'file', url: `/api/media/inbound/${encodeURIComponent(name)}`, name, mimeType } satisfies ChatMessageMedia;
}

function matchesStructuredMediaReference(reference: string, structuredMedia: ChatMessageMedia[]) {
  if (structuredMedia.length === 0) return false;
  const rawName = basenameFromReference(reference);
  const rawKey = looseMediaNameKey(rawName || reference);
  if (!rawKey) return false;
  return structuredMedia.some((item) => {
    const names = [item.name, basenameFromReference(item.url)].filter(Boolean);
    return names.some((name) => {
      const key = looseMediaNameKey(name);
      return key === rawKey || key.endsWith(rawKey) || stripAgentOpsDeckUploadPrefix(key) === rawKey;
    });
  });
}

function looseMediaNameKey(name: string) {
  return sanitizeDisplayName(name).toLowerCase().replace(/-+/g, '-');
}

function stripAgentOpsDeckUploadPrefix(key: string) {
  return key.replace(/^agentopsdeck-\d+-[a-z0-9_-]+-/, '');
}

function sanitizeDisplayName(name: string) {
  return path.basename(name).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRenderableRawMediaReference(reference: string) {
  return /^https?:\/\//i.test(reference) || isSafeInboundMediaUrl(reference);
}

function mediaFromReference(reference: string, explicitMimeType: string | undefined, source: 'structured' | 'raw'): ChatMessageMedia | undefined {
  const trimmed = reference.trim();
  if (!trimmed) return undefined;
  const httpUrl = /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
  if (httpUrl) {
    const pathname = safeUrlPathname(httpUrl);
    const name = basenameFromReference(pathname || httpUrl) || 'attachment';
    const mimeType = explicitMimeType ?? mimeTypeFor(name);
    return { type: mimeType.startsWith('image/') ? 'image' : 'file', url: httpUrl, name, mimeType };
  }
  if (isSafeInboundMediaUrl(trimmed)) {
    const name = decodeURIComponent(trimmed.split('/').pop() ?? 'attachment');
    const mimeType = explicitMimeType ?? mimeTypeFor(name);
    return { type: mimeType.startsWith('image/') ? 'image' : 'file', url: trimmed, name, mimeType };
  }
  if (source === 'raw' || isLocalPathLike(trimmed)) return undefined;
  const name = basenameFromReference(trimmed);
  if (!isSafeMediaName(name)) return undefined;
  const mimeType = explicitMimeType ?? mimeTypeFor(name);
  return { type: mimeType.startsWith('image/') ? 'image' : 'file', url: `/api/media/inbound/${encodeURIComponent(name)}`, name, mimeType };
}

function isLocalPathLike(value: string) {
  return value.startsWith('/') || /^file:\/\//i.test(value) || /^[a-zA-Z]:[\/]/.test(value);
}

function isSafeInboundMediaUrl(value: string) {
  if (!value.startsWith('/api/media/inbound/')) return false;
  try {
    const name = decodeURIComponent(value.split('/').pop() ?? '');
    return isSafeMediaName(name);
  } catch {
    return false;
  }
}

function isSafeMediaName(name: string) {
  return /^[\w.-]+$/.test(name) && !name.includes('..');
}

function safeUrlPathname(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function basenameFromReference(reference: string) {
  const normalized = reference.split(/[?#]/, 1)[0]?.replace(/\\/g, '/') ?? '';
  return path.posix.basename(normalized).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
}

function rowMessageValue(row: any) {
  const candidates = [
    row?.text,
    row?.content,
    row?.message?.content,
    row?.message?.text,
    row?.message,
    row?.parts,
    row?.payload,
    row?.data,
    row?.response,
    row?.output,
    row?.result,
    row?.delta?.text,
    row?.choice?.message?.content,
    row?.choices?.[0]?.message?.content,
    row?.choices?.[0]?.delta?.content,
  ];
  for (const candidate of candidates) {
    const text = extractText(candidate).trim();
    if (text) return candidate;
  }
  return candidates.find((candidate) => candidate !== undefined && candidate !== null) ?? '';
}

function extractText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n\n');
  if (typeof value !== 'object') return String(value);

  const record = value as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : undefined;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  if (typeof record.value === 'string') return record.value;
  if (typeof record.markdown === 'string') return record.markdown;
  if (typeof record.message === 'string') return record.message;
  if (Array.isArray(record.content)) return extractText(record.content);
  if (Array.isArray(record.parts)) return extractText(record.parts);
  if (type?.includes('image')) return '[image]';
  if (type?.includes('file')) return '[file]';
  if (type?.toLowerCase().includes('tool') || type === 'functionCall' || type === 'functionResult') {
    const callRecord = typeof record.call === 'object' && record.call !== null ? record.call as Record<string, unknown> : undefined;
    const functionRecord = typeof record.function === 'object' && record.function !== null ? record.function as Record<string, unknown> : undefined;
    const toolName = firstString(record.name, record.toolName, record.tool, callRecord?.name, functionRecord?.name);
    const args = firstPresent(record.args, record.arguments, record.input, callRecord?.arguments, functionRecord?.arguments);
    const status = firstString(record.status, record.state);
    const error = firstPresent(record.error, record.errorMessage);
    const output = firstPresent(record.output, record.result, record.results);

    if (toolName || args !== undefined || status || error !== undefined || output !== undefined) {
      const parts = [`[tool ${toolName || 'unknown'}]`];
      const safeArgs = safeToolText(args, 300);
      if (safeArgs) {
        // Markdown-safe: unlike the previous <tool_input> tag, this remains visible in ReactMarkdown
        // and in the tool timeline <pre> fallback used by the deck.
        parts.push(`tool input:\n\`\`\`json\n${safeArgs}\n\`\`\``);
      }
      if (status) parts.push(`status: ${status}`);
      const safeError = safeToolText(error, 500);
      if (safeError) parts.push(`error: ${safeError}`);
      const safeOutput = safeToolText(output, 1_000);
      if (safeOutput) parts.push(`output:\n${safeOutput}`);
      if (!safeOutput) parts.push('[tool output]');
      return parts.join('\n\n');
    }
    return '[tool output]';
  }

  const nested = [record.data, record.payload, record.body, record.item].map(extractText).filter(Boolean);
  if (nested.length > 0) return nested.join('\n\n');

  return JSON.stringify(record, (_, nestedValue) => (typeof nestedValue === 'bigint' ? String(nestedValue) : nestedValue));
}


function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function firstPresent(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null);
}

function safeToolText(value: unknown, maxLength: number) {
  if (value === undefined || value === null) return undefined;
  const redacted = redactToolValue(value);
  const text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  if (!text) return undefined;
  return text.length > maxLength ? text.slice(0, maxLength - 3) + '...' : text;
}

function redactToolValue(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return redactObjectKeys(JSON.parse(value));
    } catch {
      return redactSecretAssignments(value);
    }
  }
  if (typeof value === 'object' && value !== null) return redactObjectKeys(value);
  return value;
}

function redactSecretAssignments(value: string) {
  return value
    .replace(/("[^"\\]*(?:token|api[_-]?key|password|secret|authorization|cookie|private[_-]?key)[^"\\]*"\s*:\s*")[^"]*(")/gi, '$1***REDACTED***$2')
    .replace(/\b(token|api[_-]?key|password|secret|authorization|cookie|private[_-]?key)\b\s*[=:]\s*([^\s,&]+)/gi, '$1=***REDACTED***');
}

function redactObjectKeys(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(redactObjectKeys);
  }
  if (typeof obj === 'object' && obj !== null) {
    const result: any = {};
    for (const key of Object.keys(obj)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('token') || lowerKey.includes('key') || lowerKey.includes('password') || lowerKey.includes('secret') || lowerKey.includes('auth') || lowerKey.includes('cookie')) {
        result[key] = '***REDACTED***';
      } else {
        result[key] = redactObjectKeys(obj[key]);
      }
    }
    return result;
  }
  return obj;
}

function asArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}
