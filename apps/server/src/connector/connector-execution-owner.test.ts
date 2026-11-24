import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncConnectorExecutionReads } from './async-execution-reads.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { executeConnectorExecution, validConnectorExecutionInput, validConnectorExecutionOutput, type ExecutionOwner } from './connector-execution-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const silence = new PerformanceDiagnostics(() => {});
const codex = (sessionKey = 'session') => ({ sessionKey, commandId: 'command', connectionId: 'connection', phase: 'completed' as const,
  sync: 'current' as const, revision: 1, startedAt: 1, updatedAt: 2, runId: 'turn',
  nativeHistory: { turnId: 'turn', connectionId: 'connection', fingerprint: 'a'.repeat(64), state: 'verified' as const, reason: 'settled' as const } });
const openclaw = () => ({ sessionKey: 'session', commandId: 'command', origin: 'gateway' as const, phase: 'running' as const,
  startedAt: 1, updatedAt: 2, runId: 'run', gatewayConnectionId: 'gateway', revision: 1, historySync: { revision: 2, state: 'pending' as const } });
const page = { runtime: 'codex' as const, after: '', limit: 16 };
const recovery = { after: '', limit: 16, previousConnectionId: 'connection', nextConnectionId: 'next-connection' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('maintenance observation is a fixed metadata-only command with bounded counters', () => {
  assert.equal(validConnectorExecutionInput('codexMaintenanceObservation', {}), true);
  for (const input of [{ sql: 'SELECT 1' }, { authorized: true }, { sessionKey: 'forged' }, null]) {
    assert.equal(validConnectorExecutionInput('codexMaintenanceObservation', input), false);
  }
  assert.equal(validConnectorExecutionOutput('codexMaintenanceObservation', { pendingExecutions: 1, queuedMessages: 2 }), true);
  for (const counter of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validConnectorExecutionOutput('codexMaintenanceObservation', { pendingExecutions: counter, queuedMessages: 0 }), false);
    assert.equal(validConnectorExecutionOutput('codexMaintenanceObservation', { pendingExecutions: 0, queuedMessages: counter }), false);
  }
  const owner = { codexExecutions: { maintenancePending: () => 3 }, turns: { maintenanceCount: (runtime: string) => {
    assert.equal(runtime, 'codex'); return 4;
  } } } as unknown as ExecutionOwner;
  assert.deepEqual(executeConnectorExecution('codexMaintenanceObservation', {}, owner), { pendingExecutions: 3, queuedMessages: 4 });
});

test('execution fixed envelopes reject SQL, permission flags, callbacks, repair, invalid cursors and unbounded pages', () => {
  for (const kind of ['codexExecutionRead', 'codexHistoryObservation', 'openClawExecutionRead'] as const) {
    assert.equal(validConnectorExecutionInput(kind, { sessionKey: 'session' }), true);
    assert.equal(validConnectorExecutionInput(kind, { sessionKey: ' leading' }), true, 'original identities must not be trimmed');
    for (const sessionKey of ['', 'x'.repeat(4097)]) assert.equal(validConnectorExecutionInput(kind, { sessionKey }), false);
    if (kind !== 'openClawExecutionRead') for (const sessionKey of ['line\nbreak', '\0']) assert.equal(validConnectorExecutionInput(kind, { sessionKey }), false);
    for (const extra of ['sql', 'authorized', 'callback', 'repair', 'unlock', 'file']) assert.equal(validConnectorExecutionInput(kind, { sessionKey: 'session', [extra]: true }), false);
  }
  assert.equal(validConnectorExecutionInput('executionSessionPage', page), true);
  assert.equal(validConnectorExecutionInput('codexConnectionRecoveryPage', recovery), true);
  assert.equal(validConnectorExecutionInput('codexConnectionRecoveryPage', { ...recovery, nextConnectionId: null }), true);
  assert.equal(validConnectorExecutionInput('codexConnectionRecoveryPage', { ...recovery, previousConnectionId: null }), true);
  for (const limit of [0, 65, 1.5, Infinity]) assert.equal(validConnectorExecutionInput('executionSessionPage', { ...page, limit }), false);
  for (const patch of [{ nextConnectionId: 'connection' }, { previousConnectionId: '', nextConnectionId: null }, { nextConnectionId: 'x'.repeat(129) }, { after: '\0' }])
    assert.equal(validConnectorExecutionInput('codexConnectionRecoveryPage', { ...recovery, ...patch }), false);
  assert.equal(validConnectorExecutionInput('turnQueuePending', { runtime: 'openclaw', sessionKey: 'session' }), true);
  assert.equal(validConnectorExecutionInput('turnQueuePending', { runtime: 'unknown', sessionKey: 'session' }), false);
});

