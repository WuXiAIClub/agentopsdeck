import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorMaintenanceCommands, validConnectorMaintenanceInput,
  validConnectorMaintenanceOutput, type ConnectorMaintenanceCommands } from './connector-maintenance-domain.js';
import { RuntimeMaintenancePersistence } from './runtime-maintenance-persistence.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { captureMaintenanceFacts } from './maintenance-facts.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const quiet = new PerformanceDiagnostics(() => {});
const check = () => {};
const unavailable = /Maintenance persistence unavailable/;

test('maintenance command domain rejects extra authority, foreign runtime and malformed evidence', () => {
  assert.equal(validConnectorMaintenanceInput('runtimeMaintenanceObserve', { historyRecovery: true, authorized: true }), false);
  assert.equal(validConnectorMaintenanceInput('runtimeMaintenanceHistory', { sql: 'SELECT 1' }), false);
  assert.equal(validConnectorMaintenanceInput('runtimeMaintenanceSdkSession', { runtime: 'ghcp', key: 'claude-code:foreign' }), false);
  assert.equal(validConnectorMaintenanceInput('runtimeMaintenancePreservation', { key: 'ghcp:session', codex: true }), false);
  assert.equal(validConnectorMaintenanceOutput('runtimeMaintenanceHistory', ['codex:a', 'codex:a']), false);
  assert.equal(validConnectorMaintenanceOutput('runtimeMaintenanceObserve', { nodeId: 'node', pendingExecutions: -1, queuedMessages: 0 }), false);
  assert.equal(validConnectorMaintenanceOutput('runtimeMaintenancePreservation', { sessionKey: 'codex:a', queueSha256: 'bad', execution: null }), false);
});

