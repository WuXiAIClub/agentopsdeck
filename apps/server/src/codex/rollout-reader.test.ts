import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexRolloutReader } from './rollout-reader.js';
import { requireInterruptedDispatchSettled } from './interrupted-dispatch.js';
import { threadModelFromRollout } from './app-server.js';
import { codexRolloutUsage } from './usage.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

test('overlapping independent reads retain operation-local byte and record counts', async context => {
  const { file } = fixture(context), rows: any[] = [];
  const reader = new CodexRolloutReader({ shareConcurrentReads: false,
    diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line))) });
  context.after(() => reader.close());
  const source = record('turn_context', { model: 'first' }) + record('turn_context', { model: 'second' });
  writeFileSync(file, source);
  await Promise.all([reader.read(file), reader.read(file)]);
  assert.equal(rows.length, 2);
  for (const row of rows) { assert.equal(row.sourceBytes, Buffer.byteLength(source)); assert.equal(row.records, 2); }
  assert.equal(reader.cacheStats().sourceBytesRead, Buffer.byteLength(source) * 2);
});

test('per-read diagnostics distinguish stat-only hits, verified growth and live second-pass bytes', async context => {
  const { file } = fixture(context), rows: any[] = [];
  const reader = new CodexRolloutReader({ diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line))) });
  context.after(() => reader.close());
  const first = record('turn_context', { model: 'private-message' });
  writeFileSync(file, first); await reader.read(file);
  assert.equal(rows[0].sourceBytes, Buffer.byteLength(first)); assert.equal(rows[0].records, 1);
  await reader.read(file);
  assert.equal(rows[1].cacheHit, 1); assert.equal(rows[1].sourceBytes, undefined);
  assert.equal(typeof rows[1].snapshotVerificationMs, 'number');
  const tail = record('turn_context', { model: 'private-tail' });
  appendFileSync(file, tail); await reader.read(file);
  assert.equal(rows[2].prefixBytes, Buffer.byteLength(first)); assert.equal(rows[2].records, 1);
  assert.equal(rows[2].reusedPrefix, 1); assert.equal(rows[2].sourceBytes, Buffer.byteLength(first + tail));
  let appended = false;
  onRead(context, file, () => { if (!appended) { appended = true; appendFileSync(file, tail); } });
  // Cache hit enters verification through stat. Force one new revision before
  // reading so the hook can append during the source read.
  appendFileSync(file, tail); const capturedBytes = Buffer.byteLength(first + tail + tail);
  await reader.read(file, { consistency: 'live-prefix' });
  assert.equal(rows[3].snapshotBytes, capturedBytes);
  assert.equal(reader.cacheStats().snapshotVerificationBytes, capturedBytes);
  assert.doesNotMatch(JSON.stringify(rows), /private-message|private-tail|rollout.jsonl/);
});

function fixture(context: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-streamed-rollout-'));
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); rmSync(directory, { recursive: true, force: true }); });
  const file = join(directory, 'rollout.jsonl');
  const reader = new CodexRolloutReader();
  return { file, reader };
}
const record = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + '\n';

function onRead(context: test.TestContext, file: string, hook: (position: number, read: number) => void) {
  const original = fsPromises.open;
  let reads = 0, closed = 0, requested = 0;
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (args[0] !== file) return handle;
    const read = handle.read.bind(handle), close = handle.close.bind(handle);
    context.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
      assert.ok(length <= 1024 * 1024);
      requested += length;
      const result = await read(buffer, offset, length, position);
      hook(position, ++reads);
      return result;
    });
    context.mock.method(handle, 'close', async () => { closed++; return close(); });
    return handle;
  });
  syncBuiltinESMExports();
  return () => ({ reads, closed, requested });
}