test('journal snapshots retain independent terminal/native/Goal and history generations, never raw SQL authority', () => {
  const observed = { execution: codex(), deleted: false, outcomeUnknown: true };
  assert.equal(validConnectorExecutionOutput('codexHistoryObservation', observed), true);
  for (const patch of [{ execution: {} }, { deleted: 1 }, { outcomeUnknown: null }, { authorized: true }, { sql: 'SELECT 1' }])
    assert.equal(validConnectorExecutionOutput('codexHistoryObservation', { ...observed, ...patch }), false);
  assert.equal(validConnectorExecutionOutput('codexExecutionRead', codex()), true);
  for (const reason of ['goal-active', 'goal-paused', 'goal-blocked', 'goal-unknown']) {
    assert.equal(validConnectorExecutionOutput('codexExecutionRead', { ...codex(), nativeHistory: { ...codex().nativeHistory, state: 'blocked', reason } }), true);
  }
  const batch = { separator: '\n[boundary]\n', members: [{ id: 'command', createdAt: 1, imageCount: 0 }, { id: 'second', createdAt: 1, imageCount: 2 }] };
  assert.equal(validConnectorExecutionOutput('codexExecutionRead', { ...codex(), batch }), true);
  assert.equal(validConnectorExecutionOutput('openClawExecutionRead', openclaw()), true);
  assert.equal(validConnectorExecutionOutput('openClawExecutionRead', { ...openclaw(), gatewayConnectionId: 'g'.repeat(512) }), true);
  assert.equal(validConnectorExecutionOutput('codexExecutionRead', { ...codex(' leading'), pendingCommandTools: Array.from({ length: 300 }, (_, i) => String(i)) }), true);
  for (const patch of [{ revision: 0 }, { commandId: '' }, { sync: 'ready' }, { phase: 'idle' }, { authorized: true }, { pendingCommandTools: ['tool', 'tool'] },
    { nativeHistory: { ...codex().nativeHistory, fingerprint: 'malformed' } }, { batch: { ...batch, members: [batch.members[0], batch.members[0]] } }])
    assert.equal(validConnectorExecutionOutput('codexExecutionRead', { ...codex(), ...patch }), false);
  for (const patch of [{ origin: 'other' }, { historySync: { revision: 0, state: 'current' } }, { gatewayConnectionId: '' }, { reason: 'settled' }, { fenced: false }])
    assert.equal(validConnectorExecutionOutput('openClawExecutionRead', { ...openclaw(), ...patch }), false);
  assert.equal(validConnectorExecutionOutput('codexExecutionRead', null), true);
  assert.equal(validConnectorExecutionOutput('openClawExecutionRead', undefined), false);
});

test('original read failures and identity conflicts remain unavailable, never a missing/settled observation', () => {
  const owner = { codexExecutions: { get: () => codex('wrong-session') } } as unknown as ExecutionOwner;
  assert.throws(() => executeConnectorExecution('codexExecutionRead', { sessionKey: 'session' }, owner), /unavailable/);
  owner.codexExecutions.get = () => { throw Error('original-read-failure'); };
  assert.throws(() => executeConnectorExecution('codexExecutionRead', { sessionKey: 'session' }, owner), /original-read-failure/);
});

for (const keys of [['b', 'a'], ['a', 'a'], [''], ['before'], Array.from({ length: 17 }, (_, i) => `z${String(i).padStart(2, '0')}`)])
  test(`invalid recovery page fails before original journal effects (${JSON.stringify(keys).slice(0, 60)})`, () => {
    let effects = 0;
    const owner = { codexExecutions: { sessionPage: () => keys, get: () => codex(), disconnectAcknowledged: () => effects++, invalidateNativeHistory: () => effects++ } } as unknown as ExecutionOwner;
    assert.throws(() => executeConnectorExecution('codexConnectionRecoveryPage', { ...recovery, after: 'before' }, owner), /unavailable/);
    assert.equal(effects, 0);
  });

test('all bounded page facts validate before any connection protection mutation', () => {
  let effects = 0;
  const owner = { codexExecutions: { sessionPage: () => ['a', 'b'], get: (key: string) => codex(key === 'b' ? 'wrong' : key),
    disconnectAcknowledged: () => effects++, invalidateNativeHistory: () => effects++ } } as unknown as ExecutionOwner;
  assert.throws(() => executeConnectorExecution('codexConnectionRecoveryPage', recovery, owner), /unavailable/);
  assert.equal(effects, 0);
});

test('disconnection only invalidates native proofs; replacement never settles unknown runs or replays dispatch', () => {
  const calls: unknown[] = [];
  const owner = { codexExecutions: { sessionPage: () => ['session'], get: () => codex(),
    disconnectAcknowledged: (...args: unknown[]) => { calls.push(['disconnect', ...args]); },
    invalidateNativeHistory: (...args: unknown[]) => { calls.push(['invalidate', ...args]); } } } as unknown as ExecutionOwner;
  assert.deepEqual(executeConnectorExecution('codexConnectionRecoveryPage', { ...recovery, nextConnectionId: null }, owner), ['session']);
  assert.deepEqual(calls, [['invalidate', 'session', 'restarted']]); calls.length = 0;
  executeConnectorExecution('codexConnectionRecoveryPage', recovery, owner);
  assert.deepEqual(calls, [['disconnect', 'session', 'connection'], ['invalidate', 'session', 'restarted']]);
});