test('original and true worker maintenance commands preserve the existing database, queue and history across reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-maintenance-port-'));
  const file = join(directory, 'connector.sqlite');
  const key = 'codex:maintenance-existing';
  let owner: AsyncConnectorOwner | undefined;
  try {
    const original = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    let expected!: { observe: ConnectorMaintenanceCommands['runtimeMaintenanceObserve']['output']; queue: string };
    try {
      original.codexExecutions.begin(key, 'original-command', 'original-connection');
      original.codexExecutions.acknowledge(key, 'original-command', 'original-connection', 'original-run', () => {});
      original.codexExecutions.observe(key, 'original-connection', 'original-run', 'failed');
      original.codexExecutions.settleHistory({ sessionKey: key, commandId: 'original-command', runId: 'original-run' }, 'error');
      await original.turns.enqueueAsync('codex', { id: 'original-queued', sessionKey: key, createdAt: 1,
        payload: { text: 'PRIVATE_ORIGINAL_INPUT', images: [] } });
      const execute = createConnectorMaintenanceCommands(original);
      original.pauseTurnStarts();
      expected = { observe: execute('runtimeMaintenanceObserve', { historyRecovery: true }), queue: original.maintenanceQueueSha256() };
    } finally { original.close(); }
    owner = new AsyncConnectorOwner({ file }, quiet); await owner.open();
    const persistence = new RuntimeMaintenancePersistence(owner, quiet);
    const generation = await owner.command('maintenancePause', {});
    const head = await owner.command('eventProjectionHead', {});
    const observed = await persistence.command('runtimeMaintenanceObserve', { historyRecovery: true }, check);
    assert.equal(observed.nodeId, expected.observe.nodeId);
    assert.equal(observed.queuedMessages, expected.observe.queuedMessages);
    assert.deepEqual(await persistence.command('runtimeMaintenanceHistory', {}, check), [key]);
    assert.equal(await persistence.command('runtimeMaintenanceSdkSession', { runtime: 'ghcp', key: 'ghcp:missing' }, check), false);
    const preserved = await persistence.command('runtimeMaintenancePreservation', { key, codex: true }, check);
    assert.equal(preserved.queueSha256, expected.queue);
    assert.equal(preserved.execution?.commandId, 'original-command');
    assert.equal(preserved.execution?.runId, 'original-run');
    assert.equal(preserved.execution?.sync, 'error');
    assert.equal(JSON.stringify(preserved).includes('PRIVATE'), false);
    assert.deepEqual(await owner.command('eventProjectionHead', {}), head, 'observations must not advance event projection');
    assert.deepEqual(await persistence.command('runtimeMaintenanceInteractions', {}, check), []);
    assert.equal(await owner.command('maintenanceResume', { generation }), true);
    await assert.rejects(persistence.command('runtimeMaintenancePreservation', { key, codex: true }, check), unavailable);
    await persistence.close();
    // Consumer close must not close the shared owner.
    assert.equal(await owner.command('nodeIdentity', {}), observed.nodeId);
    await owner.close(); owner = undefined;
    const reopened = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    try {
      reopened.pauseTurnStarts();
      assert.equal(reopened.maintenanceQueueSha256(), expected.queue);
      assert.equal(reopened.turns.head('codex', key)?.id, 'original-queued');
      assert.equal(reopened.turns.head('codex', key)?.state, 'queued');
      assert.equal(reopened.codexExecutions.get(key)?.commandId, 'original-command');
      assert.equal(reopened.codexExecutions.get(key)?.sync, 'error');
    } finally { reopened.close(); }
  } finally { await owner?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('waiting maintenance reply rechecks authority and drain retains the physical command', async () => {
  const physical = gate<ConnectorMaintenanceCommands['runtimeMaintenanceObserve']['output']>();
  let calls = 0, authorized = true, supplied: unknown;
  const persistence = new RuntimeMaintenancePersistence({ async command(_kind, input) {
    calls++; supplied = input; return await physical.promise as never;
  } }, quiet);
  const input = { historyRecovery: false };
  const waiting = persistence.command('runtimeMaintenanceObserve', input, () => { if (!authorized) throw Error('PRIVATE_KEY_REVOKED'); });
  const rejected = assert.rejects(waiting, unavailable);
  input.historyRecovery = true;
  assert.deepEqual(supplied, { historyRecovery: false });
  let drained = false;
  const closing = persistence.close().then(() => { drained = true; });
  authorized = false;
  await assert.rejects(persistence.command('runtimeMaintenanceHistory', {}, check), /closing/);
  await tick(); assert.equal(drained, false); assert.equal(calls, 1);
  physical.resolve({ nodeId: 'original-node', pendingExecutions: 0, queuedMessages: 0 });
  await rejected; await closing; assert.equal(drained, true);
});

test('no physical command is issued after authority check fails; foreign receipt and private failures are rejected', async () => {
  const logs: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  let calls = 0;
  const persistence = new RuntimeMaintenancePersistence({ command() {
    calls++; return { sessionKey: 'codex:foreign', queueSha256: 'a'.repeat(64), execution: null } as never;
  } }, diagnostics);
  await assert.rejects(persistence.command('runtimeMaintenancePreservation', { key: 'codex:original', codex: true }, () => { throw Error('PRIVATE_AUTH'); }), unavailable);
  assert.equal(calls, 0);
  await assert.rejects(persistence.command('runtimeMaintenancePreservation', { key: 'codex:original', codex: true }, check), unavailable);
  await persistence.close();
  const failed = new RuntimeMaintenancePersistence({ command() { throw Error('PRIVATE_NATIVE_INPUT'); } }, diagnostics);
  await assert.rejects(failed.command('runtimeMaintenanceHistory', {}, check), unavailable);
  await failed.close();
  assert.doesNotMatch(logs.join(''), /PRIVATE|codex:original|codex:foreign/);
});

test('native maintenance guard rejects changes after asynchronous work and exposes no state in errors', async () => {
  const state = { nativeWorkers: 0, ownershipHeld: true, admissionInFlight: 0, closed: false };
  for (const property of ['nativeWorkers', 'ownershipHeld', 'admissionInFlight', 'closed'] as const) {
    const snapshot = captureMaintenanceFacts(() => ({ ...state }));
    snapshot.assertCurrent();
    await tick();
    if (typeof state[property] === 'boolean') Object.assign(state, { [property]: !state[property] });
    else Object.assign(state, { [property]: Number(state[property]) + 1 });
    assert.throws(snapshot.assertCurrent, /native observation changed/);
  }
});
