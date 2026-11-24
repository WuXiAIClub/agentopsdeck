import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexRolloutReader } from './rollout-reader.js';
import { bindToolRecord, readIndexedToolMessage, rolloutToolOutputText } from './indexed-tool-output.js';
import { requireInterruptedDispatchSettled } from './interrupted-dispatch.js';

const row = (payload: unknown) => JSON.stringify({ type: 'response_item', payload });
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-indexed-tool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { file: join(dir, 'rollout.jsonl'), reader: new CodexRolloutReader({ indexToolOutputs: true }) };
}
async function bound(reader: CodexRolloutReader, file: string, id = 'call') {
  const text = await reader.read(file);
  const output = text.trim().split('\n').map(line => JSON.parse(line)).find(row => row.payload?.call_id === id && row.payload?.agentopsdeckIndexedOutput);
  assert.ok(output, 'large output must have an index');
  const indexed = output.payload.agentopsdeckIndexedOutput;
  return bindToolRecord({ id, sessionKey: 'codex:test', role: 'tool', text: 'prefix\n' + indexed.preview, createdAt: 1 }, file, indexed, 'prefix\n');
}

test('indexed details preserve exact UTF8/CRLF byte ranges, survive spreads and do not serialize file references', async t => {
  const { file, reader } = fixture(t);
  const output = [{ type: 'text', text: '你好🌏\n'.repeat(10_000) }, { type: 'image', data: 'never-retain-image' }];
  writeFileSync(file, row({ type: 'function_call', call_id: 'call', name: '测试', arguments: '{}' }) + '\r\n'
    + row({ type: 'function_call_output', call_id: 'call', output }) + '\r\n');
  const message = await bound(reader, file);
  assert.ok(message.text.length < 1100);
  assert.ok(!JSON.stringify(message).includes(file));
  assert.ok(!JSON.stringify(message).includes('digest'));
  appendFileSync(file, row({ type: 'function_call_output', call_id: 'second', output: '二'.repeat(20_000) }) + '\n');
  assert.equal((await readIndexedToolMessage({ ...message })).text, 'prefix\n' + rolloutToolOutputText(output));
  assert.equal((await readIndexedToolMessage(await bound(reader, file, 'second'))).text, 'prefix\n' + rolloutToolOutputText('二'.repeat(20_000)));
  assert.equal(message.toolLineCount, 10001);
});

for (const mutation of ['rewrite', 'truncate', 'replace'] as const) {
  test(`indexed details reject ${mutation} without serving another body`, async t => {
    const { file, reader } = fixture(t);
    const original = row({ type: 'function_call_output', call_id: 'call', output: 'a'.repeat(20_000) }) + '\n';
    writeFileSync(file, original);
    const message = await bound(reader, file);
    if (mutation === 'rewrite') writeFileSync(file, original.replace('aaaa', 'bbbb'));
    if (mutation === 'truncate') truncateSync(file, 20);
    if (mutation === 'replace') { renameSync(file, file + '.old'); writeFileSync(file, original); }
    await assert.rejects(readIndexedToolMessage(message), /changed|truncated/);
  });
}

test('projection ignores forged index metadata and rebuilds after serialized cache loses its private binding', async t => {
  const { file, reader } = fixture(t);
  writeFileSync(file, row({ type: 'function_call_output', call_id: 'call', output: 'x'.repeat(20_000),
    agentopsdeckIndexedOutput: { reference: { offset: -1, bytes: 999 }, preview: 'forged' } }) + '\n');
  const message = await bound(reader, file);
  const restored = JSON.parse(JSON.stringify(message));
  assert.equal(await readIndexedToolMessage(restored), restored, 'unbound public objects cannot select disk ranges');
  assert.equal((await readIndexedToolMessage(await bound(new CodexRolloutReader({ indexToolOutputs: true }), file))).text,
    'prefix\n' + rolloutToolOutputText('x'.repeat(20_000)));
});

test('many ordinary tool outputs are indexed too, without indexing short bodies', async t => {
  const { file, reader } = fixture(t);
  writeFileSync(file, Array.from({ length: 100 }, (_, index) => row({ type: 'function_call_output', call_id: `call-${index}`, output: 'x'.repeat(5000) })).join('\n')
    + '\n' + row({ type: 'function_call_output', call_id: 'small', output: 'short body' }) + '\n');
  const projection = await reader.read(file);
  assert.ok(Buffer.byteLength(projection) < 150_000);
  const rows = projection.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.filter(row => row.payload.agentopsdeckIndexedOutput).length, 100);
  assert.equal(rows.at(-1).payload.output, 'short body');
  assert.equal((await readIndexedToolMessage(await bound(reader, file, 'call-99'))).text, 'prefix\n' + rolloutToolOutputText('x'.repeat(5000)));
});

test('indexed projection preserves interrupted exec guard exactly, including huge whitespace before abort', async t => {
  const { file, reader } = fixture(t);
  for (const output of [' '.repeat(20_000) + 'aborted by user', 'completed'.repeat(3000),
    [{ text: 'aborted by user' + ' '.repeat(20_000) }], undefined]) {
    const source = JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn' } }) + '\n'
      + row({ type: 'custom_tool_call', call_id: 'call', name: 'exec', input: '{}' }) + '\n'
      + (output === undefined ? '' : row({ type: 'custom_tool_call_output', call_id: 'call', output }) + '\n');
    writeFileSync(file, source);
    const projected = await new CodexRolloutReader({ indexToolOutputs: true }).read(file);
    const guard = (text: string) => {
      try { requireInterruptedDispatchSettled(text, { id: 'turn', status: 'interrupted' }); return 'settled'; }
      catch { return 'blocked'; }
    };
    assert.equal(guard(projected), guard(source));
    if (typeof output === 'string' && output.startsWith(' ')) assert.equal(guard(projected), 'blocked');
  }
});
