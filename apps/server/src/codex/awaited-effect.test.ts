import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t: import('node:test').TestContext) {
  const database = new ConnectorUserStore(':memory:'), store = new DeckStore();
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
    defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: database.turns,
    executions: database.codexExecutions, authorizeTurn: () => true, requestTimeoutMs: 20 });
  const runtime = codex as any, writes: any[] = [];
  const child = { stdin: { writable: true, write(line: string) { writes.push(JSON.parse(line)); return true; } } };
  runtime.child = child; runtime.connectionId = 'original';
  t.after(async () => { runtime.child = undefined; await codex.close(); database.close(); });
  const send = (authorize: () => Promise<void>, local = () => {}, params: unknown = { threadId: 'test' }) =>
    runtime.requestAuthorized('turn/start', params, authorize, local) as Promise<any>;
  const ack = (result: unknown = { turn: { id: 'run' } }) => {
    assert.equal(writes.length, 1); runtime.receive(JSON.stringify({ id: writes[0].id, result }));
  };
  return { codex, runtime, writes, child, send, ack };
}

test('awaited effect reserves physical ownership, snapshots input and starts RPC timer only after authorization', async t => {
  const f = fixture(t), gate = deferred(), params = { threadId: 'original' };
  let checks = 0;
  const result = f.send(() => gate.promise, () => { checks++; }, params);
  params.threadId = 'mutated';
  assert.equal(f.runtime.authorizingEffects.size, 1);
  await tick();
  assert.equal(f.writes.length, 0); assert.equal(f.runtime.pending.size, 0);
  gate.resolve(); await tick();
  assert.equal(checks, 1); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].params.threadId, 'original');
  f.ack(); assert.deepEqual(await result, { turn: { id: 'run' } });
  assert.equal(f.runtime.authorizingEffects.size, 0);
});

for (const race of ['revoked', 'child', 'connection', 'generation', 'unwritable', 'unavailable', 'local', 'promise-local', 'observation']) {
  test(`awaited effect refuses ${race} after worker wait without native write or retry`, async t => {
    const f = fixture(t), gate = deferred(); let calls = 0;
    const result = f.send(async () => { calls++; await gate.promise; if (race === 'revoked') throw Error('revoked'); }, () => {
      if (race === 'local') throw Error('local veto');
      if (race === 'promise-local') return Promise.resolve() as any;
    });
    const rejected = assert.rejects(result);
    await tick();
    const observation = deferred();
    if (race === 'child') f.runtime.child = { ...f.child };
    if (race === 'connection') f.runtime.connectionId = 'replacement';
    if (race === 'generation') f.runtime.nativeConnectionGeneration++;
    if (race === 'unwritable') f.child.stdin.writable = false;
    if (race === 'unavailable') f.runtime.executionUnavailable = true;
    if (race === 'observation') f.runtime.nativeObservations.accept(() => observation.promise, 1, 1);
    gate.resolve(); await rejected; observation.resolve();
    assert.equal(calls, 1); assert.equal(f.writes.length, 0);
    assert.equal(f.runtime.pending.size, 0); assert.equal(f.runtime.authorizingEffects.size, 0);
  });
}

test('awaited effect waits existing observations before worker authority, then writes once', async t => {
  const f = fixture(t), observation = deferred(); let calls = 0;
  f.runtime.nativeObservations.accept(() => observation.promise, 1, 1);
  const result = f.send(async () => { calls++; });
  await tick(); assert.equal(calls, 0); assert.equal(f.writes.length, 0);
  observation.resolve(); await tick(); assert.equal(calls, 1);
  f.ack(); await result;
});

test('close drains accepted physical authority without dispatching and refuses new authority', async t => {
  const f = fixture(t), gate = deferred(); let called = false;
  const result = f.send(() => gate.promise); const rejected = assert.rejects(result);
  await tick(); let closed = false;
  const closing = f.codex.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.equal(f.runtime.authorizingEffects.size, 1);
  await assert.rejects(f.send(async () => { called = true; }));
  assert.equal(called, false);
  gate.resolve(); await rejected; await closing; assert.equal(f.writes.length, 0);
});

test('reentrant close during input snapshot sees registered task and prevents authority', async t => {
  const f = fixture(t); let called = false, closing: Promise<void> | undefined;
  const params = { get threadId() { closing = f.codex.close(); return 'test'; } };
  await assert.rejects(f.send(async () => { called = true; }, () => {}, params));
  await closing; assert.equal(called, false); assert.equal(f.writes.length, 0);
});

test('awaited effect final local callback cannot switch connection or introduce pending observations', async t => {
  const f = fixture(t), observation = deferred();
  await assert.rejects(f.send(async () => {}, () => {
    f.runtime.nativeObservations.accept(() => observation.promise, 1, 1);
  }));
  observation.resolve(); assert.equal(f.writes.length, 0); assert.equal(f.runtime.pending.size, 0);
});

test('original synchronous effect authority still rejects Promise without writing', async t => {
  const f = fixture(t);
  await assert.rejects(f.runtime.request('turn/start', {}, 20, undefined, async () => {}));
  assert.equal(f.writes.length, 0); assert.equal(f.runtime.pending.size, 0);
});

test('native timeout after authorization keeps once-only write and accepts no automatic replay', async t => {
  const f = fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = f.send(async () => {}); const rejected = assert.rejects(result, /timed out/);
  await tick(); assert.equal(f.writes.length, 1);
  t.mock.timers.tick(21); await rejected;
  f.ack(); await tick(); assert.equal(f.writes.length, 1); assert.equal(f.runtime.pending.size, 0);
});
