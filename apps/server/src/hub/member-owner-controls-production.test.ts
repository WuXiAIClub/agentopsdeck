import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import type { CommandReceipt } from '../commands/receipts.js';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { NODE_ID_HEADER, EXPECTED_NODE_HEADER } from '../connector/node-identity.js';
import { registerHubRoutes } from '../routes/hub.js';
import { registerAsyncHubOwnerControls, isAsyncHubOwnerControlRequest } from '../routes/hub-owner-controls-async.js';
import { encodeHubSessionId } from './session-id.js';
import { loadConfig } from '../config.js';
import { pinOriginalRequestScope } from './original-request-scope.js';

const operations = ['message', 'queue', 'create', 'delete', 'settings', 'compact'] as const;
type Operation = typeof operations[number];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(t: TestContext, mode: 'original' | 'worker', parent: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-controls-production-')), file = join(root, 'hub.sqlite');
  const node = `node_${randomUUID()}`, session = encodeHubSessionId('local', 'codex:fixture');
  const seed = new HubStore(file, 'controls-fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = seed.identities.issueKey('default'), member = seed.createUser('Member'), key = seed.identities.issueKey(member.id);
  const cookie = seed.identities.createSession(key.token)!;
  seed.upsertConnection({ id: 'local', ownerUserId: member.id, label: 'Local', connectorUrl: 'http://controls-connector.invalid', credentialToken: 'PRIVATE_TOKEN' });
  seed.pinConnectionNode('local', member.id, seed.connectionAuthority('local', member.id)!, node);
  const scope = seed.identities.recoveryScope({ userId: member.id, admin: false });
  await seed.close();
  const metadata = new HubStore(mode === 'original' ? file : join(root, 'metadata.sqlite'), 'controls-fixture');
  const owner = mode === 'original' ? new OriginalHubAdministrativeCommands(metadata)
    : new AsyncHubMemberOwner({ file, encryptionSecret: 'controls-fixture' });
  const log: string[] = [], diagnostics = new PerformanceDiagnostics(line => { log.push(line); });
  const services = createHubAdministrativeServices(owner, diagnostics);
  const behavior: { effects: string[]; reads: number; sync: number; unknown: boolean;
    transport?: () => Promise<void> } = { effects: [], reads: 0, sync: 0, unknown: false };
  const receipts = new Map<string, CommandReceipt>();
  t.mock.method(globalThis, 'fetch', async (raw: Request | string | URL, init?: RequestInit) => {
      const request = raw instanceof Request ? raw : new Request(raw, init);
      assert.equal(new URL(request.url).origin, 'http://controls-connector.invalid');
      assert.equal(request.headers.get(EXPECTED_NODE_HEADER), node);
      const path = new URL(request.url).pathname;
      const headers = { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: node };
      if (request.method === 'GET') {
        behavior.reads++;
        if (path.endsWith('/queue')) return Response.json({ messages: [] }, { headers });
        if (path.endsWith('/goal')) return Response.json({ revision: '0'.repeat(64), goal: null }, { headers });
        return Response.json({ command: receipts.get(decodeURIComponent(path.split('/').at(-1)!)) }, { headers });
      }
      const operation: Operation = path.endsWith('/messages') ? 'message' : path.includes('/agents/') ? 'create'
        : path.endsWith('/compact') ? 'compact' : path.includes('/queue/') ? 'queue' : request.method === 'DELETE' ? 'delete' : 'settings';
      behavior.effects.push(operation); await behavior.transport?.();
      const body = operation === 'create' ? { key: 'codex:created' } : operation === 'settings'
        ? { sessionKey: 'codex:fixture', settings: { title: 'New' } } : operation === 'compact'
          ? { ok: true, status: 'compacting', runId: randomUUID() } : { ok: true };
      const status = operation === 'create' ? 201 : 200;
      const delivery = request.headers.get('idempotency-key')!;
      const command: CommandReceipt = { id: randomUUID(), key: delivery, state: behavior.unknown ? 'outcome_unknown' : 'accepted',
        createdAt: 1, updatedAt: 2, result: { status, body } };
      receipts.set(delivery, command);
      return Response.json({ ...body, command }, { status, headers });
    });
  const resolver = createAsyncConnectorClientResolver(owner, undefined, diagnostics);
  let guarded = false;
  const store = new Proxy(metadata, { get(target, property, receiver) {
    if (guarded) { behavior.sync++; throw Error('SYNCHRONOUS_CONTROL_BYPASS'); }
    return Reflect.get(target, property, receiver);
  } });
  const app = new Hono();
  const routes = parent ? registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }),
    hubStore: store, administrative: services, asyncConnectorClient: resolver,
    principal: () => { behavior.sync++; throw Error('SYNCHRONOUS_PRINCIPAL_BYPASS'); },
    connectorClient: () => { behavior.sync++; throw Error('SYNCHRONOUS_CONNECTOR_BYPASS'); }, normalizeError: () => 'unavailable',
  }) : registerAsyncHubOwnerControls(app, { mode: 'async', controls: services.createOwnerControlAccess(resolver), diagnostics });
  assert.ok(routes); guarded = true;
  t.after(async () => {
    guarded = false; await routes.close(); await services.close(); await resolver.close(); await owner.close(); await metadata.close();
    assert.equal(behavior.sync, 0);
    for (const secret of [key.token, cookie, 'PRIVATE_TOKEN', 'PRIVATE_EXCEPTION']) assert.equal(log.join('').includes(secret), false);
    rmSync(root, { recursive: true, force: true });
  });
  const headers = { cookie: `agentopsdeck_session=${cookie}`, 'content-type': 'application/json', 'if-match': '"1:1"' };
  const path = (op: Operation) => op === 'create' ? '/api/hub/v1/connections/local/agents/codex/sessions'
    : op === 'delete' || op === 'settings' ? `/api/sessions/${encodeURIComponent(session)}`
      : `/api/hub/v1/sessions/${encodeURIComponent(session)}/${op === 'message' ? 'messages' : op === 'queue' ? 'queue/queued' : 'compact'}`;
  const request = (op: Operation, commandKey = op) => app.request(path(op), {
    method: op === 'delete' ? 'DELETE' : op === 'settings' || op === 'queue' ? 'PATCH' : 'POST',
    headers: { ...headers, 'idempotency-key': commandKey }, ...(op === 'delete' ? {} : {
      body: JSON.stringify(op === 'settings' ? { title: 'New' } : op === 'queue' ? { message: 'text' } : {}) }),
  });
  const poll = (op: Operation) => app.request(op === 'create' ? path(op) + '/creation-commands/create'
    : `/api/hub/v1/sessions/${encodeURIComponent(session)}/${op === 'queue' ? 'queue/queued/commands' : op === 'message' ? 'commands' : `${op === 'delete' ? 'deletion' : op}-commands`}/${op}`,
  { headers });
  const revoke = async () => {
    const evidence = { accessKey: admin.token }, proof = await owner.command('memberSnapshot', evidence); assert.ok(proof);
    assert.deepEqual(await owner.command('memberKeyRevoke', { evidence, expectedScope: proof.recoveryScope,
      userId: member.id, keyId: key.id }), { ok: true });
  };
  return { app, routes, headers, path, request, poll, behavior, revoke, scope, key, session, log };
}

