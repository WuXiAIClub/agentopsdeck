import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { NodeGrants, type NodeGrantPolicy, type NodeResource } from './node-grants.js';
import { createConnectorClientResolver } from './connector-client.js';
import { DatabaseSync } from 'node:sqlite';
import { connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

test('created session ownership rolls back when its receipt callback escapes asynchronously', async t => {
  const { file, store, target } = fixture(t), db = (store as any).db as DatabaseSync;
  let release!: () => void, late: Promise<void> | undefined, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  db.exec('CREATE TABLE late_effect(value INTEGER)'); const insert = db.prepare('INSERT INTO late_effect VALUES(1)');
  const reader = new DatabaseSync(file, { readOnly: true });
  try {
    store.grants.create(target, { runtime: 'codex', actions: ['sessions:create'] });
    const proof = store.grants.authorize(target, 'sessions:create', { runtime: 'codex' })!; assert.ok(proof);
    const grants = reader.prepare('SELECT * FROM node_grants').all();
    assert.throws(() => store.grants.acceptCreatedSession(proof, 'codex:async', 'scope', 'key', () => {
      calls++; return late = (async () => { await held; insert.run(); })();
    }), /must be synchronous/);
    assert.equal(calls, 1); assert.equal(db.isTransaction, false);
    assert.deepEqual(reader.prepare('SELECT * FROM hub_session_owners').all(), []);
    assert.deepEqual(reader.prepare('SELECT * FROM node_grants').all(), grants);
    assert.deepEqual(reader.prepare('SELECT * FROM node_grant_dependencies').all(), []);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    const rejected = assert.rejects(late!, StorageConnectionUnavailable); release(); await rejected;
    assert.deepEqual(reader.prepare('SELECT * FROM late_effect').all(), []);
  } finally { release(); if (late) await late.catch(() => {}); reader.close(); store.close(); }
});

function fixture(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-node-grants-'));
  context.after(() => { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); });
  const file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'synthetic-vault');
  const alice = store.createUser('Alice'), bob = store.createUser('Bob');
  const connection = { id: 'same-node-alias', ownerUserId: alice.id, kind: 'remote' as const,
    label: 'Node', connectorUrl: 'http://unused.invalid', credentialToken: 'synthetic' };
  store.upsertConnection(connection);
  store.upsertConnection({ ...connection, ownerUserId: bob.id });
  const target = { ownerUserId: alice.id, connectionId: connection.id, userId: bob.id };
  return { file, store, alice, bob, connection, target };
}

for (const operation of ['authorize', 'session-policy', 'share-membership', 'share-ceiling'] as const) {
  test(`node authorization hooks cannot grant on a Promise (${operation})`, async t => {
    const { file, store, target, alice } = fixture(t), db = (store as any).db as DatabaseSync;
    const reader = new DatabaseSync(file, { readOnly: true });
    let release!: () => void, late!: Promise<boolean>, calls = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    db.exec('CREATE TABLE late_effect(value INTEGER)'); const insert = db.prepare('INSERT INTO late_effect VALUES(1)');
    const authority = () => {
      calls++; insert.run(); return late = (async () => { await held; insert.run(); return false; })();
    };
    const resource = { runtime: 'codex' as const, sessionKey: 'codex:authority' };
    try {
      store.grants.create(target, { runtime: 'codex', actions: ['sessions:create'] });
      const creator = store.grants.authorize(target, 'sessions:create', { runtime: 'codex' })!;
      store.grants.acceptCreatedSession(creator, resource.sessionKey, 'scope', 'key', () => {});
      const proof = store.grants.authorize(target, 'sessions:share', resource)!; assert.ok(proof);
      const before = reader.prepare('SELECT * FROM node_grants').all();
      const dependencies = reader.prepare('SELECT * FROM node_grant_dependencies').all();
      if (operation === 'share-membership') store.grants.canShareWith = authority as unknown as NonNullable<NodeGrants['canShareWith']>;
      else store.grants.ceiling = ((recipient: typeof target) => operation === 'share-ceiling' && recipient.userId !== alice.id
        ? true : authority()) as NonNullable<NodeGrants['ceiling']>;
      assert.throws(() => {
        if (operation === 'authorize') store.grants.authorize(target, 'messages:read', resource);
        else if (operation === 'session-policy') store.grants.sessionPolicy(target, resource, 'observer', {});
        else store.grants.shareSession(proof, alice.id, 'observer');
      }, /must be synchronous/);
      assert.equal(calls, 1); assert.equal(db.isTransaction, false);
      assert.deepEqual(reader.prepare('SELECT * FROM node_grants').all(), before);
      assert.deepEqual(reader.prepare('SELECT * FROM node_grant_dependencies').all(), dependencies);
      assert.deepEqual(reader.prepare('SELECT * FROM late_effect').all(), []);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      const rejected = assert.rejects(late, StorageConnectionUnavailable); release(); await rejected;
      assert.deepEqual(reader.prepare('SELECT * FROM late_effect').all(), []);
    } finally { release(); if (late) await late.catch(() => {}); reader.close(); store.close(); }
  });
}

