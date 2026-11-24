import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { historicalMessages } from './app-server.js';
import { readIndexedToolMessage, rolloutToolOutputText } from './indexed-tool-output.js';
import { RolloutProjectionBuilder } from './rollout-projection.js';
import { CodexRolloutReader } from './rollout-reader.js';

const row = (payload: unknown, timestamp?: unknown, type = 'response_item') => JSON.stringify({ type, payload, timestamp }) + '\n';
const iso = (seconds: number) => new Date(1700000000000 + seconds * 1000).toISOString();
const turn = (items: unknown[]) => [{ id: 'turn', status: 'completed', startedAt: 1, items }];
const assistant = (id: string, text: string) => ({ id, type: 'agentMessage', text });

for (const memoryLimit of [0, 1024 * 1024]) test(`history facts scan once and preserve string equivalence (memory=${memoryLimit})`, async () => {
  const text = row({ turn_id: 'turn' }, undefined, 'turn_context')
    + row({ type: 'message', role: 'assistant', content: [{ text: 'answer' }] }, iso(1))
    + row({ type: 'function_call', call_id: 'tool', name: 'exec_command', arguments: '{"cmd":"test"}' }, iso(2))
    + row({ type: 'function_call_output', call_id: 'tool', output: 'result' }, iso(3))
    + '\n{partial\n';
  const builder = new RolloutProjectionBuilder(memoryLimit);
  let projection;
  try {
    for (const line of text.split('\n').slice(0, -1)) await builder.add(line + '\n');
    projection = await builder.finish();
    let scans = 0;
    const iterate = projection[Symbol.asyncIterator].bind(projection);
    projection[Symbol.asyncIterator] = async function* () { scans++; yield* iterate(); };
    const turns = turn([assistant('answer', 'answer')]);
    assert.deepEqual(await historicalMessages('codex:one', turns, undefined, projection), await historicalMessages('codex:one', turns, undefined, text));
    assert.equal(scans, 1);
  } finally { await projection?.dispose(); await builder.abort(); }
});

test('repeated assistant text consumes distinct timestamps, first item timestamp wins', async () => {
  const source = row({ type: 'message', role: 'user', id: 'input' }, iso(1))
    + row({ type: 'message', role: 'user', id: 'input' }, iso(9))
    + row({ type: 'message', role: 'assistant', content: [{ text: 'same' }] }, iso(2))
    + row({ type: 'message', role: 'assistant', content: [{ text: 'same' }] }, iso(3));
  const turns = turn([{ id: 'input', type: 'userMessage', content: [{ type: 'text', text: '  exact\n' }] }, assistant('a', 'same'), assistant('b', 'same')]);
  const messages = await historicalMessages('codex:one', turns, undefined, source);
  assert.deepEqual(messages.map(m => [m.text, m.createdAt]), [['  exact\n', Date.parse(iso(1))], ['same', Date.parse(iso(2))], ['same', Date.parse(iso(3))]]);
  const again = await historicalMessages('codex:two', turns, undefined, source);
  assert.deepEqual(again.map(m => m.createdAt), messages.map(m => m.createdAt));
  assert.ok(again.every(m => m.sessionKey === 'codex:two' && m.id.startsWith('codex:two:')));
});

test('tool fallback clock, custom calls, turn context and output-before-call keep prior semantics', async () => {
  const source = row({ turn_id: 'first' }, undefined, 'turn_context')
    + row({ type: 'custom_tool_call_output', call_id: 'a', output: 'early' }, 'invalid')
    + row({ type: 'custom_tool_call', call_id: 'a', name: 'custom', input: 'not-json', status: 'completed' }, 'invalid')
    + row({ type: 'task_started', turn_id: 'second' }, undefined, 'event_msg')
    + row({ type: 'function_call', call_id: 'b', name: 'exec_command', arguments: '{}' }, 'invalid')
    + row({ type: 'function_call_output', call_id: 'orphan', output: 'ignore' }, 'invalid');
  const messages = await historicalMessages('codex:one', [], undefined, source);
  assert.deepEqual(messages.map(m => [m.toolCallId, m.toolPhase, m.turnId, m.createdAt, m.status]), [
    ['a', 'result', 'first', 0, 'sent'], ['a', 'call', 'first', 1, 'sent'], ['b', 'call', 'second', 2, 'sending'],
  ]);
  assert.match(messages[1]!.text, /not-json/);
});

