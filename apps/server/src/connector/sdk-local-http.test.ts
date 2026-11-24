import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncSdkLocal } from './async-sdk-local.js';
import { registerSdkLocalHttp, type SdkLocalHttp } from './sdk-local-http.js';
import { validConnectorSdkLocalOutput } from './connector-sdk-local-domain.js';
import type { SdkAgentId } from './sdk-execution-journal.js';

const token = 'isolated-sdk-local-http-test', authorization = `Bearer ${token}`;
const catalogs = { 'claude-code': { model: 'default', modelChoices: ['default', 'alternate'] }, ghcp: { model: 'default', modelChoices: ['default', 'alternate'] } };
const base = '/api/connector/v1';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(runtime: SdkAgentId) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-local-http-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token);
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
  const key = `${runtime}:original`;
  journal.create({ key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
  const command = createConnectorOwnerCommands(store, tokens, catalogs);
  const local = new AsyncSdkLocal({ command });
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => { lines.push(line); });
  let ready = true, fallbacks = 0;
  const deps: SdkLocalHttp = { local, ready: () => ready, diagnostics };
  const app = new Hono(); registerSdkLocalHttp(app, base, deps);
  app.patch(`${base}/sessions/:sessionKey`, async c => { fallbacks++; return c.json({ legacy: await c.req.json() }); });
  app.post(`${base}/agents/:agentId/sessions`, async c => { fallbacks++; return c.json({ legacy: await c.req.json() }); });
  app.get(`${base}/sessions/:sessionKey/settings-commands/:commandKey`, c => { fallbacks++; return c.json({ legacy: true }); });
  const createPath = `${base}/agents/${runtime}/sessions`, settingsPath = `${base}/sessions/${key}`;
  const post = (operation: 'create' | 'settings', body: unknown, headers: Record<string, string> = {}) => app.request(operation === 'create' ? createPath : settingsPath,
    { method: operation === 'create' ? 'POST' : 'PATCH', headers: { authorization, ...headers }, body: JSON.stringify(body) });
  const get = (operation: 'create' | 'settings', commandKey: string, credential = authorization) => app.request(
    `${operation === 'create' ? createPath : settingsPath}/${operation === 'create' ? 'creation' : 'settings'}-commands/${commandKey}`, { headers: { authorization: credential } });
  const scope = (operation: 'create' | 'settings') => JSON.stringify([operation, JSON.stringify([actor, operation === 'create' ? runtime : key])]);
  return { app, deps, tokens, actor, store, journal, key, command, local, lines, post, get, scope, createPath, settingsPath,
    ready: (value: boolean) => { ready = value; }, fallbacks: () => fallbacks,
    close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  for (const operation of ['create', 'settings'] as const) test(`${runtime} HTTP ${operation}: original wire/fingerprint/receipt and maintenance recovery`, async () => {
    const f = fixture(runtime);
    try {
      const payload = { ...(operation === 'create' ? { label: '  Created  ' } : { model: ' alternate ', thinking: null }),
        metadata: 'private raw fingerprint', idempotencyKey: 'original-key' };
      const first = await f.post(operation, payload);
      assert.equal(first.status, operation === 'create' ? 201 : 200);
      assert.equal(first.headers.get('cache-control'), 'no-store'); assert.equal(first.headers.get('x-agentopsdeck-command-key'), 'original-key');
      const body = await first.json(); assert.equal(body.command.key, 'original-key'); assert.equal(body.command.state, 'accepted');
      assert.equal(body.command.result, undefined);
      if (operation === 'create') { assert.equal(body.agentId, runtime); assert.equal(body.title, 'Created'); }
      else assert.deepEqual(body.settings, { model: 'alternate', modelProvider: null });
      f.ready(false);
      const duplicate = await f.post(operation, payload); assert.equal(duplicate.status, first.status); assert.deepEqual(await duplicate.json(), body);
      assert.equal((await f.post(operation, { ...payload, metadata: 'changed' })).status, 409);
      const denied = await f.post(operation, { ...payload, idempotencyKey: 'maintenance-fresh' });
      assert.equal(denied.status, 409); assert.equal((await denied.json()).command.state, 'rejected');
      f.store.pauseTurnStarts();
      const recovered = await f.get(operation, 'original-key'); assert.equal(recovered.status, 200);
      assert.equal((await recovered.json()).command.id, body.command.id);
      const other = f.tokens.create({ label: 'Other', scopes: ['sessions:create'] });
      assert.equal((await f.get(operation, 'original-key', `Bearer ${other.token}`)).status, 404);
      f.tokens.revoke(f.actor); assert.equal((await f.get(operation, 'original-key')).status, 401);
      assert.equal(f.fallbacks(), 0);
      assert.match(f.lines.join('\n'), /sdk-local-http/);
      assert.doesNotMatch(f.lines.join('\n'), /private raw fingerprint|isolated-sdk-local-http-test|:original/);
    } finally { f.close(); }
  });

  test(`${runtime} HTTP passes title/goal and foreign runtime bodies to the original lane once`, async () => {
    const f = fixture(runtime);
    try {
      for (const body of [{ title: 'Original title', idempotencyKey: 'title' }, { goal: { action: 'pause' } }]) {
        const response = await f.post('settings', body); assert.equal(response.status, 200); assert.deepEqual((await response.json()).legacy, body);
      }
      const body = { title: 'Codex', idempotencyKey: 'foreign' };
      const foreign = await f.app.request(`${base}/agents/codex/sessions`, { method: 'POST', body: JSON.stringify(body) });
      assert.deepEqual((await foreign.json()).legacy, body); assert.equal(f.fallbacks(), 3);
      assert.equal(f.store.commands.get(f.scope('settings'), 'title'), undefined);
      assert.equal(f.journal.sessionKeys(undefined, 64).length, 1);
    } finally { f.close(); }
  });

  test(`${runtime} HTTP recovers original title receipts in the shared settings namespace`, async () => {
    const f = fixture(runtime);
    try {
      await f.store.commands.claimAsync(f.scope('settings'), 'legacy-title', { title: 'Title\nfrom older UI' });
      const receipt = f.store.commands.settle(f.scope('settings'), 'legacy-title', { status: 200,
        body: { sessionKey: f.key, settings: { title: 'Title\nfrom older UI' } } });
      f.ready(false);
      const read = await f.get('settings', 'legacy-title'); assert.equal(read.status, 200); assert.deepEqual((await read.json()).command, receipt);
      assert.equal(validConnectorSdkLocalOutput('sdkModelUpdate', { runtime, key: f.key, receipt }), false);
      assert.equal(f.fallbacks(), 0);
    } finally { f.close(); }
  });

  test(`${runtime} HTTP key/input/grant validation never changes the original local state`, async () => {
    const f = fixture(runtime);
    try {
      for (const [body, headers] of [
        [null, {}], [[], {}], [{ title: 'x', idempotencyKey: 1 }, {}],
        [{ title: 'x', idempotencyKey: 'body' }, { 'idempotency-key': 'header' }],
        [{ title: 'x' }, { 'idempotency-key': '' }],
      ] as const) assert.equal((await f.post('create', body, headers)).status, 400);
      for (const operation of ['create', 'settings'] as const) {
        assert.equal((await f.post(operation, operation === 'create' ? { title: 'x' } : { model: null }, { 'x-agentopsdeck-execution-grant': 'not-an-owner' })).status, 403);
        assert.equal((await f.post(operation, {}, { authorization: '' })).status, 401);
        assert.equal((await f.get(operation, 'invalid%20key')).status, 400);
        const missing = await f.get(operation, 'absent'); assert.equal(missing.status, 404); assert.equal(missing.headers.get('cache-control'), 'no-store');
      }
      const malformed = await f.app.request(f.createPath, { method: 'POST', headers: { authorization }, body: '{' }); assert.equal(malformed.status, 400);
      const oversized = await f.post('create', { title: 'x', metadata: 'x'.repeat(128 * 1024) }); assert.equal(oversized.status, 413);
      const generated = await f.post('create', { title: 'Generated' }); assert.equal(generated.status, 201);
      const body = await generated.json(); assert.equal(generated.headers.get('x-agentopsdeck-command-key'), body.command.key);
      assert.equal((await f.get('create', body.command.key)).status, 200);
      assert.equal(f.journal.sessionKeys(undefined, 64).length, 2);
    } finally { f.close(); }
  });

  test(`${runtime} HTTP rechecks current authority after the original transaction ACK`, async () => {
    const f = fixture(runtime);
    try {
      f.deps.local = new AsyncSdkLocal({ command: async (kind, input) => {
        const result = await f.command(kind, input);
        if (kind === 'sdkSessionCreate') f.tokens.revoke(f.actor);
        return result;
      } });
      const response = await f.post('create', { title: 'Committed privately', idempotencyKey: 'revoked-after-ack' });
      assert.equal(response.status, 401); assert.doesNotMatch(await response.text(), /Committed privately/);
      assert.equal(f.journal.sessionKeys(undefined, 64).length, 2);
      assert.equal(f.store.commands.get(f.scope('create'), 'revoked-after-ack')?.state, 'accepted');
    } finally { f.close(); }
  });
}

test('HTTP late commit resolves by original GET after deadline, without resending or rebuilding owner', async () => {
  const f = fixture('ghcp');
  let release!: () => void, finish!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let writes = 0;
  try {
    f.deps.local = new AsyncSdkLocal({ command: async (kind, input) => {
      if (kind === 'sdkSessionCreate') { writes++; await pending; }
      const result = await f.command(kind, input); if (kind === 'sdkSessionCreate') finish(); return result;
    } });
    const app = new Hono(); registerSdkLocalHttp(app, base, { ...f.deps, timeoutMs: 25 });
    const response = await app.request(f.createPath, { method: 'POST', headers: { authorization }, body: JSON.stringify({ title: 'Late', idempotencyKey: 'late' }) });
    assert.equal(response.status, 503); assert.equal(response.headers.get('x-agentopsdeck-command-key'), 'late');
    assert.equal((await response.json()).status, 'outcome_unknown');
    release(); await finished;
    const recovered = await app.request(`${f.createPath}/creation-commands/late`, { headers: { authorization } });
    assert.equal(recovered.status, 200); assert.equal((await recovered.json()).command.state, 'accepted'); assert.equal(writes, 1);
  } finally { release(); await tick(); f.close(); }
});

test('HTTP bounds concurrent body assemblies across both local operations and releases capacity', async () => {
  const f = fixture('ghcp'), finish: Array<() => void> = [], pending: Array<Promise<Response>> = [];
  try {
    for (const operation of ['create', 'settings'] as const) {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { finish.push(() => {
        controller.enqueue(Buffer.from(JSON.stringify(operation === 'create' ? { title: 'Created' } : { model: null }))); controller.close();
      }); } });
      pending.push(Promise.resolve(f.app.fetch(new Request(`http://localhost${operation === 'create' ? f.createPath : f.settingsPath}`,
        { method: operation === 'create' ? 'POST' : 'PATCH', headers: { authorization }, body: stream, duplex: 'half' } as RequestInit))));
    }
    await tick(); assert.equal((await f.post('create', { title: 'Over capacity' })).status, 503);
    assert.equal((await f.get('create', 'absent')).status, 404);
    finish.forEach(release => release());
    const responses = await Promise.all(pending); assert.deepEqual(responses.map(r => r.status), [201, 200]);
    assert.equal((await f.post('create', { title: 'Capacity restored' })).status, 201);
  } finally { finish.forEach(release => { try { release(); } catch {} }); await Promise.allSettled(pending); f.close(); }
});

