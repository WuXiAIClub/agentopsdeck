import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HermesExecution } from '../hermes/journal.js';
import type { HermesHistoryRow } from '../hermes/history.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncHermesDispatch } from './async-hermes-dispatch.js';
import { AsyncHermesExecution } from './async-hermes-execution.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorOwnerUnavailable, createConnectorOwnerCommands } from './connector-owner-domain.js';
import { validConnectorHermesDispatchInput, type ConnectorHermesDispatchKind } from './connector-hermes-dispatch-domain.js';
import { NativeOperationError } from './native-operation.js';

const key = 'hermes:original', token = 'isolated-hermes-dispatch-token', authorization = `Bearer ${token}`;
const silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-dispatch-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token);
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  store.hermesJournal.save({ key, stored: 'native', title: 'Original', started: false, messages: [] });
  const command = createConnectorOwnerCommands(store, tokens);
  let ready = true, epoch = 'original-epoch', submissions = 0, attaches = 0;
  const rows: HermesHistoryRow[] = [{ row_id: 1, role: 'user', text: 'old private input', timestamp: 1 }];
  const native = { available: () => ready, epoch: () => epoch,
    attach: async () => { attaches++; return 'original-live'; }, history: async () => rows,
    submit: async (_live: string, text: string): Promise<unknown> => {
      submissions++; rows.push({ row_id: 2, role: 'user', text, timestamp: 2 }); return { status: 'streaming' };
    } };
  let count = 0;
  return { directory, tokens, actor, store, command, native, rows,
    get submissions() { return submissions; }, get attaches() { return attaches; },
    disconnect() { ready = false; epoch = 'replaced'; },
    async enqueue(text = 'original private input') {
      const commandKey = `original-${++count}`;
      const input = { key, authorization, commandKey, payloadJson: JSON.stringify({ message: text }) };
      const result = await command('hermesMessageSend', input);
      assert.ok('receipt' in result && result.admitted); return input;
    },
    facade(options: Partial<ConstructorParameters<typeof AsyncHermesDispatch>[0]> = {}) {
      return new AsyncHermesDispatch({ owner: { command }, native, deadlineMs: 10_000, diagnostics: silence, ...options });
    },
    close() { command.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('original receipt → same-actor FIFO batch → one native submit → row ACK → terminal history', async () => {
  const f = fixture();
  try {
    const first = await f.enqueue('first private'), second = await f.enqueue('second private');
    let local!: HermesExecution, callbackRows: HermesHistoryRow[] = [];
    const dispatch = f.facade({ claimed: e => { local = e; }, admitted: async (e, rows) => { assert.equal(e.phase, 'running'); callbackRows = rows; } });
    assert.equal(await dispatch.dispatch(key), 'admitted');
    assert.equal(f.submissions, 1); assert.equal(local.row, 2); assert.equal(local.members.length, 2);
    assert.deepEqual(f.store.turns.list('hermes', key), []);
    assert.equal(f.store.hermesJournal.current(key)?.phase, 'running');
    assert.equal(await dispatch.dispatch(key), 'not_started');
    for (const input of [first, second]) {
      const duplicate = await f.command('hermesMessageSend', input);
      assert.ok('receipt' in duplicate && !duplicate.admitted);
    }
    callbackRows.push({ row_id: 3, role: 'assistant', text: 'private answer', timestamp: 3 });
    assert.equal(await new AsyncHermesExecution({ command: f.command }).terminal(local, 'completed', 'rotated', callbackRows), true);
    assert.equal(f.store.hermesJournal.session(key)?.stored, 'rotated');
    assert.deepEqual(f.store.hermesJournal.session(key)?.messages.filter(m => m.turnId === local.id && m.role === 'user').map(m => m.text), ['first private', 'second private']);
    assert.equal(f.submissions, 1);
  } finally { f.close(); }
});

for (const change of ['session', 'new-member', 'revoked', 'maintenance', 'deletion'] as const)
  test(`plan is not a lease: ${change} before claim denies original transaction`, async () => {
    const f = fixture();
    try {
      await f.enqueue(); const plan = await f.command('hermesDispatchPlan', { key });
      assert.ok(plan && plan !== 'blocked');
      if (change === 'session') f.store.hermesJournal.save({ ...f.store.hermesJournal.session(key)!, stored: 'changed-native' });
      if (change === 'new-member') await f.enqueue('new tail');
      if (change === 'revoked') f.tokens.revoke(f.actor);
      if (change === 'maintenance') f.store.pauseTurnStarts();
      if (change === 'deletion') f.store.hermesJournal.beginDeletion(key);
      assert.equal(await f.command('hermesDispatchClaim', { key, digest: plan.digest, id: 'original-execution', live: 'live', epoch: 'epoch',
        ...(plan.batch ? { separator: plan.batch.separator } : {}) }), null);
      assert.equal(f.store.hermesJournal.current(key), undefined);
      assert.equal(f.store.turns.list('hermes', key)[0]?.state, change === 'revoked' ? 'blocked' : 'queued'); assert.equal(f.submissions, 0);
    } finally { f.close(); }
  });

for (const change of ['stored-identity', 'new-tail', 'queued-edit'] as const)
  test(`native preparation uses fresh original FIFO after ${change}, without stranding the queue`, async () => {
    const f = fixture();
    try {
      await f.enqueue('first'); let reads = 0;
      f.native.attach = async () => {
        if (change === 'stored-identity') f.store.hermesJournal.save({ ...f.store.hermesJournal.session(key)!, stored: 'rotated' });
        return 'original-live';
      };
      f.native.history = async () => {
        if (++reads === 1) {
          if (change === 'new-tail') await f.enqueue('second');
          if (change === 'queued-edit') {
            const head = f.store.turns.list('hermes', key)[0]!;
            f.store.turns.edit<{ text: string }>('hermes', key, head.id, payload => ({ ...payload, text: 'edited' }));
          }
        }
        return f.rows;
      };
      assert.equal(await f.facade().dispatch(key), 'admitted');
      assert.equal(f.submissions, 1); assert.deepEqual(f.store.turns.list('hermes', key), []);
      const execution = f.store.hermesJournal.current(key)!;
      assert.equal(execution.members.length, change === 'new-tail' ? 2 : 1);
      assert.equal(f.rows.at(-1)!.text, change === 'new-tail' ? `first${execution.batch!.separator}second` : change === 'queued-edit' ? 'edited' : 'first');
    } finally { f.close(); }
  });

test('revocation during native preparation persists blocked head and does not submit', async () => {
  const f = fixture();
  try {
    await f.enqueue(); f.native.history = async () => { f.tokens.revoke(f.actor); return f.rows; };
    assert.equal(await f.facade().dispatch(key), 'blocked'); assert.equal(f.submissions, 0);
    assert.equal(f.store.turns.list('hermes', key)[0]?.state, 'blocked');
    assert.equal(f.store.hermesJournal.current(key), undefined);
  } finally { f.close(); }
});

for (const change of ['revoke', 'maintenance', 'disconnect', 'projection-error'] as const)
  test(`post-claim ${change} protects original intent without sending or unlocking`, async () => {
    const f = fixture();
    try {
      await f.enqueue();
      const dispatch = f.facade({ claimed: () => {
        if (change === 'revoke') f.tokens.revoke(f.actor);
        if (change === 'maintenance') f.store.pauseTurnStarts();
        if (change === 'disconnect') f.disconnect();
        if (change === 'projection-error') throw Error('private projection failure');
      } });
      assert.equal(await dispatch.dispatch(key), 'unknown'); assert.equal(f.submissions, 0);
      assert.equal(f.store.hermesJournal.current(key)?.phase, 'unknown');
      assert.equal(f.store.turns.list('hermes', key)[0]?.state, 'outcome_unknown');
      assert.equal(await dispatch.dispatch(key), 'not_started');
    } finally { f.close(); }
  });

for (const failure of ['bad-ack', 'missing-row', 'duplicate-row', 'reset-history', 'extra-user', 'throw', 'disconnect'] as const)
  test(`single native submit with ${failure} freezes original queue, never resends`, async () => {
    const f = fixture();
    try {
      await f.enqueue(); let submits = 0;
      f.native.submit = async (_live, text) => {
        submits++;
        if (failure === 'throw') throw Error('private native failure');
        if (failure === 'disconnect') f.disconnect();
        if (failure === 'reset-history') f.rows.splice(0);
        if (failure !== 'missing-row') f.rows.push({ row_id: failure === 'duplicate-row' ? 1 : 2, role: 'user', text, timestamp: 2 });
        if (failure === 'extra-user') f.rows.push({ row_id: 3, role: 'user', text: 'foreign', timestamp: 3 });
        return { status: failure === 'bad-ack' ? 'accepted' : 'streaming' };
      };
      const dispatch = f.facade();
      assert.equal(await dispatch.dispatch(key), 'unknown');
      assert.equal(f.store.hermesJournal.current(key)?.phase, 'unknown');
      assert.equal(await dispatch.dispatch(key), 'not_started'); assert.equal(submits, 1);
      assert.equal(f.store.turns.list('hermes', key)[0]?.state, 'outcome_unknown');
    } finally { f.close(); }
  });

test('local execution stays starting until original async admission is durably acknowledged', async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<void>();
  try {
    await f.enqueue(); let local!: HermesExecution;
    const command: typeof f.command = Object.assign(async (...args: Parameters<typeof f.command>) => {
      if (args[0] === 'hermesExecutionAdmitted') { entered.resolve(); await release.promise; }
      return f.command(...args);
    }, { dispose: () => {} }) as typeof f.command;
    const dispatch = f.facade({ owner: { command }, claimed: e => { local = e; } });
    const pending = dispatch.dispatch(key); await entered.promise;
    assert.equal(local.phase, 'starting'); assert.equal(f.store.hermesJournal.current(key)?.phase, 'starting');
    release.resolve(); assert.equal(await pending, 'admitted'); assert.equal(local.phase, 'running');
  } finally { release.resolve(); f.close(); }
});

for (const stage of ['attach', 'submit'] as const) for (const cancellation of ['deadline', 'abort'] as const)
  test(`${stage} ${cancellation} retains physical same-key gate until original promise settles`, async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>(), abort = new AbortController();
    try {
      await f.enqueue(); let calls = 0;
      if (stage === 'attach') f.native.attach = async () => { calls++; entered.resolve(); await release.promise; return 'original-live'; };
      else f.native.submit = async () => { calls++; entered.resolve(); await release.promise; return { status: 'streaming' }; };
      const dispatch = f.facade({ deadlineMs: cancellation === 'deadline' ? 25 : 10_000 });
      const pending = dispatch.dispatch(key, abort.signal);
      // Install rejection handler before triggering abort/deadline.
      const observed = stage === 'attach' ? assert.rejects(pending, NativeOperationError) : pending.then(value => assert.equal(value, 'unknown'));
      await entered.promise; if (cancellation === 'abort') abort.abort(); await observed;
      assert.equal(await dispatch.dispatch(key), 'not_started'); assert.equal(calls, 1);
      release.resolve(); await tick(); await tick();
      if (stage === 'attach') {
        f.native.attach = async () => 'original-live'; assert.equal(await dispatch.dispatch(key), 'admitted');
      } else { assert.equal(await dispatch.dispatch(key), 'not_started'); assert.equal(f.store.hermesJournal.current(key)?.phase, 'unknown'); }
      assert.equal(calls, 1);
    } finally { release.resolve(); f.close(); }
  });

