import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises, { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { classifyOpenClawSessionRun, classifyOpenClawSessionRunAsync, readOpenClawSessionDiskUsage, readOpenClawSessionDiskUsageAsync } from './session-usage.js';

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-async-session-usage-')), before = process.env.HOME;
  process.env.HOME = root; assert.equal(homedir(), root);
  const sessions = join(root, '.openclaw/agents/main/sessions'), file = join(sessions, 'original.jsonl');
  await mkdir(sessions, { recursive: true });
  context.after(async () => {
    context.mock.restoreAll(); syncBuiltinESMExports();
    if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
    await rm(root, { recursive: true, force: true });
  });
  return { root, sessions, file };
}

for (const mode of ['aborted', 'stale', 'recent', 'yield', 'completed', 'malformed', 'missing'] as const)
  test(`async directory classifier preserves original ${mode} display status`, async context => {
    const f = await fixture(context), now = Date.now(), at = mode === 'stale' ? now - 7 * 24 * 60 * 60_000 : now;
    const message = mode === 'yield' ? { role: 'toolResult', toolName: 'sessions_yield', content: [] }
      : { role: 'assistant', content: mode === 'completed' ? [{ type: 'text', text: 'original reply' }] : [{ type: 'toolCall', name: 'exec' }] };
    if (mode !== 'missing') await writeFile(f.file, mode === 'malformed' ? 'invalid-json' : JSON.stringify({ timestamp: at, message }));
    const raw = { sessionFile: f.file, status: 'running', updatedAt: at, abortedLastRun: mode === 'aborted' }, row = { status: 'running', updatedAt: at };
    assert.deepEqual(await classifyOpenClawSessionRunAsync(row, raw, now), classifyOpenClawSessionRun(row, raw, now));
  });

test('async disk usage uses original registry once per agent and never calls synchronous filesystem APIs', async context => {
  const f = await fixture(context), keys = ['aborted', 'running', 'idle'].map(name => `agent:main:${name}`), now = Date.now();
  await writeFile(f.file, JSON.stringify({ timestamp: now, message: { role: 'assistant', content: 'original final reply' } }));
  const registry = Object.fromEntries(keys.map((key, index) => [key, { status: index === 2 ? 'idle' : 'running', abortedLastRun: index === 0,
    sessionFile: f.file, updatedAt: now }]));
  const index = join(f.sessions, 'sessions.json'); await writeFile(index, JSON.stringify(registry));
  const rows = [...keys.map(key => ({ key })), { sessionKey: 'agent:main:not-in-registry' }, { key: 'agent:missing:main' }, {}];
  const expected = readOpenClawSessionDiskUsage(rows), nativeRead = fsPromises.readFile;
  let reads = 0;
  context.mock.method(fsPromises, 'readFile', async (...args: Parameters<typeof nativeRead>) => {
    if (args[0] === index) reads++;
    return nativeRead(...args);
  });
  context.mock.method(fs, 'readFileSync', () => assert.fail('production refresh must not read synchronously'));
  context.mock.method(fs, 'existsSync', () => assert.fail('production refresh must not stat synchronously'));
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await readOpenClawSessionDiskUsageAsync(rows), expected); assert.equal(reads, 1);
    assert.equal(expected.size, 2);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('async directory display reads at most 1MiB tail of a long transcript and closes its original handle', async context => {
  const f = await fixture(context), now = Date.now(), limit = 1024 * 1024;
  await writeFile(f.file, `${' '.repeat(limit * 3)}\n${JSON.stringify({ timestamp: now, message: { role: 'assistant', content: 'original reply' } })}\n`);
  const nativeOpen = fsPromises.open; let requested = 0, opens = 0, closes = 0;
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof nativeOpen>) => {
    const handle = await nativeOpen(...args), nativeRead = handle.read.bind(handle), nativeClose = handle.close.bind(handle); opens++;
    context.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
      requested += length; assert.ok(position > 0); return nativeRead(buffer, offset, length, position);
    });
    context.mock.method(handle, 'close', async () => { closes++; return nativeClose(); });
    return handle;
  }); syncBuiltinESMExports();
  const result = await classifyOpenClawSessionRunAsync({ updatedAt: now }, { sessionFile: f.file, updatedAt: now }, now);
  assert.deepEqual(result, { status: 'idle', hasActiveRun: false });
  assert.ok(requested > 0 && requested <= limit + 1); assert.equal(opens, 1); assert.equal(closes, 1);
});

test('async directory read stays owned until delayed descriptor completion, without converting read failure to idle', async context => {
  const f = await fixture(context), now = Date.now();
  await writeFile(f.file, JSON.stringify({ timestamp: now, message: { role: 'assistant', content: 'terminal text' } }));
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const nativeOpen = fsPromises.open; let closed = false, settled = false;
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof nativeOpen>) => {
    const handle = await nativeOpen(...args), nativeClose = handle.close.bind(handle);
    context.mock.method(handle, 'read', async () => { enter(); await gate; throw Error('PRIVATE disk failure'); });
    context.mock.method(handle, 'close', async () => { closed = true; return nativeClose(); });
    return handle;
  }); syncBuiltinESMExports();
  const pending = classifyOpenClawSessionRunAsync({ updatedAt: now }, { sessionFile: f.file, updatedAt: now }, now);
  void pending.then(() => { settled = true; });
  try {
    await entered; assert.equal(settled, false); assert.equal(closed, false); release();
    assert.deepEqual(await pending, { status: 'running', hasActiveRun: true }); assert.equal(closed, true);
  } finally { release(); await pending; }
});
