import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { hubMemberEvidence, type HubMemberKind } from './member-owner-domain.js';
import { WorkspaceRemote } from './workspace-remote.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubRemoteRoutes } from '../routes/hub-workspace-remote.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';

const base = '/api/hub/v1/workspace/remote/devices';
const snapshot = { name: 'PRIVATE_DEVICE', targets: [{ id: 's', title: 'PRIVATE_SESSION', kind: 'session' }], active: 's' };
const input = () => ({ id: randomUUID(), sequence: 1, revision: 1, target: 's', action: 'send', text: 'PRIVATE_INPUT' });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve };
}
async function fixture(t: TestContext, mode: 'original' | 'worker', throwingSink = false) {
  const root = mkdtempSync(join(tmpdir(), 'remote-async-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const key = seed.identities.issueKey('default'), observer = seed.identities.issueKey('default');
  const other = seed.createUser('Other'), otherKey = seed.identities.issueKey(other.id); await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); if (throwingSink) throw Error('sink failed'); });
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics)
    : new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, diagnostics);
  const behavior: { after?: (kind: HubMemberKind, value: unknown) => void | Promise<void>; audits: number } = { audits: 0 };
  const port = { command: async (kind: HubMemberKind, value: never) => {
    const result = await owner.command(kind, value);
    if (kind === 'auditAppend') behavior.audits++;
    await behavior.after?.(kind, result); return result;
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const group = createHubAdministrativeServices({ ...port, weixinBackground: () => owner.weixinBackground(),
    weixinBindingEffect: () => owner.weixinBindingEffect(), connectionControlSettlement: () => owner.connectionControlSettlement() }, diagnostics), access = group.createWorkspaceRemoteAccess();
  const mailbox = new WorkspaceRemote(Date.now, 60_000, 1000), app = new Hono();
  const routes = registerHubRemoteRoutes(app, { mode: 'async', access, service: mailbox, diagnostics });
  const request = (path = '', method = 'GET', body?: unknown, token = key.token, host = '') => new Request('http://hub.invalid' + base + path,
    { method, headers: { 'x-agentopsdeck-key': token, 'X-Workspace-Host': host }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const create = async () => {
    const response = await app.fetch(request('', 'POST', snapshot)); assert.equal(response.status, 200);
    return await response.json() as { device: { id: string }; hostToken: string };
  };
  const revoke = async () => {
    const evidence = hubMemberEvidence(request('', 'GET', undefined, observer.token));
    const current = await owner.command('memberSnapshot', evidence); assert.ok(current);
    assert.deepEqual(await owner.command('memberKeyRevoke', { evidence, expectedScope: current.recoveryScope, userId: 'default', keyId: key.id }), { ok: true });
  };
  t.after(async () => {
    await routes.close(); await group.close(); await owner.close(); await original?.close();
    for (const secret of [key.token, observer.token, otherKey.token, snapshot.name, snapshot.targets[0]!.title, 'PRIVATE_INPUT'])
      assert.equal(logs.join('').includes(secret), false);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file, original, owner, group, access, app, mailbox, routes, request, create, revoke, key, observer, otherKey, behavior, logs, diagnostics };
}

async function exchange(t: TestContext, app: Hono, request: (path: string, method?: string, body?: unknown, token?: string, host?: string) => Request,
  host: { device: { id: string }; hostToken: string }) {
  const entered = deferred<void>(), original = WorkspaceRemote.prototype.poll;
  t.mock.method(WorkspaceRemote.prototype, 'poll', function(this: WorkspaceRemote, ...args: Parameters<WorkspaceRemote['poll']>) {
    const result = original.apply(this, args); entered.resolve(); return result;
  });
  const receiving = Promise.resolve(app.fetch(request(`/${host.device.id}/receive`, 'GET', undefined, undefined, host.hostToken)));
  const command = input();
  await entered.promise;
  const sending = Promise.resolve(app.fetch(request(`/${host.device.id}/commands`, 'POST', command)));
  const received = await receiving; assert.equal(received.status, 200);
  const delivery = await received.json(); assert.equal(delivery.command.id, command.id); assert.equal(delivery.command.text, command.text);
  const ack = await app.fetch(request(`/${host.device.id}/ack`, 'POST', { id: command.id, result: 'applied' }, undefined, host.hostToken));
  assert.equal(ack.status, 200); assert.deepEqual(await (await sending).json(), { result: 'applied' });
  assert.deepEqual(await (await app.fetch(request(`/${host.device.id}/commands`, 'POST', command))).json(), { result: 'applied' });
  assert.equal((await app.fetch(request(`/${host.device.id}/commands`, 'POST', { ...command, text: 'different' }))).status, 409);
  return command;
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode} remote malformed body after revocation cannot deliver stale validation result`, async t => {
    const f = await fixture(t, mode);
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      await f.revoke(); controller.enqueue(new TextEncoder().encode('{')); controller.close();
    } }, { highWaterMark: 0 });
    const request = new Request('http://hub.invalid' + base, { method: 'POST',
      headers: { 'x-agentopsdeck-key': f.key.token }, body, duplex: 'half' } as RequestInit);
    assert.equal((await f.app.fetch(request)).status, 401);
    assert.equal(f.behavior.audits, 0);
    assert.deepEqual(f.mailbox.list('default'), []);
  });
  test(`${mode} remote seven HTTP entries use awaited original identity/audit with no sync fallback`, async t => {
    const f = await fixture(t, mode), host = await f.create();
    assert.deepEqual(await (await f.app.fetch(f.request('', 'GET', undefined, f.otherKey.token))).json(), { devices: [] });
    assert.equal((await f.app.fetch(f.request('/' + host.device.id, 'PUT', snapshot, f.otherKey.token, host.hostToken))).status, 404);
    assert.equal((await f.app.fetch(f.request('/' + host.device.id, 'PUT', snapshot, undefined, host.hostToken))).status, 200);
    assert.equal((await f.app.fetch(f.request('', 'HEAD'))).status, 200);
    await exchange(t, f.app, f.request, host);
    assert.equal((await f.app.fetch(f.request('/' + host.device.id, 'DELETE'))).status, 200);
    assert.equal(f.behavior.audits, 4); // enable, command, same-receipt lookup, disable
    assert.equal((await f.app.fetch(f.request('/' + host.device.id + '/ack', 'POST', { id: randomUUID(), result: 'applied' }, undefined, host.hostToken))).status, 404);
  });

  test(`${mode} remote cookie and original request evidence stay pinned; body-time revoke denies mutation`, async t => {
    const f = await fixture(t, mode);
    const session = await f.owner.command('memberSessionCreate', { key: f.key.token }); assert.ok(session);
    const cookie = new Request('http://hub.invalid' + base, { headers: { cookie: 'agentopsdeck_session=' + session.token } });
    assert.equal((await f.app.fetch(cookie)).status, 200);
    const reading = deferred<void>();
    f.behavior.after = kind => { if (kind === 'memberSnapshot') reading.resolve(); };
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
      await reading.promise; await f.revoke(); controller.enqueue(new TextEncoder().encode(JSON.stringify(snapshot))); controller.close();
    } });
    const response = await f.app.fetch(new Request('http://hub.invalid' + base, { method: 'POST', headers: { 'x-agentopsdeck-key': f.key.token },
      body: stream, duplex: 'half' } as RequestInit));
    assert.equal(response.status, 401); assert.deepEqual(f.mailbox.list('default'), []); assert.equal(f.behavior.audits, 0);
  });

  test(`${mode} remote revoked sender settles original input UNKNOWN; observer recovery cannot redeliver it`, async t => {
    const f = await fixture(t, mode), host = await f.create(), entered = deferred<void>();
    const original = f.mailbox.poll.bind(f.mailbox); let deliveries = 0;
    t.mock.method(f.mailbox, 'poll', (...args: Parameters<WorkspaceRemote['poll']>) => {
      deliveries++; const result = original(...args); entered.resolve(); return result;
    });
    const receive = Promise.resolve(f.app.fetch(f.request('/' + host.device.id + '/receive', 'GET', undefined, undefined, host.hostToken)));
    await entered.promise;
    const command = input(), send = Promise.resolve(f.app.fetch(f.request('/' + host.device.id + '/commands', 'POST', command)));
    assert.equal((await receive).status, 200); await f.revoke();
    assert.equal((await send).status, 401);
    const recovered = await f.app.fetch(f.request('/' + host.device.id + '/commands', 'POST', command, f.observer.token));
    assert.equal(recovered.status, 200); assert.deepEqual(await recovered.json(), { result: 'unknown' });
    assert.equal(deliveries, 1);
    assert.equal((await f.app.fetch(f.request('/' + host.device.id + '/ack', 'POST', { id: command.id, result: 'applied' }, f.observer.token, host.hostToken))).status, 409);
  });

  test(`${mode} remote late audit ACK drains independently of administrative group; no automatic recreation`, async t => {
    const f = await fixture(t, mode), entered = deferred<void>(), release = deferred<void>();
    f.behavior.after = async kind => { if (kind === 'auditAppend') { entered.resolve(); await release.promise; } };
    const creating = Promise.resolve(f.app.fetch(f.request('', 'POST', snapshot)));
    try {
      await entered.promise; await f.group.close(); assert.equal(f.mailbox.list('default').length, 1);
      let drained = false; const close = f.routes.close().then(() => { drained = true; });
      await tick(); assert.equal(drained, false); assert.equal(f.behavior.audits, 1);
      assert.equal((await f.app.fetch(f.request())).status, 503);
      release.resolve(); assert.equal((await creating).status, 503); await close;
      assert.equal(drained, true); assert.equal(f.behavior.audits, 1); assert.deepEqual(f.mailbox.list('default'), []);
    } finally { release.resolve(); await creating; }
  });

  test(`${mode} remote unknown audit ACK is not retried, and diagnostic failure never grants permission`, async t => {
    const f = await fixture(t, mode, true);
    f.behavior.after = kind => { if (kind === 'auditAppend') throw Error('lost original ACK'); };
    const response = await f.app.fetch(f.request('', 'POST', snapshot)); assert.equal(response.status, 503);
    assert.equal(f.behavior.audits, 1); assert.equal(f.mailbox.list('default').length, 1);
    delete f.behavior.after;
    await f.revoke(); assert.equal((await f.app.fetch(f.request())).status, 401);
    assert.equal(f.behavior.audits, 1);
  });
}

test('production Hub remote middleware/factory cover seven entries and reject capability keys first', async t => {
  const f = await fixture(t, 'original'), config = loadConfig({ HOME: f.root, AOD_SERVER_ROLE: 'hub' });
  let guarded = false, principals = 0;
  const store = new Proxy(f.original!, { get(target, key, receiver) {
    if (guarded) throw Error('SYNC_PRODUCTION_STORE_FALLBACK'); return Reflect.get(target, key, receiver);
  } });
  const app = new Hono(), routes = registerHubRoutes(app, { config, hubStore: store, administrative: f.group,
    principal: () => { principals++; return undefined; }, connectorClient: () => { throw Error('UNEXPECTED_CONNECTOR_EFFECT'); }, normalizeError: () => 'safe' });
  try {
    guarded = true;
    for (const token of ['aod_board_synthetic', 'aod_note_synthetic']) assert.equal((await app.fetch(f.request('', 'GET', undefined, token))).status, 401);
    const response = await app.fetch(f.request('', 'POST', snapshot)); assert.equal(response.status, 200);
    const host = await response.json() as { device: { id: string }; hostToken: string };
    assert.equal((await app.fetch(f.request())).status, 200); assert.equal((await app.fetch(f.request('', 'HEAD'))).status, 200);
    assert.equal((await app.fetch(f.request('/' + host.device.id, 'PUT', snapshot, undefined, host.hostToken))).status, 200);
    await exchange(t, app, f.request, host);
    assert.equal((await app.fetch(f.request('/' + host.device.id, 'DELETE'))).status, 200);
    assert.equal(principals, 0);
    assert.equal((await app.fetch(f.request('', 'PATCH'))).status, 401); assert.equal(principals, 1);
  } finally { guarded = false; await routes?.close(); }
});
