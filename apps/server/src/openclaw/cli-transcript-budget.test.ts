import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { startOpenClawAgentFallback } from './cli.js';

type Completion = Parameters<NonNullable<Parameters<typeof startOpenClawAgentFallback>[5]>>[0];
const transcriptLimit = 1024 * 1024;
const row = (id: string, text: string) => JSON.stringify({ id, timestamp: Date.now(), message: { role: 'assistant', content: [{ type: 'text', text }] } });

function fixture(context: TestContext, bytes: string | Buffer) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-cli-transcript-'));
  const sessionDirectory = join(directory, '.openclaw', 'agents', 'synthetic', 'sessions');
  const file = join(sessionDirectory, 'original.jsonl');
  mkdirSync(sessionDirectory, { recursive: true }); writeFileSync(file, bytes);
  const originalHome = process.env.HOME;
  process.env.HOME = directory;
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  let lifetime!: Promise<void>, result: Completion | undefined, drained = false;
  context.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  const starting = startOpenClawAgentFallback('original', 'synthetic', 'display', 'input', 'original',
    completed => { result = completed; }, pending => { lifetime = pending; void pending.then(() => { drained = true; }); });
  context.after(async () => {
    child.emit('exit', 0, null); child.emit('close', 0, null); await starting; await lifetime;
    context.mock.restoreAll(); syncBuiltinESMExports();
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    rmSync(directory, { recursive: true, force: true });
  });
  return { file, sessionDirectory, drained: () => drained, complete: async () => {
    child.stdout.emit('data', Buffer.from('{"result":{"payloads":[{"text":"original stdout reply"}]}}'));
    child.emit('exit', 0, null); await starting; child.emit('close', 0, null); await lifetime;
    assert.ok(result?.ok); assert.equal(result.replyText, 'original stdout reply');
    return result.messages;
  } };
}

test('CLI transcript reads only a bounded tail while preserving original stdout reply', async context => {
  const setup = fixture(context, `${row('outside', 'outside tail')}\n${' '.repeat(2 * transcriptLimit)}\n${row('inside', 'recent transcript')}\n`);
  const nativeOpen = fsPromises.open;
  let bytesRequested = 0;
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof nativeOpen>) => {
    const handle = await nativeOpen(...args), nativeRead = handle.read.bind(handle);
    context.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
      bytesRequested += length;
      assert.ok(position > 0, 'large transcript must not be read from the beginning');
      return nativeRead(buffer, offset, length, position);
    });
    return handle;
  });
  syncBuiltinESMExports();
  const messages = await setup.complete();
  assert.equal(messages.some(message => message.text === 'outside tail'), false);
  assert.equal(messages.some(message => message.text === 'recent transcript'), true);
  assert.ok(bytesRequested > 0 && bytesRequested <= transcriptLimit + 1);
});

test('CLI transcript tail preserves a complete record exactly at its byte boundary', async context => {
  const first = `${row('boundary', '边界🙂')}\n`;
  const suffix = Buffer.concat([Buffer.from(first), Buffer.alloc(transcriptLimit - Buffer.byteLength(first), 32)]);
  const setup = fixture(context, Buffer.concat([Buffer.from('unread prefix\n'), suffix]));
  const messages = await setup.complete();
  assert.equal(messages.some(message => message.text === '边界🙂'), true);
});

test('CLI transcript discards a cut UTF-8 record but retains complete later records', async context => {
  const setup = fixture(context, `${row('cut', '🙂'.repeat(transcriptLimit / 2))}\r\n${row('last', '完整尾部🙂')}`);
  const messages = await setup.complete();
  assert.equal(messages.some(message => message.id.includes(':cut:')), false);
  assert.equal(messages.some(message => message.text === '完整尾部🙂'), true);
  assert.equal(messages.some(message => message.text.includes('\uFFFD')), false);
});

