import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { claimOpenClawOwnerTurn, openClawFixtureKey, seedOpenClawOwnerTurns } from './openclaw-owner-test-fixture.js';
import { AsyncConnectorExecutionObservations } from './async-execution-observations.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { connectorExecutionObservationSteps, executeConnectorExecutionObservation, validConnectorExecutionObservationInput,
  type ConnectorExecutionObservationCommands, type ConnectorExecutionObservationKind } from './connector-execution-observation-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { ExecutionOwner } from './connector-execution-domain.js';
import type { CodexExecution } from '../codex/executions.js';

const silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const checkpoint = { turnId: 'turn', connectionId: 'connection', fingerprint: 'a'.repeat(64), state: 'verified' as const, reason: 'settled' as const };
const codex = (): CodexExecution => ({ sessionKey: 'codex', commandId: 'command', connectionId: 'connection', runId: 'turn', phase: 'completed', sync: 'syncing', revision: 1, startedAt: 1, updatedAt: 1 });
const openclaw = () => ({ sessionKey: 'openclaw', commandId: 'command', origin: 'gateway' as const, runId: 'run', gatewayConnectionId: 'gateway', phase: 'running' as const, revision: 1, startedAt: 1, updatedAt: 1 });
const samples: { [K in ConnectorExecutionObservationKind]: ConnectorExecutionObservationCommands[K]['input'] } = {
  codexExecutionObserve: { sessionKey: 'codex', connectionId: 'connection', runId: 'turn', phase: 'completed', expected: null },
  codexExecutionUncertain: { sessionKey: 'codex', commandId: 'command' },
  codexExecutionTool: { sessionKey: 'codex', connectionId: 'connection', runId: 'turn', itemId: 'tool', completed: false },
  codexHistorySettle: { expected: { sessionKey: 'codex', commandId: 'command', runId: 'turn' }, sync: 'current' },
  codexHistoryCompareSettle: { expected: codex(), sync: 'error' },
  codexCleanupRecovered: { sessionKey: 'codex', runId: 'turn' },
  codexNativeHistorySettle: { expected: codex(), checkpoint },
  codexNativeHistoryInvalidate: { sessionKey: 'codex', reason: 'changed', readableSuccessorTurnId: null },
  codexExecutionDisconnect: { sessionKey: 'codex', connectionId: 'connection' },
  codexExecutionRecoverTerminal: { expected: codex(), runId: 'turn', phase: 'completed' },
  openClawHistorySettle: { sessionKey: 'openclaw', revision: 1, state: 'current' },
  openClawConnectionBind: { sessionKey: 'openclaw', commandId: 'command', connectionId: 'gateway' },
  openClawExecutionCompleteQuery: { expected: openclaw() },
  openClawExecutionUncertain: { sessionKey: 'openclaw', commandId: 'command' },
  openClawExecutionUnowned: { sessionKey: 'openclaw' },
  openClawExecutionObserve: { sessionKey: 'openclaw', event: { runId: 'run', phase: 'completed', gatewayConnectionId: 'gateway' } },
};

for (const kind of Object.keys(samples) as ConnectorExecutionObservationKind[]) {
  test(`fixed observation transaction validates before any owner effect: ${kind}`, () => {
    assert.equal(validConnectorExecutionObservationInput(kind, samples[kind]), true);
    const owner = new Proxy({}, { get() { throw Error('Owner must not be touched'); } }) as ExecutionOwner;
    for (const extra of ['sql', 'callback', 'authorized', 'unlock', 'repair', 'file', 'dispatch']) {
      const input = { ...samples[kind], [extra]: true };
      assert.equal(validConnectorExecutionObservationInput(kind, input), false);
      assert.throws(() => executeConnectorExecutionObservation(kind, input as never, owner), /connector_storage_unavailable/);
    }
    for (const input of [null, [], {}, true]) assert.equal(validConnectorExecutionObservationInput(kind, input), false);
  });
}

test('journal observations preserve original ID bounds, versions and native/Goal protection DTOs', () => {
  assert.equal(validConnectorExecutionObservationInput('codexExecutionUncertain', { sessionKey: ' leading', commandId: 'command' }), true);
  assert.equal(validConnectorExecutionObservationInput('openClawExecutionUncertain', { sessionKey: '\0', commandId: '\n' }), true);
  assert.equal(validConnectorExecutionObservationInput('codexExecutionUncertain', { sessionKey: 'session', commandId: 'x'.repeat(511) }), false, 'Codex counts encoded JSON bytes');
  assert.equal(validConnectorExecutionObservationInput('openClawExecutionUncertain', { sessionKey: 'session', commandId: 'x'.repeat(512) }), true);
  assert.equal(validConnectorExecutionObservationInput('codexExecutionObserve', { ...samples.codexExecutionObserve, expected: { commandId: 'command', revision: 0 } }), false);
  assert.equal(validConnectorExecutionObservationInput('codexExecutionTool', { ...samples.codexExecutionTool, itemId: ' tool' }), false);
  for (const reason of ['goal-active', 'goal-paused', 'goal-blocked', 'restarted'] as const)
    assert.equal(validConnectorExecutionObservationInput('codexNativeHistoryInvalidate', { ...samples.codexNativeHistoryInvalidate, reason }), true);
  assert.equal(validConnectorExecutionObservationInput('openClawExecutionObserve', { ...samples.openClawExecutionObserve, event: { ...samples.openClawExecutionObserve.event, reply: { text: 'private', sequence: 1 } } }), false);
  assert.equal(validConnectorExecutionObservationInput('openClawExecutionObserve', { ...samples.openClawExecutionObserve, event: { runId: 'run', phase: 'idle' } }), false);
  assert.equal(validConnectorExecutionObservationInput('codexNativeHistorySettle', { ...samples.codexNativeHistorySettle, checkpoint: { ...checkpoint, unlock: true } }), false);
});

