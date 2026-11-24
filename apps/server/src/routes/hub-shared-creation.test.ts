import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { registerExecutionGrantRoutes } from '../connector/execution-grant-http.js';
import { registerCreationReceipts } from '../commands/http.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { registerHubSharedCreationRoutes } from './hub-shared-creation.js';
import { registerHubSessionSharingRoutes } from './hub-session-sharing.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import type { NodeGrantPolicy } from '../hub/node-grants.js';

const policy: NodeGrantPolicy = { runtime: 'codex', actions: ['sessions:create', 'sessions:read', 'messages:read', 'messages:send'] };

async function fixture(creation = true) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-shared-create-'));
  const file = join(directory, 'hub.sqlite');
  let store = new HubStore(file, 'synthetic-vault');
  const users = new ConnectorUserStore(join(directory, 'connector.sqlite'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'));
  const member = store.createUser('Member'), other = store.createUser('Other');
  const target = { ownerUserId: 'default', connectionId: 'local', userId: member.id };
  store.upsertConnection({ id: 'local', ownerUserId: 'default', kind: 'local', label: 'Fixture', connectorUrl: 'local://aod-connector' });
  store.pinConnectionNode('local', 'default', store.connectionAuthority('local', 'default')!, users.nodeId);
  const connector = new Hono();
  connector.use('*', async (context, next) => { context.header(NODE_ID_HEADER, users.nodeId); await next(); });
  registerExecutionGrantRoutes(connector, { nodeId: users.nodeId, tokens, grants: users.executionGrants });
  const path = '/api/connector/v1/agents/:agentId/sessions';
  const mode = { writes: 0, posts: 0, lose: false, unavailable: false, reject: false, malformed: false, after: () => {} };
  registerCreationReceipts(connector, path, { receipts: users.commands, scope: context => {
    const principal = tokens.requireScope(context.req.raw, 'sessions:create');
    if (!principal) throw new HTTPException(403);
    return JSON.stringify([principal.tokenId, context.req.param('agentId')]);
  } });
  connector.post(path, context => {
    if (mode.reject) return context.json({ error: 'private connector error' }, 409);
    mode.writes++;
    const body = { key: `codex:fixture-${mode.writes}`, private: 'not projected' };
    context.get('acknowledgeCreation')({ status: 201, body });
    return context.json(body, 201);
  });
  const local = { connectionId: 'local', dispatch: async (request: Request) => {
    const isCreation = new URL(request.url).pathname.includes('/agents/');
    if (isCreation && mode.unavailable) throw new Error('offline');
    const response = await connector.fetch(request);
    if (isCreation && request.method === 'POST') { mode.posts++; mode.after(); if (mode.lose) throw new Error('ACK lost'); }
    if (isCreation && mode.malformed) {
      const body = await response.json() as any;
      if (body.command) body.command.key = 'wrong-delivery-key';
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    }
    return response;
  } };
  const configure = async (allowed = creation) => {
    const token = tokens.create({ label: 'Dedicated issuer', delegationHubId: store.identities.hubId,
      scopes: ['execution:delegate', 'messages:read', 'messages:send', ...(allowed ? ['sessions:create' as const] : [])] });
    return store.executionIssuers.configure('default', 'local', token.token, () => {}, local);
  };
  await configure();
  let app: Hono;
  const register = () => {
    app = new Hono();
    registerHubSharedCreationRoutes(app, { hubStore: store, principal: context => ({ userId: context.req.header('actor') ?? member.id, admin: false }), local });
    registerHubSessionSharingRoutes(app, { hubStore: store, principal: context => ({ userId: context.req.header('actor') ?? member.id, admin: false }) });
  };
  register();
  const base = '/api/hub/v1/shared/default/connections/local/agents/codex/sessions';
  return { mode, target, member, other, local, configure, store: () => store,
    grant: (next = policy) => store.grants.create(target, next),
    request: (path: string, init?: RequestInit) => app.request(path, init),
    create: (key: string, label = 'Member session', actor = member.id, extra = {}) => app.request(base, {
      method: 'POST', headers: { actor, 'content-type': 'application/json' }, body: JSON.stringify({ label, idempotencyKey: key, ...extra }),
    }),
    read: (key: string, actor = member.id) => app.request(`${base}/creation-commands/${key}`, { headers: { actor } }),
    environments: (actor = member.id) => app.request('/api/hub/v1/shared/creation-environments', { headers: { actor } }),
    restart: () => { store.close(); store = new HubStore(file, 'synthetic-vault'); register(); },
    close: () => { store.close(); users.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('shared creation requires an environment creation grant and a creation issuer', async () => {
  for (const variant of ['none', 'read', 'session', 'agent', 'issuer', 'allowed']) {
    const setup = await fixture(variant !== 'issuer');
    try {
      if (variant !== 'none') setup.grant({ ...policy,
        ...(variant === 'read' ? { actions: ['sessions:read', 'messages:read', 'messages:send'] } : {}),
        ...(variant === 'session' ? { sessionKey: 'codex:fixture' } : {}),
        ...(variant === 'agent' ? { agentId: 'codex' } : {}),
      });
      assert.equal((await (await setup.environments()).json()).environments.length, variant === 'allowed' ? 1 : 0, variant);
      assert.equal((await setup.create('one')).status, variant === 'allowed' ? 201 : variant === 'issuer' ? 409 : 403, variant);
      assert.equal(setup.mode.writes, variant === 'allowed' ? 1 : 0);
      assert.equal((await setup.create('foreign', 'Other', setup.other.id)).status, 403);
      assert.equal((await setup.read('one', setup.other.id)).status, 403);
      assert.equal((await (await setup.environments(setup.other.id)).json()).environments.length, 0);
    } finally { setup.close(); }
  }
});

test('shared creation is idempotent across restart and lost ACK; recovery only reads', async () => {
  const setup = await fixture();
  try {
    setup.grant(); setup.mode.lose = true; setup.mode.after = () => { setup.mode.unavailable = true; };
    assert.equal((await setup.create('original')).status, 202);
    setup.restart();
    assert.equal((await setup.create('original')).status, 202);
    assert.equal(setup.mode.posts, 1);
    setup.mode.unavailable = false;
    const recovered = await (await setup.read('original')).json();
    assert.equal(recovered.command.state, 'accepted');
    assert.equal(recovered.command.result.body.ownerUserId, 'default');
    assert.deepEqual(Object.keys(recovered.command.result.body).sort(), ['key', 'ownerUserId']);
    assert.equal((await setup.create('original')).status, 201);
    assert.equal((await setup.create('original', 'Changed')).status, 409);
    assert.equal(setup.mode.posts, 1); assert.equal(setup.mode.writes, 1);
    assert.equal((await setup.read('missing')).status, 404);
  } finally { setup.close(); }
});

test('revocation during dispatch and node rotation never replay or leak receipt results', async () => {
  const setup = await fixture();
  try {
    const grant = setup.grant();
    setup.mode.after = () => { setup.store().grants.revoke(setup.target, grant.id, grant.version); };
    assert.equal((await setup.create('race')).status, 403);
    assert.equal((await setup.read('race')).status, 403);
    setup.mode.after = () => {};
    await setup.configure(); setup.grant();
    assert.equal((await setup.read('race')).status, 409);
    assert.equal((await setup.create('race')).status, 409);
    assert.equal(setup.mode.posts, 1);
  } finally { setup.close(); }
});

test('creation rejects injected capabilities and malformed receipts without using owner credentials', async () => {
  const setup = await fixture();
  try {
    setup.grant();
    for (const extra of [{ model: 'other' }, { ownerUserId: 'other' }, { runtime: 'openclaw' }]) assert.equal((await setup.create('invalid', 'Session', setup.member.id, extra)).status, 400);
    for (const label of ['', ' ', 'x'.repeat(257)]) assert.equal((await setup.create('invalid', label)).status, 400);
    assert.equal(setup.mode.posts, 0);
    setup.mode.malformed = true;
    assert.equal((await setup.create('malformed')).status, 202);
    assert.equal(setup.store().grants.received(setup.member.id).grants.length, 1);
    assert.equal((await setup.create('malformed')).status, 202);
    setup.mode.malformed = false;
    assert.equal((await (await setup.read('malformed')).json()).command.state, 'accepted');
    setup.mode.reject = true;
    assert.equal((await setup.create('rejected')).status, 409);
    assert.equal((await setup.create('rejected')).status, 409);
    assert.equal(setup.mode.posts, 2);
    const issuer = setup.store().executionIssuers.current('default', 'local')!;
    const client = setup.store().executionIssuers.creationClient('default', 'local', issuer.version, () => {}, setup.local);
    for (const path of ['/sessions', '/agents/main/sessions', '/agents/codex/sessions?override=1']) await assert.rejects(client.json(path, { method: 'POST' }));
  } finally { setup.close(); }
});

test('create-only members obtain exact own-session access, persisted across receipt recovery and restart', async () => {
  const setup = await fixture();
  try {
    const root = setup.grant({ runtime: 'codex', actions: ['sessions:create'] });
    assert.equal((await (await setup.environments()).json()).environments.length, 1);
    const created = await (await setup.create('private')).json();
    const sessionKey = decodeHubSessionId(created.key)!.remoteSessionKey;
    const resource = { runtime: 'codex' as const, sessionKey };
    for (const action of ['messages:read', 'messages:send', 'sessions:read', 'events:read', 'queue:manage', 'sessions:share'] as const) {
      assert.ok(setup.store().grants.authorize(setup.target, action, resource));
      assert.equal(setup.store().grants.authorize({ ...setup.target, userId: setup.other.id }, action, resource), undefined);
      assert.equal(setup.store().grants.authorize(setup.target, action, { runtime: 'codex' }), undefined);
      assert.equal(setup.store().grants.authorize(setup.target, action, { ...resource, sessionKey: 'codex:someone-else' }), undefined);
    }
    const proof = setup.store().grants.authorize(setup.target, 'sessions:share', resource)!;
    assert.equal(setup.store().grants.ownedSession(proof), true);
    setup.restart();
    assert.equal((await setup.create('private')).status, 201);
    assert.equal(setup.mode.posts, 1);
    assert.equal(setup.store().grants.received(setup.member.id).grants.length, 2);
    assert.equal(setup.store().grants.revalidate(proof), true);
    const shared = setup.store().grants.shareSession(proof, setup.other.id, 'collaborator');
    const peerProof = setup.store().grants.authorize({ ...setup.target, userId: setup.other.id }, 'messages:send', resource)!;
    assert.ok(peerProof);
    assert.equal(setup.store().grants.authorize({ ...setup.target, userId: setup.other.id }, 'sessions:share', resource), undefined);
    assert.equal(setup.store().grants.replace({ ...setup.target, userId: setup.other.id }, shared.id, 1, { actions: ['messages:read'] }), false);
    assert.equal(setup.store().grants.revoke(setup.target, root.id, root.version), true);
    assert.equal(setup.store().grants.revalidate(proof), false);
    assert.equal(setup.store().grants.revalidate(peerProof), false);
    assert.equal(setup.store().grants.received(setup.other.id).grants.length, 0);
    setup.grant({ runtime: 'codex', actions: ['sessions:create'] });
    assert.equal(setup.store().grants.revalidate(proof), false);
    assert.equal(setup.store().grants.revalidate(peerProof), false);
    setup.restart();
    assert.equal(setup.store().grants.revalidate(peerProof), false);
  } finally { setup.close(); }
});

test('creator sharing API enforces observer/collaborator and refuses re-sharing, escalation and stale revocation', async () => {
  const setup = await fixture();
  try {
    setup.grant({ runtime: 'codex', actions: ['sessions:create'] });
    const created = await (await setup.create('collaboration')).json();
    const path = `/api/hub/v1/shared/default/sessions/${encodeURIComponent(created.key)}/collaborators`;
    const request = (method: string, actor: string, body?: unknown, suffix = '') => setup.request(path + suffix, {
      method, headers: { actor, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal((await request('GET', setup.other.id)).status, 404);
    assert.equal((await request('POST', setup.member.id, { userId: setup.other.id, role: 'admin' })).status, 400);
    assert.equal((await request('POST', setup.member.id, { userId: setup.other.id, role: 'observer', actions: ['node:manage'] })).status, 400);
    const response = await request('POST', setup.member.id, { userId: setup.other.id, role: 'observer' });
    assert.equal(response.status, 201);
    const { grant } = await response.json();
    const resource = { runtime: 'codex' as const, sessionKey: decodeHubSessionId(created.key)!.remoteSessionKey };
    assert.ok(setup.store().grants.authorize({ ...setup.target, userId: setup.other.id }, 'messages:read', resource));
    assert.equal(setup.store().grants.authorize({ ...setup.target, userId: setup.other.id }, 'messages:send', resource), undefined);
    assert.equal((await request('GET', setup.other.id)).status, 403);
    assert.equal((await request('POST', setup.other.id, { userId: setup.member.id, role: 'collaborator' })).status, 403);
    assert.equal((await request('POST', setup.member.id, { userId: setup.other.id, role: 'collaborator' })).status, 409);
    assert.equal((await request('DELETE', setup.member.id, { version: 8 }, `/${grant.id}`)).status, 409);
    assert.equal((await request('DELETE', setup.member.id, { version: 1 }, `/${grant.id}`)).status, 200);
    assert.equal((await request('GET', setup.other.id)).status, 404);
    assert.equal((await request('POST', setup.member.id, { userId: setup.other.id, role: 'collaborator' })).status, 201);
  } finally { setup.close(); }
});

test('ownership and exact grant roll back together when receipt settlement fails', async () => {
  const setup = await fixture();
  try {
    setup.grant({ runtime: 'codex', actions: ['sessions:create'] });
    const proof = setup.store().grants.authorize(setup.target, 'sessions:create', { runtime: 'codex' })!;
    assert.throws(() => setup.store().grants.acceptCreatedSession(proof, 'codex:atomic', 'scope', 'key', () => { throw new Error('disk full'); }), /disk full/);
    assert.equal(setup.store().grants.received(setup.member.id).grants.length, 1);
    setup.store().grants.acceptCreatedSession(proof, 'codex:atomic', 'scope', 'key', () => {});
    assert.equal(setup.store().grants.received(setup.member.id).grants.length, 2);
    assert.throws(() => setup.store().grants.acceptCreatedSession(proof, 'codex:other', 'scope', 'key', () => {}), /conflict/);
    assert.throws(() => setup.store().grants.acceptCreatedSession(proof, 'codex:atomic', 'scope', 'other', () => {}));
    assert.equal(setup.store().grants.received(setup.member.id).grants.length, 2);
  } finally { setup.close(); }
});

for (const change of ['revoke', 'replace'] as const) {
  test(`creation parent ${change} invalidates descendant execution leases across restart`, async () => {
    const setup = await fixture();
    try {
      const root = setup.grant({ runtime: 'codex', actions: ['sessions:create'] });
      const created = await (await setup.create(`leases-${change}`)).json();
      const resource = { runtime: 'codex' as const, sessionKey: decodeHubSessionId(created.key)!.remoteSessionKey };
      const store = setup.store();
      const owner = store.grants.authorize(setup.target, 'sessions:share', resource)!;
      store.grants.shareSession(owner, setup.other.id, 'collaborator');
      const nodeId = store.getConnection('local', 'default')!.nodeId!;
      const leases = [setup.member.id, setup.other.id].map(userId => {
        const proof = store.grants.authorize({ ...setup.target, userId }, 'messages:send', resource)!;
        return store.executionLeases.reserve(proof, nodeId, 'fixture-issuer', ['messages:send']);
      });
      assert.ok(leases.every(lease => lease.state === 'pending'));
      assert.equal(change === 'revoke' ? store.grants.revoke(setup.target, root.id, root.version)
        : store.grants.replace(setup.target, root.id, root.version, { runtime: 'codex', actions: ['sessions:create'] }), true);
      for (const lease of leases) assert.equal(store.executionLeases.get(lease.id)?.state, 'revoking');
      setup.restart();
      for (const lease of leases) assert.equal(setup.store().executionLeases.get(lease.id)?.state, 'revoking');
      assert.equal(setup.store().grants.revalidate(owner), false);
    } finally { setup.close(); }
  });
}
