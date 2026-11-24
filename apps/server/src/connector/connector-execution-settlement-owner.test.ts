import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { claimOpenClawOwnerTurn, openClawFixtureKey, seedOpenClawOwnerTurns } from './openclaw-owner-test-fixture.js';
import { AsyncConnectorExecutionSettlements } from './async-execution-settlements.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { ExecutionOwner } from './connector-execution-domain.js';
import { connectorExecutionSettlementSteps, executeConnectorExecutionSettlement, validConnectorExecutionSettlementInput,
  type ConnectorExecutionSettlementCommands, type ConnectorExecutionSettlementKind } from './connector-execution-settlement-domain.js';

const silent = new PerformanceDiagnostics(() => {});
const samples: { [K in ConnectorExecutionSettlementKind]: ConnectorExecutionSettlementCommands[K]['input'] } = {
  codexExecutionAcknowledge: { sessionKey: 'codex', commandId: 'c1', connectionId: 'connection', runId: 'turn' },
  openClawExecutionAcknowledge: { sessionKey: 'gateway', commandId: 'g1', transport: 'gateway', connectionId: 'gateway-connection', runId: 'run' },
  openClawExecutionFinishCli: { sessionKey: 'cli', commandId: 'cli1', phase: 'completed' },
  codexExecutionFinishPreparation: { expected: { sessionKey: 'preparing', commandId: 'p1', connectionId: 'connection', revision: 1 } },
};
for (const kind of Object.keys(samples) as ConnectorExecutionSettlementKind[]) {
  test(`fixed settlement refuses caller transactions or authority before any effect: ${kind}`, () => {
    assert.equal(validConnectorExecutionSettlementInput(kind, samples[kind]), true);
    const owner = new Proxy({}, { get() { throw Error('Owner must not be touched'); } }) as ExecutionOwner;
    for (const key of ['members', 'callback', 'sql', 'authorized', 'unlock', 'dispatch', 'replay']) {
      const input = { ...samples[kind], [key]: [] };
      assert.equal(validConnectorExecutionSettlementInput(kind, input), false);
      assert.throws(() => executeConnectorExecutionSettlement(kind, input as never, owner), /unavailable/);
    }
    for (const value of [null, [], {}, true]) assert.equal(validConnectorExecutionSettlementInput(kind, value), false);
  });
}
test('settlement protocol preserves original encoded/raw ID bounds and fixed transport', () => {
  assert.deepEqual(Object.values(connectorExecutionSettlementSteps), [58, 59, 60, 61]);
  assert.equal(validConnectorExecutionSettlementInput('codexExecutionAcknowledge', { ...samples.codexExecutionAcknowledge, commandId: 'x'.repeat(511) }), false);
  assert.equal(validConnectorExecutionSettlementInput('codexExecutionAcknowledge', { ...samples.codexExecutionAcknowledge, sessionKey: ' leading' }), true);
  assert.equal(validConnectorExecutionSettlementInput('openClawExecutionAcknowledge', { sessionKey: '\0', commandId: '\n', transport: 'cli' }), true);
  assert.equal(validConnectorExecutionSettlementInput('openClawExecutionAcknowledge', { ...samples.openClawExecutionAcknowledge, runId: null }), true);
  assert.equal(validConnectorExecutionSettlementInput('openClawExecutionAcknowledge', { sessionKey: 'cli', commandId: 'cli1', transport: 'cli', runId: null }), false);
  assert.equal(validConnectorExecutionSettlementInput('openClawExecutionAcknowledge', { ...samples.openClawExecutionAcknowledge, runId: 3 }), false);
});