test('live fixed prefix survives continuous appends without chasing EOF, then includes them on the next read', async context => {
  const { file, reader } = fixture(context);
  const source = record('turn_context', { turn_id: 'first', model: 'first' })
    + record('response_item', { type: 'reasoning', encrypted_content: 'x'.repeat(3 * 1024 * 1024) });
  writeFileSync(file, source);
  let writing = true;
  const stats = onRead(context, file, (_, read) => {
    if (writing) appendFileSync(file, record('turn_context', { turn_id: `append-${read}`, model: `append-${read}` }));
  });
  const first = await reader.read(file, { consistency: 'live-prefix' });
  assert.match(first, /"model":"first"/);
  assert.doesNotMatch(first, /append-/);
  assert.deepEqual(stats(), { reads: 8, closed: 1, requested: 2 * Buffer.byteLength(source) });
  writing = false;
  const next = await reader.read(file);
  assert.match(next, /append-8/);
  const beforeWarm = stats().reads;
  assert.equal(await reader.read(file), next);
  assert.equal(stats().reads, beforeWarm, 'unchanged snapshot needs no file reads');
});

for (const change of ['rewrite-and-grow', 'truncate', 'verification-rewrite'] as const) {
  test(`live prefix rejects ${change}, closes its handle and recovers without cached mixed history`, async context => {
    const { file, reader } = fixture(context);
    const original = record('turn_context', { model: 'original' });
    writeFileSync(file, original);
    const stats = onRead(context, file, (_, read) => {
      if (read === 1) {
        if (change === 'truncate') truncateSync(file, 0);
        else if (change === 'rewrite-and-grow') writeFileSync(file, record('turn_context', { model: 'rewritten' }) + original);
        else appendFileSync(file, original);
      }
      if (change === 'verification-rewrite' && read === 2) writeFileSync(file, record('turn_context', { model: 'changed-again' }));
    });
    await assert.rejects(reader.read(file, { consistency: 'live-prefix' }), /changed/);
    assert.equal(stats().closed, 1);
    writeFileSync(file, record('turn_context', { model: 'recovered' }));
    assert.match(await reader.read(file), /recovered/);
  });
}

test('stable reads still reject growth and cannot reuse live-prefix evidence as a newer stable snapshot', async context => {
  const { file, reader } = fixture(context);
  writeFileSync(file, record('turn_context', { model: 'original' }));
  onRead(context, file, (_, read) => appendFileSync(file, record('turn_context', { model: `append-${read}` })));
  assert.match(await reader.read(file, { consistency: 'live-prefix' }), /original/);
  await assert.rejects(reader.read(file), /changed during read/);
});

test('live prefix uses the same verification when an unchanged cache hit races with append', async context => {
  const { file, reader } = fixture(context);
  writeFileSync(file, record('turn_context', { model: 'cached' }));
  const cached = await reader.read(file);
  const original = fsPromises.open;
  let stats = 0;
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args), stat = handle.stat.bind(handle);
    context.mock.method(handle, 'stat', async () => {
      const result = await stat();
      if (++stats === 1) appendFileSync(file, record('turn_context', { model: 'later' }));
      return result;
    });
    return handle;
  });
  syncBuiltinESMExports();
  assert.equal(await reader.read(file, { consistency: 'live-prefix' }), cached);
  assert.match(await reader.read(file), /later/);
});

