import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeTextStreams, validateClaudeTextStream, validateClaudeStreamFinal } from './stream-projection.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { claudeHistoryPage, claudeHistoryMessage } from './history.js';
import { projectClaudeMessage } from './message-projection.js';

const event = (value: unknown, parent: string | null = null) => ({ type: 'stream_event', session_id: 'native', parent_tool_use_id: parent, event: value });
const start = (id: string) => ({ type: 'message_start', message: { id, role: 'assistant' } });
const block = (text = '') => ({ type: 'content_block_start', index: 0, content_block: { type: 'text', text } });
const delta = (text: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });

test('Claude permits the next message after a stopped empty text block omitted by the native CLI', () => {
  for (const finalBeforeStop of [true, false]) {
    const streams = new ClaudeTextStreams();
    streams.accept(event(start('tool-message')), 'native');
    streams.accept(event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use' } }), 'native');
    const final = { type: 'assistant', session_id: 'native', parent_tool_use_id: null,
      message: { id: 'tool-message', content: [{ type: 'tool_use' }] } };
    if (finalBeforeStop) streams.complete(final, 'native');
    streams.accept(event({ type: 'content_block_stop', index: 0 }), 'native');
    streams.accept(event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }), 'native');
    streams.accept(event({ type: 'content_block_stop', index: 1 }), 'native');
    streams.accept(event({ type: 'message_stop' }), 'native');
    if (!finalBeforeStop) streams.complete(final, 'native');
    assert.deepEqual(streams.drain(), [], 'No empty/phantom message is published');
    streams.accept(event(start('next')), 'native');
    streams.accept(event(block('Actual reply')), 'native');
    assert.equal(streams.drain()[0]?.blocks[0]?.text, 'Actual reply');
  }
});

test('empty-block retirement never discards nonempty, truncated, unstopped or non-text native content', () => {
  for (const kind of ['text', 'truncated', 'unstopped', 'tool_use', 'thinking']) {
    const streams = new ClaudeTextStreams();
    streams.accept(event(start('pending')), 'native');
    streams.accept(event({ type: 'content_block_start', index: 0, content_block: {
      type: ['text', 'truncated', 'unstopped'].includes(kind) ? 'text' : kind,
      text: kind === 'text' ? 'real content' : kind === 'truncated' ? 'x'.repeat(100_001) : '',
    } }), 'native');
    if (kind !== 'unstopped') streams.accept(event({ type: 'content_block_stop', index: 0 }), 'native');
    streams.accept(event({ type: 'message_stop' }), 'native');
    assert.throws(() => streams.accept(event(start('next')), 'native'), /Invalid Claude text stream/);
  }
});

