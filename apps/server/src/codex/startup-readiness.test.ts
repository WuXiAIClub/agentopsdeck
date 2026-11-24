import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-startup-'));
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(directory, 'titles.json') });
  const children: ReturnType<typeof makeChild>[] = [];
  function makeChild() {
    const writes: any[] = [];
    const child = Object.assign(new EventEmitter(), { pid: 987654321, killed: false, closed: false, autoClose: true, signalAccepted: true,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      finish() {
        if (child.closed) return;
        child.closed = true;
        child.stdout.end(); child.stderr.end();
        child.emit('exit', null); child.emit('close', null);
      },
      kill() { child.killed = child.signalAccepted; if (child.autoClose) child.finish(); return child.signalAccepted; } });
    child.stdin.on('data', chunk => writes.push(JSON.parse(chunk.toString())));
    return { child, writes, reply: (request: any, result: unknown) => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`),
      reject: (request: any) => child.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -1, message: 'synthetic initialization rejected' } })}\n`) };
  }
  t.mock.method(childProcess, 'spawn', (command: string) => {
    if (command === 'taskkill' && process.platform === 'win32') return { unref() {} };
    assert.equal(command, 'synthetic-codex-no-executable', 'only an in-memory child is permitted');
    const value = makeChild(); children.push(value); return value.child;
  });
  if (process.platform === 'linux') t.mock.method(process, 'kill', (pid: number, signal: string | number) => {
    assert.equal(pid, -987654321);
    if (signal === 0) {
      if (children.every(({ child }) => child.closed)) throw Object.assign(new Error('Synthetic group drained'), { code: 'ESRCH' });
      return true;
    }
    assert.equal(signal, 'SIGTERM');
    const child = children.at(-1)!.child;
    if (!child.kill()) throw Object.assign(new Error('Synthetic signal rejection'), { code: 'EPERM' });
    return true;
  });
  syncBuiltinESMExports();
  const codex = new CodexAppServer({ enabled: true, command: 'synthetic-codex-no-executable', defaultCwd: directory,
    defaultModel: 'synthetic-model', approvalPolicy: 'never', store, turnQueue: users.turns, executions: users.codexExecutions,
    authorizeTurn: () => true });
  t.after(async () => {
    for (const { child } of children) { child.autoClose = true; child.finish(); }
    await codex.close(); users.close();
    for (const { child } of children) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
    t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  });
  async function waitForChildren(count: number) {
    for (let attempt = 0; attempt < 500 && children.length < count; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(children.length, count);
  }
  return { codex, runtime: codex as any, children, waitForChildren };
}

test('concurrent list and history reads wait for one initialization before sending any read RPC', async t => {
  const f = fixture(t);
  const list = f.codex.refreshSessions();
  const history = f.codex.refreshSession('codex:synthetic-thread');
  // Handle both promises even if the pre-fix wire assertion fails.
  const settled = Promise.allSettled([list, history]);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.children.length, 1);
  const child = f.children[0]!;
  assert.deepEqual(child.writes.map(row => row.method), ['initialize']);
  assert.equal(f.codex.isSessionListReady(), false);
  child.reply(child.writes[0], {});
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(child.writes.map(row => row.method).sort(), ['initialize', 'initialized', 'thread/list', 'thread/read'].sort());
  for (const request of child.writes) {
    if (request.method === 'thread/list') child.reply(request, { data: [], nextCursor: null });
    if (request.method === 'thread/read') child.reply(request, { thread: { id: 'synthetic-thread', turns: [] } });
  }
  assert.ok((await settled).every(result => result.status === 'fulfilled'));
  assert.equal(f.codex.isSessionListReady(), true);
});

for (const signalAccepted of [true, false]) test(`close retains a child until close, signal accepted=${signalAccepted}`, async t => {
  const f = fixture(t);
  const startup = f.runtime.ensureStarted();
  const { child, writes, reply } = f.children[0]!;
  child.autoClose = false; child.signalAccepted = signalAccepted;
  reply(writes[0], {}); await startup;
  let finished = false;
  const closing = f.codex.close().then(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(child.killed, signalAccepted);
  assert.equal(finished, false, 'signal delivery is not process termination');
  child.emit('exit', null);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'exit alone does not prove stdio has closed');
  child.finish(); await closing;
  assert.equal(finished, true);
});

