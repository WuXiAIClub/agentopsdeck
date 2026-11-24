import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { AsyncSdkLocal } from './async-sdk-local.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, connectorOwnerCommandBytes, encodeConnectorOwnerJson } from './connector-owner-domain.js';
import { validConnectorSdkLocalRecoveryOutput } from './connector-sdk-local-recovery-domain.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import { NativeOperationError } from './native-operation.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const authorization = 'Bearer isolated-local-recovery-test';
const silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(runtime: SdkAgentId) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-local-recovery-'));
  const tokens = new ConnectorTokenStore(join(dir, 'tokens.json'), 'isolated-local-recovery-test');
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const owner = createConnectorOwnerCommands(store, tokens, { [runtime]: { model: 'default' } });
  const local = new AsyncSdkLocal({ command: owner });
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
  const key = `${runtime}:original`;
  journal.create({ key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
  const request = { runtime, authorization, commandKey: 'original-command' };
  const scope = (operation: 'create' | 'settings') => JSON.stringify([operation, JSON.stringify([actor, operation === 'create' ? runtime : key])]);
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { dir, tokens, store, actor, owner, local, journal, key, request, scope, db,
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const wait = { timeoutMs: 10_000 };
const uncertain = (e: unknown) => e instanceof NativeOperationError && e.outcome === 'unknown';
function recoveryRequest(request: { runtime: SdkAgentId; authorization: string; commandKey: string }, operation: 'create' | 'settings', key: string) {
  return operation === 'settings' ? { ...request, operation, key } : { ...request, operation };
}

for (const runtime of ['claude-code', 'ghcp'] as const) for (const operation of ['create', 'settings'] as const) {
  test(`${runtime} ${operation}: absent and unknown reads preserve original receipt/fences without writes`, async () => {
    const f = fixture(runtime);
    try {
      const input = recoveryRequest(f.request, operation, f.key);
      const absent = await f.local.readReceipt(input, wait);
      assert.ok('receipt' in absent && absent.receipt === null && !absent.settingsStartReleased);
      const p = operation === 'create' ? { title: 'Created' } : { model: null };
      await f.store.commands.claimAsync(f.scope(operation), input.commandKey, p, false, undefined, undefined, undefined, operation === 'settings');
      const before = JSON.stringify(f.db.prepare('SELECT * FROM command_receipts').all());
      const unknown = await f.local.readReceipt(input, wait);
      assert.ok('receipt' in unknown && unknown.receipt?.state === 'outcome_unknown' && !unknown.settingsStartReleased);
      assert.deepEqual(await f.local.readReceipt(input, wait), unknown);
      assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM command_receipts').all()), before);
      assert.equal(f.store.commands.sessionSettingsPending(f.key), operation === 'settings');
      assert.equal(f.journal.sessionKeys(undefined, 64).length, 1);
      assert.equal(f.db.isTransaction, false);
    } finally { f.close(); }
  });
  for (const rejected of [false, true]) test(`${runtime} ${operation}: original ${rejected ? 'rejected' : 'accepted'} recovered while paused and catalog disabled`, async () => {
    const f = fixture(runtime);
    try {
      const result = operation === 'create' ? await f.local.create({ ...f.request, payloadJson: JSON.stringify({ title: rejected ? 'x'.repeat(121) : 'Created' }) }, wait)
        : await f.local.updateModel({ ...f.request, key: f.key, payloadJson: JSON.stringify({ model: rejected ? 'forbidden' : null }) }, wait);
      assert.ok('receipt' in result && result.receipt.state === (rejected ? 'rejected' : 'accepted'));
      f.store.pauseTurnStarts();
      const noCatalog = new AsyncSdkLocal({ command: createConnectorOwnerCommands(f.store, f.tokens) });
      const input = recoveryRequest(f.request, operation, f.key);
      const recovered = await noCatalog.readReceipt(input, wait);
      assert.ok('receipt' in recovered); assert.deepEqual(recovered.receipt, result.receipt);
      assert.equal(recovered.key, result.key); assert.equal(recovered.settingsStartReleased, false);
      const other = f.tokens.create({ label: 'other', scopes: ['sessions:create'] });
      const isolated = await noCatalog.readReceipt({ ...input, authorization: `Bearer ${other.token}` }, wait);
      assert.ok('receipt' in isolated && isolated.receipt === null);
      const missing = await noCatalog.readReceipt({ ...input, commandKey: 'other' }, wait);
      assert.ok('receipt' in missing && missing.receipt === null);
      const otherRuntime = runtime === 'ghcp' ? 'claude-code' : 'ghcp';
      const wrongRuntime = await noCatalog.readReceipt(recoveryRequest({ ...f.request, runtime: otherRuntime }, operation, `${otherRuntime}:original`), wait);
      assert.ok('receipt' in wrongRuntime && wrongRuntime.receipt === null);
      const wrongOperation = await noCatalog.readReceipt(recoveryRequest(f.request, operation === 'create' ? 'settings' : 'create', f.key), wait);
      assert.ok('receipt' in wrongOperation && wrongOperation.receipt === null);
      f.tokens.revoke(f.actor);
      assert.deepEqual(await noCatalog.readReceipt(input, wait), { error: 401 });
    } finally { f.close(); }
  });
  test(`${runtime} ${operation}: post-submit abort exposes unknown and resolves original write without replay`, async () => {
    const f = fixture(runtime), abort = new AbortController();
    let writes = 0;
    const local = new AsyncSdkLocal({ command: (kind, input) => {
      const result = f.owner(kind, input);
      if (kind !== 'sdkLocalReceiptRead') { writes++; abort.abort(); }
      return result;
    } });
    try {
      const work = operation === 'create' ? local.create({ ...f.request, payloadJson: '{"title":"Created"}' }, { ...wait, signal: abort.signal })
        : local.updateModel({ ...f.request, key: f.key, payloadJson: '{"model":null}' }, { ...wait, signal: abort.signal });
      await assert.rejects(work, uncertain); await tick();
      const recovered = await local.readReceipt(recoveryRequest(f.request, operation, f.key), wait);
      assert.ok('receipt' in recovered && recovered.receipt?.state === 'accepted');
      assert.equal(writes, 1); assert.equal(f.journal.sessionKeys(undefined, 64).length, operation === 'create' ? 2 : 1);
    } finally { f.close(); }
  });
  test(`${runtime} ${operation}: lost ACK deadline retains original work and read resolves accepted without replay`, async () => {
    const f = fixture(runtime); let release!: () => void, writes = 0;
    const ack = new Promise<void>(resolve => { release = resolve; });
    const local = new AsyncSdkLocal({ command: async (kind, input) => {
      if (kind !== 'sdkLocalReceiptRead') writes++;
      const result = await f.owner(kind, input);
      if (kind !== 'sdkLocalReceiptRead') await ack;
      return result;
    } });
    try {
      const result = operation === 'create' ? local.create({ ...f.request, payloadJson: '{"title":"Created"}' }, { timeoutMs: 1 })
        : local.updateModel({ ...f.request, key: f.key, payloadJson: '{"model":null}' }, { timeoutMs: 1 });
      await assert.rejects(result, uncertain);
      const recovered = await local.readReceipt(recoveryRequest(f.request, operation, f.key), wait);
      assert.ok('receipt' in recovered && recovered.receipt?.state === 'accepted');
      assert.equal(writes, 1); release(); await tick();
      assert.deepEqual(await local.readReceipt(recoveryRequest(f.request, operation, f.key), wait), recovered);
    } finally { release(); await tick(); f.close(); }
  });
}

for (const runtime of ['claude-code', 'ghcp'] as const) test(`${runtime}: recovery preserves exact offline-audited settings release marker`, async () => {
  const f = fixture(runtime);
  try {
    const claimed = await f.store.commands.claimAsync(f.scope('settings'), f.request.commandKey, { model: null });
    const input = { ...f.request, operation: 'settings' as const, key: f.key };
    const before = await f.local.readReceipt(input, wait);
    assert.ok('receipt' in before && !before.settingsStartReleased);
    // Isolated offline audit fixture, never performed by the recovery reader.
    const row = f.db.prepare('SELECT fingerprint FROM command_receipts WHERE scope = ? AND command_key = ?').get(f.scope('settings'), f.request.commandKey)!;
    f.db.prepare('INSERT INTO settings_start_releases VALUES (?, ?, ?, ?, ?)').run(f.scope('settings'), f.request.commandKey,
      claimed.receipt.id, String(row.fingerprint), JSON.stringify({ stopped: true, authorization: 'isolated test fixture' }));
    const after = await f.local.readReceipt(input, wait);
    assert.ok('receipt' in after && after.settingsStartReleased && after.receipt?.state === 'outcome_unknown');
    assert.equal(f.store.commands.sessionSettingsPending(f.key), false);
    const another = await f.local.readReceipt({ ...input, commandKey: 'absent' }, wait);
    assert.ok('receipt' in another && another.receipt === null && !another.settingsStartReleased);
  } finally { f.close(); }
});

test('recovery denies delegated/read-only/currently-revoked authority without exposing receipt', async () => {
  const f = fixture('ghcp');
  try {
    for (const scopes of [['agents:read'], ['sessions:read'], ['sessions:create', 'execution:delegate']] as const) {
      const actor = f.tokens.create({ label: 'restricted', scopes: [...scopes] });
      assert.deepEqual(await f.local.readReceipt({ ...f.request, operation: 'create', authorization: `Bearer ${actor.token}` }, wait), { error: 403 });
    }
    const transient = f.tokens.createTransient(['sessions:create'], 'actor_fixture');
    assert.deepEqual(await f.local.readReceipt({ ...f.request, operation: 'create', authorization: `Bearer ${transient.token}` }, wait), { error: 403 });
    transient.dispose();
  } finally { f.close(); }
});

test('local async wait never submits preaborted/invalid deadline and observes late rejection', async () => {
  let calls = 0, fail!: (e: Error) => void;
  const local = new AsyncSdkLocal({ command: () => { calls++; return new Promise((_, reject) => { fail = reject; }); } });
  const input = { runtime: 'ghcp' as const, authorization, commandKey: 'command', payloadJson: '{}' };
  const abort = new AbortController(); abort.abort();
  await assert.rejects(local.create(input, { ...wait, signal: abort.signal }), e => e instanceof NativeOperationError && e.outcome === 'not_started');
  await assert.rejects(local.create(input, { timeoutMs: 0 }), RangeError); assert.equal(calls, 0);
  await assert.rejects(local.create(input, { timeoutMs: 1 }), uncertain);
  fail(Error('late')); await tick(); assert.equal(calls, 1);
});

test('read protocol rejects authority/body flags and inconsistent release/receipt correlation', () => {
  const f = fixture('ghcp');
  try {
    const input = { ...f.request, operation: 'create' };
    assert.equal(validConnectorOwnerInput('sdkLocalReceiptRead', input), true);
    for (const name of ['payloadJson', 'authorized', 'actorId', 'release', 'recover', 'catalog', 'key'])
      assert.equal(validConnectorOwnerInput('sdkLocalReceiptRead', { ...input, [name]: true }), false);
    const output = { operation: 'create', runtime: 'ghcp', key: null, commandKey: 'command', receipt: null, settingsStartReleased: false };
    assert.equal(validConnectorSdkLocalRecoveryOutput(output), true);
    for (const patch of [{ settingsStartReleased: true }, { key: 'ghcp:wrong' }, { commandKey: '' }, { runtime: 'codex' }])
      assert.equal(validConnectorSdkLocalRecoveryOutput({ ...output, ...patch }), false);
  } finally { f.close(); }
});

test('real worker accepts bounded legacy metadata above 16KiB and recovers original receipts after reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-local-recovery-worker-'));
  const config = { file: join(dir, 'connector.sqlite'), tokenFile: join(dir, 'tokens.json'), bootstrapToken: 'isolated-local-recovery-test', sdkModels: { ghcp: { model: 'default' } } };
  let owner = new AsyncConnectorOwner(config, silence);
  try {
    await owner.open(); let local = new AsyncSdkLocal(owner);
    const request = { runtime: 'ghcp' as const, authorization, commandKey: 'create', payloadJson: JSON.stringify({ title: 'Created', metadata: '\\"'.repeat(30_000) }) };
    assert.ok(Buffer.byteLength(request.payloadJson) < 128 * 1024);
    assert.ok(Buffer.byteLength(encodeConnectorOwnerJson(request, connectorOwnerCommandBytes('sdkSessionCreate'))) > 16_384);
    const created = await local.create(request, wait); assert.ok('receipt' in created && created.receipt.state === 'accepted' && created.key);
    const settings = { ...request, key: created.key, commandKey: 'settings', payloadJson: JSON.stringify({ model: null, metadata: '\\"'.repeat(30_000) }) };
    const updated = await local.updateModel(settings, wait); assert.ok('receipt' in updated && updated.receipt.state === 'accepted');
    await owner.close(); owner = new AsyncConnectorOwner({ ...config, sdkModels: {} }, silence); await owner.open(); local = new AsyncSdkLocal(owner);
    const recovered = await local.readReceipt({ ...request, operation: 'create', payloadJson: undefined } as never, wait).catch(() => null);
    assert.equal(recovered, null, 'unrecognized request fields rejected before read');
    const { payloadJson: _, ...scope } = request;
    const result = await local.readReceipt({ ...scope, operation: 'create' }, wait);
    assert.ok('receipt' in result); assert.deepEqual(result.receipt, created.receipt); assert.equal(result.key, created.key);
    const saved = await local.readReceipt({ ...scope, commandKey: 'settings', key: created.key, operation: 'settings' }, wait);
    assert.ok('receipt' in saved); assert.deepEqual(saved.receipt, updated.receipt);
    const snapshot = await owner.command('sdkSnapshotRead', { runtime: 'ghcp', key: created.key });
    assert.equal(snapshot.session?.nativeState, 'allocated');
    assert.deepEqual(await owner.command('sdkSessionPage', { runtime: 'ghcp', after: '', limit: 64 }), [created.key]);
  } finally { await owner.close(); rmSync(dir, { recursive: true, force: true }); }
});