for (const stage of ['attach', 'submit'] as const) for (const action of ['pause', 'close'] as const)
  test(`${action} drains timed-out physical ${stage} without replay or closing the shared owner`, async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>();
    try {
      await f.enqueue();
      if (stage === 'attach') f.native.attach = async () => { entered.resolve(); await release.promise; return 'original-live'; };
      else f.native.submit = async () => { entered.resolve(); await release.promise; return { status: 'streaming' }; };
      const dispatch = f.facade({ deadlineMs: 25 });
      const pending = dispatch.dispatch(key);
      const observed = stage === 'attach' ? assert.rejects(pending, NativeOperationError) : pending.then(result => assert.equal(result, 'unknown'));
      await entered.promise; await observed;
      let drained = false;
      const paused = action === 'pause' ? dispatch.pause() : undefined;
      const closing = action === 'close' ? dispatch.close() : undefined;
      if (closing) assert.equal(dispatch.close(), closing);
      const drain = (paused?.drained ?? closing!).then(() => { drained = true; });
      await tick(); assert.equal(drained, false);
      assert.equal(await dispatch.dispatch(key), 'not_started');
      release.resolve(); await drain; assert.equal(drained, true);
      // Shared worker is still owned by the original assembly, not this consumer.
      const original = await f.command('hermesExecutionRead', { sessionKey: key });
      assert.equal(original?.phase ?? null, stage === 'submit' ? 'unknown' : null);
      if (action === 'close') {
        assert.equal(dispatch.resume(), false); assert.equal(await dispatch.dispatch(key), 'not_started');
      } else {
        assert.equal(paused!.resume(), true); f.native.attach = async () => 'original-live';
        assert.equal(await dispatch.dispatch(key), stage === 'attach' ? 'admitted' : 'not_started');
      }
    } finally { release.resolve(); f.close(); }
  });

