import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { AsyncSdkUsage } from './async-sdk-usage.js';
import { registerSdkUsageHttp } from './sdk-usage-http.js';
import type { SdkAgentId } from './sdk-execution-journal.js';

const authorization = 'Bearer isolated-usage', range = { from: 0, to: 120_000, bucketMs: 60_000 };
const silence = new PerformanceDiagnostics(() => {}), tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
function fixture(runtime: SdkAgentId, timeoutMs = 5_000) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-usage-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), authorization.slice(7));
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true }), key = `${runtime}:original`;
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
  journal.create({ key, nativeSessionId: 'original-native', title: 'Original', createdAt: 1 });
  store.tokenUsage.record(runtime, key, 'private-provider-event', { inputTokens: 12, outputTokens: 3 }, 'original-model', 10);
  const command = createConnectorOwnerCommands(store, tokens), scope = { runtime, key, authorization };
  let port: Pick<AsyncConnectorOwner, 'command'> = { command };
  const usage = new AsyncSdkUsage({ command: (kind, input) => port.command(kind, input) }, { diagnostics: silence, timeoutMs });
  const app = new Hono(); registerSdkUsageHttp(app, '/sessions/:sessionKey', { usage, timeoutMs });
  app.get('/sessions/:sessionKey/token-usage', c => c.json({ legacy: true }));
  const request = (suffix = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) => app.request(
    `/sessions/${key}/token-usage${suffix}`, { method, headers: { authorization, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
  return { store, tokens, journal, key, scope, command, usage, app, request,
    port(value: Pick<AsyncConnectorOwner, 'command'>) { port = value; },
    async close() { await usage.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: all four usage HTTP endpoints preserve original ledger, immutable selection and errors`, async () => {
    const f = fixture(runtime), selection = { ...range, requestId: randomUUID() };
    try {
      const result = await f.request('?from=0&to=120000&bucketMs=60000'); assert.equal(result.status, 200);
      assert.equal(result.headers.get('cache-control'), 'no-store'); const usage = await result.json();
      assert.deepEqual(usage, f.store.tokenUsage.range(runtime, f.key, range.from, range.to, range.bucketMs));
      assert.equal(usage.buckets[0]!.cacheReadTokens, null);
      const exported = await f.request('/export?from=0&to=120000&bucketMs=60000'); assert.equal(exported.status, 200);
      const data = await exported.json(); assert.equal(data.observations.length, 1);
      assert.equal(JSON.stringify(data).includes('private-provider-event'), false);
      const created = await f.request('/snapshots', 'POST', selection); assert.equal(created.status, 200); const snapshot = await created.json();
      assert.deepEqual(snapshot.data, data);
      f.store.tokenUsage.record(runtime, f.key, 'later-provider-event', { inputTokens: 900, outputTokens: 99 }, undefined, 20);
      assert.deepEqual(await (await f.request('/snapshots', 'POST', selection)).json(), snapshot);
      assert.deepEqual(await (await f.request(`/snapshots/${selection.requestId.toUpperCase()}`)).json(), snapshot);
      assert.equal((await f.request('/snapshots', 'POST', { ...selection, to: 60_000 })).status, 409);
      assert.equal((await f.request(`/snapshots/${randomUUID()}`)).status, 404);
      assert.equal((await f.request('/snapshots/not-an-id')).status, 400);
      assert.equal((await f.request('?from=-1&to=0&bucketMs=60000')).status, 400);
      assert.equal((await f.request('/snapshots', 'POST', { ...selection, allowed: true })).status, 400);
      assert.equal((await f.request('/snapshots', 'POST', { ...selection, extra: 'x'.repeat(1024) })).status, 413);
      assert.equal((await f.request('', 'GET', undefined, { 'x-agentopsdeck-execution-grant': '' })).status, 403);
      assert.equal((await f.request('', 'GET', undefined, { authorization: '' })).status, 401);
      assert.equal((await f.app.request('/sessions/codex:legacy/token-usage')).status, 200);
      assert.equal(validConnectorOwnerInput('sdkUsageRange', { ...f.scope, ...range, sql: 'SELECT 1' }), false);
      assert.equal(validConnectorOwnerInput('sdkUsageRange', { ...f.scope, ...range, from: '0' }), false);
      assert.equal(validConnectorOwnerInput('sdkUsageSnapshotRead', { ...f.scope, requestId: 'bad' }), false);
    } finally { await f.close(); }
  });

  for (const kind of ['sdkUsageRange', 'sdkUsageExport', 'sdkUsageSnapshotCreate', 'sdkUsageSnapshotRead'] as const)
    test(`${runtime}: ${kind} rechecks current authority before response delivery`, async () => {
      const f = fixture(runtime), requestId = randomUUID();
      try {
        await f.command('sdkUsageSnapshotCreate', { ...f.scope, ...range, requestId });
        f.port({ command: (async (current, input) => {
          const result = await f.command(current, input);
          if (current === kind) f.tokens.revoke(f.tokens.authenticateAuthorization(authorization)!.tokenId);
          return result;
        }) as AsyncConnectorOwner['command'] });
        const suffix = kind === 'sdkUsageRange' ? '?from=0&to=120000&bucketMs=60000'
          : kind === 'sdkUsageExport' ? '/export?from=0&to=120000&bucketMs=60000'
            : kind === 'sdkUsageSnapshotRead' ? `/snapshots/${requestId}` : '/snapshots';
        const result = await f.request(suffix, kind === 'sdkUsageSnapshotCreate' ? 'POST' : 'GET', kind === 'sdkUsageSnapshotCreate' ? { ...range, requestId } : undefined);
        assert.equal(result.status, 401); assert.equal((await result.text()).includes('original-model'), false);
      } finally { await f.close(); }
    });

  test(`${runtime}: snapshot capacity wait reauthenticates before write; admission deferral remains retryable by original ID`, async t => {
    const f = fixture(runtime), entered = gate(), release = gate(), requestId = randomUUID();
    const original = f.store.tokenUsage.snapshotAsync.bind(f.store.tokenUsage);
    try {
      const mock = t.mock.method(f.store.tokenUsage, 'snapshotAsync', async (...args: Parameters<typeof original>) => {
        entered.release(); await release.promise; return original(...args);
      });
      const request = f.request('/snapshots', 'POST', { ...range, requestId }); await entered.promise;
      f.tokens.revoke(f.tokens.authenticateAuthorization(authorization)!.tokenId); release.release();
      assert.equal((await request).status, 401); assert.equal(f.store.tokenUsage.readSnapshot(runtime, f.key, requestId), undefined);
      mock.mock.restore();
      const actor = f.tokens.create({ label: 'replacement', scopes: ['messages:read'] });
      const defer = t.mock.method(f.store.tokenUsage, 'snapshotAsync', async () => { throw new StorageAdmissionDeferred(); });
      const headers = { authorization: `Bearer ${actor.token}` };
      assert.equal((await f.request('/snapshots', 'POST', { ...range, requestId }, headers)).status, 503);
      assert.equal(f.store.tokenUsage.readSnapshot(runtime, f.key, requestId), undefined); defer.mock.restore();
      assert.equal((await f.request('/snapshots', 'POST', { ...range, requestId }, headers)).status, 200);
    } finally { release.release(); await f.close(); }
  });

  test(`${runtime}: usage rejects delegated scopes and all deletion states`, async () => {
    const f = fixture(runtime);
    try {
      for (const scopes of [['messages:send'], ['messages:read', 'execution:delegate']] as const) {
        const actor = f.tokens.create({ label: 'limited', scopes: [...scopes] });
        assert.deepEqual(await f.command('sdkUsageRange', { ...f.scope, ...range, authorization: `Bearer ${actor.token}` }), { error: 403 });
      }
      f.journal.beginDeletion(f.key, 'original-delete');
      assert.deepEqual(await f.command('sdkUsageRange', { ...f.scope, ...range }), { error: 404 });
    } finally { await f.close(); }
  });
}

for (const ending of ['cancel', 'timeout', 'close'] as const)
  test(`usage ${ending} retains physical snapshot and drains without resubmitting`, async () => {
    const f = fixture('ghcp', ending === 'timeout' ? 25 : 5_000), entered = gate(), release = gate();
    const controller = new AbortController(), requestId = randomUUID(); let calls = 0, closing: Promise<void> | undefined;
    f.port({ command: (async (kind, input) => {
      if (kind === 'sdkUsageSnapshotCreate') { calls++; entered.release(); await release.promise; }
      return f.command(kind, input);
    }) as AsyncConnectorOwner['command'] });
    try {
      const request = f.request('/snapshots', 'POST', { ...range, requestId }, {}, controller.signal); await entered.promise;
      if (ending === 'cancel') controller.abort();
      if (ending === 'close') closing = f.usage.close();
      assert.equal((await request).status, ending === 'cancel' ? 408 : 503);
      let drained = false; closing ??= f.usage.close(); const done = closing.then(() => { drained = true; });
      await tick(); assert.equal(drained, false); assert.equal(calls, 1);
      release.release(); await done; assert.equal(calls, 1);
      assert.equal(f.store.tokenUsage.readSnapshot('ghcp', f.key, requestId)?.requestId, requestId);
      assert.equal((await f.request('?from=0&to=120000&bucketMs=60000')).status, 503);
    } finally { release.release(); await f.close(); }
  });

test('usage rejects valid but foreign range and snapshot receipt before publication', async () => {
  for (const mutation of ['key', 'range', 'requestId'] as const) {
    const f = fixture('ghcp'), requestId = randomUUID();
    try {
      f.port({ command: (async (kind, input) => {
        if (kind !== 'sdkUsageSnapshotCreate') return f.command(kind, input);
        const result = await f.command('sdkUsageSnapshotCreate', input as import('./connector-sdk-usage-domain.js').ConnectorSdkUsageCommands['sdkUsageSnapshotCreate']['input']);
        if (!('error' in result)) {
          const changed = { ...result, ...(mutation === 'key' ? { key: 'ghcp:foreign' } : {}), body: { ...result.body,
            ...(mutation === 'requestId' ? { requestId: randomUUID() } : {}),
            ...(mutation === 'range' ? { data: { ...result.body.data, usage: { ...result.body.data.usage, to: 180_000 } } } : {}) } };
          assert.equal(validConnectorOwnerOutput(kind, changed), true); return changed;
        }
        return result;
      }) as AsyncConnectorOwner['command'] });
      assert.equal((await f.request('/snapshots', 'POST', { ...range, requestId })).status, 503);
    } finally { await f.close(); }
  }
});

test('usage snapshot uses real sole owner volume admission and immutable receipt across restart', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-usage-worker-'));
  const config = { file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'), bootstrapToken: authorization.slice(7),
    sdkModels: { 'claude-code': { model: 'default' }, ghcp: { model: 'default' } } };
  let owner = new AsyncConnectorOwner(config, silence);
  try {
    await owner.open();
    for (const runtime of ['claude-code', 'ghcp'] as const) {
      const created = await owner.command('sdkSessionCreate', { runtime, authorization, commandKey: `create-${runtime}`, payloadJson: '{}' });
      assert.ok('key' in created && created.key); const scope = { runtime, key: created.key, authorization }, requestId = randomUUID();
      const usage = new AsyncSdkUsage(owner, { diagnostics: silence });
      const first = await usage.createSnapshot({ ...scope, ...range, requestId }, new Request('http://local/usage')); assert.ok(!('error' in first));
      await usage.close(); await owner.close(); owner = new AsyncConnectorOwner(config, silence); await owner.open();
      const resumed = new AsyncSdkUsage(owner, { diagnostics: silence });
      assert.deepEqual(await resumed.readSnapshot({ ...scope, requestId }, new Request('http://local/usage')), first);
      assert.deepEqual(await resumed.createSnapshot({ ...scope, ...range, requestId }, new Request('http://local/usage')), first);
      assert.deepEqual(await resumed.createSnapshot({ ...scope, ...range, to: 60_000, requestId }, new Request('http://local/usage')), { error: 409 });
      await resumed.close();
    }
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
