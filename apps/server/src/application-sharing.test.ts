import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { LEGACY_HUB_PRINCIPAL } from './hub/identity.js';
import { encodeHubSessionId } from './hub/session-id.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';

for (const backend of ['json', 'sqlite'] as const) {
  test(`actual ${backend} application sharing awaits original permissions, keeps wire/CAS and reconciles lost ACK without replay`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'application-sharing-'));
    const administratorKey = 'isolated-sharing-admin';
    const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
      AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-sharing-vault',
      AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
      AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
      AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
      ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
    const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
    const creator = seed.createUser('Session creator'), recipient = seed.createUser('Recipient');
    seed.upsertConnection({ id: 'node', ownerUserId: 'default', kind: 'remote', label: 'Original environment', connectorUrl: 'http://unused.invalid' });
    seed.pinConnectionNode('node', 'default', seed.connectionAuthority('node', 'default')!, 'node_' + randomUUID());
    const nodeVersion = seed.connectionAuthority('node', 'default')!;
    const target = (userId: string) => ({ ownerUserId: 'default', connectionId: 'node', userId });
    for (const user of [creator, recipient]) {
      const member = target(user.id);
      seed.roles.save(LEGACY_HUB_PRINCIPAL, member, { ...seed.roles.membership(member), role: 'developer', migrateLegacy: true,
        nodeVersion, environments: { codex: 'developer', openclaw: 'disabled' } });
    }
    const cookie = (userId: string) => {
      const key = seed.identities.issueKey(userId);
      return `agentopsdeck_session=${seed.identities.createSession(key.token)!}`;
    };
    const creatorCookie = cookie(creator.id), recipientCookie = cookie(recipient.id);
    const createdKey = 'codex:' + randomUUID();
    const creation = seed.grants.authorize(target(creator.id), 'sessions:create', { runtime: 'codex' })!;
    seed.grants.acceptCreatedSession(creation, createdKey, randomUUID(), randomUUID(), () => {});
    const ownedId = encodeHubSessionId('node', 'codex:' + randomUUID());
    const sharedId = encodeHubSessionId('node', createdKey);
    await seed.close();
    let application = createApplication(config);
    const calls: Array<{ kind: string; action: string | undefined }> = [];
    const original = OriginalHubAdministrativeCommands.prototype.command;
    let loseNext: 'sessionSharing' | 'ownedSessionSharing' | undefined;
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      const action = (input as { command?: { action?: string } }).command?.action;
      calls.push({ kind, action });
      const reply = original.call(this, kind, input);
      if (kind === loseNext && action === 'create') {
        loseNext = undefined;
        return reply.then(() => { throw Error('PRIVATE lost sharing ACK'); });
      }
      return reply;
    });
    const request = (path: string, method = 'GET', body?: unknown, cookie?: string) => application.app.request(path, {
      method, headers: { ...(cookie ? { cookie } : { 'x-agentopsdeck-key': administratorKey }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const expect = async (response: Response | Promise<Response>, status: number) => {
      const value = await response, text = await value.text();
      assert.equal(value.status, status, text);
      assert.equal(value.headers.get('cache-control'), 'no-store');
      return text.length ? JSON.parse(text) : undefined;
    };
    const owned = `/api/hub/v1/sessions/${ownedId}/collaborators`;
    const shared = `/api/hub/v1/shared/default/sessions/${sharedId}/collaborators`;
    try {
      for (const [path, credentials, domain] of [[owned, undefined, 'ownedSessionSharing'], [shared, creatorCookie, 'sessionSharing']] as const) {
        const initial = await expect(request(path, 'GET', undefined, credentials), 200);
        assert.ok(initial.candidates.some((user: { id: string }) => user.id === recipient.id));
        loseNext = domain;
        const before = calls.filter(call => call.kind === domain && call.action === 'create').length;
        const unknown = await expect(request(path, 'POST', { userId: recipient.id, role: 'collaborator', media: true }, credentials), 503);
        assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE|lost sharing ACK/);
        assert.equal(calls.filter(call => call.kind === domain && call.action === 'create').length, before + 1);
        const listing = await expect(request(path, 'GET', undefined, credentials), 200);
        const matches = listing.collaborators.filter((grant: { userId: string }) => grant.userId === recipient.id);
        assert.equal(matches.length, 1); // The real write committed despite an unknown HTTP outcome.
        const grant = matches[0]; assert.equal(grant.version, 1);
        const update = { version: grant.version, role: 'observer', live: false, media: false };
        const updated = await expect(request(path + '/' + grant.id, 'PUT', update, credentials), 200);
        assert.equal(updated.grant.version, 2);
        assert.deepEqual([...updated.grant.policy.actions].sort(), ['messages:read', 'sessions:read']);
        await expect(request(path + '/' + grant.id, 'PUT', update, credentials), 409);
        const received = await expect(request('/api/hub/v1/shared/grants', 'GET', undefined, recipientCookie), 200);
        assert.ok(received.grants.some((value: { id: string }) => value.id === grant.id));
        await application.close(); application = createApplication(config);
        const reopened = await expect(request(path, 'GET', undefined, credentials), 200);
        assert.equal(reopened.collaborators.find((value: { id: string }) => value.id === grant.id)?.version, 2);
        const revoked = await expect(request(path + '/' + grant.id, 'DELETE', { version: 2 }, credentials), 200);
        // Member sharing reports durable downstream revocation separately from
        // the owner-only compatibility route. With no leases issued here, the
        // exact original grant version must already be confirmed, not pending.
        const revocation = { state: 'confirmed', pending: 0, confirmed: 0 };
        assert.deepEqual(revoked, domain === 'sessionSharing' ? { ok: true, revocation } : { ok: true });
        if (domain === 'sessionSharing') {
          assert.deepEqual(await expect(request(path + '/' + grant.id + '/revocation?version=2', 'GET', undefined, credentials), 200), { revocation });
        }
        await expect(request(path + '/' + grant.id, 'DELETE', { version: 2 }, credentials), 409);
        const afterRevocation = await expect(request('/api/hub/v1/shared/grants', 'GET', undefined, recipientCookie), 200);
        assert.ok(!afterRevocation.grants.some((value: { id: string }) => value.id === grant.id));
        await application.close(); application = createApplication(config);
        const afterRestart = await expect(request(path, 'GET', undefined, credentials), 200);
        assert.ok(!afterRestart.collaborators.some((value: { id: string }) => value.id === grant.id));
        if (domain === 'sessionSharing') {
          assert.deepEqual(await expect(request(path + '/' + grant.id + '/revocation?version=2', 'GET', undefined, credentials), 200), { revocation });
        }
      }
      await expect(request('/api/hub/v1/shared/grants?unsupported=true', 'GET', undefined, recipientCookie), 400);
      await expect(request(owned, 'GET', undefined, recipientCookie), 404);
      await expect(request('/api/auth/logout', 'POST', undefined, creatorCookie), 200);
      // Rejected by the outer authentication middleware, before this route's
      // no-store wrapper runs; verify denial, not route-local headers.
      assert.equal((await request(shared, 'POST', { userId: recipient.id, role: 'observer' }, creatorCookie)).status, 401);
      for (const kind of ['receivedGrants', 'sessionCollaborators', 'sessionSharing', 'ownedSessionSharing']) assert.ok(calls.some(call => call.kind === kind));
    } finally { await application.close(); }
    const reopened = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
    try {
      const db = (reopened as unknown as { db: DatabaseSync }).db;
      for (const table of ['command_receipts', 'hub_execution_leases']) assert.equal(db.prepare('SELECT count(*) AS n FROM ' + table).get()!.n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM hub_session_owners').get()!.n, 1);
    } finally { await reopened.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
