import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import type { HermesExecution } from '../hermes/journal.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import type { ConnectorHermesLocalControlCommands } from './connector-hermes-local-control-domain.js';

const token = 'isolated-local-control-token', authorization = `Bearer ${token}`, key = 'hermes:original';
const scope = { key, authorization, commandKey: 'original-status' };
const input = { ...scope, payloadJson: JSON.stringify({ message: ' /status ', metadata: 'original fingerprint' }),
  display: { connected: true, gateway: '', session: { model: 'original-model', totalTokens: 123 } } };
const execution: HermesExecution = { key, id: 'original-run', live: 'live', epoch: 'epoch', phase: 'running', members: ['member'], at: 1, updated: 1, row: 1 };
function seed(store: ConnectorUserStore) {
  store.hermesJournal.save({ key, stored: 'native', title: 'Original', started: true, messages: [] });
  store.hermesJournal.update(execution);
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-local-control-'));
  const tokens = new ConnectorTokenStore(join(dir, 'tokens.json'), token), actor = tokens.authenticateAuthorization(authorization)!;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true }); seed(store);
  const command = createConnectorOwnerCommands(store, tokens), db = (store as unknown as { db: DatabaseSync }).db;
  return { store, tokens, actor, command, db, close() { command.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('local control protocol rejects forged authority, runtime, unbounded/truthy display and substituted report', async () => {
  const f = fixture();
  try {
    assert.equal(validConnectorOwnerInput('hermesLocalControl', input), true);
    for (const change of [{ actorId: 'forged' }, { rejectFresh: 'runtime_unavailable' }, { key: 'codex:foreign' },
      { display: { ...input.display, connected: 'true' } }, { display: { ...input.display, session: { status: 'idle' } } },
      { display: { ...input.display, session: { totalTokens: -1 } } }, { display: { ...input.display, session: { model: 'x'.repeat(257) } } }])
      assert.equal(validConnectorOwnerInput('hermesLocalControl', { ...input, ...change }), false);
    assert.equal(validConnectorOwnerInput('hermesLocalControlRead', input), false);
    const result = await f.command('hermesLocalControl', input); assert.ok('report' in result && result.report);
    assert.equal(validConnectorOwnerOutput('hermesLocalControl', result), true);
    assert.equal(validConnectorOwnerOutput('hermesLocalControl', { ...result, report: [{ ...result.report[0], id: 'foreign' }, result.report[1]] }), false);
    assert.equal(validConnectorOwnerOutput('hermesLocalControlRead', { ...result, queue: { presence: 'unknown' } }), false);
  } finally { f.close(); }
});

test('report atomically preserves original IDs/display; duplicate, maintenance and read cannot change execution or queue', async () => {
  const f = fixture();
  try {
    const before = f.store.hermesJournal.lifecycleSnapshot(key);
    const result = await f.command('hermesLocalControl', input); assert.ok('report' in result && result.report && result.receipt);
    assert.equal(result.receipt.state, 'accepted'); assert.equal(result.report[0].id, result.receipt.id);
    assert.equal(result.report[1].id, `local-status:${result.receipt.id}`);
    assert.match(result.report[1].text, /original-model/); assert.match(result.report[1].text, /Active run: yes/);
    f.store.pauseTurnStarts();
    assert.deepEqual(await f.command('hermesLocalControl', { ...input, display: { connected: false, gateway: '', session: { model: 'changed' } } }), result);
    assert.deepEqual(await f.command('hermesLocalControlRead', scope), result);
    assert.deepEqual(f.store.hermesJournal.lifecycleSnapshot(key), before);
    assert.equal(f.store.turns.list('hermes', key).length, 0);
    assert.deepEqual(await f.command('hermesLocalControl', { ...input, payloadJson: JSON.stringify({ message: '/status', metadata: 'changed' }) }), { error: 409 });
    const other = f.tokens.create({ label: 'other', scopes: ['messages:send', 'messages:read'] });
    const isolated = await f.command('hermesLocalControlRead', { ...scope, authorization: `Bearer ${other.token}` });
    assert.ok('report' in isolated && isolated.receipt === null && isolated.report === null);
    f.tokens.revoke(f.actor.tokenId);
    assert.deepEqual(await f.command('hermesLocalControlRead', scope), { error: 401 });
  } finally { f.close(); }
});

test('status requires send/read, denies delegation, while unsupported compact preserves original send-only authority', async () => {
  const f = fixture();
  try {
    for (const scopes of [['messages:send'], ['messages:read'], ['messages:send', 'messages:read', 'execution:delegate']] as const) {
      const token = f.tokens.create({ label: 'limited', scopes: [...scopes] });
      assert.deepEqual(await f.command('hermesLocalControl', { ...input, authorization: `Bearer ${token.token}` }), { error: 403 });
    }
    const send = f.tokens.create({ label: 'send', scopes: ['messages:send'] });
    const compact = { ...input, authorization: `Bearer ${send.token}`, payloadJson: '{"message":"/compact"}' };
    const result = await f.command('hermesLocalControl', compact); assert.ok('receipt' in result);
    assert.equal(result.receipt?.result?.status, 409); assert.equal(result.report, null);
    assert.equal(f.store.turns.list('hermes', key).length, 0);
  } finally { f.close(); }
});

test('failed final settlement rolls back receipt and immutable report together', async () => {
  const f = fixture();
  try {
    f.db.exec(`CREATE TRIGGER fail_local BEFORE UPDATE OF state ON command_receipts BEGIN SELECT RAISE(ABORT, 'isolated local failure'); END`);
    await assert.rejects(f.command('hermesLocalControl', input), /isolated local failure/);
    const result = await f.command('hermesLocalControlRead', scope);
    assert.ok('report' in result && result.report === null && result.receipt === null);
    assert.equal(f.db.isTransaction, false); assert.equal(f.store.hermesJournal.current(key)?.phase, 'running');
  } finally { f.close(); }
});

test('unknown execution and pending interrupt remain protected; local report is not native completion evidence', async () => {
  const f = fixture();
  try {
    assert.equal(f.store.hermesJournal.claimInterrupt(execution, 'original-stop'), true);
    f.store.hermesJournal.update({ ...execution, phase: 'unknown', updated: 2 });
    const before = f.store.hermesJournal.lifecycleSnapshot(key);
    const result = await f.command('hermesLocalControl', { ...input, display: { ...input.display, connected: false } });
    assert.ok('report' in result && result.report);
    assert.match(result.report[1].text, /Execution: unknown/); assert.match(result.report[1].text, /Runtime connection: disconnected/);
    assert.match(result.report[1].text, /unresolved interrupt; successor dispatch remains blocked/);
    assert.equal(f.store.hermesJournal.canStart(key), false); assert.equal(f.store.hermesJournal.interruptPending(key), true);
    assert.deepEqual(f.store.hermesJournal.lifecycleSnapshot(key), before);
  } finally { f.close(); }
});

test('status never promotes a preexisting unknown receipt or recomputes its report', async () => {
  const f = fixture();
  try {
    const original = f.store.commands.claim(JSON.stringify([f.actor.tokenId, key]), scope.commandKey, JSON.parse(input.payloadJson));
    const result = await f.command('hermesLocalControl', input);
    assert.ok('report' in result && result.report === null); assert.deepEqual(result.receipt, original.receipt);
  } finally { f.close(); }
});

for (const payload of [{ message: '/compact' }, { message: 'ordinary' }, { message: '/status', deliveryMode: 'mirror' },
  { message: '/status', media: [{ url: 'file:///isolated' }] }])
  test(`nonlocal/unsupported payload is rejected without native queue: ${JSON.stringify(payload)}`, async () => {
    const f = fixture();
    try {
      const result = await f.command('hermesLocalControl', { ...input, payloadJson: JSON.stringify(payload) });
      assert.ok('report' in result && result.report === null && result.receipt?.state === 'rejected');
      assert.equal(f.store.turns.list('hermes', key).length, 0); assert.deepEqual(f.store.hermesJournal.current(key), execution);
    } finally { f.close(); }
  });

test('exclusive worker reopen preserves original report and original execution, with no main-thread store retained', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-local-worker-')), file = join(dir, 'connector.sqlite'), tokenFile = join(dir, 'tokens.json');
  let worker: AsyncConnectorOwner | undefined;
  try {
    new ConnectorTokenStore(tokenFile, token);
    const db = new ConnectorUserStore(file, undefined, { runtimeOwner: true }); seed(db); db.close();
    const silence = new PerformanceDiagnostics(() => {});
    worker = new AsyncConnectorOwner({ file, tokenFile }, silence); await worker.open();
    const original = await worker.command('hermesLocalControl', input); assert.ok('report' in original && original.report);
    const before = await worker.command('hermesLifecycleRead', { key });
    await worker.close(); worker = new AsyncConnectorOwner({ file, tokenFile }, silence); await worker.open();
    const recovered: ConnectorHermesLocalControlCommands['hermesLocalControlRead']['output'] = await worker.command('hermesLocalControlRead', scope);
    assert.deepEqual(recovered, original);
    assert.deepEqual(await worker.command('hermesLocalControl', { ...input, display: { connected: false, gateway: '', session: {} } }), original);
    assert.deepEqual(await worker.command('hermesLifecycleRead', { key }), before);
  } finally { await worker?.close(); rmSync(dir, { recursive: true, force: true }); }
});
