import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {DEFAULT_HUB_NOTEBOOK_LAYOUT} from '@agentopsdeck/shared';
import {loadConfig} from '../config.js';
import {registerHubRoutes} from '../routes/hub.js';
import {HubStore} from './hub-store.js';
import {createHubAdministrativeServices} from './administrative-route-services.js';
import {AsyncHubMemberOwner} from './async-member-owner.js';
import {asyncNativeFileFixture, deferredNative, nativeNotebook} from './async-native-file-fixture.js';
import {hubNotebookReplyExpectation, validHubNotebookCommand, validHubNotebookReply, type HubNotebookCommand,
  type PrivateNotebookRead} from './member-notebook-domain.js';
import {hubMemberResultBytes} from './member-owner-domain.js';
import {readNotebookSnapshot, readNotebookSnapshotInTransaction} from './notebook-snapshot-read.js';

const read = (resourceId = nativeNotebook): PrivateNotebookRead => ({mode: 'hot', resourceId, after: null, query: null, includeArchive: false});
const errorStatus = (status: number) => (error: unknown) => (error as {status?: number}).status === status;
async function fixture(t: TestContext, mode: 'original' | 'worker', seedBeforeMount?: (store: HubStore, sessionId: string) => void) {
  const f = await asyncNativeFileFixture(t, mode, 'card', undefined, seedBeforeMount);
  const hooks: {after?: ((kind: string, input: unknown, result: unknown) => Promise<unknown> | unknown) | undefined} = {};
  const owner = {weixinBackground: () => f.current().owner.weixinBackground(),
    weixinBindingEffect: () => f.current().owner.weixinBindingEffect(),
    connectionControlSettlement: () => f.current().owner.connectionControlSettlement(),
    nativeFileBackground: () => f.current().owner.nativeFileBackground(),
    contentBackground: () => f.current().owner.contentBackground(), command: async (kind, input) => {
    const result = await f.current().owner.command(kind, input);
    return hooks.after ? await hooks.after(kind, input, result) : result;
  }} as Pick<AsyncHubMemberOwner, 'command' | 'nativeFileBackground' | 'contentBackground'
    | 'weixinBackground' | 'weixinBindingEffect' | 'connectionControlSettlement'>;
  const services = createHubAdministrativeServices(owner);
  const metadata = f.current().metadata ?? new HubStore(':memory:', 'fixture');
  let guarded = false, synchronous = 0;
  const forbidden = () => {synchronous++; return assert.fail('Private Notebook touched synchronous dependency');};
  const store = new Proxy(metadata, {get(target, property, receiver) {return guarded ? forbidden() : Reflect.get(target, property, receiver);}});
  const app = new Hono(), routes = registerHubRoutes(app, {config: {...loadConfig({HOME: f.root, AOD_SERVER_ROLE: 'hub'}), boardFilesEnabled: true},
    hubStore: store, administrative: services, asyncConnectorClient: f.current().resolver,
    principal: forbidden, connectorClient: forbidden, fileCardClient: forbidden, normalizeError: () => 'safe'});
  assert.ok(routes); guarded = true;
  t.after(async () => {guarded = false; hooks.after = undefined; await routes.close(); await services.close(); if (!f.current().metadata) await metadata.close();});
  const request = (path: string, method = 'GET', body?: unknown, headers = f.request().headers) => app.request('/api/hub/v1/' + path, {
    method, headers, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  return {...f, owner, services, hooks, originalRequest: f.request, request, synchronous: () => synchronous};
}

test('worker native file fixture returns ready initial and reopened owners', async t => {
  const f = await asyncNativeFileFixture(t, 'worker', 'card'), first = f.current().owner;
  assert.ok(first instanceof AsyncHubMemberOwner);
  assert.equal(first.snapshot().ready, true, 'initial fixture must await worker ready');
  await f.reopen();
  const reopened = f.current().owner;
  assert.ok(reopened instanceof AsyncHubMemberOwner);
  assert.notEqual(reopened, first);
  assert.equal(reopened.snapshot().ready, true, 'reopened fixture must await its new worker ready');
});

test('private snapshot contract rejects owner/session/extra fields and correlates the original read scope and budget', () => {
  const command: HubNotebookCommand = {action: 'snapshotPrivate', read: read()};
  assert.equal(validHubNotebookCommand(command), true);
  for (const scope of [{...read(), owner: 'other'}, {...read(), resourceId: '["owner","node","codex","session"]'},
    {...read(), resourceId: '["hub-notebook", 1]'}, {...read(), callback: 'get'}, {...read(), mode: 'cold', resourceId: '["hub-notebook-layout",1,"default"]'}])
    assert.equal(validHubNotebookCommand({...command, read: scope}), false);
  const snapshot = {documents: [{resourceId: nativeNotebook, revision: 0, text: '', updatedAt: null}], defaultDocument: null, search: null,
    versions: [{resourceId: nativeNotebook, area: 'hot', revision: 0, updatedAt: null}]};
  const result = {...command, snapshot}, expected = hubNotebookReplyExpectation(command);
  assert.equal(validHubNotebookReply(expected, result), true);
  assert.equal(validHubNotebookReply(expected, {...result, read: {...read(), mode: 'cold'}}), false);
  assert.equal(validHubNotebookReply(expected, {...result, snapshot: {...snapshot, documents: []}}), false);
  const input = {command};
  assert.ok(hubMemberResultBytes('personalNotebook', input) > 8 * 1024 * 1024);
  assert.ok(hubMemberResultBytes('personalNotebook', {command: {action: 'savePrivate'}}) < 1024 * 1024);
});

test('explicit in-transaction snapshot cannot begin, commit or roll back its identity caller transaction', async () => {
  const store = new HubStore(':memory:', 'fixture'), db = (store as unknown as {db: DatabaseSync}).db;
  const scope = {...read(), owner: 'default'};
  try {
    assert.throws(() => readNotebookSnapshotInTransaction(db, scope));
    db.exec('SAVEPOINT original_identity');
    store.notebooks.save('default', {resourceId: nativeNotebook, revision: 0, text: 'uncommitted'});
    assert.equal(readNotebookSnapshotInTransaction(db, scope).documents[0]!.text, 'uncommitted');
    assert.throws(() => readNotebookSnapshot(db, scope)); assert.equal(db.isTransaction, true);
    assert.throws(() => readNotebookSnapshotInTransaction(db, {...scope, query: 'invalid'}));
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK TO original_identity; RELEASE original_identity');
    assert.equal(store.notebooks.get('default', nativeNotebook).revision, 0);
  } finally {if (db.isTransaction) db.exec('ROLLBACK'); await store.close();}
});

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: private hot/cold/layout/list/search/control production package has no synchronous request dependency`, {timeout: 30_000}, async t => {
    const f = await fixture(t, mode), id = randomUUID(), resourceId = JSON.stringify(['hub-notebook', 1, id]);
    const layout = JSON.stringify(['hub-notebook-layout', 1, id]);
    const save = f.services.privateNotebooks.savePrivate;
    const text = '私人 needle 热笔记🙂', cold = '归档 needle 冷笔记';
    for (const [resource, body, area] of [[resourceId, text, 'hot'], [resourceId, cold, 'cold'],
      [layout, JSON.stringify({...DEFAULT_HUB_NOTEBOOK_LAYOUT, title: 'Private layout'}), 'layout']] as const) {
      assert.equal((await save(f.originalRequest(), 'default', {resourceId: resource, revision: 0, text: body}, area, true)).status, 'saved');
    }
    for (const headers of [new Headers({'x-agentopsdeck-key': f.key.token}), new Headers({authorization: `Bearer ${f.key.token}`}),
      new Headers({cookie: `agentopsdeck_session=${f.cookie}`})]) {
      for (const [path, resource, expected] of [['notebook', nativeNotebook, 'new old'], [`notebooks/${id}`, resourceId, text],
        [`notebooks/${id}/archive`, resourceId, cold], [`notebooks/${id}/layout`, layout, JSON.stringify({...DEFAULT_HUB_NOTEBOOK_LAYOUT, title: 'Private layout'})]]) {
        const response = await f.request(path!, 'GET', undefined, headers);
        assert.equal(response.status, 200, path); assert.equal(response.headers.get('cache-control'), 'no-store');
        const document = await response.json(); assert.equal(document.resourceId, resource); assert.equal(document.text, expected); assert.equal(document.revision, 1);
      }
    }
    const defaults = await f.request('notebooks/default/layout'); assert.equal(defaults.status, 200);
    const defaultDocument = await defaults.json(); assert.equal(defaultDocument.revision, 0); assert.deepEqual(JSON.parse(defaultDocument.text), DEFAULT_HUB_NOTEBOOK_LAYOUT);
    const list = await f.request('notebooks'); assert.equal(list.status, 200);
    const page = await list.json(); assert.equal(page.nextCursor, null); assert.equal(page.items.length, 2);
    assert.equal(page.items[0].resourceId, '["hub-notebook-layout",1,"default"]');
    assert.equal(page.items[1].resourceId, layout);
    const cursor = await f.request('notebooks?after=' + encodeURIComponent(layout)); assert.equal(cursor.status, 200);
    assert.deepEqual((await cursor.json()).items, []);
    const search = await f.request(`notebooks/${id}/search?q=needle&archive=1`); assert.equal(search.status, 200);
    const matches = await search.json(); assert.equal(matches.hotRevision, 1); assert.equal(matches.coldRevision, 1);
    assert.deepEqual(matches.results.map((v: {area: string}) => v.area), ['hot', 'cold']);
    assert.equal((await f.request(`notebooks/${id}/search?q=`)).status, 400);
    assert.equal((await f.request(`notebooks/${id}/search?q=needle&archive=0`)).status, 400);
    assert.equal((await f.request('notebooks/not-an-id')).status, 404);
    assert.equal((await f.request('notebooks?after=invalid')).status, 400);
    const capabilities = `notebooks/${id}/capabilities`;
    assert.deepEqual(await (await f.request(capabilities)).json(), {capabilities: []});
    const issued = await f.request(capabilities, 'POST', {facets: ['hot:read', 'cold:read'], expiresAt: Date.now() + 60_000});
    assert.equal(issued.status, 201); const grant = await issued.json(); assert.ok(grant.token);
    const grants = await (await f.request(capabilities)).json(); assert.equal(grants.capabilities.length, 1);
    assert.equal(grants.capabilities[0].id, grant.capability.id); assert.equal('token' in grants.capabilities[0], false);
    assert.equal((await f.request(capabilities + '/' + grant.capability.id, 'DELETE')).status, 200);
    assert.equal((await f.request(capabilities + '/invalid', 'DELETE')).status, 404);
    assert.equal(f.synchronous(), 0); assert.equal(f.calls.write, 0); assert.equal(f.calls.install, 0);
  });

  test(`${mode}: private snapshot failed ACK/scope substitution fails closed without synchronous fallback`, async t => {
    const f = await fixture(t, mode);
    for (const failure of ['lost', 'scope', 'body'] as const) {
      f.hooks.after = (kind, _input, result) => {
        if (kind !== 'personalNotebook') return result;
        if (failure === 'lost') throw Error('lost_ack');
        const value = result as {read: PrivateNotebookRead; snapshot: {documents: unknown[]}};
        return failure === 'scope' ? {...value, read: {...value.read, mode: 'cold'}} : {...value, snapshot: {...value.snapshot, documents: []}};
      };
      const response = await f.request('notebook'); assert.equal(response.status, 503, failure);
      assert.equal((await response.text()).includes('new old'), false);
    }
    f.hooks.after = undefined;
    assert.equal((await f.request('notebook')).status, 200); assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: revocation after private snapshot ACK blocks original result delivery`, async t => {
    const f = await fixture(t, mode);
    f.hooks.after = async (kind, _input, result) => {
      if (kind === 'personalNotebook') {f.hooks.after = undefined; await f.revokeKey();}
      return result;
    };
    const response = await f.request('notebook'); assert.equal(response.status, 401);
    assert.equal((await response.text()).includes('new old'), false); assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: private layout page keeps original bounded historical rows beyond ordinary save reply budget`, async t => {
    // Old/corrupt-but-bounded layout text is intentionally returned as stored;
    // this is not admission of a new invalid layout through the save command.
    // Seed history before worker migration/activation, never through a second
    // writer racing an already mounted production owner.
    const f = await fixture(t, mode, store => {
      const db = (store as unknown as {db: DatabaseSync}).db;
      const insert = db.prepare('INSERT INTO hub_session_notebooks(user_id,resource_id,revision,text,updated_at) VALUES (?,?,?,?,?)');
      for (let index = 0; index < 8; index++) {
        const resource = JSON.stringify(['hub-notebook-layout', 1, randomUUID()]);
        insert.run('default', resource, 1, '界'.repeat(49_000), 1);
      }
    });
    const response = await f.request('notebooks'); assert.equal(response.status, 200, JSON.stringify(f.logs.map(line => JSON.parse(line))));
    const body = await response.text(); assert.ok(Buffer.byteLength(body) > 1024 * 1024);
    assert.equal(JSON.parse(body).items.length, 9); assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: private snapshot close drains retained ACK and rejects new admission`, async t => {
    const f = await fixture(t, mode), entered = deferredNative(), release = deferredNative();
    f.hooks.after = async (kind, _input, result) => {if (kind === 'personalNotebook') {entered.resolve(); await release.promise;} return result;};
    const pending = assert.rejects(f.services.privateNotebooks.snapshotPrivate(f.originalRequest(), 'default', read()), errorStatus(503));
    try {
      await entered.promise;
      let settled = false; const closing = f.services.close(); void closing.then(() => {settled = true;});
      await new Promise<void>(yes => setImmediate(yes)); assert.equal(settled, false);
      await assert.rejects(f.services.privateNotebooks.snapshotPrivate(f.originalRequest(), 'default', read()), errorStatus(503));
      release.resolve(); await pending; await closing; assert.equal(settled, true);
    } finally {release.resolve(); await pending;}
  });

  test(`${mode}: private read captures caller scope before awaiting initial identity`, async t => {
    const f = await fixture(t, mode), entered = deferredNative(), release = deferredNative();
    let paused = false;
    f.hooks.after = async (kind, _input, result) => {if (kind === 'memberSnapshot' && !paused) {paused = true; entered.resolve(); await release.promise;} return result;};
    const original = read(), pending = f.services.privateNotebooks.snapshotPrivate(f.originalRequest(), 'default', original);
    try {
      await entered.promise; original.mode = 'cold'; original.resourceId = JSON.stringify(['hub-notebook', 1, randomUUID()]);
      release.resolve(); const snapshot = await pending; assert.equal(snapshot.documents[0]!.text, 'new old');
      assert.equal(snapshot.documents[0]!.resourceId, nativeNotebook);
    } finally {release.resolve(); await pending;}
  });
}