test('replacement initialization waits for retired child close and coalesces waiting readers', async t => {
  const f = fixture(t);
  const failed = assert.rejects(f.runtime.ensureStarted(), /synthetic initialization rejected/);
  const old = f.children[0]!; old.child.autoClose = false;
  old.reject(old.writes[0]); await failed;
  const one = f.runtime.ensureStarted(), two = f.runtime.ensureStarted();
  const settled = Promise.allSettled([one, two]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.children.length, 1, 'retired process still owns its lifetime');
  old.child.emit('exit', null);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.children.length, 1);
  old.child.finish();
  await f.waitForChildren(2);
  assert.equal(f.children.length, 2);
  const next = f.children[1]!; next.reply(next.writes[0], {});
  assert.ok((await settled).every(result => result.status === 'fulfilled'));
});

for (const retry of [false, true]) test(`close waits a retired child without respawning, waiting retry=${retry}`, async t => {
  const f = fixture(t);
  const failed = assert.rejects(f.runtime.ensureStarted(), /synthetic initialization rejected/);
  const old = f.children[0]!; old.child.autoClose = false;
  old.reject(old.writes[0]); await failed;
  const pending = retry ? assert.rejects(f.runtime.ensureStarted(), /closed/) : Promise.resolve();
  let finished = false;
  const closing = f.codex.close().then(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  old.child.finish(); await closing; await pending;
  assert.equal(f.children.length, 1, 'closing a waiting startup must not spawn a replacement');
});

test('spawn failure without pid remains owned until close and handles later child errors', async t => {
  const f = fixture(t);
  const failed = assert.rejects(f.runtime.ensureStarted(), /synthetic spawn failed/);
  const { child } = f.children[0]!; child.autoClose = false;
  Object.assign(child, { pid: undefined });
  child.emit('error', new Error('synthetic spawn failed')); await failed;
  let finished = false;
  const closing = f.codex.close().then(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.doesNotThrow(() => child.emit('error', new Error('synthetic late process error')));
  child.finish(); await closing;
});

test('initialization rejection retires its child and fails all waiting readers without sending reads', async t => {
  const f = fixture(t);
  const list = assert.rejects(f.codex.refreshSessions(), /synthetic initialization rejected/);
  const history = assert.rejects(f.codex.refreshSession('codex:synthetic-thread'), /synthetic initialization rejected/);
  const child = f.children[0]!;
  child.reject(child.writes[0]);
  await Promise.all([list, history]);
  assert.deepEqual(child.writes.map(row => row.method), ['initialize']);
  assert.equal(child.child.killed, true);
  assert.equal(f.runtime.child, undefined);
  assert.equal(f.runtime.connectionId, undefined);
  assert.equal(f.codex.isSessionListReady(), false);
  const retry = f.codex.refreshSessions();
  await f.waitForChildren(2);
  const replacement = f.children[1]!;
  assert.ok(replacement, 'explicit read retry opens a fresh initialization');
  replacement.reply(replacement.writes[0], {});
  await new Promise<void>(resolve => setImmediate(resolve));
  const request = replacement.writes.find(row => row.method === 'thread/list');
  replacement.reply(request, { data: [], nextCursor: null });
  await retry;
  assert.equal(f.codex.isSessionListReady(), true);
});

test('a bounded read reuses the RPC timer and never recycles the shared initialized child', async t => {
  const f = fixture(t);
  const startup = f.runtime.ensureStarted();
  const child = f.children[0]!;
  child.reply(child.writes[0], {});
  await startup;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let failure: Error | undefined;
  const read = f.runtime.request('thread/list', {}, 10).catch((error: Error) => { failure = error; });
  t.mock.timers.tick(10);
  await Promise.resolve();
  try {
    assert.match(failure?.message ?? '', /request timed out: thread\/list/);
    assert.equal(child.child.killed, false);
    assert.equal(f.runtime.pending.size, 0);
    assert.equal(f.runtime.child, child.child);
  } finally {
    t.mock.timers.tick(30_000); await read; t.mock.timers.reset();
  }
});

for (const replacement of [false, true]) test(`late initialization cannot notify a ${replacement ? 'replacement' : 'closed'} runtime`, async t => {
  const f = fixture(t);
  const started = assert.rejects(f.runtime.ensureStarted(), /closed|connection changed/);
  const child = f.children[0]!;
  child.reply(child.writes[0], {});
  if (replacement) {
    // Simulate replacement after the response settles, before its continuation.
    const other = { killed: false, stdin: new PassThrough() };
    const writes: string[] = [];
    other.stdin.on('data', data => writes.push(data.toString()));
    f.runtime.child = other; f.runtime.setConnection('synthetic-replacement');
    await started;
    assert.deepEqual(writes, [], 'old initialized must not be sent on a different child');
    assert.equal(f.runtime.child, other, 'retired initialization failure must not recycle a replacement');
    other.stdin.destroy();
  } else {
    const closing = f.codex.close();
    await started; await closing;
  }
  assert.deepEqual(child.writes.map(row => row.method), ['initialize']);
});
