import { normalizeSourceFiles, type SourceFileChange } from '@agentopsdeck/shared';

/** Small transcript summaries. Bounded text-only tool details are persisted
 * separately and fetched through an authorized detail reader, never copied
 * into every message page. Binary, thinking and provider internals are omitted.
 */
export type ClaudeProjectedMessage = {
  nativeMessageId: string; blockIndex: number; parentToolUseId: string | null;
  role: 'user' | 'assistant' | 'tool'; text: string; truncated: boolean;
  toolCallId?: string; toolName?: string; toolPhase?: 'call' | 'result'; toolError?: boolean;
  detailAvailable: boolean;
  sourceFiles?: SourceFileChange[];
};
export const CLAUDE_MESSAGE_TEXT_LIMIT = 100_000;
export const CLAUDE_TOOL_PREVIEW_LIMIT = 1_000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const invalid = () => new Error('Invalid Claude transcript identity or content');

function preview(value: unknown, limit: number): { text: string; truncated: boolean } {
  if (typeof value === 'string') return { text: value.slice(0, limit), truncated: value.length > limit };
  if (!Array.isArray(value)) return { text: '', truncated: value !== undefined && value !== null };
  let text = '', truncated = false;
  for (const block of value.slice(0, 256)) {
    if (!record(block) || block.type !== 'text' || typeof block.text !== 'string') { truncated = true; continue; }
    const remaining = Math.max(0, limit - text.length);
    const separator = text ? '\n' : '';
    // Never concatenate an unbounded native body before applying the limit.
    const piece = separator + block.text.slice(0, remaining);
    text += piece.slice(0, remaining);
    truncated ||= separator.length + block.text.length > remaining;
  }
  return { text, truncated: truncated || value.length > 256 };
}

export function projectClaudeMessage(event: unknown, expectedSessionId: string): ClaudeProjectedMessage[] {
  if (!record(event)) throw invalid();
  if (event.type !== 'assistant' && event.type !== 'user') return [];
  if (!id(expectedSessionId) || event.session_id !== expectedSessionId || !id(event.uuid)
    || event.parent_tool_use_id !== null && !id(event.parent_tool_use_id)
    || !record(event.message) || event.message.role !== event.type) throw invalid();
  const content = event.message.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (!Array.isArray(blocks) || blocks.length > 256) throw invalid();
  const rows: ClaudeProjectedMessage[] = [];
  let remaining = CLAUDE_MESSAGE_TEXT_LIMIT;
  for (const [blockIndex, block] of blocks.entries()) {
    if (!record(block)) throw invalid();
    const base = { nativeMessageId: event.uuid, blockIndex, parentToolUseId: event.parent_tool_use_id as string | null };
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw invalid();
      const text = block.text.slice(0, remaining), truncated = text.length < block.text.length;
      remaining -= text.length;
      if (text || truncated) rows.push({ ...base, role: event.type, text, truncated, detailAvailable: truncated });
    } else if (block.type === 'tool_use') {
      if (event.type !== 'assistant' || !id(block.id) || !id(block.name)) throw invalid();
      // Parameter values may contain large image/data payloads. Only the tool
      // name is eager; input is retrieved by native message+block identity.
      const text = block.name.slice(0, remaining);
      remaining -= text.length;
      rows.push({ ...base, role: 'tool', text, truncated: text.length !== block.name.length, detailAvailable: true,
        toolCallId: block.id, toolName: block.name, toolPhase: 'call' });
    } else if (block.type === 'tool_result') {
      if (event.type !== 'user' || !id(block.tool_use_id) || block.is_error !== undefined && typeof block.is_error !== 'boolean') throw invalid();
      const summary = preview(block.content, Math.min(remaining, CLAUDE_TOOL_PREVIEW_LIMIT));
      remaining -= summary.text.length;
      rows.push({ ...base, role: 'tool', ...summary, detailAvailable: true,
        toolCallId: block.tool_use_id, toolPhase: 'result', toolError: block.is_error === true });
    }
    // Unsupported/binary/thinking blocks never enter list payloads. They do
    // not prove lifecycle completion and remain in native history only.
  }
  return rows;
}

/** Parent-side IPC validation, copying only known fields. No raw native
 * bodies/metadata are trusted merely because a child process sent them. */
export function validateClaudeProjection(input: unknown, nativeMessageId: string, parentToolUseId: unknown): ClaudeProjectedMessage[] {
  if (!id(nativeMessageId) || parentToolUseId !== null && !id(parentToolUseId)
    || !Array.isArray(input) || input.length > 256) throw invalid();
  let size = 0, previousIndex = -1;
  return input.map(row => {
    if (!record(row) || row.nativeMessageId !== nativeMessageId || row.parentToolUseId !== parentToolUseId
      || !Number.isSafeInteger(row.blockIndex) || (row.blockIndex as number) <= previousIndex || (row.blockIndex as number) > 255
      || !['user', 'assistant', 'tool'].includes(row.role as string) || typeof row.text !== 'string'
      || typeof row.truncated !== 'boolean' || typeof row.detailAvailable !== 'boolean') throw invalid();
    previousIndex = row.blockIndex as number;
    size += row.text.length;
    if (size > CLAUDE_MESSAGE_TEXT_LIMIT) throw invalid();
    const result: ClaudeProjectedMessage = { nativeMessageId, blockIndex: previousIndex,
      parentToolUseId: parentToolUseId as string | null, role: row.role as ClaudeProjectedMessage['role'],
      text: row.text, truncated: row.truncated, detailAvailable: row.detailAvailable };
    if (row.role === 'tool') {
      if (!id(row.toolCallId) || !['call', 'result'].includes(row.toolPhase as string)
        || row.toolName !== undefined && !id(row.toolName)
        || row.toolError !== undefined && typeof row.toolError !== 'boolean'
        || row.text.length > CLAUDE_TOOL_PREVIEW_LIMIT) throw invalid();
      result.toolCallId = row.toolCallId;
      result.toolPhase = row.toolPhase as 'call' | 'result';
      if (row.toolName !== undefined) result.toolName = row.toolName as string;
      if (row.toolError !== undefined) result.toolError = row.toolError as boolean;
      if (result.toolPhase === 'result' && result.toolError === false) {
        const files = normalizeSourceFiles(row.sourceFiles);
        if (files.length) result.sourceFiles = files;
      }
    }
    return result;
  });
}
