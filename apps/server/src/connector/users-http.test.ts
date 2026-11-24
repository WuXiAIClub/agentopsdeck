import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorUsersRequests, ConnectorUsersRequestError, synchronousConnectorUsersRequests, type ConnectorUsersRequestPort } from './async-users-request.js';
import { registerConnectorUsersHttp } from './users-http.js';
const silence = new PerformanceDiagnostics(() => {});
async function fixture(t: TestContext, async: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'connector-users-http-'));
  let cleanup: (() => void | Promise<void>) | undefined;
  t.after(async () => { try { await cleanup?.(); } finally { rmSync(root, { recursive: true, force: true }); } });
  const config = { file: join(root, 'users.sqlite'), tokenFile: join(root, 'tokens.json') };
  let port: ConnectorUsersRequestPort, authorization: string, revoke: () => Promise<unknown>, list: () => Promise<unknown>;
  if (async) {
    const owner = new AsyncConnectorOwner(config, silence); cleanup = () => owner.closeForShutdown(); await owner.open();
    const token = await owner.command('tokenCreate', { label: 'writer' }); authorization = `Bearer ${token.token}`;
    port = new AsyncConnectorUsersRequests(owner); revoke = () => owner.command('tokenRevoke', { tokenId: token.record.id }); list = () => owner.command('usersList', {});
  } else {
    const users = new ConnectorUserStore(config.file), tokens = new ConnectorTokenStore(config.tokenFile); cleanup = () => users.close();
    const token = tokens.create({ label: 'writer' }); authorization = `Bearer ${token.token}`;
    port = synchronousConnectorUsersRequests(users, tokens); revoke = async () => tokens.revoke(token.record.id); list = async () => users.listUsers();
  }
  const app = new Hono(); registerConnectorUsersHttp(app, '/connector', port);
  const json = (path: string, method: string, body?: unknown) => app.request('/connector' + path, {
    method, headers: { authorization, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { app, port, json, authorization, revoke, list };
}
for (const async of [false, true]) {
  test(`${async ? 'async' : 'legacy'} users HTTP preserves current frontend response shapes/statuses`, async t => {
    const { json } = await fixture(t, async);
    const before = await json('/users', 'GET'); assert.equal(before.status, 200); assert.equal(typeof (await before.json()).updatedAt, 'number');
    const created = await json('/users', 'POST', { label: 'created' }); assert.equal(created.status, 201);
    const body = await created.json(); assert.deepEqual(Object.keys(body).sort(), ['updatedAt', 'user']);
    const update = await json('/users/' + body.user.id, 'PATCH', { label: 'renamed' }); assert.equal(update.status, 200);
    assert.equal((await update.json()).user.id, body.user.id);
    const missing = await json('/users/missing', 'PATCH', { label: 'rename' }); assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'connector user not found' });
    const invalid = await json('/users', 'POST', { label: ' ' }); assert.equal(invalid.status, 400);
  });
  test(`${async ? 'async' : 'legacy'} users HTTP rechecks revocation after preflight and body await`, async t => {
    const { port, authorization, revoke, list } = await fixture(t, async);
    const before = await list(); const app = new Hono();
    registerConnectorUsersHttp(app, '/connector', { ...port,
      authorize: async (request, scope) => { const result = await port.authorize(request, scope); await revoke(); return result; },
      list: r => port.list(r), create: (r, label) => port.create(r, label), update: (r, id, label) => port.update(r, id, label),
    });
    const response = await app.request('/connector/users', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'must not create' }) });
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'missing users:write scope' }); assert.deepEqual(await list(), before);
  });
  test(`${async ? 'async' : 'legacy'} unauthenticated malformed JSON stays forbidden without leaking validation`, async t => {
    const { app } = await fixture(t, async);
    const response = await app.request('/connector/users', { method: 'POST', body: '{' });
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'missing users:write scope' });
  });
  test(`${async ? 'async' : 'legacy'} malformed labels fail validation without SQL`, async t => {
    const { json, list } = await fixture(t, async); const before = await list();
    for (const body of [null, [], { label: 42 }, { label: '' }, { label: ' \t\n ' }]) assert.equal((await json('/users', 'POST', body)).status, 400);
    assert.deepEqual(await list(), before);
  });
  test(`${async ? 'async' : 'legacy'} historical label normalization and SQL readback match the original store`, async t => {
    const { json } = await fixture(t, async);
    const original = new ConnectorUserStore(':memory:'); t.after(() => original.close());
    for (const label of ['  a\t b\n c  ', '中'.repeat(6000), 'legacy\0label', '\0']) {
      const reference = original.createUser(label);
      const response = await json('/users', 'POST', { label }); assert.equal(response.status, 201);
      const { user } = await response.json(); assert.equal(user.label, reference.label);
      const update = await json('/users/' + user.id, 'PATCH', { label: '  ' + label + '  ' });
      assert.equal(update.status, 200); assert.equal((await update.json()).user.label, original.updateUser(reference.id, '  ' + label + '  ')!.label);
      assert.equal((await (await json('/users', 'GET')).json()).users.find((u: { id: string }) => u.id === user.id).label, original.getUser(reference.id)!.label);
    }
  });
}
test('unknown owner response stays 503 without exposing private errors or replaying writes', async () => {
  let writes = 0; const app = new Hono();
  registerConnectorUsersHttp(app, '/connector', {
    authorize: () => true, list: () => { throw Error('/private/db.sqlite secret raw SQL'); },
    create: () => { writes++; throw Error('/private/db.sqlite secret raw SQL'); }, update: () => { throw Error('private'); },
  });
  const response = await app.request('/connector/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'valid' }) });
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'connector_storage_unavailable' }); assert.equal(writes, 1);
  assert.equal((await app.request('/connector/users')).status, 503); assert.equal(writes, 1);
});
test('aborted requests never admit a user mutation', async t => {
  const { port, authorization, list } = await fixture(t, true); const before = await list(); const controller = new AbortController(); controller.abort();
  const request = new Request('http://fixture.invalid', { headers: { authorization }, signal: controller.signal });
  await assert.rejects(async () => port.create(request, 'not admitted'), /connector_storage_unavailable/);
  assert.deepEqual(await list(), before);
});

