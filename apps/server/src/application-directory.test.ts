import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';
import { NODE_ID_HEADER, EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import { encodeHubSessionId } from './hub/session-id.js';

for (const backend of ['json', 'sqlite'] as const) {
  test(`actual ${backend} shared directory uses original awaited proof, preserves cookies and rejects changed authority without replay`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'application-directory-'));
    const administratorKey = 'isolated-directory-administrator';
    const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
      AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-directory-vault',
      AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
      AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
      AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
      ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
    const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
    const member = seed.createUser('Directory member');
    const key = seed.identities.issueKey(member.id), cookie = `agentopsdeck_session=${seed.identities.createSession(key.token)!}`;
    const node = 'node_' + randomUUID();
    seed.upsertConnection({ id: 'node', kind: 'remote', label: 'Original node', connectorUrl: 'http://directory-fixture.invalid', credentialToken: 'PRIVATE_DAILY' });
    seed.pinConnectionNode('node', 'default', seed.connectionAuthority('node', 'default')!, node);
    const target = { ownerUserId: 'default', connectionId: 'node', userId: member.id };
    const directoryGrant = seed.grants.create(target, { runtime: 'codex', actions: ['sessions:read'] });
    seed.grants.create(target, { runtime: 'codex', sessionKey: 'codex:visible', actions: ['messages:read'] });
    await seed.close();
    let application = createApplication(config), remote = 0, loseProjection = false;
    const calls: Array<{ kind: string; action: string | undefined }> = [];
    const original = OriginalHubAdministrativeCommands.prototype.command;
    let revokeBeforeProjection = false;
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      const payload = input as { evidence: unknown; expectedScope: string; command?: { action?: string } };
      calls.push({ kind, action: payload.command?.action });
      const reply = original.call(this, kind, input);
      if (kind === 'sharedDirectory' && payload.command?.action === 'project' && loseProjection) {
        loseProjection = false;
        return reply.then(() => { throw Error('PRIVATE lost projection ACK'); });
      }
      return reply;
    });
    t.mock.method(globalThis, 'fetch', async (raw: Request | string | URL, init?: RequestInit) => {
      const request = raw instanceof Request ? raw : new Request(raw, init);
      assert.equal(new URL(request.url).origin, 'http://directory-fixture.invalid');
      assert.equal(new URL(request.url).pathname, '/api/connector/v1/sessions/directory');
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('authorization'), 'Bearer PRIVATE_DAILY');
      assert.equal(request.headers.get(EXPECTED_NODE_HEADER), node);
      remote++;
      if (revokeBeforeProjection) {
        revokeBeforeProjection = false;
        const response = await application.app.request(`/api/hub/v1/connections/node/grants/${directoryGrant.id}`, {
          method: 'DELETE', headers: { 'x-agentopsdeck-key': administratorKey, 'content-type': 'application/json' },
          body: JSON.stringify({ version: directoryGrant.version }),
        });
        assert.equal(response.status, 200, await response.text());
      }
      return Response.json({ sessions: [{ sessionKey: 'codex:discovery-only', runtime: 'codex' },
        { sessionKey: 'codex:visible', runtime: 'codex' }], nextCursor: null, sourceCursor: 'fixture-source' },
      { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: node } });
    });
    const path = `/api/hub/v1/shared/default/connections/node/grants/${directoryGrant.id}/sessions`;
    const request = (suffix = '') => application.app.request(path + suffix, { headers: { cookie } });
    const expect = async (response: Response | Promise<Response>, status: number) => {
      const value = await response, text = await value.text(); assert.equal(value.status, status, text);
      assert.equal(value.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(text, /PRIVATE|Bearer|credentialToken|lost projection/);
      return text.length ? JSON.parse(text) : undefined;
    };
    try {
      const initial = await expect(request('?limit=20'), 200);
      assert.deepEqual(initial, { sessions: [
        { sessionKey: 'codex:discovery-only', runtime: 'codex', sessionId: null },
        { sessionKey: 'codex:visible', runtime: 'codex', sessionId: encodeHubSessionId('node', 'codex:visible') },
      ], nextCursor: null, sourceCursor: 'fixture-source' });
      assert.ok(calls.some(call => call.kind === 'connectorAccess' && call.action === 'open'));
      assert.ok(calls.some(call => call.kind === 'connectorAccess' && call.action === 'check'));
      assert.deepEqual(calls.filter(call => call.kind === 'sharedDirectory').map(call => call.action), ['open', 'project']);
      assert.equal(remote, 1);
      await expect(request('?runtime=codex'), 400); assert.equal(remote, 1);
      loseProjection = true;
      await expect(request(), 503); assert.equal(remote, 2);
      const reconciled = await expect(request(), 200); assert.deepEqual(reconciled, initial); assert.equal(remote, 3);
      await application.close(); application = createApplication(config);
      assert.deepEqual(await expect(request(), 200), initial); assert.equal(remote, 4);
      revokeBeforeProjection = true;
      await expect(request(), 403); assert.equal(remote, 5);
      await expect(request(), 404); assert.equal(remote, 5);
      await application.close(); application = createApplication(config);
      await expect(request(), 404); assert.equal(remote, 5);
      const logout = await application.app.request('/api/auth/logout', { method: 'POST', headers: { cookie } });
      assert.equal(logout.status, 200); assert.equal((await request()).status, 401);
    } finally { await application.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