test('large raw history retains all relevant evidence without a whole-file allocation', async context => {
  const { file, reader } = fixture(context);
  writeFileSync(file, record('turn_context', { turn_id: 'first', model: 'model-first' }));
  const reasoning = record('response_item', { type: 'reasoning', encrypted_content: 'x'.repeat(1024 * 1024) });
  for (let index = 0; index < 66; index++) appendFileSync(file, reasoning);
  appendFileSync(file, record('turn_context', { turn_id: 'last', model: 'model-last' }));
  appendFileSync(file, record('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'unanswered', input: 'do not run' }));
  const result = await reader.read(file);
  assert.ok(result.length < 10_000);
  assert.ok(result.includes('model-first') && result.includes('model-last'));
  assert.throws(() => requireInterruptedDispatchSettled(result, { id: 'last', status: 'interrupted' }), /cleanup is unconfirmed/);
});

test('tool-heavy history may project beyond the former 64 MiB limit', async context => {
  const { file, reader } = fixture(context);
  const output = 'x'.repeat(1024 * 1024);
  for (let index = 0; index < 65; index++) {
    appendFileSync(file, record('response_item', {
      type: 'function_call_output', call_id: `call-${index}`, output,
    }));
  }
  appendFileSync(file, record('turn_context', { turn_id: 'latest', model: 'model-latest' }));
  const result = await reader.read(file);
  assert.ok(Buffer.byteLength(result) > 64 * 1024 * 1024);
  assert.ok(result.includes('model-latest'));
});

test('unchanged history reuses projection and append validates the old prefix', async context => {
  const { file, reader } = fixture(context);
  const initial = record('turn_context', { turn_id: 'first', model: 'first' });
  writeFileSync(file, initial);
  const first = await reader.read(file);
  let reads = 0;
  const original = fsPromises.open;
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    const read = handle.read.bind(handle);
    context.mock.method(handle, 'read', (...parameters: any[]) => { reads++; return (read as any)(...parameters); });
    return handle;
  });
  syncBuiltinESMExports();
  assert.equal(await reader.read(file), first);
  assert.equal(reads, 0);
  appendFileSync(file, record('turn_context', { turn_id: 'second', model: 'second' }));
  const appended = await reader.read(file);
  assert.ok(appended.startsWith(first) && appended.includes('second'));
  assert.ok(reads >= 2);
  writeFileSync(file, initial.replace('first', 'other') + ' '.repeat(500));
  await assert.rejects(reader.read(file), /prefix changed/);
  const rewritten = await reader.read(file);
  assert.ok(rewritten.includes('other') && !rewritten.includes('second'));
});

test('partial trailing record is reparsed when completed, including UTF-8', async context => {
  const { file, reader } = fixture(context);
  const line = record('response_item', { type: 'function_call_output', call_id: 'call', output: '中文🙂' });
  writeFileSync(file, line.slice(0, -4));
  assert.equal(await reader.read(file), '');
  appendFileSync(file, line.slice(-4));
  assert.ok((await reader.read(file)).includes('中文🙂'));
});

test('over-budget record never certifies an incomplete projection', async context => {
  const { file, reader } = fixture(context);
  writeFileSync(file, record('response_item', { type: 'function_call_output', output: 'x'.repeat(8 * 1024 * 1024) }));
  await assert.rejects(reader.read(file), /record budget/);
});

test('projection preserves model, compaction and usage evidence exactly', async context => {
  const { file, reader } = fixture(context);
  const source = record('session_meta', { id: 'thread' })
    + record('turn_context', { type: 'turn_context', turn_id: 'first', model: 'original' })
    + record('event_msg', { type: 'task_complete' })
    + record('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'replacement' } })
    + record('event_msg', { type: 'task_complete', error: 'failed' })
    + record('compacted', { replacement_history: ['irrelevant'] })
    + record('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 1234 }, model_context_window: 200000 } });
  writeFileSync(file, source);
  const projected = await reader.read(file);
  assert.equal(threadModelFromRollout(projected), threadModelFromRollout(source));
  assert.deepEqual(codexRolloutUsage(projected), codexRolloutUsage(source));
});

for (const envelope of ['native', 'payload-only'] as const) {
  test(`streamed model recovery retains ${envelope} contexts and successful-turn precedence`, async context => {
    const { file, reader } = fixture(context);
    const contextRow = (model: string) => envelope === 'native'
      ? record('turn_context', { turn_id: model, model })
      : JSON.stringify({ payload: { type: 'turn_context', turn_id: model, model } }) + '\n';
    const event = (payload: unknown) => envelope === 'native'
      ? record('event_msg', payload) : JSON.stringify({ payload }) + '\n';
    let source = contextRow('persisted');
    writeFileSync(file, source);
    assert.equal(threadModelFromRollout(source), 'persisted');
    assert.equal(threadModelFromRollout(await reader.read(file)), 'persisted');
    const appended = event({ type: 'thread_settings_applied', thread_settings: { model: 'selected' } })
      + event({ type: 'task_complete' }) + contextRow('failed-attempt')
      + event({ type: 'task_complete', error: 'failed' });
    appendFileSync(file, appended);
    source += appended;
    assert.equal(threadModelFromRollout(source), 'selected');
    assert.equal(threadModelFromRollout(await reader.read(file)), 'selected');
    assert.equal(threadModelFromRollout(await reader.read(file)), 'selected', 'cached projection retains model evidence');
  });
}