test('NodeGrant defaults deny; exact actor/node/runtime/agent/session/action matching', t => {
  const { store, alice, bob, target } = fixture(t);
  const resource = { runtime: 'codex' as const, agentId: 'coding', sessionKey: 'codex:空 格/a' };
  try {
    assert.equal(store.grants.authorize(target, 'messages:read', resource), undefined);
    store.grants.create(target, { ...resource, actions: ['messages:read', 'events:read'] });
    const proof = store.grants.authorize(target, 'messages:read', resource)!;
    assert.ok(proof);
    assert.equal(store.grants.revalidate(proof), true);
    assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.resource));
    for (const action of ['messages:send', 'node:manage', 'runs:interrupt', 'queue:manage'] as const) {
      assert.equal(store.grants.authorize(target, action, resource), undefined);
    }
    for (const other of [{}, { ...resource, runtime: 'openclaw' }, { ...resource, agentId: 'other' }, { ...resource, sessionKey: 'other' },
      { runtime: 'codex', sessionKey: resource.sessionKey }]) {
      assert.equal(store.grants.authorize(target, 'messages:read', other as NodeResource), undefined);
    }
    for (const other of [{ ...target, userId: alice.id }, { ...target, ownerUserId: bob.id }, { ...target, connectionId: 'missing' }]) {
      assert.equal(store.grants.authorize(other, 'messages:read', resource), undefined);
    }
    // Authorization objects are policy data, not permission to use the owner's
    // credentials: shared connection routing has not been enabled yet.
    assert.equal(store.getConnection('missing', bob.id), undefined);
  } finally { store.close(); }
});

test('grant revisions are compare-and-swap; revocation cannot be undone or rebind another actor', t => {
  const { store, alice, target } = fixture(t);
  try {
    const grant = store.grants.create(target, { actions: ['messages:read'] });
    const proof = store.grants.authorize(target, 'messages:read', {})!;
    assert.equal(store.grants.replace({ ...target, userId: alice.id }, grant.id, 1, { actions: ['messages:send'] }), false);
    assert.equal(store.grants.replace(target, grant.id, 1, { actions: ['messages:read', 'messages:send'] }), true);
    assert.equal(store.grants.revalidate(proof), false);
    assert.equal(store.grants.replace(target, grant.id, 1, { actions: ['node:manage'] }), false);
    const current = store.grants.authorize(target, 'messages:send', {})!;
    assert.equal(current.version, 2);
    assert.equal(store.grants.revoke(target, grant.id, 1), false);
    assert.equal(store.grants.revoke(target, grant.id, 2), true);
    assert.equal(store.grants.revalidate(current), false);
    assert.equal(store.grants.replace(target, grant.id, 3, { actions: ['messages:send'] }), false);
    assert.equal(store.grants.authorize(target, 'messages:read', {}), undefined);
    // A second grant does not make the revoked proof valid again.
    store.grants.create(target, { actions: ['messages:send'] });
    assert.ok(store.grants.authorize(target, 'messages:send', {}));
    assert.equal(store.grants.revalidate(current), false);
  } finally { store.close(); }
});

test('node or credential changes invalidate grants durably; only explicit reauthorization follows a new authority', t => {
  const { file, store, target, connection } = fixture(t);
  let reopened: HubStore | undefined;
  try {
    const grant = store.grants.create(target, { runtime: 'openclaw', actions: ['messages:read'] });
    const resource = { runtime: 'openclaw' as const };
    const proof = store.grants.authorize(target, 'messages:read', resource)!;
    store.upsertConnection({ ...connection, status: 'disabled' });
    assert.equal(store.grants.revalidate(proof), false);
    assert.equal(store.grants.replace(target, grant.id, 1, { actions: ['messages:read'] }), false);
    store.upsertConnection({ ...connection, status: 'enabled' });
    assert.equal(store.grants.authorize(target, 'messages:read', resource), undefined);
    assert.equal(store.grants.replace(target, grant.id, 1, { runtime: 'openclaw', actions: ['messages:read'] }), true);
    const current = store.grants.authorize(target, 'messages:read', resource)!;
    reopened = new HubStore(file, 'synthetic-vault');
    assert.equal(reopened.grants.revalidate(current), true);
    reopened.upsertConnection({ ...connection, credentialToken: 'synthetic-rotated' });
    assert.equal(store.grants.revalidate(current), false);
    assert.equal(reopened.grants.authorize(target, 'messages:read', resource), undefined);
  } finally { reopened?.close(); store.close(); }
});

