export const ANTIGRAVITY_TOOL_OUTPUT_LIMIT = 64_000;

export type AntigravityProjectedUpdate = {
  sessionUpdate: 'agent_message_chunk';
  content: { type: 'text'; text: string };
} | {
  sessionUpdate: 'usage_update';
  used: number;
  size: number;
} | {
  sessionUpdate: 'tool_call' | 'tool_call_update';
  toolCallId: string;
  title?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  kind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
  outputText?: string;
  outputTruncated?: boolean;
};

const failure = () => Error('Antigravity message update could not be verified');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const metadataText = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && Buffer.byteLength(value) <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const normalizeToolTitle = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!collapsed) return undefined;
  if (Buffer.byteLength(collapsed) <= 512) return collapsed;
  let out = '';
  for (const ch of collapsed) {
    if (Buffer.byteLength(out + ch) > 512) break;
    out += ch;
  }
  return out || undefined;
};
const statuses = new Set(['pending', 'in_progress', 'completed', 'failed']);
const kinds = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);
const nonNegativeInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function extractToolOutput(value: Record<string, unknown>): { text: string; truncated: boolean } | undefined {
  const parts: string[] = [];
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (!record(item)) continue;
      if (item.type === 'content' && record(item.content) && item.content.type === 'text' && typeof item.content.text === 'string') {
        parts.push(item.content.text);
      } else if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      }
    }
  }
  if (parts.length === 0 && record(value.rawOutput) && typeof value.rawOutput.output === 'string') {
    parts.push(value.rawOutput.output);
  }
  if (parts.length === 0) return undefined;
  const joined = parts.join('\n');
  if (!joined) return undefined;
  const truncated = joined.length > ANTIGRAVITY_TOOL_OUTPUT_LIMIT;
  return { text: truncated ? joined.slice(0, ANTIGRAVITY_TOOL_OUTPUT_LIMIT) : joined, truncated };
}

export function projectAntigravityUpdate(value: unknown): AntigravityProjectedUpdate | undefined {
  if (!record(value) || typeof value.sessionUpdate !== 'string') throw failure();
  if (value.sessionUpdate === 'agent_message_chunk') {
    if (!record(value.content) || typeof value.content.type !== 'string') throw failure();
    if (value.content.type !== 'text') return;
    if (typeof value.content.text !== 'string' || Buffer.byteLength(value.content.text) > 524_288) throw failure();
    return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value.content.text } };
  }
  if (value.sessionUpdate === 'usage_update') {
    if (!nonNegativeInt(value.used) || !nonNegativeInt(value.size) || value.size <= 0) return;
    return { sessionUpdate: 'usage_update', used: value.used, size: value.size };
  }
  if (value.sessionUpdate !== 'tool_call' && value.sessionUpdate !== 'tool_call_update') return;
  const rawTitle = value.title === null ? undefined : value.title;
  const rawStatus = value.status === null ? undefined : value.status;
  const rawKind = value.kind === null ? undefined : value.kind;
  if (!metadataText(value.toolCallId)
    || rawTitle !== undefined && typeof rawTitle !== 'string'
    || rawStatus !== undefined && (typeof rawStatus !== 'string' || !statuses.has(rawStatus))
    || rawKind !== undefined && (typeof rawKind !== 'string' || !kinds.has(rawKind))) throw failure();
  const title = rawTitle !== undefined ? normalizeToolTitle(rawTitle) : undefined;
  const output = rawStatus === 'completed' || rawStatus === 'failed' ? extractToolOutput(value) : undefined;
  return {
    sessionUpdate: value.sessionUpdate, toolCallId: value.toolCallId,
    ...(title !== undefined ? { title } : {}),
    ...(rawStatus !== undefined ? { status: rawStatus as 'pending' | 'in_progress' | 'completed' | 'failed' } : {}),
    ...(rawKind !== undefined ? { kind: rawKind as 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other' } : {}),
    ...(output ? { outputText: output.text, outputTruncated: output.truncated } : {}),
  };
}
