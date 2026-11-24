import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { registerExecutionGrantRoutes } from '../connector/execution-grant-http.js';
import { registerHubExecutionIssuerRoutes } from './hub-execution-issuers.js';

function fixture(enabled = true, identity = 'verified') {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-local-issuer-'));
  const store = new HubStore(join(directory, 'hub.sqlite'), 'synthetic-vault');
  const users = new ConnectorUserStore(join(directory, 'connector.sqlite'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'));
  store.upsertConnection({ id: 'local', ownerUserId: 'default', kind: 'local', label: 'Fixture', connectorUrl: 'local://aod-connector' });
  if (identity !== 'unverified') store.pinConnectionNode('local', 'default', store.connectionAuthority('local', 'default')!,
    identity === 'mismatched' ? 'node_11111111-1111-4111-8111-111111111111' : users.nodeId);
  const connector = new Hono();
  registerExecutionGrantRoutes(connector, { nodeId: users.nodeId, tokens, grants: users.executionGrants });
  let principal = { userId: 'default', admin: true }, fail = false, afterProbe = () => {};
  const app = new Hono();
  registerHubExecutionIssuerRoutes(app, { hubStore: store, principal: () => principal,
    local: { connectionId: 'local', dispatch: async request => {
      if (fail) throw new Error('Synthetic unavailable Connector');
      const response = await connector.fetch(request); afterProbe(); return response;
    } },
    ...(enabled ? { operator: {
      create: (hubId: string, createSessions = false) => tokens.create({ label: 'Fixture operator', delegationHubId: hubId,
        scopes: ['execution:delegate', 'messages:read', 'messages:send', 'queue:manage', ...(createSessions ? ['sessions:create' as const] : [])] }),
      revoke: (id: string) => tokens.revoke(id),
    } } : {}),
  });
  const base = '/api/hub/v1/connections/local/execution-issuer';
  return { app, base, store, tokens, users,
    principal: (next: typeof principal) => { principal = next; }, fail: () => { fail = true; },
    afterProbe: (fn: typeof afterProbe) => { afterProbe = fn; },
    post: (body: unknown = { confirm: true, nodeVersion: store.connectionAuthority('local', 'default') }) =>
      app.request(base + '/local', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    close: () => { store.close(); users.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('local execution setup requires operator opt-in, admin ownership, confirmation and current node version', async () => {
  for (const enabled of [false, true]) {
    const setup = fixture(enabled);
    try {
      assert.equal((await (await setup.app.request(setup.base)).json()).localSetupAllowed, enabled);
      if (!enabled) { assert.equal((await setup.post()).status, 403); continue; }
      setup.principal({ userId: 'default', admin: false });
      assert.equal((await setup.post()).status, 403);
      setup.principal({ userId: 'unowned', admin: true });
      assert.equal((await setup.post()).status, 403);
      setup.principal({ userId: 'default', admin: true });
      assert.equal((await setup.post({ confirm: false })).status, 400);
      assert.equal((await setup.post({ confirm: true, nodeVersion: 999 })).status, 409);
      assert.equal((await setup.post({ confirm: true, nodeVersion: 1, hubId: 'injected' })).status, 400);
      assert.equal(setup.tokens.list().length, 0);
    } finally { setup.close(); }
  }
});

test('local setup verifies new Hub-bound credential, invalidates old grants and reconciles duplicate requests without new keys', async () => {
  const setup = fixture();
  try {
    const user = setup.store.createUser('Member');
    const target = { ownerUserId: 'default', connectionId: 'local', userId: user.id };
    const resource = { runtime: 'codex' as const, sessionKey: 'codex:fixture' };
    setup.store.grants.create(target, { ...resource, actions: ['messages:read'] });
    assert.ok(setup.store.grants.authorize(target, 'messages:read', resource));
    const response = await setup.post();
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ['issuer']);
    assert.equal(JSON.stringify(body).includes('aod_conn_'), false);
    const record = setup.tokens.list()[0]!;
    assert.equal(record.delegationHubId, setup.store.identities.hubId);
    assert.deepEqual(record.scopes.sort(), ['execution:delegate', 'messages:read', 'messages:send', 'queue:manage']);
    assert.equal(setup.store.grants.authorize(target, 'messages:read', resource), undefined);
    assert.equal((await setup.post()).status, 200);
    assert.equal(setup.tokens.list().length, 1);
    assert.equal(setup.store.getCredentialToken('local'), undefined);
  } finally { setup.close(); }
});

test('member creation requires explicit credential upgrade and does not silently elevate grants', async () => {
  const setup = fixture();
  try {
    assert.equal((await setup.post()).status, 201);
    const original = setup.store.executionIssuers.current('default', 'local')!;
    assert.equal(original.creationAllowed, undefined);
    const user = setup.store.createUser('Member');
    const target = { ownerUserId: 'default', connectionId: 'local', userId: user.id };
    setup.store.grants.create(target, { runtime: 'codex', actions: ['messages:read', 'messages:send'] });
    assert.equal((await setup.post({ confirm: true, nodeVersion: original.version, createSessions: true })).status, 201);
    const upgraded = setup.store.executionIssuers.current('default', 'local')!;
    assert.equal(upgraded.creationAllowed, true);
    assert.notEqual(upgraded.issuerId, original.issuerId);
    assert.equal(setup.store.grants.authorize(target, 'messages:send', { runtime: 'codex' }), undefined);
    assert.equal(setup.store.grants.authorize(target, 'sessions:create', { runtime: 'codex' }), undefined);
    assert.equal((await setup.post({ confirm: true, nodeVersion: upgraded.version, createSessions: true })).status, 200);
    assert.equal(setup.tokens.list().length, 2);
  } finally { setup.close(); }
});

test('local setup rejects disabled, unverified and mismatched local nodes without leaving an active credential', async () => {
  for (const mode of ['disabled', 'unverified', 'mismatched']) {
    const setup = fixture(true, mode);
    try {
      if (mode === 'disabled') {
        setup.store.upsertConnection({ id: 'local', ownerUserId: 'default', kind: 'local', label: 'Fixture',
          connectorUrl: 'local://aod-connector', status: 'disabled' });
      }
      assert.equal((await setup.post()).status, 409, mode);
      assert.equal(setup.store.executionIssuers.current('default', 'local'), undefined);
      assert.ok(setup.tokens.list().every(record => record.revokedAt), mode);
    } finally { setup.close(); }
  }
});

test('failed verification or revoked administrator during setup revokes the uninstalled credential', async () => {
  for (const failure of ['connector', 'principal']) {
    const setup = fixture();
    try {
      if (failure === 'connector') setup.fail();
      else setup.afterProbe(() => setup.principal({ userId: 'default', admin: false }));
      assert.equal((await setup.post()).status, 409);
      assert.equal(setup.store.executionIssuers.current('default', 'local'), undefined);
      assert.equal(setup.tokens.list().length, 1);
      assert.ok(setup.tokens.list()[0]!.revokedAt);
    } finally { setup.close(); }
  }
});
