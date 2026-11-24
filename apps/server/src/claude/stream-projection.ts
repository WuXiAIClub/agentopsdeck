import { CLAUDE_MESSAGE_TEXT_LIMIT } from './message-projection.js';

export type ClaudeTextStream = {
  messageId: string; parentToolUseId: string | null;
  blocks: { blockIndex: number; text: string; truncated: boolean }[];
};
/** Native assistant envelopes use local content indexes; stream events use
 * provider-wide indexes. The pinned CLI emits one envelope per block. */
export type ClaudeStreamFinal = { messageId: string; blockIndexes: number[] };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const invalid = () => new Error('Invalid Claude text stream');

export function validateClaudeStreamFinal(value: unknown): ClaudeStreamFinal {
  if (!record(value) || !id(value.messageId) || !Array.isArray(value.blockIndexes) || value.blockIndexes.length > 256) throw invalid();
  let previous = -1;
  const blockIndexes = value.blockIndexes.map(index => {
    if (!Number.isSafeInteger(index) || index <= previous || index > 255) throw invalid();
    previous = index; return index as number;
  });
  return { messageId: value.messageId, blockIndexes };
}

/** No thinking, tool JSON, binary, usage, errors or provider metadata crosses
 * this boundary. The final SDK message remains the durable history source. */
export function validateClaudeTextStream(value: unknown): ClaudeTextStream {
  if (!record(value) || !id(value.messageId) || value.parentToolUseId !== null && !id(value.parentToolUseId)
    || !Array.isArray(value.blocks) || value.blocks.length > 256) throw invalid();
  let chars = 0, index = -1;
  const blocks = value.blocks.map(block => {
    if (!record(block) || !Number.isSafeInteger(block.blockIndex) || (block.blockIndex as number) <= index
      || (block.blockIndex as number) > 255 || typeof block.text !== 'string' || typeof block.truncated !== 'boolean') throw invalid();
    index = block.blockIndex as number; chars += block.text.length;
    if (chars > CLAUDE_MESSAGE_TEXT_LIMIT) throw invalid();
    return { blockIndex: index, text: block.text, truncated: block.truncated };
  });
  return { messageId: value.messageId, parentToolUseId: value.parentToolUseId as string | null, blocks };
}

/** Worker-local reducer for the pinned SDK's Messages API partial events.
 * Each parent is independent; never attach a child delta to the root reply. */
export class ClaudeTextStreams {
  private readonly streams = new Map<string | null, { value: ClaudeTextStream; chars: number; stopped: Set<number>;
    blocks: Map<number, { type: string; finalized: boolean }>; wireStopped: boolean; dirty: boolean }>();

  private releaseStopped(parent: string | null) {
    const stream = this.streams.get(parent);
    if (!stream?.wireStopped) return;
    // The pinned CLI can omit the assistant envelope for an empty text block
    // after a tool. Only a stopped, genuinely empty text block may retire
    // without that envelope. Nonempty text, tools and thinking still require
    // their native final; this does not complete the turn or create history.
    if ([...stream.blocks].every(([index, block]) => {
      if (block.finalized) return true;
      const text = stream.value.blocks.find(value => value.blockIndex === index);
      return block.type === 'text' && stream.stopped.has(index)
        && text?.text === '' && !text.truncated;
    })) this.streams.delete(parent);
  }