test('close waits original admission IPC and preserves its protected result', async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<void>();
  try {
    await f.enqueue();
    const command = Object.assign(async (...args: Parameters<typeof f.command>) => {
      if (args[0] === 'hermesExecutionAdmitted') { entered.resolve(); await release.promise; }
      return f.command(...args);
    }, { dispose: () => {} }) as typeof f.command;
    const dispatch = f.facade({ owner: { command } }), pending = dispatch.dispatch(key);
    await entered.promise; let drained = false;
    const drain = dispatch.close().then(() => { drained = true; });
    await tick(); assert.equal(drained, false);
    release.resolve(); assert.equal(await pending, 'unknown'); await drain;
    assert.equal(f.submissions, 1); assert.equal(f.store.hermesJournal.current(key)?.row, 2);
    assert.equal(f.store.hermesJournal.current(key)?.phase, 'unknown'); assert.equal(dispatch.resume(), false);
  } finally { release.resolve(); f.close(); }
});

for (const stage of ['plan', 'attach', 'submit'] as const) for (const action of ['pause', 'close'] as const)
  test(`synchronous ${stage} reentry into ${action} cannot acknowledge drain before original work settles`, async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>();
    let drain: Promise<void> | undefined, work: Promise<unknown> | undefined, drained = false, stopped = false;
    let dispatch!: AsyncHermesDispatch;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      drain = (action === 'pause' ? dispatch.pause().drained : dispatch.close()).then(() => { drained = true; });
      entered.resolve();
    };
    try {
      await f.enqueue();
      const command = Object.assign(async (...args: Parameters<typeof f.command>) => {
        if (stage === 'plan' && args[0] === 'hermesDispatchPlan') { stop(); await release.promise; }
        return f.command(...args);
      }, { dispose: () => {} }) as typeof f.command;
      if (stage === 'attach') f.native.attach = async () => { stop(); await release.promise; return 'original-live'; };
      if (stage === 'submit') f.native.submit = async () => { stop(); await release.promise; return { status: 'streaming' }; };
      dispatch = f.facade({ owner: { command }, deadlineMs: 25 });
      const pending = dispatch.dispatch(key);
      work = pending;
      const observed = stage === 'attach' ? assert.rejects(pending, NativeOperationError) : pending;
      await entered.promise;
      if (stage !== 'plan') await observed;
      await tick(); assert.equal(drained, false);
      assert.equal(await dispatch.dispatch(key), 'not_started');
      release.resolve();
      if (stage === 'plan') assert.equal(await observed, 'not_started');
      if (stage === 'submit') assert.equal(await observed, 'unknown');
      await drain; assert.equal(drained, true);
      assert.equal(f.store.hermesJournal.current(key)?.phase ?? null, stage === 'submit' ? 'unknown' : null);
    } finally { release.resolve(); await Promise.allSettled([work, drain]); f.close(); }
  });