class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(value: { id: number; kind: string; body: string }) { this.messages.push(value); }
  terminate() { return Promise.resolve(1); }
}
test('lost mutation acknowledgement stays unknown: no replay, early reservation release or content logs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'observation-owner-wire-')), fake = new FakeWorker();
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const owner = new AsyncConnectorOwner({ file: join(root, 'db.sqlite') }, diagnostics, () => fake as unknown as Worker, 1);
  try {
    fake.emit('message', { kind: 'ready' }); await owner.open();
    const input = { sessionKey: 'private-session', commandId: 'private-command' };
    const work = owner.command('codexExecutionUncertain', input); void work.catch(() => {});
    input.commandId = 'retargeted'; await tick();
    assert.equal(JSON.parse(fake.messages[0]!.body).commandId, 'private-command');
    fake.emit('error', Error('owner lost'));
    await assert.rejects(work, /unavailable/);
    await assert.rejects(owner.command('codexExecutionUncertain', input), /unavailable/);
    assert.equal(fake.messages.length, 1);
    assert.equal(owner.snapshot().ownerExitConfirmed, false);
    assert.ok(logs.some(line => line.includes('connector-sqlite-command')));
    assert.ok(logs.every(line => !/private-session|private-command|retargeted/.test(line)));
  } finally { fake.emit('exit', 1); rmSync(root, { recursive: true, force: true }); }
});

test('non-boolean mutation result fences the sole owner rather than manufacturing success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'observation-owner-result-')), fake = new FakeWorker();
  const owner = new AsyncConnectorOwner({ file: join(root, 'db.sqlite') }, silence, () => fake as unknown as Worker);
  try {
    fake.emit('message', { kind: 'ready' }); await owner.open();
    const work = owner.command('openClawExecutionUnowned', { sessionKey: 'openclaw' }); void work.catch(() => {}); await tick();
    const request = fake.messages[0]!;
    fake.emit('message', { id: request.id, kind: request.kind, ok: true, body: JSON.stringify({ changed: true }) });
    await assert.rejects(work, /unavailable/); assert.equal(owner.snapshot().unavailable, true);
    assert.equal(owner.snapshot().ownerExitConfirmed, false);
  } finally { fake.emit('exit', 1); rmSync(root, { recursive: true, force: true }); }
});