for (const mode of ['original', 'worker'] as const) for (const parent of [false, true]) {
  const label = `${mode}/${parent ? 'parent' : 'no-store'}`;
  test(`${label}: all six effects, duplicates and receipt GETs retain original wire and owner`, async t => {
    const f = await fixture(t, mode, parent);
    for (const op of operations) {
      const first = await f.request(op), body = await first.text();
      assert.equal(first.status, op === 'create' ? 201 : 200, `${op}: ${body}`);
      assert.equal(first.headers.get('x-agentopsdeck-command-key'), op);
      assert.equal(first.headers.get('cache-control'), 'no-store');
      assert.equal((await f.request(op)).status, first.status);
      const polled = await f.poll(op); assert.equal(polled.status, 200, await polled.text());
    }
    assert.deepEqual(f.behavior.effects, [...operations]);
    for (const suffix of ['queue', 'goal']) {
      const response = await f.app.request(`/api/hub/v1/sessions/${encodeURIComponent(f.session)}/${suffix}`, { headers: f.headers });
      assert.equal(response.status, 200, await response.text());
    }
  });
  test(`${label}: unknown effects only observe; original scope and explicit invalid key cannot downgrade to cookie`, async t => {
    const f = await fixture(t, mode, parent); f.behavior.unknown = true;
    for (const op of operations) {
      assert.equal((await f.request(op)).status, 202, op);
      assert.equal((await f.request(op)).status, 202, op);
      assert.equal((await f.poll(op)).status, 200, op);
    }
    assert.deepEqual(f.behavior.effects, [...operations]);
    for (const headers of [{ ...f.headers, 'x-agentopsdeck-recovery-scope': 'wrong' },
      { ...f.headers, 'x-agentopsdeck-key': 'hub_key_invalid-explicit-key' }]) {
      const response = await f.app.request(f.path('message'), { method: 'POST', headers, body: '{}' });
      assert.ok([401, 409].includes(response.status), await response.text());
    }
    const raw = new Request('http://fixture.invalid' + f.path('message'), { method: 'POST', headers: f.headers, body: '{}' });
    pinOriginalRequestScope(raw, 'wrong');
    assert.equal((await f.app.fetch(raw)).status, 401);
    assert.deepEqual(f.behavior.effects, [...operations]);
  });
}