test('normal empty and revoked dispatch observations are not execution failures', async () => {
  for (const revoked of [false, true]) {
    const f = fixture(), diagnostics = new PerformanceDiagnostics(() => {});
    try {
      if (revoked) { await f.enqueue(); f.tokens.revoke(f.actor); }
      assert.equal(await f.facade({ diagnostics }).dispatch(key), revoked ? 'blocked' : 'not_started');
      assert.equal(diagnostics.snapshot().totals.failed, 0); assert.equal(f.submissions, 0);
    } finally { f.close(); }
  }
});

test('published dispatch work is bounded before callbacks and close fences deferred native access', async () => {
  const f = fixture(), release = deferred<void>();
  let dispatch: AsyncHermesDispatch | undefined;
  const work: Promise<unknown>[] = [];
  try {
    let calls = 0;
    const command = Object.assign(async () => { calls++; await release.promise; return null; }, { dispose: () => {} }) as typeof f.command;
    dispatch = f.facade({ owner: { command } });
    for (let i = 0; i < 128; i++) work.push(dispatch.dispatch(`hermes:capacity-${i}`));
    assert.equal(await dispatch.dispatch('hermes:overflow'), 'not_started'); assert.equal(calls, 128);
    release.resolve(); await Promise.all(work);
    assert.equal(await dispatch.dispatch('hermes:after-drain'), 'not_started'); assert.equal(calls, 129);
    await dispatch.close();
    const original = f.facade();
    const pending = original.dispatch(key), closed = original.close();
    assert.equal(await pending, 'not_started'); await closed; assert.equal(f.attaches, 0);
  } finally { release.resolve(); await Promise.allSettled(work); await dispatch?.close(); f.close(); }
});

