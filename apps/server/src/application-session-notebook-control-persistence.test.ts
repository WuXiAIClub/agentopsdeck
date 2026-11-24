import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';
import { LEGACY_HUB_PRINCIPAL } from './hub/identity.js';
import { encodeHubSessionId } from './hub/session-id.js';

const tick = () => new Promise<void>(yes => setImmediate(yes));
for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true])
  for (const shared of [false, true]) for (const action of ['move', 'issue', 'revoke'] as const)
    for (const outcome of ['normal', 'lost', 'cancel-lost', 'close'] as const) {
      if (shared && action !== 'move') continue;
      test(`application session control ${backend}/${member ? 'member' : 'admin'}/${shared ? 'shared' : 'owner'}/${action}/${outcome}: reopen without replay`, async t => {
        const root = mkdtempSync(join(tmpdir(), 'application-session-control-'));
        const administratorKey = 'isolated-session-control-administrator';
        const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
          AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-session-control-vault',
          AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
          AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
          AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
          ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
        const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
        const userId = seed.createUser('Session actor').id;
        if (!member) seed.roles.setHubRole(LEGACY_HUB_PRINCIPAL, userId, 'admin', 0);
        const key = seed.identities.issueKey(userId), cookie = `agentopsdeck_session=${seed.identities.createSession(key.token)!}`;
        const ownerUserId = shared ? seed.createUser('Node owner').id : userId;
        const nodeId = 'node_11111111-1111-4111-8111-111111111111', remote = 'codex:original';
        seed.upsertConnection({ id: 'fixture', ownerUserId, kind: 'local', connectorUrl: 'local://aod-connector', label: 'Isolated' });
        seed.pinConnectionNode('fixture', ownerUserId, seed.connectionAuthority('fixture', ownerUserId)!, nodeId);
        if (shared) seed.grants.create({ ownerUserId, connectionId: 'fixture', userId },
          { runtime: 'codex', sessionKey: remote, actions: ['messages:read'] });
        const resourceId = JSON.stringify([ownerUserId, nodeId, 'codex', 'original']);
        seed.notebooks.save(userId, { resourceId, revision: 0, text: 'hello world' });
        const capability = seed.notebookCapabilities.issue(userId, resourceId,
          { facets: ['hot:read'], expiresAt: Date.now() + 600_000 }, null)!;
        await seed.close();
        const input = { requestId: randomUUID(), direction: 'archive', hotRevision: 1, coldRevision: 0,
          ranges: [{ start: 0, end: 5, sha256: createHash('sha256').update('hello').digest('hex') }] };
        let application = createApplication(config), effects = 0, holding = outcome !== 'normal';
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
        const original = OriginalHubAdministrativeCommands.prototype.command;
        t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, command: never) {
          const reply = original.call(this, kind, command);
          if (String(kind) === 'notebookControl') {
            const op = (command as { command: { action: string } }).command.action;
            if (op === action) {
              effects++;
              if (holding) { holding = false; return reply.then(async value => {
                entered(); await gate;
                if (outcome === 'lost' || outcome === 'cancel-lost') throw Error('PRIVATE session control ACK lost');
                return value;
              }); }
            }
          }
          return reply;
        });
        const base = '/api/hub/v1/' + (shared ? `shared/${ownerUserId}/sessions/` : 'sessions/')
          + encodeURIComponent(encodeHubSessionId('fixture', remote)) + '/notebook';
        const path = base + (action === 'move' ? '/moves' : action === 'issue' ? '/capabilities' : `/capabilities/${capability.capability.id}`);
        const headers = { cookie, 'content-type': 'application/json' };
        const send = (signal?: AbortSignal) => application.app.request(path, { method: action === 'revoke' ? 'DELETE' : 'POST', headers,
          ...(action === 'revoke' ? {} : { body: JSON.stringify(action === 'move' ? input
            : { facets: ['hot:read'], expiresAt: Date.now() + 600_000 }) }), ...(signal ? { signal } : {}) });
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
              assert.doesNotMatch(await response.text(), /PRIVATE|ACK lost|aod_note_/);
            }
          } else assert.equal((await pending).status, action === 'issue' ? 201 : 200);
          assert.equal(effects, 1); await application.close(); application = createApplication(config);
          const hot = await application.app.request(base, { headers }); assert.equal(hot.status, 200);
          assert.equal((await hot.json()).text, action === 'move' ? ' world' : 'hello world');
          if (action === 'move') {
            const receipt = await application.app.request(base + `/moves/${input.requestId}`, { headers });
            assert.equal(receipt.status, 200); assert.equal((await receipt.json()).moved, 5);
            const cold = await application.app.request(base + '/archive', { headers }); assert.equal((await cold.json()).text, 'hello');
          } else {
            const caps = await application.app.request(base + '/capabilities', { headers }); assert.equal(caps.status, 200);
            const list = (await caps.json()).capabilities;
            assert.equal(list.length, action === 'issue' ? 2 : 1);
            if (action === 'revoke') assert.ok(list[0].revokedAt !== null);
          }
          assert.equal(effects, 1, 'reopen and reads must never replay unknown writes or mint another token');
        } finally { release(); await application.close(); rmSync(root, { recursive: true, force: true }); }
      });
    }
