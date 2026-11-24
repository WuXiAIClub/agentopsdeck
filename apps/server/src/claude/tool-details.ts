import { projectClaudeMessage, type ClaudeProjectedMessage } from './message-projection.js';

export type ClaudeToolDetail = { blockIndex: number; text: string; truncated: boolean };
/** Per native envelope, not per block. Stored separately from eager history. */
export const CLAUDE_TOOL_DETAIL_CHARS = 64_000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('Invalid Claude tool details');

/** Bound traversal before serialization; never stringify a native image or
 * an unbounded nested tool input just to slice the resulting string. */
export function boundedToolInputPreview(value: unknown, limit: number) {
  let remaining = limit, nodes = 0, truncated = false;
  const seen = new Set<object>();
  const text = (value: string) => {
    const result = value.slice(0, remaining); remaining -= result.length;
    truncated ||= result.length !== value.length; return result;
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (remaining <= 0 || ++nodes > 1024 || depth > 8) { truncated = true; return null; }
    if (typeof value === 'string') {
      if (/^data:[^,]{0,200};base64,/i.test(value)) { truncated = true; return text('[binary omitted]'); }
      return text(value);
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (!value || typeof value !== 'object' || seen.has(value)) { truncated = true; return null; }
    seen.add(value);
    if (Array.isArray(value)) {
      const result = [];
      for (const row of value) {
        if (result.length >= 64 || remaining <= 0 || nodes >= 1024) { truncated = true; break; }
        result.push(visit(row, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++count > 64 || remaining <= 0 || nodes >= 1024) { truncated = true; break; }
      if (/^(?:base64|image|images|image_url|image_data|audio|video)$/i.test(key)) {
        result[text(key)] = text('[binary omitted]'); truncated = true; continue;
      }
      const name = text(key.slice(0, 128)); truncated ||= key.length > 128;
      result[name] = visit((value as Record<string, unknown>)[key], depth + 1);
    }
    return result;
  };
  const rendered = JSON.stringify(visit(value, 0), null, 2) ?? '';
  return { text: rendered.slice(0, limit), truncated: truncated || rendered.length > limit };
}

export function projectClaudeToolDetails(event: unknown, sessionId: string): ClaudeToolDetail[] {
  const rows = projectClaudeMessage(event, sessionId).filter(row => row.role === 'tool');
  if (!rows.length) return [];
  const content = (event as { message: { content: unknown[] } }).message.content;
  const result: ClaudeToolDetail[] = [];
  let remaining = CLAUDE_TOOL_DETAIL_CHARS;
  for (const row of rows) {
    if (remaining <= 0) break;
    const block = content[row.blockIndex] as Record<string, unknown>;
    let detail: { text: string; truncated: boolean };
    if (row.toolPhase === 'call') detail = boundedToolInputPreview(block.input, remaining);
    else if (typeof block.content === 'string') detail = { text: block.content.slice(0, remaining), truncated: block.content.length > remaining };
    else {
      let text = '', truncated = false;
      if (Array.isArray(block.content)) for (const part of block.content.slice(0, 256)) {
        if (!record(part) || part.type !== 'text' || typeof part.text !== 'string') { truncated = true; continue; }
        const separator = text ? '\n' : '';
        const available = remaining - text.length;
        const piece = separator + part.text.slice(0, available);
        text += piece.slice(0, available); truncated ||= separator.length + part.text.length > available;
      }
      truncated ||= !Array.isArray(block.content) || block.content.length > 256;
      detail = { text, truncated };
    }
    remaining -= detail.text.length;
    result.push({ blockIndex: row.blockIndex, ...detail });
  }
  return result;
}

export function validateClaudeToolDetails(input: unknown, rows: readonly ClaudeProjectedMessage[]): ClaudeToolDetail[] {
  if (!Array.isArray(input) || input.length > 256) throw invalid();
  let previous = -1, chars = 0;
  return input.map(detail => {
    if (!record(detail) || !Number.isSafeInteger(detail.blockIndex) || (detail.blockIndex as number) <= previous
      || typeof detail.text !== 'string' || typeof detail.truncated !== 'boolean'
      || !rows.some(row => row.blockIndex === detail.blockIndex && row.role === 'tool')) throw invalid();
    previous = detail.blockIndex as number; chars += detail.text.length;
    if (chars > CLAUDE_TOOL_DETAIL_CHARS) throw invalid();
    return { blockIndex: previous, text: detail.text, truncated: detail.truncated };
  });
}