test('aggregate prompt cap retains exact FIFO remainder for a later turn', async () => {
  const f = fixture();
  try {
    await f.enqueue('x'.repeat(MAX_MESSAGE_CHARS)); await f.enqueue('tail');
    const plan = await f.command('hermesDispatchPlan', { key }); assert.ok(plan && plan !== 'blocked');
    assert.equal(plan.text.length, MAX_MESSAGE_CHARS); assert.equal(plan.members.length, 1);
    assert.equal(await f.facade().dispatch(key), 'admitted'); assert.equal(f.store.turns.list('hermes', key).length, 1);
  } finally { f.close(); }
});

test('dispatch protocol never accepts caller actor, authority, prompt, SQL, or callback', () => {
  const inputs = { hermesDispatchPlan: { key }, hermesDispatchClaim: { key, digest: 'a'.repeat(64), id: 'id', live: 'live', epoch: 'epoch' },
    hermesDispatchPreparationFailed: { key, head: 'original' } };
  for (const [kind, input] of Object.entries(inputs)) {
    assert.equal(validConnectorHermesDispatchInput(kind as ConnectorHermesDispatchKind, input), true);
    for (const name of ['actorId', 'authorized', 'text', 'sql', 'callback'])
      assert.equal(validConnectorHermesDispatchInput(kind as ConnectorHermesDispatchKind, { ...input, [name]: true }), false);
  }
});

test('preparation denial respects maintenance, original queued head and original execution protection', async () => {
  const f = fixture();
  try {
    await f.enqueue(); const head = f.store.turns.head('hermes', key)!;
    const resume = f.store.pauseTurnStarts();
    assert.equal(await f.command('hermesDispatchPreparationFailed', { key, head: head.id }), false);
    assert.equal(f.store.turns.head('hermes', key)?.state, 'queued'); assert.equal(resume(), true);
    f.store.hermesJournal.update({ id: 'protected', key, live: 'live', epoch: 'epoch', phase: 'unknown', members: [], at: 1, updated: 1 });
    assert.equal(await f.command('hermesDispatchPreparationFailed', { key, head: head.id }), false);
    assert.equal(f.store.turns.head('hermes', key)?.state, 'queued');
  } finally { f.close(); }
  const original = fixture();
  try {
    await original.enqueue(); const head = original.store.turns.head('hermes', key)!;
    assert.equal(await original.command('hermesDispatchPreparationFailed', { key, head: head.id }), true);
    assert.equal(original.store.turns.head('hermes', key)?.state, 'blocked');
    assert.equal(await original.command('hermesDispatchPreparationFailed', { key, head: head.id }), false);
    assert.equal(original.submissions, 0);
  } finally { original.close(); }
});

for (const stage of ['hermesDispatchClaim', 'hermesExecutionAdmitted'] as const)
  test(`lost ${stage} ACK never permits native replay or an unlocked original intent`, async () => {
    const f = fixture();
    try {
      await f.enqueue();
      const command = Object.assign(async (...args: Parameters<typeof f.command>) => {
        const result = await f.command(...args);
        if (args[0] === stage) throw Error('private lost transport ACK');
        return result;
      }, { dispose: () => {} }) as typeof f.command;
      const dispatch = f.facade({ owner: { command } });
      if (stage === 'hermesDispatchClaim') await assert.rejects(dispatch.dispatch(key));
      else assert.equal(await dispatch.dispatch(key), 'unknown');
      assert.equal(f.store.hermesJournal.canStart(key), false);
      assert.equal(await dispatch.dispatch(key), 'not_started');
      assert.equal(f.submissions, stage === 'hermesDispatchClaim' ? 0 : 1);
      if (stage === 'hermesExecutionAdmitted') assert.equal(f.store.hermesJournal.current(key)?.row, 2);
    } finally { f.close(); }
  });