test('Claude partial projection isolates root and child text, bounds output and strips non-text payloads', () => {
  const streams = new ClaudeTextStreams();
  streams.accept(event(start('root')), 'native'); streams.accept(event(block()), 'native');
  streams.accept(event(start('child'), 'tool'), 'native'); streams.accept(event(block(), 'tool'), 'native');
  const root = streams.accept(event(delta('Root')), 'native')!;
  const child = streams.accept(event(delta('Child'), 'tool'), 'native')!;
  assert.equal(root.blocks[0]?.text, 'Root'); assert.equal(child.blocks[0]?.text, 'Child');
  assert.equal(child.parentToolUseId, 'tool');
  assert.equal(streams.accept(event({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: 'PRIVATE' } }), 'native'), undefined);
  assert.equal(streams.accept(event({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'PRIVATE' } }), 'native'), undefined);
  assert.equal(streams.accept(event({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', input: { secret: 'PRIVATE' } } }), 'native'), undefined);
  assert.equal(streams.accept(event({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'PRIVATE' } }), 'native'), undefined);
  const capped = streams.accept(event(delta('x'.repeat(120_000))), 'native')!;
  assert.equal(capped.blocks[0]?.text.length, 100_000); assert.equal(capped.blocks[0]?.truncated, true);
  assert.equal(streams.accept(event(delta('more')), 'native'), undefined, 'do not repeatedly publish already truncated text');
  assert.ok(!JSON.stringify(capped).includes('PRIVATE'));
  assert.equal(root.blocks[0]?.text, 'Root', 'snapshots do not share mutable buffers');
});

test('stream final index mappings reject malformed aliases and native blocks cannot cross-bind', () => {
  assert.throws(() => validateClaudeStreamFinal({ messageId: 'id', blockIndexes: [0, 0] }));
  assert.throws(() => validateClaudeStreamFinal({ messageId: 'id', blockIndexes: [-1] }));
  assert.throws(() => validateClaudeStreamFinal({ messageId: 'id', blockIndexes: [256] }));
  const streams = new ClaudeTextStreams();
  streams.accept(event(start('id')), 'native');
  assert.throws(() => streams.accept(event({ type: 'content_block_stop', index: 0 }), 'native'));
  assert.throws(() => streams.accept(event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }), 'native'));
  streams.accept(event(block('text')), 'native');
  streams.accept(event({ type: 'content_block_stop', index: 0 }), 'native');
  streams.accept(event({ type: 'message_stop' }), 'native');
  assert.deepEqual(streams.complete({ type: 'assistant', session_id: 'native', parent_tool_use_id: null,
    message: { id: 'id', content: 'text' } }, 'native'), { messageId: 'id', blockIndexes: [0] });
  streams.accept(event(start('next')), 'native');
});

test('Claude partial reducer rejects foreign, missing, out-of-order or excessive stream identities', () => {
  const streams = new ClaudeTextStreams();
  assert.throws(() => streams.accept(event(delta('unknown')), 'native'));
  assert.throws(() => streams.accept(event(start('root')), 'foreign'));
  streams.accept(event(start('root')), 'native');
  assert.throws(() => streams.accept(event(start('root')), 'native'));
  streams.accept(event(block()), 'native');
  streams.accept(event({ type: 'content_block_stop', index: 0 }), 'native');
  assert.throws(() => streams.accept(event(delta('late')), 'native'));
  assert.throws(() => streams.complete({ type: 'assistant', session_id: 'native', parent_tool_use_id: null, message: { id: 'foreign' } }, 'native'));
  assert.deepEqual(streams.complete({ type: 'assistant', session_id: 'native', parent_tool_use_id: null,
    message: { id: 'root', content: 'text' } }, 'native'), { messageId: 'root', blockIndexes: [0] });
  const valid = { messageId: 'id', parentToolUseId: null, blocks: [{ blockIndex: 0, text: 'ok', truncated: false }] };
  assert.deepEqual(validateClaudeTextStream({ ...valid, secret: 'PRIVATE' }), valid);
  assert.throws(() => validateClaudeTextStream({ ...valid, blocks: [...valid.blocks, ...valid.blocks] }));
  assert.throws(() => validateClaudeTextStream({ ...valid, blocks: [{ blockIndex: 0, text: 'x'.repeat(100_001), truncated: false }] }));
});

