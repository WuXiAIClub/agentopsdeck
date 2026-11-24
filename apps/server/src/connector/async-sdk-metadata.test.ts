import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore, DEFAULT_SCOPES } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { AsyncSdkMetadata } from './async-sdk-metadata.js';
import { registerSdkMetadataHttp } from './sdk-metadata-http.js';
import type { SdkAgentId } from './sdk-execution-journal.js';

const authorization = 'Bearer isolated-metadata', silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
function fixture(runtime: SdkAgentId, timeoutMs = 5_000) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-metadata-'));
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), authorization.slice(7));
  const ownerAuthorization = `Bearer ${tokens.create({ label: 'metadata owner', scopes: [...DEFAULT_SCOPES, 'models:read'] }).token}`;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true }), key = `${runtime}:original`;
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
  journal.create({ key, nativeSessionId: 'original-native', title: 'Private title', createdAt: 1 });
  const catalogs = { [runtime]: { model: 'default', modelChoices: ['alternate'] } };
  const command = createConnectorOwnerCommands(store, tokens, catalogs);
  let port: Pick<AsyncConnectorOwner, 'command'> = { command }, connected = true;
  const metadata = new AsyncSdkMetadata({ command: (kind, input) => port.command(kind, input) }, { diagnostics: silence, timeoutMs });
  const app = new Hono(); registerSdkMetadataHttp(app, '', { metadata, ready: () => connected, configured: () => true });
  app.get('/sessions/:sessionKey/state', c => c.json({ legacy: true })); app.get('/models/:runtime', c => c.json({ legacy: true }));
  const request = (state = true, headers: Record<string, string> = {}, signal?: AbortSignal) => app.request(
    state ? `/sessions/${key}/state` : `/models/${runtime}`, { headers: { authorization: ownerAuthorization, ...headers }, ...(signal ? { signal } : {}) });
  const ref = { key, id: 'execution', epoch: 'epoch' };
  const begin = () => { store.turns.enqueue(runtime, { id: 'input', sessionKey: key, createdAt: 2, payload: { text: 'Input', images: [], actorId: 'owner' } }); return journal.begin(ref, ['input'], store.turns); };
  return { store, tokens, journal, key, command, metadata, app, request, begin, ref, catalogs, authorization: ownerAuthorization,
    connected(value: boolean) { connected = value; }, port(value: Pick<AsyncConnectorOwner, 'command'>) { port = value; },
    async close() { await metadata.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: HTTP state observes original journal, never turns settling/offline into completion`, async () => {
    const f = fixture(runtime);
    try {
      const read = async () => { const response = await f.request(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); return response.json(); };
      assert.equal((await read()).status, 'idle'); assert.ok(f.begin());
      assert.equal((await read()).runtime.phase, 'starting');
      assert.equal(f.journal.acknowledge(f.ref, 'native-request', f.store.turns), true);
      const before = f.journal.readSnapshot(f.key), cursor = f.store.events.latestEventId();
      const running = await read(); assert.equal(running.runtime.phase, 'running'); assert.equal(running.hasActiveRun, true);
      assert.equal(running.sourceCursor, cursor); assert.equal(JSON.stringify(running).includes('Private title'), false);
      assert.deepEqual(f.journal.readSnapshot(f.key), before); assert.equal(f.store.events.latestEventId(), cursor);
      f.connected(false); const offline = await read(); assert.equal(offline.runtime.connection, 'disconnected'); assert.equal(offline.status, 'running');
      assert.equal(f.journal.observeTerminal(f.ref, 'completed', f.store.turns), true);
      const settling = await read(); assert.equal(settling.runtime.phase, 'finalizing'); assert.equal(settling.runCompletedAt, undefined);
      assert.equal(f.journal.confirmSettled(f.ref), true);
      const completed = await read(); assert.equal(completed.runtime.phase, 'completed'); assert.equal(completed.runtime.connection, 'disconnected');
      assert.equal(completed.status, 'idle'); assert.equal(completed.hasActiveRun, false); assert.equal(typeof completed.runCompletedAt, 'number');
    } finally { await f.close(); }
  });

  test(`${runtime}: catalog is the original construction snapshot, scoped independently of session reads`, async () => {
    const f = fixture(runtime);
    try {
      f.catalogs[runtime]!.model = 'mutated'; f.catalogs[runtime]!.modelChoices.push('mutated');
      const response = await f.request(false); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { models: [{ id: 'default', label: 'default' }, { id: 'alternate', label: 'alternate' }] });
      const reader = f.tokens.create({ label: 'reader', scopes: ['messages:read'] }), models = f.tokens.create({ label: 'models', scopes: ['models:read'] });
      assert.equal((await f.request(false, { authorization: `Bearer ${reader.token}` })).status, 403);
      assert.equal((await f.request(true, { authorization: `Bearer ${models.token}` })).status, 403);
      assert.equal((await f.request(false, { authorization: `Bearer ${models.token}` })).status, 200);
      assert.equal((await f.request(true, { authorization: `Bearer ${reader.token}` })).status, 200);
      assert.deepEqual(await f.command('sdkModelsRead', { runtime: runtime === 'ghcp' ? 'claude-code' : 'ghcp', authorization: f.authorization }), { error: 404 });
      assert.equal((await f.request(false, { authorization })).status, 403, 'bootstrap authority does not implicitly include models:read');
      f.connected(false); assert.equal((await f.request(false)).status, 200, 'configured offline catalog remains available');
      const delegate = f.tokens.create({ label: 'delegate', scopes: ['messages:read', 'models:read', 'messages:send', 'execution:delegate'] });
      for (const state of [true, false]) {
        assert.equal((await f.request(state, { authorization: `Bearer ${delegate.token}` })).status, 403);
        assert.equal((await f.request(state, { 'x-agentopsdeck-execution-grant': 'original' })).status, 403);
        assert.equal((await f.request(state, { authorization: '' })).status, 401);
      }
      assert.deepEqual(await (await f.app.request('/models/codex')).json(), { legacy: true });
      assert.deepEqual(await (await f.app.request('/sessions/codex:original/state')).json(), { legacy: true });
    } finally { await f.close(); }
  });

  for (const state of [true, false]) test(`${runtime}: ${state ? 'state' : 'catalog'} delivery withholds original result after revocation`, async () => {
    const f = fixture(runtime);
    try {
      f.port({ command: (async (kind, input) => {
        const result = await f.command(kind, input);
        if (kind === (state ? 'sdkStateRead' : 'sdkModelsRead')) f.tokens.revoke(f.tokens.authenticateAuthorization(f.authorization)!.tokenId);
        return result;
      }) as AsyncConnectorOwner['command'] });
      const response = await f.request(state); assert.equal(response.status, 401); assert.equal((await response.text()).includes('default'), false);
    } finally { await f.close(); }
  });

  test(`${runtime}: state delivery rejects deletion and a replaced native incarnation`, async t => {
    const f = fixture(runtime);
    try {
      let replace = false;
      f.port({ command: (async (kind, input) => {
        const result = await f.command(kind, input);
        if (kind === 'sdkStateRead' && replace) {
          const original = f.journal.session.bind(f.journal);
          t.mock.method(f.journal, 'session', (key: string) => { const row = original(key); return row && { ...row, nativeSessionId: 'replacement' }; });
        }
        return result;
      }) as AsyncConnectorOwner['command'] });
      replace = true; assert.equal((await f.request()).status, 409); t.mock.restoreAll(); replace = false;
      f.port({ command: (async (kind, input) => {
        const result = await f.command(kind, input);
        if (kind === 'sdkStateRead' && result && typeof result === 'object' && !('error' in result)) f.journal.beginDeletion(f.key, 'delete');
        return result;
      }) as AsyncConnectorOwner['command'] });
      assert.equal((await f.request()).status, 404);
      assert.equal((await f.request()).status, 404);
      assert.deepEqual(await f.command('sdkModelsDeliver', { runtime, authorization: f.authorization, readerId: 'foreign' }), { error: 409 });
    } finally { await f.close(); }
  });
}

for (const state of [true, false]) for (const ending of ['cancel', 'timeout', 'close'] as const)
  test(`metadata ${state ? 'state' : 'models'} ${ending} retains original physical read and drains without replay`, async () => {
    const f = fixture('ghcp', ending === 'timeout' ? 25 : 5_000), entered = gate(), release = gate();
    const controller = new AbortController(); let calls = 0, closing: Promise<void> | undefined;
    try {
      f.port({ command: (async (kind, input) => { calls++; entered.release(); await release.promise; return f.command(kind, input); }) as AsyncConnectorOwner['command'] });
      const pending = f.request(state, {}, controller.signal); await entered.promise;
      if (ending === 'cancel') controller.abort();
      if (ending === 'close') closing = f.metadata.close();
      assert.equal((await pending).status, ending === 'cancel' ? 408 : 503);
      let drained = false; closing ??= f.metadata.close(); const done = closing.then(() => { drained = true; });
      await tick(); assert.equal(drained, false); assert.equal(calls, 1);
      release.release(); await done; assert.equal(calls, 1); assert.equal((await f.request(state)).status, 503);
    } finally { release.release(); await f.close(); }
  });

test('metadata cancelled HTTP retains all eight physical slots until their original read settles', async () => {
  const f = fixture('ghcp'), entered = gate(), release = gate(); let calls = 0;
  try {
    f.port({ command: (async (kind, input) => { if (++calls === 8) entered.release(); await release.promise; return f.command(kind, input); }) as AsyncConnectorOwner['command'] });
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const pending = controllers.map(controller => f.request(true, {}, controller.signal)); await entered.promise;
    controllers.forEach(controller => controller.abort()); assert.ok((await Promise.all(pending)).every(response => response.status === 408));
    assert.equal((await f.request(false)).status, 503); assert.equal(calls, 8);
    release.release(); await tick(); await tick(); assert.equal((await f.request(false)).status, 200); assert.equal(calls, 10);
  } finally { release.release(); await f.close(); }
});

test('metadata wire rejects authority overrides, unknown status fields, missing cursor and oversized/duplicate catalog', async () => {
  const f = fixture('ghcp');
  try {
    const input = { runtime: 'ghcp' as const, key: f.key, authorization, connected: true };
    assert.equal(validConnectorOwnerInput('sdkStateRead', { ...input, actorId: 'trusted' }), false);
    assert.equal(validConnectorOwnerInput('sdkStateRead', { ...input, connected: 'true' }), false);
    assert.equal(validConnectorOwnerInput('sdkModelsRead', { runtime: 'ghcp', authorization, sql: 'SELECT 1' }), false);
    const result = await f.command('sdkStateRead', input); assert.ok(!('error' in result));
    assert.equal(validConnectorOwnerOutput('sdkStateRead', { ...result, body: { ...result.body, private: true } }), false);
    assert.equal(validConnectorOwnerOutput('sdkStateRead', { ...result, body: { sessionKey: f.key, status: 'idle' } }), false);
    assert.equal(validConnectorOwnerOutput('sdkModelsRead', { runtime: 'ghcp', readerId: 'reader', body: { models: [{ id: 'a', label: 'a' }, { id: 'a', label: 'a' }] } }), false);
    assert.equal(validConnectorOwnerOutput('sdkModelsRead', { runtime: 'ghcp', readerId: 'reader', body: { models: Array.from({ length: 101 }, (_, i) => ({ id: `m${i}`, label: `m${i}` })) } }), false);
  } finally { await f.close(); }
});

test('metadata real sole worker reads durable unknown execution after reopen, without native effects', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-metadata-worker-'));
  const config = { file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'), bootstrapToken: authorization.slice(7),
    sdkModels: { 'claude-code': { model: 'original' }, ghcp: { model: 'original' } } };
  let owner = new AsyncConnectorOwner(config, silence);
  try {
    await owner.open();
    const ownerAuthorization = `Bearer ${(await owner.command('tokenCreate', { label: 'metadata owner', scopes: [...DEFAULT_SCOPES, 'models:read'] })).token}`;
    for (const runtime of ['claude-code', 'ghcp'] as const) {
      const created = await owner.command('sdkSessionCreate', { runtime, authorization, commandKey: `create-${runtime}`, payloadJson: '{}' });
      assert.ok('key' in created && created.key); const key = created.key;
      const admitted = await owner.command('sdkMessageSend', { runtime, key, authorization, commandKey: 'input', payloadJson: JSON.stringify({ message: 'Input' }) }); assert.ok(!('error' in admitted));
      const plan = await owner.command('sdkDispatchPlan', { runtime, key }); assert.ok(plan && plan !== 'blocked');
      assert.ok(await owner.command('sdkDispatchClaim', { runtime, key, id: `run-${runtime}`, epoch: 'epoch', digest: plan.digest }));
      await owner.close(); owner = new AsyncConnectorOwner(config, silence); await owner.open();
      const metadata = new AsyncSdkMetadata(owner, { diagnostics: silence });
      try {
        const state = await metadata.state({ runtime, key, authorization, connected: false }, new Request('http://local/state'));
        assert.ok(!('error' in state)); assert.equal(state.body.runtime?.phase, 'unknown'); assert.equal(state.body.status, 'unknown');
        const models = await metadata.models({ runtime, authorization: ownerAuthorization }, new Request('http://local/models'));
        assert.ok(!('error' in models)); assert.deepEqual(models.body, { models: [{ id: 'original', label: 'original' }] });
      } finally { await metadata.close(); }
    }
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