test('concurrent original plans cannot both claim, and execution IDs cannot overwrite history', async () => {
  const f = fixture();
  try {
    await f.enqueue(); const plan = await f.command('hermesDispatchPlan', { key }); assert.ok(plan && plan !== 'blocked');
    const request = { key, digest: plan.digest, id: 'original-execution', live: 'live', epoch: 'epoch' };
    const first = await f.command('hermesDispatchClaim', request); assert.ok(first);
    assert.equal(await f.command('hermesDispatchClaim', { ...request, id: 'competing-execution' }), null);
    const foreign = 'hermes:foreign';
    f.store.hermesJournal.save({ key: foreign, stored: 'native', title: 'Foreign', started: false, messages: [] });
    assert.equal(f.store.hermesJournal.begin({ ...first, key: foreign }, f.store.turns), false);
    assert.equal(f.store.hermesJournal.current(key)?.key, key);
  } finally { f.close(); }
});

test('readiness must be exactly true and dispatch logs never contain private identities or prompts', async () => {
  const f = fixture(), lines: string[] = [];
  try {
    await f.enqueue();
    const native = { ...f.native, available: (() => Promise.resolve(true)) as unknown as () => boolean };
    assert.equal(await f.facade({ native }).dispatch(key), 'not_started'); assert.equal(f.attaches, 0);
    assert.equal(await f.facade({ diagnostics: new PerformanceDiagnostics(line => lines.push(line)) }).dispatch(key), 'admitted');
    assert.ok(lines.some(line => line.includes('hermes-async-dispatch')));
    const text = lines.join('\n');
    for (const privateValue of [key, token, f.actor, 'original-live', 'original-epoch', 'original private input']) assert.ok(!text.includes(privateValue));
  } finally { f.close(); }
});

class Fake extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { return Promise.resolve(1); }
}
for (const field of ['key', 'id', 'live', 'epoch'] as const)
  test(`foreign ${field} claim ACK retires original worker without replay`, async () => {
    const f = fixture(), fake = new Fake();
    const owner = new AsyncConnectorOwner({ file: join(f.directory, 'unused.sqlite') }, silence, () => fake as unknown as Worker);
    try {
      await f.enqueue(); const plan = await f.command('hermesDispatchPlan', { key }); assert.ok(plan && plan !== 'blocked');
      const request = { key, digest: plan.digest, id: 'original-execution', live: 'live', epoch: 'epoch' };
      const claimed = await f.command('hermesDispatchClaim', request); assert.ok(claimed);
      fake.emit('message', { kind: 'ready' });
      const pending = owner.command('hermesDispatchClaim', request), rejected = assert.rejects(pending, ConnectorOwnerUnavailable);
      await tick(); const wire = fake.messages[0]!;
      fake.emit('message', { id: wire.id, kind: wire.kind, ok: true,
        body: JSON.stringify({ ...claimed, [field]: field === 'key' ? 'hermes:foreign' : 'foreign' }) });
      await rejected; assert.equal(fake.messages.length, 1); assert.equal(f.submissions, 0);
    } finally {
      const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped; f.close();
    }
  });

test('real unique worker dispatch survives close/reopen, keeps original row binding and receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-dispatch-worker-'));
  const config = { file: join(directory, 'original.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: token };
  const source = new ConnectorUserStore(config.file);
  source.hermesJournal.save({ key, stored: 'native', title: 'Original', started: false, messages: [] }); source.close();
  let owner = new AsyncConnectorOwner(config, silence);
  try {
    await owner.open();
    const request = { key, authorization, commandKey: 'worker-original', payloadJson: JSON.stringify({ message: 'private input' }) };
    const sent = await owner.command('hermesMessageSend', request); assert.ok('receipt' in sent && sent.admitted);
    const rows: HermesHistoryRow[] = []; let submits = 0;
    const dispatch = new AsyncHermesDispatch({ owner, deadlineMs: 10_000, diagnostics: silence, native: {
      available: () => true, epoch: () => 'epoch', attach: async () => 'live', history: async () => rows,
      submit: async (_live, text) => { submits++; rows.push({ row_id: 7, role: 'user', text, timestamp: 1 }); return { status: 'streaming' }; },
    } });
    assert.equal(await dispatch.dispatch(key), 'admitted'); assert.equal(submits, 1);
    await owner.close(); owner = new AsyncConnectorOwner(config, silence); await owner.open();
    const execution = new AsyncHermesExecution(owner);
    assert.equal((await execution.read(key))?.row, 7);
    assert.deepEqual(await execution.recoverPage('', 8), [key]);
    assert.equal((await execution.read(key))?.phase, 'unknown');
    const duplicate = await owner.command('hermesMessageSend', request); assert.ok('receipt' in duplicate && !duplicate.admitted);
    assert.equal(submits, 1);
  } finally { await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});