test('grants have bounded policies and transactional capacity including revocation tombstones', t => {
  const { store, target } = fixture(t);
  const grants = new NodeGrants((store as any).db, 2);
  try {
    for (const invalid of [null, {}, { actions: [] }, { actions: ['*'] }, { actions: ['messages:read'], runtime: 'other' },
      { actions: ['messages:read'], sessionKey: 'ambiguous-runtime' }, { actions: ['messages:read'], runtime: 'codex', sessionKey: 'a'.repeat(2049) },
      { actions: ['node:manage'], runtime: 'codex' }, { actions: ['messages:read'], runtime: 'codex', agentId: '\u0000' }]) {
      assert.throws(() => grants.create(target, invalid as NodeGrantPolicy));
    }
    const first = grants.create(target, { actions: ['messages:read'] });
    assert.throws(() => grants.create({ ...target, userId: 'missing-user' }, { actions: ['messages:read'] }));
    grants.create(target, { runtime: 'codex', actions: ['messages:send'] });
    assert.equal(grants.revoke(target, first.id, 1), true);
    assert.throws(() => grants.create(target, { actions: ['node:manage'] }), /capacity/);
    assert.equal(grants.authorize(target, 'node:manage', {}), undefined);
    assert.ok(grants.authorize(target, 'messages:send', { runtime: 'codex' }));
  } finally { store.close(); }
});

for (const transport of ['local', 'http'] as const) test(`${transport}: shared exact-session read uses owner's credential and current grant, never enables writes or broad streams`, async t => {
  const { store, alice, bob } = fixture(t);
  const app = new Hono();
  let reads = 0, observedAuthorization = '';
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  let pending: (() => void) | undefined;
  app.get('/api/connector/v1/sessions/:key/messages', (c) => {
    reads++; observedAuthorization = c.req.header('authorization') ?? '';
    if (!pending) return c.json({ messages: [{ id: 'message', sessionKey: c.req.param('key') }] });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; pending?.(); } }), { headers: { 'content-type': 'application/json' } });
  });
  const server = transport === 'http' ? serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server?.address() as { port: number } | undefined)?.port;
  const node = { id: 'shared', ownerUserId: transport === 'local' ? 'default' : alice.id, kind: transport === 'local' ? 'local' as const : 'remote' as const,
    label: 'Shared', connectorUrl: transport === 'local' ? 'local://aod-connector' : `http://127.0.0.1:${port}`, credentialToken: 'synthetic-owner' };
  store.upsertConnection(node);
  const target = { ownerUserId: node.ownerUserId, connectionId: node.id, userId: bob.id };
  const sessionKey = 'codex:shared/空 格';
  const resource = { runtime: 'codex' as const, sessionKey };
  const grant = store.grants.create(target, { ...resource, actions: ['messages:read', 'messages:send', 'events:read'] });
  const proof = store.grants.authorize(target, 'messages:read', resource)!;
  const resolve = createConnectorClientResolver(store, transport === 'local'
    ? { connectionId: node.id, token: 'synthetic-owner', dispatch: (request) => app.fetch(request) } : undefined);
  try {
    assert.throws(() => resolve(node.id, false, bob.id), { status: 404 });
    assert.throws(() => resolve(node.id, false, alice.id, proof), { status: 403 });
    assert.throws(() => resolve(node.id, true, bob.id, proof), { status: 403 });
    const client = resolve(node.id, false, bob.id, proof);
    const page = await client.messages(sessionKey);
    assert.equal(page.messages[0]?.sessionKey, sessionKey);
    assert.equal(observedAuthorization, 'Bearer synthetic-owner');
    assert.equal(reads, 1);
    for (const path of ['/users', '/sessions/state', '/events/stream', '/sessions/other/messages', `/sessions/${encodeURIComponent(sessionKey)}/queue`]) {
      await assert.rejects(client.json(path), { status: 403 });
    }
    await assert.rejects(client.json(`/sessions/${encodeURIComponent(sessionKey)}/messages`, { method: 'POST', body: '{}' }), { status: 403 });
    await assert.rejects(client.events(new AbortController().signal).next(), { status: 403 });
    assert.equal(reads, 1);
    const admitted = new Promise<void>((ready) => { pending = ready; });
    const delayed = client.messages(sessionKey);
    const rejected = assert.rejects(delayed, { status: 403 });
    await admitted;
    assert.equal(store.grants.revoke(target, grant.id, grant.version), true);
    source!.enqueue(new TextEncoder().encode('{"messages":[{"id":"must-not-deliver"}]}'));
    source!.close();
    await rejected;
    assert.throws(() => resolve(node.id, false, bob.id, proof), { status: 403 });
    assert.equal(reads, 2);
  } finally {
    if (server && 'closeAllConnections' in server) server.closeAllConnections();
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});