function inertPort(): ConnectorUsersRequestPort {
  return { authorize: () => false, list: () => ({ authorized: false }),
    create: () => ({ authorized: false }), update: () => ({ authorized: false }) };
}
test('HTTP wait observation cannot settle, cancel or replay the original mutation', async () => {
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  let release!: () => void, writes = 0, finished = false;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const app = new Hono(); registerConnectorUsersHttp(app, '/connector', {
    ...inertPort(), authorize: () => true,
    create: async () => { writes++; await wait; return { authorized: false }; },
  }, diagnostics, 1);
  const request = Promise.resolve(app.request('/connector/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer private-http-credential' }, body: JSON.stringify({ label: 'private-http-label' }) }));
  void request.then(() => { finished = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(finished, false); assert.equal(writes, 1);
    const pending = lines.map(line => JSON.parse(line));
    assert.ok(pending.some(e => e.operation === 'connector-users-http' && e.step === 2 && e.phase === 'pending'));
    assert.equal(pending.some(e => e.settled === 1), false);
  } finally { release(); }
  assert.equal((await request).status, 403); assert.equal(writes, 1);
  const final = lines.map(line => JSON.parse(line)).find(e => e.phase === 'finished');
  assert.equal(final.settled, 1); assert.equal(final.deferred, 1); assert.equal(final.commitMs, undefined);
  assert.doesNotMatch(lines.join(''), /private-http-credential|private-http-label|authorization/);
});
test('cancelled admission uses 499; HTTP error logs survive routine saturation without exception disclosure', async () => {
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line), () => 1);
  for (let i = 0; i < 100; i++) diagnostics.start('system-operation').finish();
  const app = new Hono(); registerConnectorUsersHttp(app, '/connector', {
    ...inertPort(), list: () => { throw new ConnectorUsersRequestError(499); },
    authorize: () => true, create: () => { throw Error('private-exception-path-and-query'); },
  }, diagnostics);
  assert.equal((await app.request('/connector/users')).status, 499);
  const response = await app.request('/connector/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"label":"private-log-label"}' });
  assert.equal(response.status, 503);
  const events = lines.map(line => JSON.parse(line)).filter(e => e.operation === 'connector-users-http');
  assert.equal(events.length, 2); assert.equal(events[0].deferred, 1); assert.equal(events[0].unknown, undefined);
  assert.equal(events[1].unknown, 1); assert.equal(events[1].settled, 1);
  assert.doesNotMatch(lines.join(''), /private-exception|private-log-label|query/);
});
for (const broken of ['start', 'add', 'reportPending', 'finish'] as const)
  test(`HTTP diagnostics ${broken} failure cannot change original response or replay a mutation`, async () => {
    class BrokenDiagnostics extends PerformanceDiagnostics {
      override start(operation: Parameters<PerformanceDiagnostics['start']>[0]) {
        if (broken === 'start') throw Error('private-diagnostic-fault');
        const trace = super.start(operation);
        trace[broken] = () => { throw Error('private-diagnostic-fault'); }; return trace;
      }
    }
    let writes = 0; const app = new Hono();
    registerConnectorUsersHttp(app, '/connector', { ...inertPort(), authorize: () => true,
      create: async () => { writes++; await new Promise(resolve => setTimeout(resolve, 10)); return { authorized: false }; },
    }, new BrokenDiagnostics(() => {}), 1);
    const response = await app.request('/connector/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"label":"fixture"}' });
    assert.equal(response.status, 403); assert.equal(writes, 1);
  });
