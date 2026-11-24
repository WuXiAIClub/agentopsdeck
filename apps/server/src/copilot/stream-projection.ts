import { COPILOT_MESSAGE_TEXT_LIMIT, copilotIdentifier, type CopilotMessageScope } from './message-projection.js';
import { copilotLifecycleFrame } from './worker-protocol.js';

export type CopilotTextStream = CopilotMessageScope & { messageId: string; text: string; truncated: boolean };
const invalid = () => new Error('Invalid Copilot text stream');
const identity = (row: CopilotMessageScope & { messageId: string }) => JSON.stringify([row.agentId ?? null, row.parentToolCallId ?? null, row.messageId]);

export function validateCopilotStream(value: unknown): CopilotTextStream {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (!copilotIdentifier(row.messageId) || row.agentId !== undefined && !copilotIdentifier(row.agentId)
    || row.parentToolCallId !== undefined && !copilotIdentifier(row.parentToolCallId)
    || typeof row.text !== 'string' || row.text.length > COPILOT_MESSAGE_TEXT_LIMIT || typeof row.truncated !== 'boolean') throw invalid();
  return { messageId: row.messageId, text: row.text, truncated: row.truncated,
    ...(typeof row.agentId === 'string' ? { agentId: row.agentId } : {}),
    ...(typeof row.parentToolCallId === 'string' ? { parentToolCallId: row.parentToolCallId } : {}) };
}

/** Text only; neither an assistant final nor a stream end finishes a run. */
export class CopilotTextStreams {
  private readonly streams = new Map<string, { value: CopilotTextStream; dirty: boolean }>();
  private readonly completed = new Set<string>();
  accept(value: unknown) {
    const frame = copilotLifecycleFrame(value);
    if (!['assistant.message_delta', 'assistant.message'].includes(frame.type)) return;
    const data = (value as { data: Record<string, unknown> }).data;
    if (!copilotIdentifier(data.messageId)) throw invalid();
    const scope = { messageId: data.messageId, ...(frame.agentId ? { agentId: frame.agentId } : {}),
      ...(typeof frame.data.parentToolCallId === 'string' ? { parentToolCallId: frame.data.parentToolCallId } : {}) };
    const key = identity(scope);
    if (this.completed.has(key)) throw invalid();
    if (frame.type === 'assistant.message') {
      if (this.completed.size >= 10_000) throw invalid();
      this.completed.add(key); this.streams.delete(key); return;
    }
    if (typeof data.deltaContent !== 'string') throw invalid();
    let state = this.streams.get(key);
    if (!state) {
      if (this.streams.size >= 16) throw invalid();
      state = { value: { ...scope, text: '', truncated: false }, dirty: false }; this.streams.set(key, state);
    }
    const text = data.deltaContent.slice(0, COPILOT_MESSAGE_TEXT_LIMIT - state.value.text.length);
    const truncated = text.length < data.deltaContent.length;
    state.dirty ||= !!text || truncated && !state.value.truncated;
    state.value.text += text; state.value.truncated ||= truncated;
  }
  get hasPending() { return [...this.streams.values()].some(row => row.dirty); }
  drain() {
    const rows: CopilotTextStream[] = [];
    for (const row of this.streams.values()) if (row.dirty) { row.dirty = false; rows.push({ ...row.value }); }
    return rows;
  }
}