test('worker/no-store: close owns ignored-abort transport past HTTP deadline; late result never dispatches another effect', async t => {
  const f = await fixture(t, 'worker', false), entered = deferred(), release = deferred();
  f.behavior.transport = async () => { entered.resolve(); await release.promise; };
  const sending = f.request('message'); await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 10050));
  let done = false; const closing = f.routes.close().then(() => { done = true; });
  await tick(); assert.equal(done, false);
  assert.equal((await f.request('compact')).status, 503);
  release.resolve(); assert.equal((await sending).status, 503); await closing;
  assert.deepEqual(f.behavior.effects, ['message']);
});

for (const action of ['close', 'revoke'] as const) test(`worker/parent: ${action} while body is pending never dispatches`, async t => {
  const f = await fixture(t, 'worker', true), entered = deferred(), release = deferred();
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    entered.resolve(); await release.promise; controller.enqueue(new TextEncoder().encode('{}')); controller.close();
  } }, { highWaterMark: 0 });
  const raw = new Request('http://fixture.invalid' + f.path('message'), {
    method: 'POST', headers: f.headers, body, duplex: 'half',
  } as RequestInit);
  const sending = f.app.fetch(raw); await entered.promise;
  // Zero prefetch: pull begins only after original identity/target opens.
  let closed = false;
  const closing = action === 'close' ? f.routes.close().then(() => { closed = true; }) : f.revoke();
  if (action === 'revoke') await closing;
  else { await tick(); assert.equal(closed, false); }
  release.resolve(); const response = await sending;
  assert.ok([401, 403, 503].includes(response.status), await response.text());
  await closing; assert.deepEqual(f.behavior.effects, []);
});

test('exact control request inventory refuses aliases, unrelated routes and missing required ports', () => {
  const id = encodeURIComponent(encodeHubSessionId('local', 'codex:fixture'));
  for (const [method, path] of [['PATCH', `/api/sessions/${id}`], ['HEAD', `/api/hub/v1/sessions/${id}/commands/key`],
    ['POST', '/api/hub/v1/connections/local/agents/codex/sessions']]) assert.equal(isAsyncHubOwnerControlRequest(method!, path!), true);
  for (const [method, path] of [['PATCH', '/api/sessions/native'], ['POST', '/api/hub/v1/sessions/state'],
    ['GET', `/api/hub/v1/sessions/${id}/history`], ['POST', `/api/hub/v1/sessions/${id}/queue`]])
    assert.equal(isAsyncHubOwnerControlRequest(method!, path!), false);
  assert.throws(() => registerAsyncHubOwnerControls(new Hono(), { mode: 'async', controls: {} as never }), /ports_required/);
});