for (const runtime of ['claude-code', 'ghcp'] as const) test(`${runtime} real worker HTTP creates, updates and reopens original durable receipts`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-local-http-worker-'));
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: token, sdkModels: catalogs };
  const diagnostics = new PerformanceDiagnostics(() => {});
  let owner = new AsyncConnectorOwner(config, diagnostics);
  try {
    await owner.open();
    const app = new Hono(); registerSdkLocalHttp(app, base, { local: new AsyncSdkLocal({ command: (kind, input) => owner.command(kind, input) }), ready: () => true, diagnostics });
    const createPath = `${base}/agents/${runtime}/sessions`;
    const created = await app.request(createPath, { method: 'POST', headers: { authorization, 'idempotency-key': 'create' }, body: '{"title":"Durable"}' });
    assert.equal(created.status, 201); const body = await created.json();
    const settingsPath = `${base}/sessions/${encodeURIComponent(body.key)}`;
    const update = await app.request(settingsPath, { method: 'PATCH', headers: { authorization, 'idempotency-key': 'model' }, body: '{"model":"alternate"}' });
    assert.equal(update.status, 200);
    await owner.close(); owner = new AsyncConnectorOwner(config, diagnostics); await owner.open();
    for (const path of [`${createPath}/creation-commands/create`, `${settingsPath}/settings-commands/model`]) {
      const response = await app.request(path, { headers: { authorization } }); assert.equal(response.status, 200); assert.equal((await response.json()).command.state, 'accepted');
    }
    const snapshot = await owner.command('sdkSnapshotRead', { runtime, key: body.key });
    assert.equal(snapshot.session?.model, 'alternate'); assert.equal(snapshot.session?.nativeState, 'allocated');
  } finally { await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});
