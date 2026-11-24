import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { InteractionAnswer, InteractionCapabilities } from '@agentopsdeck/shared';
import { InteractionStore } from './interaction-store.js';
import { InteractionRuntime, type NativeInteractionHandle } from './interaction-runtime.js';
import type { InteractionContinuation } from './interaction-continuation.js';

const capabilities: InteractionCapabilities = { version: 1, modes: ['automatic', 'interactive'], kinds: ['approval', 'text', 'single-select', 'multi-select'] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t: test.TestContext, acknowledgementMs = 10_000) {
  const db = new DatabaseSync(':memory:');
  const store = new InteractionStore(db), changed: string[] = [], delivered: InteractionAnswer[] = [], cancelled: string[] = [];
  let active = true, permission = true, available = true;
  let evidence: InteractionContinuation = { connectionId: 'connection', goal: { status: 'active', version: '1' } };
  const runtime = new InteractionRuntime(store, () => available, key => changed.push(key), Date.now, acknowledgementMs);
  const scope = { ownerId: 'owner', nodeId: 'node', sessionKey: 'codex:thread', runId: 'turn' };
  const handle: NativeInteractionHandle = { scope, active: () => active, continuation: async () => evidence,
    permitted: async () => permission, deliver: async answer => { delivered.push(answer); return 'confirmed'; }, cancel: reason => cancelled.push(reason) };
  t.after(() => { runtime.close(); db.close(); });
  const open = () => runtime.open({ kind: 'text', prompt: 'Question' }, capabilities, handle);
  const answer = (id: string, responseId = 'response') => runtime.answer({ scope, requestId: id, responseId, expectedRevision: 1,
    answer: { kind: 'text', text: 'Answer' }, authorize: () => permission });
  return { store, runtime, scope, handle, changed, delivered, cancelled, open, answer,
    active: (value: boolean) => { active = value; }, permission: (value: boolean) => { permission = value; },
    available: (value: boolean) => { available = value; }, evidence: (value: InteractionContinuation) => { evidence = value; } };
}

test('native missing ACK is bounded, remains unknown, cancels waiter and never redelivers', async t => {
  const f = fixture(t, 10), request = await f.open();
  f.handle.deliver = async answer => { f.delivered.push(answer); return new Promise(() => {}); };
  assert.equal((await f.answer(request.request.requestId)).delivery, 'unknown');
  assert.equal((await f.answer(request.request.requestId)).delivery, 'unknown');
  assert.equal(f.delivered.length, 1); assert.deepEqual(f.cancelled, ['disconnected']);
});

test('goal evidence failure after acceptance cancels queued answer instead of leaving a waiting request', async t => {
  const f = fixture(t), request = await f.open(); let checks = 0;
  f.handle.permitted = async () => { if (++checks === 2) f.handle.continuation = async () => { throw new Error('Disconnected'); }; return true; };
  await assert.rejects(f.answer(request.request.requestId));
  assert.equal(f.store.get(f.scope, request.request.requestId)?.delivery, 'cancelled');
  assert.equal(f.delivered.length, 0);
});

test('original continuation receives one answer; refresh/retry expose no internal claim or goal fingerprint', async t => {
  const f = fixture(t), request = await f.open();
  const result = await f.answer(request.request.requestId);
  assert.equal(result.delivery, 'confirmed'); assert.equal(f.delivered.length, 1);
  f.active(false); f.evidence({ connectionId: 'replacement', goal: { status: 'paused', version: '2' } });
  assert.deepEqual(await f.answer(request.request.requestId), result);
  assert.equal(f.delivered.length, 1);
  assert.ok(!JSON.stringify(f.runtime.list(f.scope)).match(/claimId|continuationHash|"answer"/));
  assert.equal(f.runtime.list({ ...f.scope, ownerId: 'other' }).length, 0);
  assert.ok(f.changed.length >= 3);
});

