import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { registerHubAccountDirectory } from './hub-account-directory.js';
import { HubMemberRequestError, type AsyncHubMemberRequests } from '../hub/async-member-request.js';
import type { HubPrincipal } from '../hub/identity.js';

const user = { id: 'member', label: 'Original member', createdAt: 1, updatedAt: 2 };
const connection = { id: 'node', ownerUserId: 'member', label: 'Original node', connectorUrl: 'http://fixture.invalid',
  kind: 'remote' as const, status: 'enabled' as const, capabilities: [], hasCredential: false, createdAt: 1, updatedAt: 2 };
for (const configured of [false, true]) for (const kind of ['users', 'connections'] as const)
  for (const outcome of ['normal', 'failure', 'revoked', 'cancel', 'retarget'] as const)
    test(`account directory ${configured}/${kind}/${outcome}: bounded command, no fallback and original wire`, async () => {
      const app = new Hono(), controller = new AbortController();
      let actor: HubPrincipal | undefined = { userId: 'member', admin: false };
      let legacyReads = 0, commands = 0, presentations = 0;
      const change = () => {
        if (outcome === 'failure') throw new Error('PRIVATE storage details');
        if (outcome === 'revoked') actor = undefined;
        if (outcome === 'retarget') actor = { userId: 'foreign', admin: false };
        if (outcome === 'cancel') controller.abort();
      };
      registerHubAccountDirectory(app, {
        principal: () => { if (!actor) throw new HTTPException(401); return actor; },
        store: {
          listUsersAsync: async (owner, admin) => {
            legacyReads++; assert.equal(configured, false); assert.equal(owner, 'member'); assert.equal(admin, false);
            await Promise.resolve(); change(); return [{ ...user }];
          },
          listConnectionsAsync: async owner => { legacyReads++; assert.equal(configured, false); assert.equal(owner, 'member'); return [{ ...connection }]; },
        },
        present: (connections, users) => { presentations++; assert.deepEqual(users, [user]); return connections.map(row => ({ id: row.id, label: row.label })); },
        ...(configured ? { access: { begin: async (request: Request) => {
          assert.equal(request.headers.get('cookie'), 'agentopsdeck_session=fixture-session');
          assert.equal(request.headers.get('authorization'), 'Bearer fixture-key');
          assert.equal(request.signal.aborted, false);
          const read = async () => { commands++; await Promise.resolve(); change(); return { principal: { userId: 'member', admin: false }, users: [user], connections: [connection] }; };
          return { principal: { userId: 'member', admin: false }, users: read,
            connectionDirectory: async () => ({ ...await read(), check: async () => {} }) };
        } } as unknown as Pick<AsyncHubMemberRequests, 'begin'> } : {}),
      });
      const response = await app.fetch(new Request('http://hub/api/hub/v1/' + kind, { signal: controller.signal,
        headers: { cookie: 'agentopsdeck_session=fixture-session', authorization: 'Bearer fixture-key' } }));
      assert.equal(response.status, outcome === 'normal' ? 200 : outcome === 'revoked' || outcome === 'retarget' ? 401 : 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.text();
      assert.doesNotMatch(body, /PRIVATE|fixture-key|fixture-session|foreign/);
      if (outcome === 'normal') {
        const value = JSON.parse(body);
        assert.equal(typeof value.updatedAt, 'number');
        assert.deepEqual(Object.keys(value).sort(), [kind, 'updatedAt'].sort());
        assert.deepEqual(value[kind], kind === 'users' ? [user] : [{ id: 'node', label: 'Original node' }]);
      } else if (response.status === 503) assert.deepEqual(JSON.parse(body), { error: `hub_${kind}_unavailable` });
      assert.equal(commands, configured ? 1 : 0);
      assert.equal(legacyReads, configured ? 0 : kind === 'connections' && outcome === 'normal' ? 2 : 1);
      assert.equal(presentations, kind === 'connections' && outcome === 'normal' ? 1 : 0);
    });

for (const status of [401, 403, 499, 503] as const)
  test(`configured account command refusal ${status} never falls back to legacy display SQL`, async () => {
    const app = new Hono();
    registerHubAccountDirectory(app, {
      principal: () => ({ userId: 'member', admin: false }),
      store: { listUsersAsync: async () => { throw Error('must not fall back'); }, listConnectionsAsync: async () => { throw Error('must not fall back'); } },
      present: () => { throw Error('must not present'); },
      access: { begin: async () => { throw new HubMemberRequestError(status); } } as unknown as Pick<AsyncHubMemberRequests, 'begin'>,
    });
    for (const kind of ['users', 'connections']) {
      const response = await app.request('/api/hub/v1/' + kind);
      assert.equal(response.status, status === 401 || status === 403 ? status : 503);
    }
  });

test('connection directory final joint proof must pass before presenting original rows', async () => {
  const app = new Hono();
  let checked = 0;
  registerHubAccountDirectory(app, {
    principal: () => ({ userId: 'member', admin: false }),
    store: { listUsersAsync: async () => { throw Error('must not fall back'); }, listConnectionsAsync: async () => { throw Error('must not fall back'); } },
    present: () => { throw Error('must not present rejected rows'); },
    access: { begin: async () => ({ principal: { userId: 'member', admin: false }, connectionDirectory: async () => ({
      users: [user], connections: [connection], check: async () => { checked++; throw new HubMemberRequestError(503); },
    }) }) } as unknown as Pick<AsyncHubMemberRequests, 'begin'>,
  });
  const response = await app.request('/api/hub/v1/connections');
  assert.equal(response.status, 503); assert.equal(checked, 1);
  assert.doesNotMatch(await response.text(), /Original member|Original node/);
});
