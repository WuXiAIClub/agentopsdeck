import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { AsyncCodexPublicUsage } from './async-codex-public-usage.js';
import { registerCodexPublicUsageHttp } from './codex-public-usage-http.js';

const key = 'codex:original', range = { from: 0, to: 120_000, bucketMs: 60_000 };
const silence = new PerformanceDiagnostics(() => {}), tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; return { promise: new Promise<void>(ok => { release = ok; }), release: () => release() }; }
async function fixture(t: TestContext, timeoutMs = 5_000) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-public-usage-'));
  const config = { file: join(directory, 'original.sqlite'), tokenFile: join(directory, 'tokens.json') };
  const tokens = new ConnectorTokenStore(config.tokenFile);
  const reader = tokens.create({ label: 'reader', scopes: ['messages:read'] });
  const sender = tokens.create({ label: 'sender', scopes: ['messages:send'] });
  const delegate = tokens.create({ label: 'delegate', scopes: ['messages:read', 'execution:delegate'] });
  const store = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  try { store.tokenUsage.record('codex', key, 'private-provider-event', { inputTokens: 12, outputTokens: 3 }, 'original-model', 10); }
  finally { store.close(); }
  let owner = new AsyncConnectorOwner(config, silence); await owner.open();
  let command: AsyncConnectorOwner['command'] = (kind, input) => owner.command(kind, input);
  let exists = true, local = true;
  const usage = new AsyncCodexPublicUsage({ owner: { command: (kind, input) => command(kind, input) }, diagnostics: silence, timeoutMs,
    local() { if (!local) throw Error('local unavailable'); }, sessionExists: session => exists && session === key });
  const app = new Hono(); registerCodexPublicUsageHttp(app, '/sessions/:sessionKey', { usage, timeoutMs });
  app.get('/sessions/:sessionKey/token-usage', c => c.json({ legacy: true }));
  const authorization = `Bearer ${reader.token}`, scope = { runtime: 'codex' as const, key, authorization };
  const request = (suffix = '?from=0&to=120000&bucketMs=60000', method = 'GET', body?: unknown,
    headers: Record<string, string> = {}, signal?: AbortSignal) => app.request(`/sessions/${key}/token-usage${suffix}`, {
      method, headers: { authorization, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
  t.after(async () => { try { await usage.close(); await owner.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  return { usage, request, scope, tokens, reader, sender, delegate, app, get owner() { return owner; },
    port(value: AsyncConnectorOwner['command']) { command = value; }, exists(value: boolean) { exists = value; }, local(value: boolean) { local = value; },
    async restart() { await owner.close(); owner = new AsyncConnectorOwner(config, silence); await owner.open(); } };
}

test('public usage DTOs reject caller authority, SQL, runtime and selection substitution', () => {
  const input = { runtime: 'codex', key, authorization: 'Bearer original', ...range, requestId: randomUUID() };
  assert.equal(validConnectorOwnerInput('codexPublicUsageSnapshotCreate', input), true);
  for (const extra of [{ actor: 'forged' }, { sql: 'SELECT 1' }, { nativeSessionId: 'foreign' }, { runtime: 'ghcp' },
    { key: 'claude-code:original' }, { from: '0' }, { requestId: 'bad' }, { authorization: 'Bearer\nsecret' }])
    assert.equal(validConnectorOwnerInput('codexPublicUsageSnapshotCreate', { ...input, ...extra }), false);
  assert.equal(validConnectorOwnerOutput('codexPublicUsageDeliver', { runtime: 'codex', key, readerId: 'reader', body: {} }), false);
});

test('real sole worker serves all four public usage endpoints and persists immutable snapshots across reopen', async t => {
  const f = await fixture(t), selection = { ...range, requestId: randomUUID() };
  const read = await f.request(); assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
  const usage = await read.json(); assert.equal(usage.runtime, 'codex'); assert.equal(usage.buckets[0].inputTokens, 12);
  const exported = await f.request('/export?from=0&to=120000&bucketMs=60000'); assert.equal(exported.status, 200);
  const data = await exported.json(); assert.equal(data.observations.length, 1); assert.equal(JSON.stringify(data).includes('private-provider-event'), false);
  const created = await f.request('/snapshots', 'POST', selection); assert.equal(created.status, 200);
  const snapshot = await created.json(); assert.deepEqual(snapshot.data, data);
  assert.deepEqual(await (await f.request('/snapshots', 'POST', selection)).json(), snapshot);
  assert.deepEqual(await (await f.request(`/snapshots/${selection.requestId.toUpperCase()}`)).json(), snapshot);
  assert.equal((await f.request('/snapshots', 'POST', { ...selection, to: 60_000 })).status, 409);
  assert.equal((await f.request(`/snapshots/${randomUUID()}`)).status, 404);
  await f.restart();
  assert.deepEqual(await (await f.request(`/snapshots/${selection.requestId}`)).json(), snapshot);
  assert.deepEqual(await (await f.request('/snapshots', 'POST', selection)).json(), snapshot);
});

test('public usage HTTP preserves owner authority, validation, Deck and runtime boundaries', async t => {
  const f = await fixture(t), selection = { ...range, requestId: randomUUID() };
  assert.equal((await f.request('', 'GET', undefined, { authorization: '' })).status, 401);
  for (const token of [f.sender.token, f.delegate.token])
    assert.equal((await f.request(undefined, 'GET', undefined, { authorization: `Bearer ${token}` })).status, 403);
  assert.equal((await f.request(undefined, 'GET', undefined, { 'x-agentopsdeck-execution-grant': 'forbidden' })).status, 403);
  assert.equal((await f.request('?from=-1&to=0&bucketMs=60000')).status, 400);
  assert.equal((await f.request('/snapshots/not-an-id')).status, 400);
  assert.equal((await f.request('/snapshots', 'POST', { ...selection, actor: 'forged' })).status, 400);
  assert.deepEqual(await (await f.app.request('/sessions/ghcp:other/token-usage')).json(), { legacy: true });
  f.exists(false); assert.equal((await f.request()).status, 404);
  f.exists(true); f.local(false); assert.equal((await f.request()).status, 503);
});

for (const mutation of ['key', 'range', 'requestId', 'readerId'] as const)
  test(`public usage refuses valid but substituted ${mutation} before publication`, async t => {
    const f = await fixture(t), selection = { ...range, requestId: randomUUID() };
    f.port((async (kind, input) => {
      const result = await f.owner.command(kind, input);
      if (kind !== 'codexPublicUsageSnapshotCreate') return result;
      const snapshot = result as Awaited<ReturnType<typeof f.usage.createSnapshot>>;
      assert.ok(!('error' in snapshot));
      return { ...snapshot, ...(mutation === 'key' ? { key: 'codex:foreign' } : {}), ...(mutation === 'readerId' ? { readerId: 'foreign' } : {}),
        body: { ...snapshot.body, ...(mutation === 'requestId' ? { requestId: randomUUID() } : {}),
          ...(mutation === 'range' ? { data: { ...snapshot.body.data, usage: { ...snapshot.body.data.usage, to: 180_000 } } } : {}) } };
    }) as AsyncConnectorOwner['command']);
    assert.equal((await f.request('/snapshots', 'POST', selection)).status, mutation === 'readerId' ? 409 : 503);
  });

for (const boundary of ['revoke', 'deck', 'delete'] as const)
  test(`public usage independently fences ${boundary} between read and delivery`, async t => {
    const f = await fixture(t);
    f.port((async (kind, input) => {
      const result = await f.owner.command(kind, input);
      if (kind === 'codexPublicUsageRange') {
        if (boundary === 'revoke') f.tokens.revoke(f.reader.record.id);
        else if (boundary === 'deck') f.exists(false);
        else {
          const credential = f.tokens.create({ label: 'deleter', scopes: ['sessions:create'] });
          // A fresh owner observes this credential file; the old one correctly retires.
          await f.restart();
          const claimed = await f.owner.command('codexDeletionClaim', { key, authorization: `Bearer ${credential.token}`, commandKey: 'delete' });
          assert.ok(!('error' in claimed));
        }
      }
      return result;
    }) as AsyncConnectorOwner['command']);
    assert.equal((await f.request()).status, boundary === 'revoke' ? 401 : 404);
  });

for (const ending of ['timeout', 'abort', 'close'] as const)
  test(`snapshot ${ending} ends waiting but drains the one original commit and recovers original requestId`, async t => {
    const f = await fixture(t, ending === 'timeout' ? 30 : 5_000), entered = gate(), release = gate();
    const selection = { ...range, requestId: randomUUID() }, controller = new AbortController();
    let count = 0, closing: Promise<void> | undefined;
    f.port((async (kind, input) => {
      if (kind === 'codexPublicUsageSnapshotCreate') { count++; entered.release(); await release.promise; }
      return f.owner.command(kind, input);
    }) as AsyncConnectorOwner['command']);
    try {
      const pending = f.request('/snapshots', 'POST', selection, {}, controller.signal); await entered.promise;
      if (ending === 'abort') controller.abort();
      if (ending === 'close') closing = f.usage.close();
      assert.equal((await pending).status, ending === 'abort' ? 408 : 503);
      let drained = false; closing ??= f.usage.close(); const drain = closing.then(() => { drained = true; });
      await tick(); assert.equal(drained, false); assert.equal(count, 1);
      release.release(); await drain;
      assert.equal(count, 1); assert.equal((await f.request()).status, 503);
      const recovered = await f.owner.command('codexPublicUsageSnapshotRead', { ...f.scope, requestId: selection.requestId });
      assert.ok(!('error' in recovered)); assert.equal(recovered.body.requestId, selection.requestId);
    } finally { release.release(); }
  });

test('snapshot transaction rechecks current owner authority before original write', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codex-public-usage-guard-'));
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'));
  const reader = tokens.create({ label: 'reader', scopes: ['messages:read'] });
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const command = createConnectorOwnerCommands(store, tokens), original = store.tokenUsage.snapshotAsync.bind(store.tokenUsage), requestId = randomUUID();
  t.mock.method(store.tokenUsage, 'snapshotAsync', async (...args: Parameters<typeof original>) => { tokens.revoke(reader.record.id); return original(...args); });
  assert.deepEqual(await command('codexPublicUsageSnapshotCreate', { runtime: 'codex', key, authorization: `Bearer ${reader.token}`, ...range, requestId }), { error: 401 });
  assert.equal(store.tokenUsage.readSnapshot('codex', key, requestId), undefined);
});
