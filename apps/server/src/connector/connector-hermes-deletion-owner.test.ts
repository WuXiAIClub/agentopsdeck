import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { HermesRemoteError } from '../hermes/rpc-peer.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncHermesDeletion } from './async-hermes-deletion.js';
import type { HermesDeletionIntent } from './connector-hermes-deletion-domain.js';

const token = 'isolated-original-hermes-deletion', authorization = `Bearer ${token}`, key = 'hermes:original';
const silence = new PerformanceDiagnostics(() => {}), tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(file = ':memory:') {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-deletion-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token);
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  store.hermesJournal.save({ key, stored: 'stored', title: 'Original', started: true, messages: [] });
  const execute = createConnectorOwnerCommands(store, tokens), owner = { command: execute };
  const request = { key, commandKey: 'original-delete', authorization };
  const scope = JSON.stringify(['delete', JSON.stringify([actor, key])]);
  return { directory, tokens, actor, store, execute, owner, request, scope,
    async claim() { const r = await execute('hermesDeletionClaim', request); assert.ok('intent' in r && r.intent && r.admitted); return r; },
    close() { execute.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function consumer(owner: Pick<AsyncConnectorOwner, 'command'>, diagnostics = silence) {
  let live: string | undefined = 'live', epoch = 'epoch', available = true, removed = 0, fenced = 0;
  const calls: string[] = [];
  const native = { available: () => available, epoch: () => epoch, live: () => live,
    request: async (method: string, _params: Record<string, unknown>): Promise<unknown> => {
      calls.push(method);
      if (method === 'session.activate') return { session_id: 'live', session_key: 'stored', status: 'idle', running: false };
      if (method === 'session.close') return { closed: true };
      if (method === 'session.delete') return { deleted: 'stored' };
      throw Error('Unexpected native effect');
    } };
  const lifecycle = new AsyncHermesDeletion({ owner, native, diagnostics, fence: () => { fenced++; },
    closed: () => { live = undefined; }, removed: () => { removed++; } });
  return { native, lifecycle, calls, get removed() { return removed; }, get fenced() { return fenced; },
    changeEpoch() { epoch = 'foreign'; }, disconnect() { available = false; } };
}
async function ready(f: ReturnType<typeof fixture>, intent: HermesDeletionIntent) {
  for (const stage of ['close', 'delete'] as const)
    assert.equal(await f.execute('hermesDeletionReady', { intent, authorization, stage }), true);
}

test('Hermes deletion protocol rejects authority booleans, foreign identities and callback/SQL fields', async () => {
  const f = fixture();
  try {
    assert.equal(validConnectorOwnerInput('hermesDeletionClaim', f.request), true);
    for (const field of ['actorId', 'authorized', 'sql', 'callback', 'nativeRequired', 'ready'])
      assert.equal(validConnectorOwnerInput('hermesDeletionClaim', { ...f.request, [field]: true }), false);
    for (const foreign of ['hermes:', 'codex:original', 'hermes:bad\n'])
      assert.equal(validConnectorOwnerInput('hermesDeletionClaim', { ...f.request, key: foreign }), false);
    assert.equal(validConnectorOwnerInput('hermesDeletionReady', { intent: { key, stored: 'stored', receiptId: 'r' }, authorization, stage: 'retry' }), false);
    assert.equal(validConnectorOwnerOutput('hermesDeletionClaim', { error: '401' }), false);
  } finally { f.close(); }
});

test('original Hermes intent and unknown receipt commit together; duplicate returns no native handoff', async () => {
  const f = fixture();
  try {
    const first = await f.claim();
    assert.equal(f.store.hermesJournal.deletion(key), 'pending');
    assert.equal(first.receipt.state, 'outcome_unknown');
    assert.deepEqual(f.store.commands.get(f.scope, f.request.commandKey), first.receipt);
    const duplicate = await f.execute('hermesDeletionClaim', f.request);
    assert.ok('intent' in duplicate); assert.equal(duplicate.intent, null); assert.equal(duplicate.admitted, false);
    assert.deepEqual(duplicate.receipt, first.receipt);
    assert.equal(await f.execute('hermesDeletionReady', { intent: { ...first.intent!, stored: 'foreign' }, authorization, stage: 'close' }), false);
    assert.equal(await f.execute('hermesDeletionReady', { intent: first.intent!, authorization, stage: 'delete' }), false);
    assert.equal(await f.execute('hermesDeletionSettle', { intent: first.intent!, accepted: true }), false);
  } finally { f.close(); }
});

for (const reason of ['queued', 'unknown', 'maintenance', 'deleted'] as const) test(`Hermes deletion original reciprocal guard rejects ${reason}`, async () => {
  const f = fixture();
  try {
    if (reason === 'queued' || reason === 'unknown') await f.store.turns.enqueueAsync('hermes', { id: 'm', sessionKey: key, createdAt: 1,
      payload: { text: 'original', actorId: f.actor } });
    if (reason === 'unknown') {
      const execution = { id: 'run', key, live: 'live', epoch: 'epoch', phase: 'starting' as const, members: ['m'], at: 1, updated: 1 };
      assert.equal(f.store.hermesJournal.begin(execution, f.store.turns), true);
      assert.equal(f.store.hermesJournal.unknown(execution, f.store.turns), true);
    }
    if (reason === 'maintenance') await f.execute('maintenancePause', {});
    if (reason === 'deleted') f.store.hermesJournal.beginDeletion(key);
    const rejected = await f.execute('hermesDeletionClaim', f.request);
    assert.ok('receipt' in rejected && rejected.receipt.state === 'rejected');
    assert.equal(rejected.admitted, false); assert.equal(rejected.intent, null);
    assert.equal(rejected.receipt.result?.status, 409);
    assert.equal(f.store.commands.get(f.scope, f.request.commandKey)?.id, rejected.receipt.id);
  } finally { f.close(); }
});

test('claim transaction rolls original intent back if receipt binding fails after intent write', async () => {
  const f = fixture(), begin = f.store.hermesJournal.beginDeletion.bind(f.store.hermesJournal);
  try {
    f.store.hermesJournal.beginDeletion = target => { begin(target); throw Error('private-intent-failure'); };
    await assert.rejects(f.execute('hermesDeletionClaim', f.request), /private-intent-failure/);
    assert.equal(f.store.hermesJournal.deletion(key), undefined);
    assert.equal(f.store.commands.get(f.scope, f.request.commandKey), undefined);
  } finally { f.close(); }
});

test('each native deletion step consumes one current permission; revocation cannot erase accepted native facts', async () => {
  const f = fixture();
  try {
    const r = await f.claim(), intent = r.intent!;
    assert.equal(await f.execute('hermesDeletionReady', { intent, authorization, stage: 'close' }), true);
    assert.equal(await f.execute('hermesDeletionReady', { intent, authorization, stage: 'close' }), false);
    assert.equal(await f.execute('hermesDeletionReady', { intent, authorization, stage: 'delete' }), true);
    assert.equal(await f.execute('hermesDeletionReady', { intent, authorization, stage: 'delete' }), false);
    f.tokens.revoke(f.actor);
    const settled = await f.execute('hermesDeletionSettle', { intent, accepted: true });
    assert.ok(settled && settled.receipt.state === 'accepted');
    assert.equal(f.store.hermesJournal.deletion(key), 'accepted'); assert.equal(f.store.hermesJournal.session(key), undefined);
    assert.deepEqual(await f.execute('hermesDeletionReceiptRead', f.request), { error: 401 });
  } finally { f.close(); }
});

test('delete settlement event failure rolls session, deletion and original receipt back atomically', async () => {
  const f = fixture(), append = f.store.events.appendInTransaction.bind(f.store.events);
  try {
    const r = await f.claim(), intent = r.intent!; await ready(f, intent);
    f.store.events.appendInTransaction = () => { throw Error('private-event-failure'); };
    await assert.rejects(f.execute('hermesDeletionSettle', { intent, accepted: true }), /private-event-failure/);
    assert.equal(f.store.hermesJournal.deletion(key), 'pending'); assert.ok(f.store.hermesJournal.session(key));
    assert.equal(f.store.commands.get(f.scope, f.request.commandKey)?.state, 'outcome_unknown');
    const unknown = await f.execute('hermesDeletionSettle', { intent, accepted: false });
    assert.ok(unknown && unknown.receipt.state === 'outcome_unknown');
    assert.equal(await f.execute('hermesDeletionReady', { intent, authorization, stage: 'delete' }), false);
  } finally { f.store.events.appendInTransaction = append; f.close(); }
});

for (const fault of ['revoke', 'epoch', 'close-ack', 'delete-ack', 'untyped-absence', 'typed-absence'] as const)
  test(`async Hermes original deletion effects preserve ${fault} outcome without replay`, async () => {
    const f = fixture(), c = consumer(f.owner), invoke = c.native.request;
    c.native.request = async (method, params) => {
      const result = await invoke(method, params);
      if (method === 'session.close') {
        if (fault === 'revoke') f.tokens.revoke(f.actor);
        if (fault === 'epoch') c.changeEpoch();
        if (fault === 'close-ack') return { closed: false };
      }
      if (method === 'session.delete') {
        if (fault === 'delete-ack') return { deleted: 'foreign' };
        if (fault === 'untyped-absence') throw Error('4007 not found');
        if (fault === 'typed-absence') throw new HermesRemoteError(4007);
      }
      return result;
    };
    try {
      const r = await c.lifecycle.remove(key, f.request.commandKey, authorization);
      assert.ok('receipt' in r);
      assert.equal(r.receipt.state, fault === 'typed-absence' ? 'accepted' : 'outcome_unknown');
      assert.equal(c.removed, fault === 'typed-absence' ? 1 : 0);
      assert.equal(c.calls.filter(m => m === 'session.close').length, 1);
      assert.equal(c.calls.includes('session.delete'), !['revoke', 'epoch', 'close-ack'].includes(fault));
      const before = [...c.calls]; await c.lifecycle.remove(key, f.request.commandKey, authorization);
      assert.deepEqual(c.calls, before);
    } finally { await c.lifecycle.close(); f.close(); }
  });

test('async deletion publishes task before reentrant close and retains physical ownership through delayed ACK', async () => {
  const f = fixture(), c = consumer(f.owner), invoke = c.native.request;
  let resolveClose!: (v: unknown) => void, finished = false;
  c.native.request = async (method, params) => {
    if (method === 'session.close') { c.calls.push(method); return new Promise(resolve => { resolveClose = resolve; }); }
    return invoke(method, params);
  };
  try {
    const task = c.lifecycle.remove(key, f.request.commandKey, authorization);
    for (let i = 0; i < 100 && !resolveClose; i++) await tick();
    assert.ok(resolveClose);
    const close = c.lifecycle.close(); assert.equal(close, c.lifecycle.close());
    void close.then(() => { finished = true; }); await tick(); assert.equal(finished, false);
    assert.deepEqual(await c.lifecycle.remove(key, 'different', authorization), { error: 409 });
    resolveClose({ closed: true }); await task; await close;
    assert.equal(c.calls.includes('session.delete'), false);
    assert.equal(f.store.commands.get(f.scope, f.request.commandKey)?.state, 'outcome_unknown');
  } finally { await c.lifecycle.close(); f.close(); }
});

test('concurrent original claims yield one intent; caller mutation cannot replace captured deletion identity', async () => {
  const f = fixture();
  try {
    const request = { ...f.request }, first = f.execute('hermesDeletionClaim', request);
    request.key = 'hermes:foreign'; request.commandKey = 'foreign'; request.authorization = 'Bearer foreign';
    const results = await Promise.all([first, f.execute('hermesDeletionClaim', f.request)]);
    for (const r of results) assert.ok('receipt' in r);
    const admitted = results.filter(r => 'admitted' in r && r.admitted);
    assert.equal(admitted.length, 1);
    assert.ok('receipt' in results[0]! && 'receipt' in results[1]!);
    assert.equal(results[0]!.receipt.id, results[1]!.receipt.id);
    assert.equal(results[0]!.key, key); assert.equal(results[0]!.commandKey, f.request.commandKey);
    assert.equal(f.store.hermesJournal.deletion('hermes:foreign'), undefined);
  } finally { f.close(); }
});

test('revocation before original claim or close cannot hand off native deletion', async () => {
  for (const phase of ['claim', 'close'] as const) {
    const f = fixture(), c = consumer(f.owner), invoke = c.native.request;
    try {
      if (phase === 'claim') f.tokens.revoke(f.actor);
      else c.native.request = async (method, params) => { const result = await invoke(method, params); f.tokens.revoke(f.actor); return result; };
      const result = await c.lifecycle.remove(key, f.request.commandKey, authorization);
      if (phase === 'claim') { assert.deepEqual(result, { error: 401 }); assert.deepEqual(c.calls, []); }
      else { assert.ok('receipt' in result && result.receipt.state === 'outcome_unknown'); assert.deepEqual(c.calls, ['session.activate']); }
    } finally { await c.lifecycle.close(); f.close(); }
  }
});

test('unsafe native idle probe never hands off close or delete, and never reattaches', async () => {
  const f = fixture(), c = consumer(f.owner);
  c.native.request = async method => { c.calls.push(method); return { session_id: 'live', session_key: 'stored', status: 'running', running: true }; };
  try {
    const result = await c.lifecycle.remove(key, f.request.commandKey, authorization);
    assert.ok('receipt' in result && result.receipt.state === 'outcome_unknown');
    assert.deepEqual(c.calls, ['session.activate']); assert.equal(f.store.hermesJournal.deletion(key), 'pending');
  } finally { await c.lifecycle.close(); f.close(); }
});

test('synchronous close before scheduled owner entry prevents any receipt or native invocation', async () => {
  const f = fixture(), c = consumer(f.owner);
  try {
    const task = c.lifecycle.remove(key, f.request.commandKey, authorization), close = c.lifecycle.close();
    assert.deepEqual(await task, { error: 409 }); await close;
    assert.deepEqual(c.calls, []); assert.equal(f.store.commands.get(f.scope, f.request.commandKey), undefined);
  } finally { await c.lifecycle.close(); f.close(); }
});

test('real Hermes worker deletion preserves accepted and unknown original receipts after exclusive close/reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-deletion-worker-')), file = join(directory, 'connector.sqlite'), tokenFile = join(directory, 'tokens.json');
  let worker: AsyncConnectorOwner | undefined;
  try {
    new ConnectorTokenStore(tokenFile, token);
    const seed = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    for (const target of [key, 'hermes:pending']) seed.hermesJournal.save({ key: target, stored: 'stored', title: 'Original', started: true, messages: [] });
    seed.close();
    worker = new AsyncConnectorOwner({ file, tokenFile }, silence); await worker.open();
    const c = consumer(worker), accepted = await c.lifecycle.remove(key, 'accepted', authorization);
    assert.ok('receipt' in accepted && accepted.receipt.state === 'accepted'); await c.lifecycle.close();
    const pending = await worker.command('hermesDeletionClaim', { key: 'hermes:pending', commandKey: 'pending', authorization });
    assert.ok('intent' in pending && pending.intent);
    await worker.close(); worker = new AsyncConnectorOwner({ file, tokenFile }, silence); await worker.open();
    for (const [target, commandKey, state] of [[key, 'accepted', 'accepted'], ['hermes:pending', 'pending', 'outcome_unknown']] as const) {
      const view = await worker.command('hermesDeletionReceiptRead', { key: target, commandKey, authorization });
      assert.ok('receipt' in view && view.receipt?.state === state);
      const duplicate = await worker.command('hermesDeletionClaim', { key: target, commandKey, authorization });
      assert.ok('admitted' in duplicate && !duplicate.admitted && duplicate.intent === null);
    }
    assert.equal(await worker.command('hermesDeletionReady', { intent: pending.intent!, authorization, stage: 'close' }), false);
    await worker.close(); worker = undefined;
    const reopened = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    try { assert.equal(reopened.hermesJournal.deletion(key), 'accepted'); assert.equal(reopened.hermesJournal.deletion('hermes:pending'), 'pending'); }
    finally { reopened.close(); }
  } finally { await worker?.close(); rmSync(directory, { recursive: true, force: true }); }
});
