import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { PersistentDeckSessionSet } from './auth/passkeys.js';
import { openSqliteAuth } from './auth/sqlite-store.js';
import { keyIdentityHash } from './auth/security.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';

const administratorKey = 'isolated-production-admin';
const legacyToken = 'a'.repeat(43);

for (const backend of ['json', 'sqlite'] as const) {
  test(`actual application ${backend} original-cookie administrative callers preserve saves, conflicts, revocation and reopen`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'production-administrative-'));
    const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
      AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-vault',
      AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
      AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
      AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
      ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
    assert.equal(config.accessKey, administratorKey);
    if (config.authSqliteFile) {
      const auth = openSqliteAuth(config.authSqliteFile, [], () => keyIdentityHash(administratorKey));
      auth.sessions.add(legacyToken); await auth.close();
    } else new PersistentDeckSessionSet(config.authSessionsFile).add(legacyToken);
    const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
    const member = seed.createUser('Existing member'), recipient = seed.createUser('Existing recipient');
    const memberKey = seed.identities.issueKey(member.id), memberCookie = seed.identities.createSession(memberKey.token)!;
    seed.upsertConnection({ id: 'node', ownerUserId: 'default', kind: 'remote', label: 'Existing node', connectorUrl: 'http://unused.invalid' });
    seed.pinConnectionNode('node', 'default', seed.connectionAuthority('node', 'default')!, 'node_' + randomUUID());
    const nodeVersion = seed.connectionAuthority('node', 'default')!;
    await seed.close();
    const kinds: string[] = [], original = OriginalHubAdministrativeCommands.prototype.command;
    let loseNextConnectionReply = false, lostReplies = 0;
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      kinds.push(kind);
      const reply = original.call(this, kind, input);
      if (loseNextConnectionReply && kind === 'connectionChange') {
        loseNextConnectionReply = false; lostReplies++;
        return reply.then(() => { throw Error('PRIVATE isolated lost connection ACK'); });
      }
      return reply;
    });
    let application = createApplication(config);
    const headers = { cookie: `agentopsdeck_session=${legacyToken}` };
    const request = (path: string, method = 'GET', body?: unknown, credentials: HeadersInit = headers) => application.app.request(path, {
      method, headers: { ...Object.fromEntries(new Headers(credentials)), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const expect = async (response: Response | Promise<Response>, status: number) => {
      const value = await response, text = await value.text();
      assert.equal(value.status, status, text); return JSON.parse(text);
    };
    try {
      const created = await expect(request('/api/hub/v1/users', 'POST', { label: 'Created via awaited caller', frontendExtra: true }), 201);
      assert.equal(created.user.label, 'Created via awaited caller');
      assert.equal((await expect(request(`/api/hub/v1/users/${created.user.id}`, 'PATCH', { label: 'Renamed via awaited caller' }), 200)).user.label,
        'Renamed via awaited caller');
      const keyPath = `/api/hub/v1/users/${recipient.id}/login-keys`;
      const key = await expect(request(keyPath, 'POST'), 201);
      assert.deepEqual(Object.keys(key).sort(), ['id', 'token']);
      assert.equal((await expect(request(keyPath), 200)).keys.length, 1);
      assert.deepEqual(await expect(request(keyPath + '/invalid-id', 'DELETE'), 200), { ok: false });
      assert.deepEqual(await expect(request(keyPath + '/' + key.id, 'DELETE'), 200), { ok: true });
      const rolePath = `/api/hub/v1/access/users/${recipient.id}/hub-role`;
      assert.deepEqual(await expect(request(rolePath), 200), { role: 'member', version: 0 });
      assert.deepEqual(await expect(request(rolePath, 'PUT', { role: 'admin', version: 0 }), 200), { role: 'admin', version: 1 });
      await expect(request(rolePath, 'PUT', { role: 'member', version: 0 }), 409);
      assert.deepEqual(await expect(request(rolePath, 'PUT', { role: 'member', version: 1 }), 200), { role: 'member', version: 2 });
      const membershipPath = `/api/hub/v1/access/default/connections/node/members/${member.id}`;
      const membership = { role: 'developer', version: 0, nodeVersion, migrateLegacy: true,
        environments: { codex: 'developer', openclaw: 'disabled' } };
      const savedMembership = await expect(request(membershipPath, 'PUT', membership), 200);
      assert.ok(savedMembership);
      await expect(request(membershipPath, 'PUT', membership), 409);
      await expect(request(membershipPath), 200);
      const grantPath = '/api/hub/v1/connections/node/grants';
      const grant = await expect(request(grantPath, 'POST', { userId: recipient.id, nodeVersion,
        policy: { runtime: 'codex', sessionKey: 'codex:synthetic/空 格', actions: ['messages:read'] } }), 201);
      assert.equal(grant.grant.userId, recipient.id);
      const grantPage = await expect(request(grantPath), 200);
      assert.equal(grantPage.verified, true); assert.equal(grantPage.nodeVersion, nodeVersion);
      await expect(request('/api/hub/v1/access/directory'), 200);
      const connectionPath = '/api/hub/v1/connections/saved-node';
      const savedConnection = await expect(request('/api/hub/v1/connections', 'POST', {
        id: 'saved-node', label: 'Frontend connection', connectorUrl: 'https://unused.invalid/',
        token: 'isolated-daily-token', capabilities: ['sessions', 42, 'messages'], frontendExtra: true,
      }), 201);
      assert.equal(savedConnection.connection.hasCredential, true);
      assert.deepEqual(savedConnection.connection.capabilities, ['sessions', 'messages']);
      assert.equal(savedConnection.connection.token, undefined);
      assert.equal(savedConnection.connection.credentialToken, undefined);
      const renamedConnection = await expect(request(connectionPath, 'PATCH', {
        label: ' Renamed connection ', environmentLabel: ' Frontend environment ', frontendExtra: true,
      }), 200);
      assert.equal(renamedConnection.connection.label, 'Renamed connection');
      assert.equal(renamedConnection.connection.environmentLabel, 'Frontend environment');
      assert.equal(renamedConnection.connection.hasCredential, true);
      assert.equal((await expect(request(connectionPath + '/maintenance-credential', 'PUT', {
        token: ' isolated-maintenance-token ', frontendExtra: true,
      }), 200)).hasMaintenanceCredential, true);
      const disabledConnection = await expect(request(connectionPath, 'PATCH', { enabled: false }), 200);
      assert.equal(disabledConnection.connection.status, 'disabled');
      assert.equal(disabledConnection.connection.hasCredential, true);
      await expect(request('/api/hub/v1/connections', 'POST', {
        id: 'deleted-node', connectorUrl: 'https://unused.invalid',
      }), 201);
      assert.deepEqual(await expect(request('/api/hub/v1/connections/deleted-node', 'DELETE'), 200), { ok: true });
      assert.deepEqual(await expect(request('/api/hub/v1/connections/deleted-node', 'DELETE'), 404), { ok: false });
      loseNextConnectionReply = true;
      const unknown = await expect(request('/api/hub/v1/connections', 'POST', {
        id: 'unknown-node', connectorUrl: 'https://unused.invalid',
      }), 503);
      assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE|isolated lost/);
      assert.equal(lostReplies, 1);
      assert.equal((await expect(request('/api/hub/v1/connections/unknown-node', 'PATCH', {
        label: 'Explicitly reconciled existing connection',
      }), 200)).connection.id, 'unknown-node');
      await expect(request('/api/hub/v1/users', 'POST', { label: 'forbidden' }, { cookie: `agentopsdeck_session=${memberCookie}` }), 403);
      for (const kind of ['memberSnapshot', 'userChange', 'memberKeyIssue', 'memberKeysRead', 'memberKeyRevoke',
        'roleRead', 'roleSet', 'membershipRead', 'membershipSet', 'grantRead', 'grantChange', 'accessDirectory',
        'connectionSnapshot', 'connectionTarget', 'connectionChange']) assert.ok(kinds.includes(kind), kind);
      await application.close(); application = createApplication(config);
      const reopenedConnection = await expect(request(connectionPath, 'PATCH', { label: 'Reopened connection' }), 200);
      assert.equal(reopenedConnection.connection.status, 'disabled');
      assert.equal(reopenedConnection.connection.environmentLabel, 'Frontend environment');
      assert.equal(reopenedConnection.connection.hasCredential, true);
      assert.deepEqual(await expect(request(rolePath), 200), { role: 'member', version: 2 });
      assert.equal((await expect(request(keyPath), 200)).keys.length, 0);
      assert.equal((await expect(request(grantPath), 200)).grants.some((value: { id: string }) => value.id === grant.grant.id), true);
      await expect(request(membershipPath), 200);
      await expect(request('/api/auth/logout', 'POST'), 200);
      await expect(request(rolePath), 401);
      await application.close(); application = createApplication(config);
      await expect(request(rolePath), 401);
    } finally { await application.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
