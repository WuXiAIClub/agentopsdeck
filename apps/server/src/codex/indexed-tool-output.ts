import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ChatMessage } from '@agentopsdeck/shared';
import { compactToolHistoryContent } from './tool-history-content.js';
import { maxRolloutFileBytes } from './rollout-limits.js';

// These references are local projection state, not client-supplied paths or a
// new file-access API. JSON/SSE/persistence never serialize the symbol binding.
const binding = Symbol('codex-tool-record');
export type ToolRecordReference = {
  offset: number; bytes: number; digest: string; dev: number; ino: number; callId: string;
};
export type IndexedToolOutput = { reference: ToolRecordReference; preview: string; lines: number };
type BoundMessage = ChatMessage & { [binding]?: { file: string; reference: ToolRecordReference; prefix: string } };

export function rolloutToolOutputText(rawOutput: unknown): string {
  const output = compactToolHistoryContent(rawOutput);
  const text = (Array.isArray(output) ? output : [])
    .map(item => typeof item?.text === 'string' ? item.text.trim() : '').filter(Boolean).join('');
  return text || (JSON.stringify(output, null, 2) ?? '');
}

export function bindToolRecord(message: ChatMessage, file: string, output: IndexedToolOutput, prefix: string): ChatMessage {
  // Enumerable symbol survives the existing projection's object spreads, but
  // is absent from public JSON. No external value can recreate this binding.
  (message as BoundMessage)[binding] = { file, reference: output.reference, prefix };
  message.toolDetailAvailable = true;
  message.toolLineCount = prefix.split('\n').length - 1 + output.lines;
  return message;
}

/** Resolve only the exact verified record, bounded by the existing 8MiB record
 * limit. Callers MUST recheck authorization and projection identity after await.
 * A rewritten/truncated/replaced file never turns into a different tool body.
 */
export async function readIndexedToolMessage(message: ChatMessage): Promise<ChatMessage> {
  const source = (message as BoundMessage)[binding];
  if (!source) return message;
  const { reference: ref } = source;
  if (!Number.isSafeInteger(ref.offset) || ref.offset < 0 || !Number.isSafeInteger(ref.bytes)
    || ref.bytes <= 0 || ref.bytes > 8 * 1024 * 1024 || ref.offset + ref.bytes > maxRolloutFileBytes) {
    throw new Error('Invalid tool record reference');
  }
  const handle = await open(source.file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(), end = ref.offset + ref.bytes;
    if (!before.isFile() || before.dev !== ref.dev || before.ino !== ref.ino || before.size < end) {
      throw new Error('Tool record source changed');
    }
    const buffer = Buffer.allocUnsafe(ref.bytes);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, Math.min(1024 * 1024, buffer.length - read), ref.offset + read);
      if (!bytesRead) throw new Error('Tool record truncated');
      read += bytesRead;
    }
    const after = await handle.stat();
    if (after.size < before.size || (after.size === before.size && (after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs))
      || createHash('sha256').update(buffer).digest('hex') !== ref.digest) throw new Error('Tool record changed');
    const row = JSON.parse(buffer.toString('utf8'));
    if (row?.type !== 'response_item' || row.payload?.call_id !== ref.callId
      || !['custom_tool_call_output', 'function_call_output'].includes(row.payload?.type)) throw new Error('Tool record identity changed');
    return { ...message, text: source.prefix + rolloutToolOutputText(row.payload.output) };
  } finally { await handle.close(); }
}