class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(value: { id: number; kind: string; body: string }) { this.messages.push(value); }
  terminate() { return Promise.resolve(1); }
  reply(value: unknown) { const request = this.messages[0]!; this.emit('message', { id: request.id, kind: request.kind, ok: true, body: JSON.stringify(value) }); }
}
for (const kind of ['codexExecutionRead', 'openClawExecutionRead'] as const)
  test(`wrong original session reply fences owner without replacement (${kind})`, async () => {
    const fake = new FakeWorker(), root = mkdtempSync(join(tmpdir(), 'execution-owner-wire-'));
    const owner = new AsyncConnectorOwner({ file: join(root, 'db.sqlite') }, silence, () => fake as unknown as Worker);
    try {
      fake.emit('message', { kind: 'ready' }); await owner.open();
      const input = { sessionKey: 'session' }, work = owner.command(kind, input); input.sessionKey = 'wrong';
      await tick(); fake.reply(kind === 'codexExecutionRead' ? codex('wrong') : { ...openclaw(), sessionKey: 'wrong' });
      await assert.rejects(work, /unavailable/); assert.equal(owner.snapshot().unavailable, true);
      assert.equal(owner.snapshot().ownerExitConfirmed, false); assert.equal(fake.messages.length, 1);
    } finally { fake.emit('exit', 1); rmSync(root, { recursive: true, force: true }); }
  });

test('real sole owner reads both journals, applies only protection invalidation and preserves original queue across reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'execution-original-owner-')), file = join(root, 'connector.sqlite');
  const seed = new ConnectorUserStore(file);
  seed.codexExecutions.begin('codex-session', 'codex-command', 'connection');
  seed.codexExecutions.acknowledge('codex-session', 'codex-command', 'connection', 'codex-run', () => {});
  seed.codexExecutions.observe('codex-session', 'connection', 'codex-run', 'completed');
  seed.codexExecutions.settleNativeHistory(seed.codexExecutions.get('codex-session')!, { ...codex().nativeHistory, turnId: 'codex-run' });
  seed.openClawExecutions.begin('openclaw-session', 'openclaw-command');
  seed.openClawExecutions.acknowledge('openclaw-session', 'openclaw-command', 'openclaw-run');
  const originalOpenClaw = seed.openClawExecutions.get('openclaw-session');
  await seed.turns.enqueueAsync('codex', { id: 'queued-original', sessionKey: 'queued-session', createdAt: 1, payload: { message: 'private original message' } });
  seed.close();
  const owner = new AsyncConnectorOwner({ file }, silence), reads = new AsyncConnectorExecutionReads(owner);
  try {
    await owner.open();
    assert.equal((await reads.codex.get('codex-session'))!.sync, 'current');
    const recovered = (await reads.openclaw.get('openclaw-session'))!;
    assert.deepEqual({ ...recovered, phase: originalOpenClaw!.phase, reason: undefined,
      updatedAt: originalOpenClaw!.updatedAt, revision: originalOpenClaw!.revision },
    { ...originalOpenClaw, reason: undefined }, 'startup preserves original command/run identity');
    assert.equal(recovered.phase, 'unknown'); assert.equal(recovered.reason, 'restarted');
    assert.equal(recovered.revision, originalOpenClaw!.revision! + 1);
    assert.equal(await owner.command('openClawExecutionAcknowledge', { sessionKey: 'openclaw-session',
      commandId: 'openclaw-command', transport: 'gateway', connectionId: 'replacement', runId: 'openclaw-run' }), false);
    assert.deepEqual(await reads.openclaw.get('openclaw-session'), recovered, 'late ACK cannot revive restarted execution');
    assert.equal(await reads.codex.get('absent'), undefined);
    assert.deepEqual(await reads.codex.sessionPage('', 16), ['codex-session']);
    assert.deepEqual(await reads.openclaw.sessionPage('', 16), ['openclaw-session']);
    assert.equal(await reads.codex.hasPending('queued-session'), true);
    assert.equal(await reads.openclaw.hasPending('queued-session'), false);
    assert.deepEqual(await reads.invalidateConnectionPage('', 16, 'connection', 'next-connection'), ['codex-session']);
    const after = (await reads.codex.get('codex-session'))!;
    assert.equal(after.phase, 'completed'); assert.equal(after.sync, 'syncing'); assert.equal(after.nativeHistory!.state, 'blocked');
    assert.equal(after.nativeHistory!.reason, 'restarted'); assert.equal(after.commandId, 'codex-command'); assert.equal(after.runId, 'codex-run');
  } finally { await owner.closeForShutdown(); }
  const reopened = new ConnectorUserStore(file);
  try { assert.equal(reopened.turns.maintenanceCount('codex'), 1); assert.equal(reopened.codexExecutions.get('codex-session')!.nativeHistory!.state, 'blocked'); }
  finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
});
