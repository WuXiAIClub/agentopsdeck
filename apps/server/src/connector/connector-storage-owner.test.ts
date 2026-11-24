import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncConnectorStorageRequests, synchronousConnectorStorageRequests, type ConnectorStorageRequestPort } from './async-storage-request.js';
import { executeConnectorStorage, validConnectorStorageInput, validConnectorStorageOutput,
  type ConnectorStorageDependencies, type ConnectorStorageKind } from './connector-storage-domain.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const silence = new PerformanceDiagnostics(() => {});
const kinds: ConnectorStorageKind[] = ['authorizedStorageRecovery', 'authorizedStorageStats', 'authorizedStorageCheckpoint'];
const evidence = { authorization: 'Bearer synthetic', expectedNode: 'synthetic-node', protocol: '1', originPresent: false };
const timing = () => ({ sqlSteps: 0, sqlMs: 0, sqlMaxMs: 0, jsonCalls: 0, jsonMs: 0, jsonBytes: 0 });
const stats = () => ({ databaseBytes: 1, walBytes: 2, availableBytes: 3, lowSpace: true, walPressure: false,
  connection: { state: 'ready' as const, attempts: 0 }, reads: { claude: timing(), copilot: timing() } });
const checkpoint = { deferred: false as const, busy: 0, logFrames: 0, checkpointedFrames: 0 };
async function fixture(t: TestContext, worker: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'connector-storage-owner-'));
  const config = { file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json') };
  const tokens = new ConnectorTokenStore(config.tokenFile, undefined, silence);
  const updater = tokens.create({ label: 'private-storage-updater', scopes: ['connector:update'] });
  const lifecycle = tokens.create({ label: 'private-storage-lifecycle', scopes: ['connector:lifecycle'] });
  const reader = tokens.create({ label: 'private-storage-reader', scopes: ['sessions:read'] });
  const seed = new ConnectorUserStore(config.file);
  const nodeId = seed.nodeId;
  await seed.turns.enqueueAsync('codex', { id: 'storage-preserved-turn', sessionKey: 'codex:private-storage-session', createdAt: Date.now(),
    payload: { actorId: reader.record.id, message: 'private-storage-message' } });
  let owner: AsyncConnectorOwner | undefined;
  let requests: ConnectorStorageRequestPort;
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  if (worker) {
    seed.close(); owner = new AsyncConnectorOwner(config, diagnostics);
    t.after(async () => { try { await owner!.closeForShutdown(); } finally { rmSync(root, { recursive: true, force: true }); } });
    await owner.open(); requests = new AsyncConnectorStorageRequests(owner);
  } else {
    t.after(() => { seed.close(); rmSync(root, { recursive: true, force: true }); });
    requests = synchronousConnectorStorageRequests({ owner: seed, tokens, diagnostics });
  }
  const request = (token: string, headers: Record<string, string> = {}) => new Request('http://fixture.invalid', {
    headers: { authorization: `Bearer ${token}`, ...headers } });
  return { owner, seed, tokens, config, requests, lines, updater, lifecycle, reader, nodeId, request };
}
for (const worker of [false, true]) {
  test(`${worker ? 'worker' : 'original'}: storage commands retain original operator policy and omit private data`, async t => {
    const f = await fixture(t, worker);
    for (const kind of kinds) {
      const result = await f.requests.execute(kind, f.request(f.updater.token));
      assert.equal(result.status, 200, 'legacy updater does not acquire new node/protocol requirements');
      assert.equal(validConnectorStorageOutput(kind, result), true);
      assert.doesNotMatch(JSON.stringify(result), /private-storage|storage-preserved|sqlite|tokens\.json|SELECT|PRAGMA/);
      const denied = await f.requests.execute(kind, f.request(f.reader.token));
      assert.equal(denied.status, 403);
      assert.equal((await f.requests.execute(kind, f.request(f.lifecycle.token))).status, 403);
      const headers = { [EXPECTED_NODE_HEADER]: f.nodeId, [CONNECTOR_PROTOCOL_HEADER]: '1' };
      assert.equal((await f.requests.execute(kind, f.request(f.lifecycle.token, { ...headers, Origin: '' }))).status, 403);
      assert.equal((await f.requests.execute(kind, f.request(f.lifecycle.token, { ...headers, [EXPECTED_NODE_HEADER]: 'wrong' }))).status, 403);
      assert.equal((await f.requests.execute(kind, f.request(f.lifecycle.token, headers))).status, 200);
    }
    const count = f.owner ? await f.owner.command('turnMaintenanceCount', {}) : f.seed.turns.maintenanceCount();
    assert.equal(count, 1, 'maintenance is not queued-turn release or native dispatch');
    const text = f.lines.join('\n');
    for (const secret of [f.updater.token, f.reader.record.id, f.nodeId, f.config.file, 'private-storage']) assert.equal(text.includes(secret), false);
    assert.ok(f.lines.some(line => JSON.parse(line).operation === (worker ? 'connector-sqlite-command' : 'connector-storage-maintenance')));
  });
}