test('finalized local index zero maps to each distinct provider block; partial cleanup is exact-execution scoped', () => {
  const source = new ConnectorUserStore(':memory:', () => true);
  const key = 'claude-code:multiple', ref = { key, id: 'run', epoch: 'epoch' };
  try {
    source.claudeJournal.create({ key, nativeSessionId: 'native', title: 'Stream', createdAt: 1 });
    source.turns.enqueue('claude-code', { id: 'input', sessionKey: key, createdAt: 2, payload: { text: 'Input' } });
    source.claudeJournal.begin(ref, ['input'], source.turns);
    source.claudeJournal.acknowledge(ref, 'request', source.turns);
    const snapshot = { messageId: 'provider', parentToolUseId: null, blocks: [
      { blockIndex: 0, text: 'First', truncated: false }, { blockIndex: 1, text: 'Second', truncated: false },
    ] };
    source.claudeTranscript.updateStream(ref, snapshot);
    const before = claudeHistoryPage(source, key)!;
    for (const [index, text] of ['First', 'Second'].entries()) {
      source.claudeTranscript.append(ref, projectClaudeMessage({ type: 'assistant', uuid: `final-${index}`, session_id: 'native',
        parent_tool_use_id: null, message: { role: 'assistant', content: text } }, 'native'), { messageId: 'provider', blockIndexes: [index] });
    }
    const after = claudeHistoryPage(source, key)!;
    assert.deepEqual(after.messages, before.messages, 'finalization retains both IDs and timestamps');
    assert.equal(source.claudeTranscript.liveMessages(key).length, 0);
    assert.equal(claudeHistoryMessage(source, key, before.messages[1]!.id)?.text, 'Second');
    assert.deepEqual(claudeHistoryPage(source, key, 200, before.messages[1]!.id)?.messages.map(m => m.text), ['First']);
    source.claudeTranscript.updateStream(ref, { ...snapshot, messageId: 'incomplete' });
    source.claudeTranscript.endStreams({ ...ref, epoch: 'old' });
    assert.equal(source.claudeTranscript.liveMessages(key).length, 2);
    source.claudeTranscript.endStreams(ref);
    assert.equal(source.claudeTranscript.liveMessages(key).length, 0);
    assert.deepEqual(claudeHistoryPage(source, key)!.messages, after.messages, 'partial cleanup cannot delete durable history');
  } finally { source.close(); }
});

test('live text shares authorized history paging; final history keeps IDs and drops provisional copy atomically', () => {
  const source = new ConnectorUserStore(':memory:', () => true);
  const key = 'claude-code:stream', ref = { key, id: 'run', epoch: 'epoch' };
  try {
    source.claudeJournal.create({ key, nativeSessionId: 'native', title: 'Stream', createdAt: 1 });
    source.turns.enqueue('claude-code', { id: 'input', sessionKey: key, createdAt: 2, payload: { text: 'Input' } });
    source.claudeJournal.begin(ref, ['input'], source.turns);
    source.claudeJournal.acknowledge(ref, 'request', source.turns);
    const stream = { messageId: 'provider', parentToolUseId: null, blocks: [{ blockIndex: 0, text: 'Hel', truncated: false }] };
    source.claudeTranscript.updateStream(ref, stream);
    const first = claudeHistoryPage(source, key)!;
    assert.equal(first.messages[0]?.text, 'Hel');
    const id = first.messages[0]!.id;
    source.turns.enqueue('claude-code', { id: 'queued', sessionKey: key, createdAt: 3, payload: { text: 'Next' } });
    assert.deepEqual(claudeHistoryPage(source, key)!.messages.map(m => m.text), ['Hel', 'Next']);
    assert.equal(claudeHistoryPage(source, key, 1, 'queued')!.messages[0]?.id, id);
    assert.equal(claudeHistoryPage(source, key, 1, id)!.messages.length, 0);
    source.claudeTranscript.updateStream(ref, { ...stream, blocks: [{ blockIndex: 0, text: 'Hello', truncated: false }] });
    assert.equal(claudeHistoryPage(source, key)!.messages[0]?.id, id);
    assert.throws(() => source.claudeTranscript.updateStream({ ...ref, epoch: 'stale' }, stream));
    assert.throws(() => source.claudeTranscript.updateStream(ref, stream), 'stale text cannot replace a longer snapshot');
    source.claudeTranscript.append(ref, projectClaudeMessage({ type: 'assistant', uuid: 'final-uuid', session_id: 'native',
      parent_tool_use_id: null, message: { role: 'assistant', content: 'Hello' } }, 'native'), { messageId: 'provider', blockIndexes: [0] });
    assert.equal(source.claudeTranscript.liveMessages(key).length, 0);
    const final = claudeHistoryPage(source, key)!;
    assert.deepEqual(final.messages.map(m => m.id), [id, 'queued']);
    assert.equal(final.totalCount, 2);
    assert.equal(claudeHistoryMessage(source, key, id)?.text, 'Hello');
    assert.equal(claudeHistoryPage(source, key, 1, id)!.messages.length, 0);
  } finally { source.close(); }
});
