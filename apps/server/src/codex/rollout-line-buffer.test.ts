import assert from 'node:assert/strict';
import test from 'node:test';
import { RolloutLineBuffer } from './rollout-line-buffer.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRolloutReader } from './rollout-reader.js';
import { bindToolRecord, readIndexedToolMessage, rolloutToolOutputText } from './indexed-tool-output.js';
import { createHash } from 'node:crypto';

test('complete records borrow the read buffer without a whole-chunk copy', t => {
  const chunk = Buffer.from('first\r\n\nlast\n');
  t.mock.method(Buffer, 'concat', () => { throw Error('Unexpected copy'); });
  const lines = new RolloutLineBuffer();
  const result = [...lines.push(chunk)];
  assert.deepEqual(result.map(row => row.toString()), ['first\r', '', 'last']);
  for (const row of result) assert.equal(row.buffer, chunk.buffer);
  assert.equal(lines.finish().length, 0);
});

test('fragmented records concatenate exactly once and copy linearly', t => {
  const fragments = 8, size = 1024 * 1024;
  const chunk = Buffer.alloc(size, 120), ending = Buffer.from('\nnext\n');
  const concat = Buffer.concat;
  const concatenations: number[] = [];
  t.mock.method(Buffer, 'concat', (parts: readonly Uint8Array[], length?: number) => {
    concatenations.push(parts.reduce((sum, part) => sum + part.length, 0));
    return concat(parts, length);
  });
  const lines = new RolloutLineBuffer(fragments * size);
  for (let index = 0; index < fragments; index++) assert.deepEqual([...lines.push(chunk)], []);
  assert.deepEqual(concatenations, [], 'no repeated growing-prefix concatenation');
  const result = [...lines.push(ending)];
  assert.equal(result[0]!.length, fragments * size);
  assert.ok(result[0]!.every(byte => byte === 120));
  assert.equal(result[1]!.toString(), 'next');
  assert.deepEqual(concatenations, [fragments * size]);
  assert.equal(lines.finish().length, 0);
});

test('reused buffers preserve split UTF-8, CRLF, empty records and partial EOF bytes', () => {
  const source = Buffer.concat([Buffer.from('你好🙂\r\n\ntail'), Buffer.from([0xff, 0xc3])]);
  for (const size of [1, 2, 3, 7, source.length]) {
    const lines = new RolloutLineBuffer(), buffer = Buffer.alloc(size);
    const records: Buffer[] = [];
    for (let at = 0; at < source.length; at += size) {
      const length = Math.min(size, source.length - at);
      source.copy(buffer, 0, at, at + length);
      for (const line of lines.push(buffer.subarray(0, length))) records.push(Buffer.from(line));
      buffer.fill(0); // caller reuses native read storage after consumption
    }
    assert.deepEqual(records, [Buffer.from('你好🙂\r'), Buffer.alloc(0)]);
    assert.deepEqual(lines.finish(), source.subarray(Buffer.byteLength('你好🙂\r\n\n')));
    assert.equal(lines.finish().length, 0);
  }
});

test('record limits include cross-chunk fragments, exclude newline, and reset per record', () => {
  const lines = new RolloutLineBuffer(4);
  assert.deepEqual([...lines.push(Buffer.from('ab'))], []);
  assert.deepEqual([...lines.push(Buffer.from('cd\n1234\n'))].map(row => row.toString()), ['abcd', '1234']);
  assert.throws(() => [...lines.push(Buffer.from('12345\n'))], /record budget/);
  const partial = new RolloutLineBuffer(4);
  [...partial.push(Buffer.from('1234'))];
  assert.throws(() => [...partial.push(Buffer.from('5'))], /record budget/);
  const completed = new RolloutLineBuffer(4);
  [...completed.push(Buffer.from('1234'))];
  assert.throws(() => [...completed.push(Buffer.from('5\n'))], /record budget/);
});

test('empty chunks and EOF without newline preserve all bytes', () => {
  const lines = new RolloutLineBuffer();
  assert.deepEqual([...lines.push(Buffer.alloc(0))], []);
  [...lines.push(Buffer.from('ab'))];
  [...lines.push(Buffer.from('cd'))];
  assert.equal(lines.finish().toString(), 'abcd');
});

test('multi-chunk tool records retain exact indexed bytes after an unprojected UTF-8 prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rollout-fragment-index-'));
  const file = join(directory, 'history.jsonl');
  const reader = new CodexRolloutReader({ indexToolOutputs: true, projectionMemoryBytes: 0 });
  const output = '你好🙂'.repeat(400_000);
  const prefix = Buffer.concat([Buffer.from('ignored '), Buffer.from([0xff]), Buffer.from('\r\n')]);
  const record = Buffer.from(JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'cross-chunk', output } }) + '\r');
  await writeFile(file, Buffer.concat([prefix, record, Buffer.from('\n')]));
  try {
    const projected = (await reader.read(file)).trim().split('\n').map(line => JSON.parse(line));
    const indexed = projected[0].payload.agentopsdeckIndexedOutput;
    assert.equal(indexed.reference.offset, prefix.length);
    assert.equal(indexed.reference.bytes, record.length);
    const message = bindToolRecord({ id: 'cross-chunk', sessionKey: 'codex:fixture', role: 'tool', text: indexed.preview, createdAt: 1 }, file, indexed, '');
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    assert.equal(digest((await readIndexedToolMessage(message)).text), digest(rolloutToolOutputText(output)));
  } finally { await reader.close(); await rm(directory, { recursive: true, force: true }); }
});