async function queue(store: ConnectorUserStore, runtime: string, sessionKey: string, id: string) {
  await store.turns.enqueueAsync(runtime, { sessionKey, id, state: 'dispatching', createdAt: 1, payload: { message: 'original private queued content' } });
}
async function seed(store: ConnectorUserStore, openclaw = true) {
  for (const id of ['c1', 'c2']) await queue(store, 'codex', 'codex', id);
  await queue(store, 'codex', 'unrelated', 'untouched');
  store.codexExecutions.begin('codex', 'c1', 'connection', false, {
    separator: '\n', members: ['c1', 'c2'].map(id => ({ id, createdAt: -1, imageCount: 0 })),
  });
  // Native completion can arrive before its original invocation ACK.
  store.codexExecutions.observe('codex', 'connection', 'turn', 'completed');
  store.codexExecutions.begin('preparing', 'p1', 'connection', true);
  if (!openclaw) return;
  for (const [sessionKey, commandId] of [['gateway', 'g1'], ['cli', 'cli1'], ['missing-run', 'm1']]) {
    await queue(store, 'openclaw', sessionKey!, commandId!);
    store.openClawExecutions.begin(sessionKey!, commandId!);
    if (sessionKey === 'cli') store.openClawExecutions.useCli(sessionKey, commandId!);
    else store.openClawExecutions.bindGatewayConnection(sessionKey!, commandId!, 'gateway-connection');
  }
  store.openClawExecutions.observe('gateway', { runId: 'run', phase: 'completed', gatewayConnectionId: 'gateway-connection' });
}
test('real async ACKs atomically settle stored batch/CLI/Gateway queues without reopening early terminal runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'settlement-owner-')), file = join(root, 'db.sqlite');
  const original = new ConnectorUserStore(file); await seed(original, false);
  const keys = { gateway: openClawFixtureKey('gateway'), cli: openClawFixtureKey('cli'), missing: openClawFixtureKey('missing-run') };
  const config = await seedOpenClawOwnerTurns(original, root, [
    { key: keys.gateway, id: 'g1' }, { key: keys.cli, id: 'cli1' }, { key: keys.missing, id: 'm1' },
  ]);
  original.close();
  const owner = new AsyncConnectorOwner({ file, ...config }, silent), port = new AsyncConnectorExecutionSettlements(owner);
  try {
    await owner.open();
    await claimOpenClawOwnerTurn(owner, keys.gateway, 'gateway-connection');
    await claimOpenClawOwnerTurn(owner, keys.cli, 'gateway-connection', true);
    await claimOpenClawOwnerTurn(owner, keys.missing, 'gateway-connection');
    assert.equal(await owner.command('openClawExecutionObserve', { sessionKey: keys.gateway,
      event: { runId: 'run', phase: 'completed', gatewayConnectionId: 'gateway-connection' } }), true);
    assert.equal(await port.codex.acknowledge('codex', 'c1', 'wrong-connection', 'turn'), false);
    assert.equal(await port.codex.hasPending('codex'), true);
    const preparation = (await port.codex.get('preparing'))!;
    const expected = { sessionKey: preparation.sessionKey, commandId: preparation.commandId, connectionId: preparation.connectionId, revision: preparation.revision };
    assert.equal(await port.codex.finishPreparation({ ...expected, revision: expected.revision + 1 }), false);
    assert.equal(await port.codex.finishPreparation(expected), true);
    assert.equal(await port.codex.acknowledge('preparing', 'p1', 'connection', 'turn'), false, 'preparation ready is not native dispatch/admission');
    assert.equal(await port.codex.acknowledge('codex', 'wrong-command', 'connection', 'turn'), false);
    assert.equal(await port.codex.acknowledge('codex', 'c1', 'connection', 'turn'), true);
    assert.equal((await port.codex.get('codex'))!.phase, 'completed');
    assert.equal(await port.codex.hasPending('codex'), false);
    assert.equal(await port.codex.hasPending('unrelated'), true);
    assert.equal(await port.codex.acknowledge('codex', 'c1', 'connection', 'turn'), true, 'original duplicate acceptance remains accepted');
    assert.equal((await port.codex.get('codex'))!.phase, 'completed');
    const gatewayAck = { ...samples.openClawExecutionAcknowledge, sessionKey: keys.gateway };
    assert.equal(await port.openclaw.acknowledge({ sessionKey: keys.gateway, commandId: 'g1', transport: 'cli' }), false);
    assert.equal(await port.openclaw.acknowledge({ ...gatewayAck, transport: 'gateway', connectionId: 'stale', runId: 'run' }), false);
    assert.equal(await port.openclaw.hasPending(keys.gateway), true);
    assert.equal(await port.openclaw.acknowledge(gatewayAck), true);
    assert.equal((await port.openclaw.get(keys.gateway))!.phase, 'completed');
    assert.equal(await port.openclaw.hasPending(keys.gateway), false);
    assert.equal(await port.openclaw.acknowledge({ sessionKey: keys.cli, commandId: 'cli1', transport: 'cli' }), true);
    assert.equal(await port.openclaw.finishCli(keys.cli, 'wrong-command', 'completed'), false);
    assert.equal(await port.openclaw.finishCli(keys.cli, 'cli1', 'completed'), true);
    assert.equal(await port.openclaw.acknowledge({ sessionKey: keys.cli, commandId: 'cli1', transport: 'cli' }), true);
    assert.equal((await port.openclaw.get(keys.cli))!.phase, 'completed');
    assert.equal(await port.openclaw.acknowledge({ sessionKey: keys.missing, commandId: 'm1', transport: 'gateway', connectionId: 'gateway-connection', runId: null }), true);
    assert.equal((await port.openclaw.get(keys.missing))!.phase, 'unknown', 'accepted without run proof never becomes guessed running');
    assert.equal(await port.openclaw.hasPending(keys.missing), false, 'definitive acceptance consumes queue even when run identity unavailable');
  } finally { await owner.closeForShutdown(); }
  const reopened = new ConnectorUserStore(file);
  try {
    assert.equal(reopened.codexExecutions.get('codex')!.phase, 'completed');
    assert.deepEqual(reopened.turns.list('codex').map(item => item.id), ['untouched']);
    assert.equal(reopened.turns.maintenanceCount('openclaw'), 0);
    assert.equal(reopened.openClawExecutions.get(keys.cli)!.phase, 'completed');
    assert.equal(reopened.openClawExecutions.get(keys.missing)!.phase, 'unknown');
  } finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const runtime of ['codex', 'openclaw'] as const) {
  test(`original ${runtime} ACK and all queue deletions roll back together on SQL failure`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'settlement-rollback-')), store = new ConnectorUserStore(join(root, 'db.sqlite'));
    try {
      await seed(store);
      const db = (store as unknown as { db: DatabaseSync }).db;
      const sessionKey = runtime === 'codex' ? 'codex' : 'gateway';
      const read = () => runtime === 'codex' ? store.codexExecutions.get(sessionKey) : store.openClawExecutions.get(sessionKey);
      const before = read(), pending = store.turns.list(runtime, sessionKey), cursor = store.events.latestEventId();
      // c2 fails AFTER c1 was deleted; rollback must restore both batch members.
      db.exec(`CREATE TEMP TRIGGER fail_ack BEFORE DELETE ON connector_turns WHEN OLD.id = '${runtime === 'codex' ? 'c2' : 'g1'}' BEGIN SELECT RAISE(ABORT, 'injected settlement failure'); END`);
      const invoke = () => runtime === 'codex'
        ? executeConnectorExecutionSettlement('codexExecutionAcknowledge', samples.codexExecutionAcknowledge, store)
        : executeConnectorExecutionSettlement('openClawExecutionAcknowledge', samples.openClawExecutionAcknowledge, store);
      assert.throws(invoke, /injected settlement failure/);
      assert.deepEqual(read(), before); assert.deepEqual(store.turns.list(runtime, sessionKey), pending);
      assert.equal(store.events.latestEventId(), cursor, 'journal effects are rolled back too');
      assert.equal(db.isTransaction, false);
      db.exec('DROP TRIGGER fail_ack');
      assert.equal(invoke(), true); assert.equal(store.turns.hasPending(runtime, sessionKey), false);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
  test(`restarted ${runtime} cannot consume the original queue using an old ACK`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'settlement-restarted-')), file = join(root, 'db.sqlite');
    const first = new ConnectorUserStore(file); await seed(first); first.close();
    const reopened = new ConnectorUserStore(file);
    try {
      if (runtime === 'codex') {
        reopened.codexExecutions.recoverInterrupted();
        assert.equal(executeConnectorExecutionSettlement('codexExecutionAcknowledge', samples.codexExecutionAcknowledge, reopened), false);
      } else {
        reopened.openClawExecutions.recoverInterrupted();
        assert.equal(executeConnectorExecutionSettlement('openClawExecutionAcknowledge', samples.openClawExecutionAcknowledge, reopened), false);
      }
      assert.equal(reopened.turns.hasPending(runtime, runtime === 'codex' ? 'codex' : 'gateway'), true);
    } finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test('lost mutation ACK never replays or opens a replacement owner before actual exit', async () => {
  class FakeWorker extends EventEmitter {
    messages: unknown[] = [];
    postMessage(value: unknown) { this.messages.push(value); }
    terminate() { return Promise.resolve(1); }
  }
  const root = mkdtempSync(join(tmpdir(), 'settlement-lost-')), fake = new FakeWorker();
  const owner = new AsyncConnectorOwner({ file: join(root, 'db.sqlite') }, silent, () => fake as unknown as Worker);
  try {
    fake.emit('message', { kind: 'ready' }); await owner.open();
    const port = new AsyncConnectorExecutionSettlements(owner);
    const ack = port.codex.acknowledge('codex', 'c1', 'connection', 'turn'); void ack.catch(() => {});
    await new Promise<void>(resolve => setImmediate(resolve));
    fake.emit('error', Error('transport failed after commit'));
    await assert.rejects(ack, /unavailable/);
    assert.equal(owner.snapshot().ownerExitConfirmed, false);
    await assert.rejects(port.codex.acknowledge('codex', 'c1', 'connection', 'turn'), /unavailable/);
    assert.equal(fake.messages.length, 1);
  } finally { fake.emit('exit', 1); rmSync(root, { recursive: true, force: true }); }
});