test('CLI transcript directory overflow closes the scan without guessing a newest file', async context => {
  const setup = fixture(context, `${row('guess', 'must not select an incomplete scan')}\n`);
  let visits = 0, closed = false;
  context.mock.method(fsPromises, 'opendir', async () => ({ async *[Symbol.asyncIterator]() {
    try {
      visits++; yield { name: 'original.jsonl', isFile: () => true };
      for (let index = 0; index < 8192; index++) { visits++; yield { name: `${index}.jsonl`, isFile: () => true }; }
    } finally { closed = true; }
  } }));
  syncBuiltinESMExports();
  const messages = await setup.complete();
  assert.deepEqual(messages, []);
  assert.equal(closed, true);
  assert.equal(visits, 4097);
});

test('CLI transcript short reads reassemble UTF-8 before decoding and close the descriptor', async context => {
  const setup = fixture(context, row('short', '短读🙂'));
  const nativeOpen = fsPromises.open;
  let closes = 0;
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof nativeOpen>) => {
    const handle = await nativeOpen(...args), nativeRead = handle.read.bind(handle), nativeClose = handle.close.bind(handle);
    context.mock.method(handle, 'read', (buffer: Buffer, offset: number, length: number, position: number) =>
      nativeRead(buffer, offset, Math.min(length, 7), position));
    context.mock.method(handle, 'close', async () => { closes++; await nativeClose(); });
    return handle;
  });
  syncBuiltinESMExports();
  const messages = await setup.complete();
  assert.equal(messages.some(message => message.text === '短读🙂'), true);
  assert.equal(closes, 1);
});

for (const boundary of ['read-error', 'read-budget', 'changed'] as const) {
  test(`CLI transcript ${boundary} releases its descriptor without replacing original reply evidence`, async context => {
    const setup = fixture(context, row('discard', 'must not project '.repeat(100)));
    const nativeOpen = fsPromises.open;
    let closes = 0, reads = 0;
    context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof nativeOpen>) => {
      const handle = await nativeOpen(...args), nativeRead = handle.read.bind(handle), nativeClose = handle.close.bind(handle);
      context.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
        reads++;
        if (boundary === 'read-error') throw new Error('synthetic private read failure');
        const result = await nativeRead(buffer, offset, boundary === 'read-budget' ? 1 : length, position);
        if (boundary === 'changed') appendFileSync(setup.file, '\n');
        return result;
      });
      context.mock.method(handle, 'close', async () => { closes++; await nativeClose(); });
      return handle;
    });
    syncBuiltinESMExports();
    const messages = await setup.complete();
    assert.equal(messages.some(message => message.id.includes(':discard:')), false);
    assert.equal(messages.some(message => message.text.includes('private')), false);
    assert.equal(closes, 1);
    assert.equal(reads, boundary === 'read-budget' ? 64 : 1);
  });
}

test('CLI transcript replacement with a symlink is not followed', async context => {
  const setup = fixture(context, row('original', 'original file'));
  const other = join(setup.sessionDirectory, 'other.jsonl');
  writeFileSync(other, row('other', 'other transcript must not leak'));
  const nativeOpen = fsPromises.open;
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof nativeOpen>) => {
    assert.equal(args[0], setup.file);
    unlinkSync(setup.file); symlinkSync(other, setup.file);
    return nativeOpen(...args);
  });
  syncBuiltinESMExports();
  assert.deepEqual(await setup.complete(), []);
});

test('CLI transcript descriptor close remains owned until its finally finishes', async context => {
  const setup = fixture(context, row('owned', 'display'));
  const nativeOpen = fsPromises.open;
  let release!: () => void, closing!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { closing = resolve; });
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof nativeOpen>) => {
    const handle = await nativeOpen(...args), nativeClose = handle.close.bind(handle);
    context.mock.method(handle, 'close', async () => { closing(); await gate; await nativeClose(); });
    return handle;
  });
  syncBuiltinESMExports();
  const completing = setup.complete();
  try { await entered; assert.equal(setup.drained(), false); }
  finally { release(); }
  await completing;
  assert.equal(setup.drained(), true);
});