  accept(input: unknown, sessionId: string, snapshot = true): ClaudeTextStream | undefined {
    if (!record(input) || input.type !== 'stream_event') return;
    if (input.session_id !== sessionId || input.parent_tool_use_id !== null && !id(input.parent_tool_use_id)
      || !record(input.event)) throw invalid();
    const parent = input.parent_tool_use_id as string | null, event = input.event;
    if (event.type === 'message_start') {
      if (!record(event.message) || !id(event.message.id) || event.message.role !== 'assistant'
        || this.streams.has(parent) || this.streams.size >= 16) throw invalid();
      this.streams.set(parent, { value: { messageId: event.message.id, parentToolUseId: parent, blocks: [] }, chars: 0,
        stopped: new Set(), blocks: new Map(), wireStopped: false, dirty: false });
      return;
    }
    const stream = this.streams.get(parent);
    if (!stream) {
      if (event.type === 'ping') return;
      throw invalid();
    }
    if (stream.wireStopped) throw invalid();
    if (event.type === 'message_stop') {
      stream.wireStopped = true;
      this.releaseStopped(parent);
      return;
    }
    if (event.type === 'content_block_start' || event.type === 'content_block_delta' || event.type === 'content_block_stop') {
      if (!Number.isSafeInteger(event.index) || (event.index as number) < 0 || (event.index as number) > 255) throw invalid();
      const index = event.index as number;
      if (stream.stopped.has(index)) throw invalid();
      if (event.type !== 'content_block_start' && !stream.blocks.has(index)) throw invalid();
      if (event.type === 'content_block_stop') { stream.stopped.add(index); return; }
      let block = stream.value.blocks.find(row => row.blockIndex === index);
      let text: string;
      if (event.type === 'content_block_start') {
        if (!record(event.content_block) || typeof event.content_block.type !== 'string' || index !== stream.blocks.size) throw invalid();
        stream.blocks.set(index, { type: event.content_block.type, finalized: false });
        if (event.content_block.type !== 'text') return;
        if (block || typeof event.content_block.text !== 'string') throw invalid();
        text = event.content_block.text;
        block = { blockIndex: index, text: '', truncated: false };
        stream.value.blocks.push(block); stream.value.blocks.sort((a, b) => a.blockIndex - b.blockIndex);
      } else {
        if (!record(event.delta)) throw invalid();
        if (event.delta.type !== 'text_delta') return;
        if (!block || typeof event.delta.text !== 'string') throw invalid();
        text = event.delta.text;
      }
      const portion = text.slice(0, CLAUDE_MESSAGE_TEXT_LIMIT - stream.chars);
      const changed = portion.length > 0 || text.length > portion.length && !block.truncated;
      block.text += portion; block.truncated ||= portion.length < text.length; stream.chars += portion.length;
      if (changed) {
        stream.dirty = true;
        if (snapshot) return structuredClone(stream.value);
      }
    }
    // message_stop closes the wire stream, not the run or durable message.
    // Retain its identity until the complete assistant message is received.
  }

  get hasPending() { return [...this.streams.values()].some(stream => stream.dirty); }

  drain(): ClaudeTextStream[] {
    const snapshots: ClaudeTextStream[] = [];
    for (const stream of this.streams.values()) if (stream.dirty) {
      stream.dirty = false; snapshots.push(structuredClone(stream.value));
    }
    return snapshots;
  }

  complete(input: unknown, sessionId: string): ClaudeStreamFinal | undefined {
    if (!record(input) || input.type !== 'assistant') return;
    if (input.session_id !== sessionId || !record(input.message)) throw invalid();
    const parent = input.parent_tool_use_id as string | null, stream = this.streams.get(parent);
    if (!stream) return;
    if (input.message.id !== stream.value.messageId) throw invalid();
    const content = typeof input.message.content === 'string' ? [{ type: 'text', text: input.message.content }] : input.message.content;
    if (!Array.isArray(content) || content.length > 256) throw invalid();
    const pending = [...stream.blocks].filter(([, block]) => !block.finalized);
    const blockIndexes = content.map((block, index) => {
      const wire = pending[index];
      if (!record(block) || !wire || wire[1].type !== block.type) throw invalid();
      wire[1].finalized = true;
      return wire[0];
    });
    stream.value.blocks = stream.value.blocks.filter(block => !blockIndexes.includes(block.blockIndex));
    // The pinned CLI emits the completed assistant BEFORE forwarding its
    // content_block_stop/message_stop. Retain the wire context until both
    // sides finish; otherwise an ordinary successful reply fences the run.
    this.releaseStopped(parent);
    return { messageId: stream.value.messageId, blockIndexes };
  }
}

export function claudeLiveMessageId(key: string, executionId: string, stream: Pick<ClaudeTextStream, 'messageId' | 'parentToolUseId'>, blockIndex: number) {
  return `claude-live:${Buffer.from(JSON.stringify([key, executionId, stream.parentToolUseId, stream.messageId, blockIndex])).toString('base64url')}`;
}
