import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { createConnectorOwnerCommands, connectorOwnerConfig } from './connector-owner-domain.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { connectorSdkLocalSteps, copySdkOwnerCatalogs, validConnectorSdkLocalInput, validConnectorSdkLocalOutput } from './connector-sdk-local-domain.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const authorization = 'Bearer isolated-local-command-test-token';
const catalogs = {
  'claude-code': { model: 'default', modelChoices: ['default', 'alternate'] },
  ghcp: { model: 'default', modelChoices: ['default', 'alternate'] },
  antigravity: { model: 'default', modelChoices: ['default', 'alternate'] },
};
const silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(runtime: SdkAgentId) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-local-owner-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), 'isolated-local-command-test-token');
  const actorId = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const owner = createConnectorOwnerCommands(store, tokens, catalogs);
  const journal = runtime === 'claude-code' ? store.claudeJournal : runtime === 'ghcp' ? store.copilotJournal : store.antigravityJournal;
  const key = `${runtime}:original`;
  journal.create({ key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
  const scope = (operation: 'settings' | 'create') => JSON.stringify([operation, JSON.stringify([actorId, operation === 'settings' ? key : runtime])]);
  const request = { runtime, authorization, commandKey: 'original-command', payloadJson: JSON.stringify({ title: '  Created  ', extraMetadata: 'preserve-fingerprint' }) };
  const modelRequest = { ...request, key, payloadJson: JSON.stringify({ model: ' alternate ', thinking: null }) };
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { directory, tokens, actorId, store, owner, journal, key, scope, request, modelRequest, db,
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('SDK local protocol uses append-only commands, fixed fields and trusted copied catalogs', () => {
  assert.deepEqual(Object.values(connectorSdkLocalSteps), [89, 90]);
  const f = fixture('ghcp');
  try {
    assert.equal(validConnectorSdkLocalInput('sdkSessionCreate', f.request), true);
    assert.equal(validConnectorSdkLocalInput('sdkSessionCreate', { ...f.request, rejectFresh: 'runtime_unavailable' }), true);
    for (const rejectFresh of [true, false, 'authorized', null, undefined]) {
      assert.equal(validConnectorSdkLocalInput('sdkSessionCreate', { ...f.request, rejectFresh }), false);
    }
    for (const extra of ['actorId', 'authorized', 'models', 'catalog', 'sql', 'callback', 'nativeOptions']) {
      assert.equal(validConnectorSdkLocalInput('sdkSessionCreate', { ...f.request, [extra]: true }), false);
    }
    for (const payloadJson of ['null', '[]', '1', '{} trailing', JSON.stringify({ idempotencyKey: 'other' }), ' '.repeat(128 * 1024 + 1)]) {
      assert.equal(validConnectorSdkLocalInput('sdkSessionCreate', { ...f.request, payloadJson }), false);
    }
    assert.equal(validConnectorSdkLocalInput('sdkModelUpdate', { ...f.modelRequest, key: 'claude-code:wrong' }), false);
    assert.throws(() => copySdkOwnerCatalogs({ ghcp: { model: 'bad model' } }));
    assert.throws(() => copySdkOwnerCatalogs({ codex: { model: 'default' } }));
    assert.throws(() => connectorOwnerConfig({ file: '/tmp/unused', sdkModels: { ghcp: { model: 'default', authorized: true } } }));
    const config = { file: '/tmp/unused', sdkModels: structuredClone(catalogs) };
    const copy = connectorOwnerConfig(config); config.sdkModels.ghcp.model = 'mutated';
    assert.equal(copy.sdkModels?.ghcp?.model, 'default');
    assert.throws(() => copySdkOwnerCatalogs({ antigravity: { model: 'default', dynamicModels: 'yes' } }));
    assert.deepEqual(copySdkOwnerCatalogs({ antigravity: { model: 'default', dynamicModels: true } }),
      { antigravity: { model: 'default', modelChoices: ['default'], dynamicModels: true } });
  } finally { f.close(); }
});

test('antigravity dynamicModels catalog accepts valid discovered model overrides while rejecting malformed model IDs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-dynamic-model-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), 'isolated-local-command-test-token');
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const owner = createConnectorOwnerCommands(store, tokens, { antigravity: { model: 'gemini-4-neon-high', dynamicModels: true } });
  const key = 'antigravity:dynamic-test';
  store.antigravityJournal.create({ key, nativeSessionId: 'native-dynamic', title: 'Dynamic', createdAt: 0 });
  try {
    const allowed = await owner('sdkModelUpdate', {
      runtime: 'antigravity',
      authorization,
      commandKey: 'dynamic-claude',
      key,
      payloadJson: JSON.stringify({ model: 'claude-opus-5-5-high' }),
    });
    assert.ok('receipt' in allowed && allowed.receipt.state === 'accepted');
    assert.equal(store.antigravityJournal.session(key)?.model, 'claude-opus-5-5-high');

    const malformed = await owner('sdkModelUpdate', {
      runtime: 'antigravity',
      authorization,
      commandKey: 'dynamic-malformed',
      key,
      payloadJson: JSON.stringify({ model: 'bad model with spaces' }),
    });
    assert.ok('receipt' in malformed && malformed.receipt.state === 'rejected' && malformed.receipt.result?.status === 400);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const runtime of ['claude-code', 'ghcp', 'antigravity'] as const) {
  test(`${runtime}: creation preserves legacy JSON title coercion and metadata fingerprint`, async () => {
    const f = fixture(runtime);
    try {
      const titles = [42, false, ['a', 'b'], {}, '', null];
      for (const [index, title] of titles.entries()) {
        const result = await f.owner('sdkSessionCreate', { ...f.request, commandKey: `coercion-${index}`,
          payloadJson: JSON.stringify({ title }) });
        assert.ok('receipt' in result && result.receipt.state === 'accepted');
        assert.equal(result.receipt.result?.body.title, String(title ?? 'New chat').trim() || 'New chat');
      }
    } finally { f.close(); }
  });
  test(`${runtime}: local creation and original HTTP receipt commit together without native allocation`, async () => {
    const f = fixture(runtime);
    try {
      const result = await f.owner('sdkSessionCreate', f.request);
      assert.ok('receipt' in result && result.receipt.state === 'accepted');
      assert.equal(result.receipt.result?.status, 201); assert.equal(result.receipt.result?.body.title, 'Created');
      assert.equal(f.journal.session(result.key!)?.nativeState, 'allocated');
      assert.equal(f.journal.session(result.key!)?.title, 'Created');
      assert.equal(f.journal.current(result.key!), undefined);
      assert.deepEqual(f.store.commands.get(f.scope('create'), f.request.commandKey), result.receipt);
      assert.deepEqual(await f.owner('sdkSessionCreate', f.request), result);
      assert.equal(f.journal.sessionKeys(undefined, 64).length, 2);
      // Different original fingerprint is conflict, not cached success.
      assert.deepEqual(await f.owner('sdkSessionCreate', { ...f.request, payloadJson: JSON.stringify({ title: 'Created' }) }), { error: 409 });
      assert.equal(f.journal.sessionKeys(undefined, 64).length, 2);
    } finally { f.close(); }
  });
  test(`${runtime}: model and original settings ACK share savepoint, raw fingerprint and reset default remain compatible`, async () => {
    const f = fixture(runtime);
    try {
      const result = await f.owner('sdkModelUpdate', f.modelRequest);
      assert.ok('receipt' in result && result.receipt.state === 'accepted');
      assert.equal(f.journal.session(f.key)?.model, 'alternate');
      assert.deepEqual(result.receipt.result?.body, { sessionKey: f.key, settings: { model: 'alternate', modelProvider: null } });
      assert.equal(f.store.commands.sessionSettingsPending(f.key), false);
      assert.deepEqual(f.store.commands.get(f.scope('settings'), f.modelRequest.commandKey), result.receipt);
      assert.deepEqual(await f.owner('sdkModelUpdate', f.modelRequest), result);
      assert.deepEqual(await f.owner('sdkModelUpdate', { ...f.modelRequest, payloadJson: JSON.stringify({ model: 'alternate', thinking: null }) }), { error: 409 });
      const reset = await f.owner('sdkModelUpdate', { ...f.modelRequest, commandKey: 'reset', payloadJson: '{"model":null}' });
      assert.ok('receipt' in reset && reset.receipt.state === 'accepted');
      assert.equal(f.journal.session(f.key)?.model, undefined);
      assert.equal(reset.receipt.result?.body.settings && (reset.receipt.result.body.settings as { model: string }).model, 'default');
    } finally { f.close(); }
  });
  for (const operation of ['sdkSessionCreate', 'sdkModelUpdate'] as const) {
    test(`${runtime}: ${operation} revoke after claim rolls back local work and settles original denial`, async () => {
      const f = fixture(runtime), claim = f.store.commands.claimAsync.bind(f.store.commands);
      try {
        f.store.commands.claimAsync = async (...args) => {
          const result = await claim(...args); f.tokens.revoke(f.actorId); return result;
        };
        const result = await f.owner(operation, operation === 'sdkSessionCreate' ? f.request : f.modelRequest);
        assert.ok('receipt' in result && result.receipt.state === 'rejected');
        assert.equal(result.receipt.result?.status, 403);
        assert.equal(f.journal.sessionKeys(undefined, 64).length, 1);
        assert.equal(f.journal.session(f.key)?.model, undefined);
        assert.equal(f.store.commands.sessionSettingsPending(f.key), false);
        assert.equal(f.db.isTransaction, false);
      } finally { f.close(); }
    });
    test(`${runtime}: ${operation} revoke inside original transaction cannot commit local state`, async () => {
      const f = fixture(runtime);
      try {
        if (operation === 'sdkSessionCreate') {
          const create = f.journal.create.bind(f.journal);
          f.journal.create = (session, commit) => create(session, db => { f.tokens.revoke(f.actorId); commit!(db); });
        } else {
          const update = f.journal.updateModel.bind(f.journal);
          f.journal.updateModel = (key, model, commit) => update(key, model, () => { f.tokens.revoke(f.actorId); commit!(); });
        }
        const result = await f.owner(operation, operation === 'sdkSessionCreate' ? f.request : f.modelRequest);
        assert.ok('receipt' in result && result.receipt.state === 'rejected');
        assert.equal(result.receipt.result?.status, 403);
        assert.equal(f.journal.sessionKeys(undefined, 64).length, 1);
        assert.equal(f.journal.session(f.key)?.model, undefined);
        assert.equal(f.store.commands.sessionSettingsPending(f.key), false);
        assert.equal(f.db.isTransaction, false);
      } finally { f.close(); }
    });
    test(`${runtime}: ${operation} unknown receipt never retries a local write`, async () => {
      const f = fixture(runtime);
      try {
        const input = operation === 'sdkSessionCreate' ? f.request : f.modelRequest;
        await f.store.commands.claimAsync(f.scope(operation === 'sdkSessionCreate' ? 'create' : 'settings'), input.commandKey,
          JSON.parse(input.payloadJson), false, undefined, undefined, undefined, operation === 'sdkModelUpdate');
        const result = await f.owner(operation, input);
        assert.ok('receipt' in result && result.receipt.state === 'outcome_unknown');
        assert.equal(f.journal.sessionKeys(undefined, 64).length, 1); assert.equal(f.journal.session(f.key)?.model, undefined);
      } finally { f.close(); }
    });
    test(`${runtime}: ${operation} receipt participant failure rolls back state, leaves original unknown`, async () => {
      const f = fixture(runtime), settle = f.store.commands.settle.bind(f.store.commands);
      try {
        f.store.commands.settle = (...args) => { const result = settle(...args); if (result.state === 'accepted') throw Error('fixture commit participant failed'); return result; };
        await assert.rejects(f.owner(operation, operation === 'sdkSessionCreate' ? f.request : f.modelRequest), /participant failed/);
        assert.equal(f.journal.sessionKeys(undefined, 64).length, 1); assert.equal(f.journal.session(f.key)?.model, undefined);
        assert.equal(f.store.commands.get(f.scope(operation === 'sdkSessionCreate' ? 'create' : 'settings'), f.request.commandKey)?.state, 'outcome_unknown');
        assert.equal(f.db.isTransaction, false);
        if (operation === 'sdkModelUpdate') {
          f.store.commands.settle = settle; f.store.commands.recoverSettingsPrewrites();
          assert.equal(f.store.commands.sessionSettingsPending(f.key), false);
        }
      } finally { f.close(); }
    });
    test(`${runtime}: ${operation} post-COMMIT notification failure recovers original accepted receipt`, async () => {
      const f = fixture(runtime);
      try {
        if (operation === 'sdkSessionCreate') {
          const original = f.journal.create.bind(f.journal);
          f.journal.create = (...args) => { original(...args); throw Error('fixture notification failed'); };
        } else {
          const original = f.journal.updateModel.bind(f.journal);
          f.journal.updateModel = (...args) => { original(...args); throw Error('fixture notification failed'); };
        }
        const input = operation === 'sdkSessionCreate' ? f.request : f.modelRequest;
        const result = await f.owner(operation, input);
        assert.ok('receipt' in result && result.receipt.state === 'accepted');
        assert.deepEqual(await f.owner(operation, input), result);
        assert.equal(f.journal.sessionKeys(undefined, 64).length, operation === 'sdkSessionCreate' ? 2 : 1);
      } finally { f.close(); }
    });
    for (const fault of ['revoked', 'read-only', 'delegated', 'pause', 'no-catalog'] as const) {
      test(`${runtime}: ${operation} ${fault} cannot write local state`, async () => {
        const f = fixture(runtime);
        try {
          let auth = authorization;
          if (fault === 'revoked') f.tokens.revoke(f.actorId);
          if (fault === 'pause') f.store.pauseTurnStarts();
          if (fault === 'read-only' || fault === 'delegated') auth = `Bearer ${f.tokens.create({ label: 'fixture', scopes:
            fault === 'read-only' ? ['messages:read'] : ['sessions:create', 'execution:delegate'] }).token}`;
          const owner = fault === 'no-catalog' ? createConnectorOwnerCommands(f.store, f.tokens) : f.owner;
          const result = await owner(operation, { ...(operation === 'sdkSessionCreate' ? f.request : f.modelRequest), authorization: auth });
          assert.ok('error' in result || result.receipt.state === 'rejected');
          assert.equal(f.journal.sessionKeys(undefined, 64).length, 1); assert.equal(f.journal.session(f.key)?.model, undefined);
        } finally { f.close(); }
      });
    }
  }
  for (const fault of ['queue', 'deletion', 'settings', 'active', 'model', 'thinking', 'goal'] as const) {
    test(`${runtime}: settings ${fault} remains a definitive prewrite rejection`, async () => {
      const f = fixture(runtime);
      try {
        let input = f.modelRequest;
        if (fault === 'queue' || fault === 'active') f.store.turns.enqueue(runtime, { id: 'waiting', sessionKey: f.key, createdAt: 0, payload: {} });
        if (fault === 'active') f.journal.begin({ key: f.key, id: 'active', epoch: 'epoch' }, ['waiting'], f.store.turns);
        if (fault === 'settings') await f.store.commands.claimAsync(JSON.stringify(['settings', JSON.stringify([f.actorId, f.key])]), 'other', {}, false, undefined, undefined, undefined, true);
        if (fault === 'deletion') await f.store.commands.claimAsync(JSON.stringify(['delete', JSON.stringify([f.actorId, f.key])]), 'other', {});
        if (fault === 'model') input = { ...input, payloadJson: '{"model":"not-in-catalog"}' };
        if (fault === 'thinking') input = { ...input, payloadJson: '{"model":"alternate","thinking":"high"}' };
        if (fault === 'goal') input = { ...input, payloadJson: '{"model":"alternate","goal":{}}' };
        const result = await f.owner('sdkModelUpdate', input);
        assert.ok('receipt' in result && result.receipt.state === 'rejected');
        assert.equal(f.journal.session(f.key)?.model, undefined);
      } finally { f.close(); }
    });
  }
}

test('SDK owner catalog snapshot cannot expand during admission', async () => {
  const f = fixture('ghcp'), mutable = structuredClone(catalogs);
  try {
    const owner = createConnectorOwnerCommands(f.store, f.tokens, mutable);
    const claim = f.store.commands.claimAsync.bind(f.store.commands);
    f.store.commands.claimAsync = async (...args) => {
      const result = await claim(...args); mutable.ghcp.modelChoices.push('injected'); return result;
    };
    const result = await owner('sdkModelUpdate', { ...f.modelRequest, payloadJson: '{"model":"injected"}' });
    assert.ok('receipt' in result && result.receipt.state === 'rejected');
    assert.equal(result.receipt.result?.status, 400);
    assert.equal(f.journal.session(f.key)?.model, undefined);
  } finally { f.close(); }
});

test('real sole owner creates and saves settings, closes and reopens the original identities and receipts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-local-worker-'));
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'),
    bootstrapToken: 'isolated-local-command-test-token', sdkModels: catalogs };
  let owner = new AsyncConnectorOwner(config, silence);
  try {
    await owner.open();
    const input = { runtime: 'ghcp' as const, authorization, commandKey: 'create', payloadJson: '{"label":"Original allocation"}' };
    const created = await owner.command('sdkSessionCreate', input);
    assert.ok('receipt' in created && created.receipt.state === 'accepted' && created.key);
    const settings = { ...input, key: created.key, commandKey: 'settings', payloadJson: '{"model":"alternate"}' };
    const updated = await owner.command('sdkModelUpdate', settings);
    assert.ok('receipt' in updated && updated.receipt.state === 'accepted');
    await owner.close(); owner = new AsyncConnectorOwner(config, silence); await owner.open();
    assert.deepEqual(await owner.command('sdkSessionCreate', input), created);
    assert.deepEqual(await owner.command('sdkModelUpdate', settings), updated);
    const snapshot = await owner.command('sdkSnapshotRead', { runtime: 'ghcp', key: created.key });
    assert.equal(snapshot.session?.model, 'alternate'); assert.equal(snapshot.session?.nativeState, 'allocated');
  } finally { await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});

class FakeWorker extends EventEmitter {
  sent: Array<{ id: number; kind: string; body: string }> = [];
  postMessage(value: { id: number; kind: string; body: string }) { this.sent.push(value); }
  terminate() { return Promise.resolve(1); }
}
for (const fault of ['runtime', 'receipt', 'session'] as const) test(`valid-shaped local ${fault} reply mismatch retires original owner without replay`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-local-fake-')), fake = new FakeWorker();
  const owner = new AsyncConnectorOwner({ file: join(directory, 'db.sqlite') }, silence, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' });
  try {
    const request = owner.command('sdkModelUpdate', { runtime: 'ghcp', authorization, commandKey: 'command', key: 'ghcp:original', payloadJson: '{"model":null}' });
    const rejected = assert.rejects(request);
    await tick();
    const runtime = fault === 'runtime' ? 'claude-code' : 'ghcp';
    const key = `${runtime}:${fault === 'session' ? 'wrong' : 'original'}`;
    const result = { runtime, key, receipt: { id: 'receipt', key: fault === 'receipt' ? 'wrong' : 'command', state: 'accepted', createdAt: 0, updatedAt: 0,
      result: { status: 200, body: { sessionKey: key, settings: { model: 'default', modelProvider: null } } } } };
    assert.equal(validConnectorSdkLocalOutput('sdkModelUpdate', result), true);
    fake.emit('message', { id: fake.sent[0]!.id, kind: 'sdkModelUpdate', ok: true, body: JSON.stringify(result) });
    await rejected; assert.equal(owner.snapshot().unavailable, true); assert.equal(fake.sent.length, 1);
  } finally { const close = owner.closeForShutdown(); fake.emit('exit', 1); await close; rmSync(directory, { recursive: true, force: true }); }
});
