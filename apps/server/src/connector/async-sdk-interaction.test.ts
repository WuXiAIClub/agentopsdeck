import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { InteractionRuntime } from '../commands/interaction-runtime.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { validConnectorSdkDispatchInput, validConnectorSdkDispatchOutput } from './connector-sdk-dispatch-domain.js';
import { AsyncSdkInteractions } from './async-sdk-interaction.js';
import { AsyncSdkDispatch } from './async-sdk-dispatch.js';
import type { SdkAgentId, SdkCompactRef } from './sdk-execution-journal.js';
import type { SdkDispatchAdapter } from './sdk-dispatch.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ClaudeDispatchAdapter } from '../claude/dispatch-adapter.js';
import { CopilotDispatchAdapter } from '../copilot/dispatch-adapter.js';

function fixture(runtime: SdkAgentId) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-interaction-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), 'test-sdk-interaction');
  const actorId = tokens.authenticateAuthorization('Bearer test-sdk-interaction')!.tokenId;
  const store = new ConnectorUserStore(':memory:', () => false, { runtimeOwner: true });
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
  const key = `${runtime}:interaction`;
  journal.create({ key, nativeSessionId: 'native-session', title: 'Private', createdAt: 0 });
  const owner = { command: createConnectorOwnerCommands(store, tokens) };
  const interactions = new InteractionRuntime(store.interactions, () => true);
  const manager = new AsyncSdkInteractions({ owner, runtime, interactions });
  const enqueue = (id: string, actor = actorId) => store.turns.enqueue(runtime,
    { id, sessionKey: key, createdAt: 0, payload: { text: id, images: [], actorId: actor } });
  const claim = async () => {
    const plan = await owner.command('sdkDispatchPlan', { runtime, key });
    assert.ok(plan && plan !== 'blocked');
    const execution = await owner.command('sdkDispatchClaim', { runtime, key, id: 'original-run', epoch: 'original-epoch',
      digest: plan.digest, ...(plan.batch ? { separator: plan.batch.separator } : {}) });
    assert.ok(execution);
    const { id, epoch, nativeSessionId } = execution;
    return { key, id, epoch, nativeSessionId };
  };
  const mode = () => store.interactions.setMode({ ownerId: actorId, nodeId: store.nodeId, sessionKey: key }, 'interactive');
  return { directory, tokens, actorId, store, journal, key, owner, interactions, manager, enqueue, claim, mode,
    close: async () => { await manager.close(); interactions.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const gate = () => { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), release: () => resolve() }; };

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: real sole worker binds original authority and original vendor adapter receives the local context`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-interaction-worker-'));
    const file = join(directory, 'connector.sqlite'), tokenFile = join(directory, 'tokens.json');
    const tokens = new ConnectorTokenStore(tokenFile, 'test-sdk-worker');
    const actorId = tokens.authenticateAuthorization('Bearer test-sdk-worker')!.tokenId;
    const seed = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    const key = `${runtime}:original-worker`;
    const journal = runtime === 'ghcp' ? seed.copilotJournal : seed.claudeJournal;
    journal.create({ key, nativeSessionId: randomUUID(), title: 'Worker', createdAt: 0 });
    seed.interactions.setMode({ ownerId: actorId, nodeId: seed.nodeId, sessionKey: key }, 'interactive');
    await seed.turns.enqueueAsync(runtime, { id: 'original-input', sessionKey: key, createdAt: 0, payload: { actorId, text: 'original', images: [] } });
    const expectedNode = seed.nodeId; seed.close();
    const owner = new AsyncConnectorOwner({ file, tokenFile }, new PerformanceDiagnostics(() => {}));
    // This runtime is the local native handle registry; this test does not
    // invoke its still-unmigrated durable interaction operations.
    const local = new ConnectorUserStore(':memory:');
    const interactions = new InteractionRuntime(local.interactions, () => true);
    const manager = new AsyncSdkInteractions({ owner, runtime, interactions });
    let reached = false;
    const callbacks = { epoch: 'original-worker-epoch', terminal: async () => false, unknown: () => {},
      start: (_e: unknown, _text: string, _context: unknown, _attachments: unknown, context?: import('../commands/interaction-port.js').WorkerInteractionContext): never => {
        assert.ok(context); assert.equal(context.runtime, interactions);
        assert.equal(context.scope.ownerId, actorId); assert.equal(context.scope.nodeId, expectedNode);
        reached = true; throw Error('fixture stops before actual provider effect');
      } };
    const adapter = runtime === 'ghcp' ? new CopilotDispatchAdapter(callbacks) : new ClaudeDispatchAdapter(callbacks);
    try {
      await owner.open();
      const dispatch = new AsyncSdkDispatch({ owner, runtime, adapter, interactions: manager, deadlineMs: 1000 });
      assert.equal(await dispatch.dispatch(key), 'unknown'); assert.equal(reached, true);
      assert.equal((await owner.command('sdkSnapshotRead', { runtime, key })).execution?.phase, 'unknown');
      assert.equal(await dispatch.dispatch(key), 'not_started');
    } finally {
      adapter.close(); await manager.close(); interactions.close(); local.close(); await owner.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test(`${runtime}: original binding survives queue ACK, retains capabilities and rechecks revocation`, async () => {
    const f = fixture(runtime);
    try {
      f.mode(); f.enqueue('original'); const ref = await f.claim();
      const context = await f.manager.prepare(ref); assert.ok(context);
      assert.equal(context.runtime, f.interactions);
      assert.deepEqual(context.scope, { ownerId: f.actorId, nodeId: f.store.nodeId, sessionKey: f.key, runId: ref.id });
      assert.equal(context.capabilities.kinds.includes('multi-select'), runtime === 'claude-code');
      assert.equal(await f.owner.command('sdkNativeReady', { runtime, ref }), true);
      assert.equal(await f.owner.command('sdkExecutionAcknowledge', { runtime, ref, nativeRequestId: 'original-ack' }), true);
      assert.equal(f.store.turns.head(runtime, f.key), undefined);
      assert.equal(await context.permitted(), true);
      assert.deepEqual(await context.continuation(), { connectionId: ref.epoch, goal: { status: 'absent', version: `${runtime}:no-native-goal:v1` } });
      f.tokens.revoke(f.actorId);
      assert.equal(await context.permitted(), false);
      await assert.rejects(context.continuation(), /Original native execution is unavailable/);
      await f.manager.release(ref); assert.equal(await context.permitted(), false);
    } finally { await f.close(); }
  });
  test(`${runtime}: automatic mode has no binding and different actors never coalesce`, async () => {
    const f = fixture(runtime);
    try {
      f.enqueue('first'); const ref = await f.claim();
      assert.equal(await f.manager.prepare(ref), undefined);
      f.mode();
      // Original actor metadata, not a caller-supplied owner, is the only source.
      const binding = await f.owner.command('sdkInteractionPrepare', { runtime, ref }); assert.ok(binding);
      assert.equal(await f.owner.command('sdkInteractionCheck', { runtime, ref: { ...ref, epoch: 'foreign' }, bindingId: binding.bindingId }), false);
      assert.equal(await f.owner.command('sdkInteractionRelease', { runtime, ref: { ...ref, nativeSessionId: 'foreign' }, bindingId: binding.bindingId }), false);
      assert.equal(await f.owner.command('sdkInteractionRelease', { runtime, ref, bindingId: binding.bindingId }), true);
      const other = f.tokens.create({ label: 'other', scopes: ['messages:send'] });
      const mixedKey = `${runtime}:mixed`;
      f.journal.create({ key: mixedKey, nativeSessionId: 'native-mixed', title: 'Mixed', createdAt: 0 });
      for (const [id, actorId] of [['a', f.actorId], ['b', other.record.id]]) f.store.turns.enqueue(runtime,
        { id: id!, sessionKey: mixedKey, createdAt: 0, payload: { text: id!, images: [], actorId: actorId! } });
      const plan = await f.owner.command('sdkDispatchPlan', { runtime, key: mixedKey }); assert.ok(plan && plan !== 'blocked');
      assert.deepEqual(plan.members, ['a']); assert.equal(plan.batch, undefined);
      const e = await f.owner.command('sdkDispatchClaim', { runtime, key: mixedKey, id: 'mixed', epoch: 'epoch', digest: plan.digest });
      assert.ok(e);
      assert.equal(await f.owner.command('sdkInteractionPrepare', { runtime, ref: { key: e.key, id: e.id, epoch: e.epoch, nativeSessionId: e.nativeSessionId } }), null);
    } finally { await f.close(); }
  });
  for (const fault of ['stop', 'maintenance', 'unknown', 'foreign-id', 'foreign-native', 'foreign-epoch'] as const) {
    test(`${runtime}: interaction ${fault} never returns a usable continuation`, async () => {
      const f = fixture(runtime);
      try {
        f.mode(); f.enqueue('original'); const ref = await f.claim();
        const context = await f.manager.prepare(ref); assert.ok(context);
        if (fault === 'stop') {
          assert.equal(f.journal.acknowledge(ref, 'original-ack', f.store.turns), true);
          assert.equal(f.journal.requestStop(ref), true);
        }
        if (fault === 'maintenance') await f.owner.command('maintenancePause', {});
        if (fault === 'unknown') f.journal.markUnknown(ref, f.store.turns);
        if (fault.startsWith('foreign')) {
          const field = fault === 'foreign-id' ? 'id' : fault === 'foreign-native' ? 'nativeSessionId' : 'epoch';
          assert.equal(await f.owner.command('sdkNativeReady', { runtime, ref: { ...ref, [field]: 'foreign' } }), false);
          await assert.rejects(f.manager.prepare({ ...ref, [field]: 'foreign' }));
        } else {
          assert.equal(await context.permitted(), false);
          await assert.rejects(context.continuation());
        }
      } finally {
        // Failed original preparation is a cleanup failure, not success.
        if (fault.startsWith('foreign')) {
          await assert.rejects(f.manager.close()); f.interactions.close(); f.store.close(); rmSync(f.directory, { recursive: true, force: true });
        } else await f.close();
      }
    });
  }
  for (const fault of ['revoke', 'pause', 'stop'] as const) {
    test(`${runtime}: ${fault} after asynchronous preparation prevents native start and replay`, async () => {
      const f = fixture(runtime); let calls = 0;
      try {
        f.enqueue('original');
        const adapter: SdkDispatchAdapter = { epoch: 'epoch', ready: true,
          send: async () => { calls++; return { nativeRequestId: 'unexpected' }; }, interrupt: async () => {},
          inspectSettlement: async e => ({ ...e, historyPersisted: true, nativeQuiescent: true }) };
        const dispatch = new AsyncSdkDispatch({ owner: f.owner, runtime, adapter, deadlineMs: 1000,
          interactions: { release: async () => {}, prepare: async ref => {
            if (fault === 'revoke') f.tokens.revoke(f.actorId);
            if (fault === 'pause') await f.owner.command('maintenancePause', {});
            if (fault === 'stop') {
              assert.equal(f.journal.acknowledge(ref, 'original-ack', f.store.turns), true);
              assert.equal(f.journal.requestStop(ref), true);
            }
            return undefined;
          } } });
        assert.equal(await dispatch.dispatch(f.key), 'unknown'); assert.equal(calls, 0);
        assert.equal(f.journal.current(f.key)?.phase, 'unknown');
        assert.equal(await dispatch.dispatch(f.key), 'not_started'); assert.equal(calls, 0);
      } finally { await f.close(); }
    });
  }
  test(`${runtime}: close waits original prepare/release and invalidates late permission receipts`, async () => {
    const f = fixture(runtime), preparing = gate(), releasing = gate(), checked = gate(), entered = gate();
    try {
      f.mode(); f.enqueue('original'); const ref = await f.claim();
      const port = { command: (async (kind, input) => {
        if (kind === 'sdkInteractionPrepare') await preparing.promise;
        const value = await f.owner.command(kind, input);
        if (kind === 'sdkInteractionRelease') await releasing.promise;
        if (kind === 'sdkInteractionCheck') { entered.release(); await checked.promise; }
        return value;
      }) as typeof f.owner.command };
      const manager = new AsyncSdkInteractions({ owner: port, runtime, interactions: f.interactions });
      const pending = manager.prepare(ref); preparing.release();
      const context = await pending; assert.ok(context);
      const permission = context.permitted(); await entered.promise;
      let closed = false; const closing = manager.close().then(() => { closed = true; });
      checked.release(); assert.equal(await permission, false);
      await new Promise<void>(done => setImmediate(done)); assert.equal(closed, false);
      releasing.release(); await closing;
      await assert.rejects(manager.prepare(ref)); assert.equal(await context.permitted(), false);
    } finally { preparing.release(); releasing.release(); checked.release(); await f.close(); }
  });
}

test('SDK native/interaction fixed commands reject forged authority and malformed receipts', () => {
  const ref: SdkCompactRef = { key: 'ghcp:original', id: 'run', epoch: 'epoch', nativeSessionId: 'native' };
  for (const kind of ['sdkNativeReady', 'sdkInteractionPrepare'] as const) {
    assert.equal(validConnectorSdkDispatchInput(kind, { runtime: 'ghcp', ref }), true);
    assert.equal(validConnectorSdkDispatchInput(kind, { runtime: 'ghcp', ref, ownerId: 'forged' }), false);
    assert.equal(validConnectorSdkDispatchInput(kind, { runtime: 'claude-code', ref }), false);
  }
  assert.equal(validConnectorSdkDispatchOutput('sdkNativeReady', 1), false);
  assert.equal(validConnectorSdkDispatchOutput('sdkInteractionCheck', null), false);
  assert.equal(validConnectorSdkDispatchOutput('sdkInteractionPrepare', { bindingId: 'binding', ref,
    scope: { ownerId: 'actor', nodeId: 'node', sessionKey: ref.key, runId: 'other-run' } }), false);
});