class FakeWorker extends EventEmitter {
  sent: Array<{ id: number; kind: string; body: string }> = [];
  postMessage(v: { id: number; kind: string; body: string }) { this.sent.push(v); }
  terminate() { return Promise.resolve(1); }
}
for (const fault of ['runtime', 'operation', 'commandKey', 'key'] as const) for (const missing of [false, true])
  test(`valid-shaped ${missing ? 'missing' : 'unknown'} recovery ${fault} mismatch retires original owner without replay`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-local-recovery-fake-')), fake = new FakeWorker();
    const owner = new AsyncConnectorOwner({ file: join(dir, 'db.sqlite') }, silence, () => fake as unknown as Worker);
    fake.emit('message', { kind: 'ready' });
    try {
      const work = owner.command('sdkLocalReceiptRead', { runtime: 'ghcp', operation: 'settings', key: 'ghcp:original', commandKey: 'command', authorization });
      const rejected = assert.rejects(work); await tick();
      const runtime = fault === 'runtime' ? 'claude-code' : 'ghcp';
      const operation = fault === 'operation' ? 'create' : 'settings';
      const commandKey = fault === 'commandKey' ? 'wrong' : 'command';
      const key = operation === 'create' ? null : `${runtime}:${fault === 'key' ? 'wrong' : 'original'}`;
      const reply = { runtime, operation, key, commandKey, settingsStartReleased: false,
        receipt: missing ? null : { id: 'receipt', key: commandKey, state: 'outcome_unknown', createdAt: 0, updatedAt: 0 } };
      assert.equal(validConnectorSdkLocalRecoveryOutput(reply), true);
      fake.emit('message', { id: fake.sent[0]!.id, kind: 'sdkLocalReceiptRead', ok: true, body: JSON.stringify(reply) });
      await rejected; assert.equal(owner.snapshot().unavailable, true); assert.equal(fake.sent.length, 1);
    } finally { const closed = owner.closeForShutdown(); fake.emit('exit', 1); await closed; rmSync(dir, { recursive: true, force: true }); }
  });
