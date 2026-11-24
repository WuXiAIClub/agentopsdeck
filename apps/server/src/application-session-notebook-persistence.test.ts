import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';
import { LEGACY_HUB_PRINCIPAL } from './hub/identity.js';
import { encodeHubSessionId } from './hub/session-id.js';

const tick = () => new Promise<void>(yes => setImmediate(yes));
for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true])
  for (const shared of [false, true]) for (const area of ['hot', 'cold'] as const)
    for (const outcome of ['normal', 'lost', 'cancel-lost', 'close'] as const) {
      test(`application session notebook ${backend}/${member ? 'member' : 'admin'}/${shared ? 'shared' : 'owner'}/${area}/${outcome}: durable CAS without replay`, async t => {
        const root = mkdtempSync(join(tmpdir(), 'application-session-notebook-'));
        const administratorKey = 'isolated-session-notebook-administrator';
        const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
          AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-session-notebook-vault',
          AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
          AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
          AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
          ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
        const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
        const userId = seed.createUser(member ? 'Session member' : 'Session administrator').id;
        if (!member) seed.roles.setHubRole(LEGACY_HUB_PRINCIPAL, userId, 'admin', 0);
        const key = seed.identities.issueKey(userId), cookie = `agentopsdeck_session=${seed.identities.createSession(key.token)!}`;
        assert.deepEqual(seed.identities.requestPrincipal(new Request('http://fixture.invalid', { headers: { cookie } }), () => false),
          { userId, admin: !member });
        const ownerUserId = shared ? seed.createUser('Node owner').id : userId;
        const nodeId = 'node_11111111-1111-4111-8111-111111111111', remoteSessionKey = 'codex:original';
        seed.upsertConnection({ id: 'fixture', ownerUserId, kind: 'local', connectorUrl: 'local://aod-connector', label: 'Isolated' });
        seed.pinConnectionNode('fixture', ownerUserId, seed.connectionAuthority('fixture', ownerUserId)!, nodeId);
        if (shared) seed.grants.create({ ownerUserId, connectionId: 'fixture', userId },
          { runtime: 'codex', sessionKey: remoteSessionKey, actions: ['messages:read'] });
        const resourceId = JSON.stringify([ownerUserId, nodeId, 'codex', 'original']);
        const body = { resourceId, revision: 1, text: '**PRIVATE_SESSION_NOTEBOOK_TEXT**\n中文' };
        const initial = { resourceId, revision: 0, text: 'Original note' };
        if (area === 'cold') seed.notebooks.saveArchive(userId, initial); else seed.notebooks.save(userId, initial);
        await seed.close();
        let application = createApplication(config), effects = 0, snapshots = 0, holding = outcome !== 'normal';
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
        const original = OriginalHubAdministrativeCommands.prototype.command;
        t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
          const reply = original.call(this, kind, input);
          if (String(kind) === 'personalNotebook' && (input as {command: {action: string}}).command.action === 'snapshotSession') snapshots++;
          if (String(kind) === 'personalNotebook' && (input as {command: {action: string}}).command.action === 'saveSession') {
            effects++;
            if (holding) { holding = false; return reply.then(async value => {
              entered(); await gate;
              if (outcome === 'lost' || outcome === 'cancel-lost') throw Error('PRIVATE session ACK lost');
              return value;
            }); }
          }
          return reply;
        });
        const path = '/api/hub/v1/' + (shared ? `shared/${ownerUserId}/sessions/` : 'sessions/')
          + encodeURIComponent(encodeHubSessionId('fixture', remoteSessionKey)) + '/notebook' + (area === 'cold' ? '/archive' : '');
        const headers = { cookie, 'content-type': 'application/json' };
        const send = (signal?: AbortSignal) => application.app.request(path, { method: 'PUT', headers,
          body: JSON.stringify(body), ...(signal ? { signal } : {}) });
        try {
          const controller = new AbortController(), pending = send(controller.signal);
          if (outcome !== 'normal') {
            await admission; assert.equal(effects, 1);
            if (outcome === 'cancel-lost') controller.abort();
            let settled = false; void Promise.resolve(pending).then(() => { settled = true; });
            await tick(); assert.equal(settled, false);
            if (outcome === 'close') {
              const closing = application.close(); let drained = false; void closing.then(() => { drained = true; });
              await tick(); assert.equal(drained, false); release();
              assert.equal((await pending).status, 503); await closing; assert.equal(drained, true);
            } else {
              release(); const response = await pending; assert.equal(response.status, 503);
              assert.doesNotMatch(await response.text(), /PRIVATE|ACK lost|hub_session_/);
            }
          } else assert.equal((await pending).status, 200);
          assert.equal(effects, 1); await application.close(); application = createApplication(config);
          const read = await application.app.request(path, { headers }); assert.equal(read.status, 200);
          assert.equal(read.headers.get('cache-control'), 'no-store');
          const state = await read.json(); assert.equal(state.revision, 2); assert.equal(state.text, body.text);
          assert.equal(snapshots, 1, 'read uses the async snapshot domain, not a save');
          assert.equal(effects, 1, 'reopen/read never replay the original save');
          assert.equal((await send()).status, 409, 'legacy CAS remains conflict, not hidden retry');
          assert.deepEqual(await (await application.app.request(path, { headers })).json(), state);
        } finally { release(); await application.close(); rmSync(root, { recursive: true, force: true }); }
      });
    }
