// Isolated acceptance only: bounded structural diagnostics, never text,
// arguments, stderr, headers, provider errors or credential values.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const params = new URL(import.meta.url).searchParams;
const root = params.get('root'), compiled = params.get('compiled');
if (!root?.startsWith('/') || !compiled?.startsWith('/')) throw new Error('Missing isolated probe paths');
const { ClaudeStreamDelivery } = await import(pathToFileURL(join(compiled, 'claude/stream-delivery.js')));
const original = ClaudeStreamDelivery.prototype.send;
const shapes = [];
const allowed = new Set(['stream_event', 'message_start', 'message_stop', 'message_delta', 'content_block_start',
  'content_block_delta', 'content_block_stop', 'text', 'tool_use', 'tool_result', 'thinking', 'assistant', 'user', 'result', 'system']);
const type = value => allowed.has(value) ? value : 'other';
ClaudeStreamDelivery.prototype.send = async function (event) {
  const index = event?.event?.index;
  shapes.push({ type: type(event?.type), wire: type(event?.event?.type),
    index: Number.isSafeInteger(index) && index >= 0 && index < 256 ? index : undefined,
    wireBlock: type(event?.event?.content_block?.type),
    content: Array.isArray(event?.message?.content) ? event.message.content.slice(0, 256).map(block => ({
      type: type(block?.type), ...(typeof block?.text === 'string' ? { chars: block.text.length } : {}),
    })) : undefined });
  if (shapes.length > 64) shapes.shift();
  try { return await original.call(this, event); }
  catch (error) {
    writeFileSync(join(root, `claude-stream-failure-${process.pid}.json`), JSON.stringify(shapes), { mode: 0o600 });
    throw error;
  }
};
