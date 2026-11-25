export type AntigravityProjectedUpdate = {
  sessionUpdate: 'agent_message_chunk';
  content: { type: 'text'; text: string };
} | {
  sessionUpdate: 'tool_call' | 'tool_call_update';
  toolCallId: string;
  title?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  kind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
};

const failure = () => Error('Antigravity message update could not be verified');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const metadataText = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && Buffer.byteLength(value) <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const statuses = new Set(['pending', 'in_progress', 'completed', 'failed']);
const kinds = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);

export function projectAntigravityUpdate(value: unknown): AntigravityProjectedUpdate | undefined {
  if (!record(value) || typeof value.sessionUpdate !== 'string') throw failure();
  if (value.sessionUpdate === 'agent_message_chunk') {
    if (!record(value.content) || typeof value.content.type !== 'string') throw failure();
    if (value.content.type !== 'text') return;
    if (typeof value.content.text !== 'string' || Buffer.byteLength(value.content.text) > 524_288) throw failure();
    return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value.content.text } };
  }
  if (value.sessionUpdate !== 'tool_call' && value.sessionUpdate !== 'tool_call_update') return;
  if (!metadataText(value.toolCallId) || value.title !== undefined && !metadataText(value.title)
    || value.status !== undefined && (typeof value.status !== 'string' || !statuses.has(value.status))
    || value.kind !== undefined && (typeof value.kind !== 'string' || !kinds.has(value.kind))) throw failure();
  return {
    sessionUpdate: value.sessionUpdate, toolCallId: value.toolCallId,
    ...(value.title !== undefined ? { title: value.title as string } : {}),
    ...(value.status !== undefined ? { status: value.status as 'pending' | 'in_progress' | 'completed' | 'failed' } : {}),
    ...(value.kind !== undefined ? { kind: value.kind as 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other' } : {}),
  };
}