test('fixed storage command envelopes and replies cannot smuggle authority, paths, callbacks or SQL', () => {
  for (const kind of kinds) {
    assert.equal(validConnectorStorageInput(kind, evidence), true);
    for (const key of ['tokenId', 'authorized', 'file', 'sql', 'check', 'body', 'generation'])
      assert.equal(validConnectorStorageInput(kind, { ...evidence, [key]: 'forged' }), false);
    assert.equal(validConnectorStorageInput(kind, { ...evidence, authorization: 'Bearer x\r\n' }), false);
    assert.equal(validConnectorStorageInput(kind, { ...evidence, originPresent: 'false' }), false);
    assert.equal(validConnectorStorageOutput(kind, { status: 403, error: 'Storage maintenance unavailable' }), true);
    assert.equal(validConnectorStorageOutput(kind, { status: 503, error: 'private-storage-error' }), false);
  }
  assert.equal(validConnectorStorageOutput('authorizedStorageRecovery', { status: 200, value: { state: 'ready', attempts: 0, file: 'private' } }), false);
  assert.equal(validConnectorStorageOutput('authorizedStorageStats', { status: 200, value: stats() }), true);
  assert.equal(validConnectorStorageOutput('authorizedStorageStats', { status: 200, value: { ...stats(), reads: { claude: { ...timing(), sqlMs: Infinity }, copilot: timing() } } }), false);
  assert.equal(validConnectorStorageOutput('authorizedStorageCheckpoint', { status: 200, value: { ...checkpoint, logFrames: -1, checkpointedFrames: -1 } }), true);
  assert.equal(validConnectorStorageOutput('authorizedStorageCheckpoint', { status: 200, value: { deferred: true, busy: 0 } }), false);
});

for (const stage of ['before-sql', 'after-sql'] as const) {
  test(`checkpoint ${stage} revocation refuses the outcome without releasing or replaying original work`, async t => {
    const f = await fixture(t, false);
    let release!: () => void, entered!: () => void, writes = 0;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const lines: string[] = [];
    const owner: ConnectorStorageDependencies['owner'] = {
      nodeId: f.nodeId, storageRecovery: () => ({ state: 'ready', attempts: 0 }), storageStats: async () => stats(),
      checkpointStorage: async check => {
        if (stage === 'after-sql') { check?.(); writes++; }
        entered(); await wait;
        check?.();
        if (stage === 'before-sql') writes++;
        return checkpoint;
      },
    };
    const pending = executeConnectorStorage('authorizedStorageCheckpoint', { ...evidence, authorization: `Bearer ${f.updater.token}` },
      { owner, tokens: f.tokens, diagnostics: new PerformanceDiagnostics(line => lines.push(line)) });
    await started; f.tokens.revoke(f.updater.record.id); release();
    assert.equal((await pending).status, 403);
    assert.equal(writes, stage === 'before-sql' ? 0 : 1);
    assert.equal(f.seed.turns.maintenanceCount(), 1);
    assert.equal(JSON.parse(lines.at(-1)!).unknown, 1);
    assert.equal(lines.join('\n').includes(f.updater.token), false);
  });
}

test('a pending storage observation cannot acknowledge a closed original owner', async t => {
  const f = await fixture(t, false);
  let release!: () => void, state: 'ready' | 'closed' = 'ready';
  const wait = new Promise<void>(resolve => { release = resolve; });
  const owner: ConnectorStorageDependencies['owner'] = {
    nodeId: f.nodeId, storageRecovery: () => ({ state, attempts: 0 }),
    storageStats: async () => { await wait; return stats(); }, checkpointStorage: async () => checkpoint,
  };
  const pending = executeConnectorStorage('authorizedStorageStats', { ...evidence, authorization: `Bearer ${f.updater.token}` }, { owner, tokens: f.tokens, diagnostics: silence });
  state = 'closed'; release(); assert.equal((await pending).status, 503);
});

test('pending maintenance logs never cancel, settle or replay an admitted checkpoint', async t => {
  const f = await fixture(t, false);
  const keepAlive = setTimeout(() => {}, 2000); t.after(() => clearTimeout(keepAlive));
  let release!: () => void, reported!: () => void, writes = 0;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { reported = resolve; });
  const rows: Record<string, unknown>[] = [];
  const owner: ConnectorStorageDependencies['owner'] = {
    nodeId: f.nodeId, storageRecovery: () => ({ state: 'ready', attempts: 0 }), storageStats: async () => stats(),
    checkpointStorage: async check => { check?.(); writes++; await wait; check?.(); return checkpoint; },
  };
  const pending = executeConnectorStorage('authorizedStorageCheckpoint', { ...evidence, authorization: `Bearer ${f.updater.token}` },
    { owner, tokens: f.tokens, warningMs: 5, diagnostics: new PerformanceDiagnostics(line => {
      const row = JSON.parse(line); rows.push(row); if (row.phase === 'pending') reported();
    }) });
  await observed; assert.equal(writes, 1); assert.equal(rows.some(row => row.settled === 1), false);
  release(); assert.equal((await pending).status, 200); assert.equal(writes, 1); assert.equal(rows.at(-1)?.settled, 1);
});

test('pre-aborted storage requests never enter the owner queue', () => {
  let calls = 0;
  const requests = new AsyncConnectorStorageRequests({ command() { calls++; throw Error('must not run'); } } as unknown as AsyncConnectorOwner);
  const abort = new AbortController(); abort.abort();
  assert.throws(() => requests.execute('authorizedStorageCheckpoint', new Request('http://fixture.invalid', { signal: abort.signal })));
  assert.equal(calls, 0);
});