const liveOpenClaw = { main: openClawFixtureKey('openclaw'), uncertain: openClawFixtureKey('open-uncertain'), unowned: openClawFixtureKey('open-unowned') };
async function seed(file: string, root: string) {
  const store = new ConnectorUserStore(file);
  for (const key of ['codex', 'recovery']) {
    store.codexExecutions.begin(key, 'command', 'connection');
    store.codexExecutions.acknowledge(key, 'command', 'connection', 'turn', () => {});
  }
  store.codexExecutions.begin('uncertain', 'unsent-command', 'connection');
  const config = await seedOpenClawOwnerTurns(store, root, [
    { key: liveOpenClaw.main, id: 'command' }, { key: liveOpenClaw.uncertain, id: 'unsent-command' },
    { key: liveOpenClaw.unowned, id: 'command-unowned' },
  ]);
  await store.turns.enqueueAsync('codex', { id: 'queued-original', sessionKey: 'queued-session', createdAt: 1, payload: { message: 'private original' } });
  store.close();
  return config;
}
test('real sole worker journals retain CAS, terminal protection, uncertain sends and queue across reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'execution-observation-owner-')), file = join(root, 'connector.sqlite');
  const config = await seed(file, root);
  const owner = new AsyncConnectorOwner({ file, ...config }, silence), journals = new AsyncConnectorExecutionObservations(owner);
  const c = journals.codex, o = journals.openclaw;
  try {
    await owner.open();
    await claimOpenClawOwnerTurn(owner, liveOpenClaw.main, 'gateway');
    assert.equal(await owner.command('openClawExecutionAcknowledge', { sessionKey: liveOpenClaw.main,
      commandId: 'command', transport: 'gateway', connectionId: 'gateway', runId: 'run' }), true);
    assert.equal(await o.observe(liveOpenClaw.main, { runId: 'run', phase: 'running', gatewayConnectionId: 'gateway' }), true);
    await claimOpenClawOwnerTurn(owner, liveOpenClaw.uncertain, 'gateway');
    await claimOpenClawOwnerTurn(owner, liveOpenClaw.unowned, 'gateway');
    const observed = (await c.get('codex'))!;
    assert.equal(await c.observe('codex', 'connection', 'turn', 'running', { commandId: observed.commandId, revision: observed.revision + 1 }), false);
    assert.equal(await c.observeCommandTool('codex', 'connection', 'turn', 'tool'), true);
    assert.equal(await c.observeCommandTool('codex', 'connection', 'turn', 'tool', true), true);
    assert.equal(await c.observe('codex', 'connection', 'turn', 'completed'), true);
    const terminal = (await c.get('codex'))!;
    assert.equal(await c.cleanupRecovered('codex', 'turn'), false);
    assert.equal(await c.compareSettleHistory({ ...terminal, revision: terminal.revision + 1 }, 'current'), false);
    assert.equal(await c.compareSettleHistory({ ...terminal, connectionId: 'replacement' }, 'current'), false);
    assert.equal(await c.compareSettleHistory(terminal, 'current'), true);
    assert.equal(await c.compareSettleHistory(terminal, 'error'), false, 'stale error must not overwrite accepted history');
    assert.equal(await c.settleHistory({ sessionKey: 'codex', commandId: 'wrong', runId: 'turn' }, 'current'), false);
    assert.equal(await c.settleHistory({ sessionKey: 'codex', commandId: 'command', runId: 'turn' }, 'error'), true);
    assert.equal(await c.settleNativeHistory(terminal, checkpoint), false, 'history write advanced revision');
    assert.equal(await c.settleNativeHistory((await c.get('codex'))!, checkpoint), true);
    assert.equal(await c.invalidateNativeHistory('codex', 'goal-active', 'successor'), true);
    const blocked = (await c.get('codex'))!;
    assert.equal(await c.invalidateNativeHistory('codex', 'goal-active', 'successor'), false, 'continuous successor observation does not churn revisions');
    assert.equal((await c.get('codex'))!.revision, blocked.revision);
    assert.equal(await c.settleNativeHistory(terminal, checkpoint), false, 'old snapshot cannot clear Goal protection');
    assert.equal(await c.disconnectAcknowledged('recovery', 'connection'), true);
    const recovery = (await c.get('recovery'))!;
    assert.equal(recovery.phase, 'unknown');
    assert.equal(await c.recoverTerminal({ ...recovery, revision: recovery.revision + 1 }, 'turn', 'completed'), false);
    assert.equal(await c.recoverTerminal(recovery, 'turn', 'completed'), true);
    assert.equal(await c.uncertain('uncertain', 'unsent-command'), true);
    assert.equal((await c.get('uncertain'))!.phase, 'unknown');
    assert.equal(await o.bindGatewayConnection(liveOpenClaw.main, 'wrong-command', 'gateway'), false);
    assert.equal(await o.bindGatewayConnection(liveOpenClaw.main, 'command', 'gateway'), true);
    const expected = (await o.get(liveOpenClaw.main))!;
    assert.equal(await o.completeFromQuery({ ...expected, revision: expected.revision! + 1 }), false);
    assert.equal(await o.observe(liveOpenClaw.main, { runId: 'run', phase: 'waiting', gatewayConnectionId: 'gateway' }), true);
    assert.equal(await o.completeFromQuery(expected), false, 'later observation invalidates query CAS');
    assert.equal(await o.completeFromQuery((await o.get(liveOpenClaw.main))!), true);
    const history = (await o.get(liveOpenClaw.main))!.historySync!;
    assert.equal(await o.setHistorySync(liveOpenClaw.main, history.revision + 1, 'current'), false);
    assert.equal(await o.setHistorySync(liveOpenClaw.main, history.revision, 'current'), true);
    assert.equal(await o.uncertain(liveOpenClaw.uncertain, 'unsent-command'), true);
    assert.equal(await o.unownedActivity(liveOpenClaw.unowned), true);
  } finally { await owner.closeForShutdown(); }
  const reopened = new ConnectorUserStore(file);
  try {
    assert.equal(reopened.codexExecutions.get('codex')!.nativeHistory!.reason, 'goal-active');
    assert.equal(reopened.codexExecutions.get('uncertain')!.phase, 'unknown');
    assert.equal(reopened.openClawExecutions.get(liveOpenClaw.uncertain)!.phase, 'unknown');
    assert.equal(reopened.openClawExecutions.get(liveOpenClaw.unowned)!.reason, 'unowned_run');
    assert.equal(reopened.turns.maintenanceCount('codex'), 1);
  } finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
});

test('observation step numbers append to the existing diagnostic protocol', () => {
  assert.deepEqual(Object.values(connectorExecutionObservationSteps).sort((a, b) => a - b),
    [...Array.from({ length: 14 }, (_, i) => i + 44), 246, 247]);
});