test('duplicate tool IDs keep last call/output and do not duplicate native tool items', async () => {
  const source = row({ type: 'function_call', call_id: 'a', name: 'old', arguments: '{}' }, iso(1))
    + row({ type: 'function_call_output', call_id: 'a', output: 'old' }, iso(2))
    + row({ type: 'function_call', call_id: 'a', name: 'new', arguments: '{}' }, iso(3))
    + row({ type: 'function_call_output', call_id: 'a', output: 'new' }, iso(4));
  const messages = await historicalMessages('codex:one', [], undefined, source);
  assert.equal(messages.length, 2);
  assert.ok(messages.every(m => m.toolName === 'new'));
  assert.equal(messages[0]!.createdAt, Date.parse(iso(3)));
  assert.ok(messages[1]!.text.endsWith('output:\n' + rolloutToolOutputText('new')));
  const native = turn([{ id: 'a', type: 'commandExecution', command: 'native', aggregatedOutput: 'native output', status: 'completed', exitCode: 0 }]);
  const deduped = await historicalMessages('codex:one', native, undefined, source);
  assert.equal(deduped.length, 2);
  assert.ok(deduped.every(m => m.toolCallId === 'a' && m.toolName !== 'new'));
});

test('indexed tool details stay lazy/private and require their original source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-history-facts-'));
  const file = join(directory, 'synthetic.jsonl');
  const reader = new CodexRolloutReader({ indexToolOutputs: true, projectionMemoryBytes: 0 });
  try {
    const body = '你好🌏\n'.repeat(10_000);
    await writeFile(file, row({ type: 'function_call', call_id: 'a', name: 'exec_command', arguments: '{}' })
      + row({ type: 'function_call_output', call_id: 'a', output: body }));
    const projection = await reader.readSnapshot(file);
    try {
      const messages = await historicalMessages('codex:one', [], undefined, projection, file);
      const message = messages.find(m => m.toolPhase === 'result')!;
      assert.ok(message.text.length < 1500);
      assert.ok(!JSON.stringify(messages).includes(file));
      assert.ok((await readIndexedToolMessage(message)).text.endsWith(rolloutToolOutputText(body)));
      await assert.rejects(historicalMessages('codex:one', [], undefined, projection), /Indexed tool source unavailable/);
    } finally { await projection.dispose(); }
  } finally { await reader.close(); await rm(directory, { recursive: true, force: true }); }
});

test('malformed/empty records do not hide failed-turn messages or identity collisions', async () => {
  const source = '\nnull\n[]\n{"type":"response_item"}\n{partial';
  const turns = [{ id: 'turn', status: 'failed', completedAt: 123, error: { message: 'failure' }, items: [assistant('a', 'partial reply')] }];
  const messages = await historicalMessages('codex:one', turns, undefined, source);
  assert.equal(messages.at(-1)?.status, 'failed');
  assert.equal(messages.at(-1)?.text, 'failure');
  await assert.rejects(historicalMessages('codex:one', turn([assistant('same-id', 'one'), assistant('same-id', 'two')]), undefined, source), /history message identity/);
});

test('projection failure propagates and releases iterator lease without returning partial history', async () => {
  const builder = new RolloutProjectionBuilder(0);
  await builder.add(row({ type: 'message', role: 'assistant', content: [{ text: 'answer' }] }, iso(1)));
  const projection = await builder.finish();
  let finalized = false;
  const iterate = projection[Symbol.asyncIterator].bind(projection);
  projection[Symbol.asyncIterator] = async function* () {
    try { for await (const line of iterate()) { yield line; throw Error('synthetic read failure'); } }
    finally { finalized = true; }
  };
  try {
    await assert.rejects(historicalMessages('codex:one', turn([assistant('a', 'answer')]), undefined, projection), /synthetic read failure/);
    assert.equal(finalized, true);
    projection[Symbol.asyncIterator] = iterate;
    assert.equal((await historicalMessages('codex:one', turn([assistant('a', 'answer')]), undefined, projection)).length, 1);
  } finally { await projection.dispose(); }
});

test('concurrent consumers of appended segments do not share consumed assistant timestamps', async () => {
  const headBuilder = new RolloutProjectionBuilder(0), tailBuilder = new RolloutProjectionBuilder(0);
  await headBuilder.add(row({ type: 'message', role: 'assistant', content: [{ text: 'same' }] }, iso(1)));
  await tailBuilder.add(row({ type: 'message', role: 'assistant', content: [{ text: 'same' }] }, iso(2)));
  const head = await headBuilder.finish(), tail = await tailBuilder.finish(), combined = head.append(tail);
  await head.dispose(); await tail.dispose();
  try {
    const turns = turn([assistant('a', 'same'), assistant('b', 'same')]);
    const [first, second] = await Promise.all(['one', 'two'].map(key => historicalMessages(`codex:${key}`, turns, undefined, combined)));
    assert.deepEqual(first!.map(m => m.createdAt), [Date.parse(iso(1)), Date.parse(iso(2))]);
    assert.deepEqual(second!.map(m => m.createdAt), first!.map(m => m.createdAt));
    assert.notEqual(first![0]!.id, second![0]!.id);
  } finally { await combined.dispose(); }
});