test('competing clients cannot deliver two answers', async t => {
  const f = fixture(t), request = await f.open();
  const results = await Promise.allSettled([f.answer(request.request.requestId, 'a'), f.answer(request.request.requestId, 'b')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.delivered.length, 1);
});

for (const reason of ['stopped', 'disconnected', 'revoked', 'restarted'] as const) {
  test(`${reason} during async permission check never delivers`, async t => {
    const f = fixture(t), request = await f.open(), gate = deferred<boolean>();
    f.handle.permitted = () => gate.promise;
    const answer = f.answer(request.request.requestId);
    f.runtime.closeRun(f.scope, reason); gate.resolve(true);
    await assert.rejects(answer); assert.equal(f.delivered.length, 0);
    assert.equal(f.store.get(f.scope, request.request.requestId)?.delivery, 'cancelled');
    assert.deepEqual(f.cancelled, [reason]);
  });
}

test('stop during native delivery retains unknown despite late ACK; retry never redelivers', async t => {
  const f = fixture(t), request = await f.open(), started = deferred<void>(), delivered = deferred<'confirmed'>();
  f.handle.deliver = async answer => { f.delivered.push(answer); started.resolve(); return delivered.promise; };
  const answer = f.answer(request.request.requestId); await started.promise;
  f.runtime.closeRun(f.scope, 'stopped'); delivered.resolve('confirmed');
  assert.equal((await answer).delivery, 'unknown');
  assert.equal((await f.answer(request.request.requestId)).delivery, 'unknown');
  assert.equal(f.delivered.length, 1); assert.equal(f.store.hasUnresolvedKey(f.scope.sessionKey), true);
});

test('revoke after acceptance before claim cancels the queued answer', async t => {
  const f = fixture(t), request = await f.open(); let checks = 0;
  f.handle.permitted = async () => ++checks < 2;
  await assert.rejects(f.answer(request.request.requestId));
  assert.equal(f.delivered.length, 0);
  const fact = f.store.get(f.scope, request.request.requestId)!;
  assert.equal(fact.state.status, 'answered'); assert.equal(fact.delivery, 'cancelled');
});

for (const status of ['paused', 'usageLimited', 'budgetLimited', 'unknown'] as const) {
  test(`goal ${status} never admits or delivers an interaction`, async t => {
    const f = fixture(t), request = await f.open();
    f.evidence({ connectionId: 'connection', goal: { status, version: '2' } });
    await assert.rejects(f.answer(request.request.requestId)); await assert.rejects(f.open());
    assert.equal(f.delivered.length, 0);
  });
}

test('goal generation changes during permission lookup fail closed before answer acceptance', async t => {
  const f = fixture(t), request = await f.open();
  f.handle.permitted = async () => { f.evidence({ connectionId: 'connection', goal: { status: 'active', version: '2' } }); return true; };
  await assert.rejects(f.answer(request.request.requestId));
  assert.equal(f.store.get(f.scope, request.request.requestId)?.state.status, 'pending');
});

test('maintenance barrier blocks new requests and answers without fabricating a native result', async t => {
  const f = fixture(t), request = await f.open(); f.available(false);
  await assert.rejects(f.open()); await assert.rejects(f.answer(request.request.requestId));
  assert.equal(f.delivered.length, 0); assert.equal(f.store.hasUnresolvedKey(f.scope.sessionKey), true);
});

test('delivery failure is unknown; projection failure does not replay or undo durable state', async t => {
  const f = fixture(t); f.handle.deliver = async () => { throw new Error('transport gone'); };
  const runtime = new InteractionRuntime(f.store, () => true, () => { throw new Error('projection offline'); });
  t.after(() => runtime.close());
  const request = await runtime.open({ kind: 'text', prompt: 'Question' }, capabilities, f.handle);
  const answer = await runtime.answer({ scope: f.scope, requestId: request.request.requestId, expectedRevision: 1,
    responseId: 'response', answer: { kind: 'text', text: 'Answer' }, authorize: () => true });
  assert.equal(answer.delivery, 'unknown');
});
