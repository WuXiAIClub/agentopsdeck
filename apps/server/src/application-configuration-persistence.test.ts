import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceFileCardResource } from '@agentopsdeck/shared';
import { HUB_CONFIGURATION_KINDS } from './hub/member-configuration-domain.js';
import { configurationWrite } from './hub/configuration-test-fixtures.js';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';

const tick = () => new Promise<void>(yes => setImmediate(yes));
for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true])
  for (const kind of HUB_CONFIGURATION_KINDS) for (const outcome of ['normal', 'lost', 'cancel-lost', 'close'] as const)
    test(`application configuration ${backend}/${member ? 'member' : 'administrator'}/${kind}/${outcome}: durable original state and exact receipt reconciliation`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'application-configuration-')), administratorKey = 'isolated-configuration-administrator';
      const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
        AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-configuration-vault',
        AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
        AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
        AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
        ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
      const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey), resource = randomUUID();
      const userId = member ? seed.createUser('Configuration member').id : 'default', key = seed.identities.issueKey(userId);
      const cookie = `agentopsdeck_session=${seed.identities.createSession(key.token)!}`;
      const body = configurationWrite(kind);
      await seed.close(); let application = createApplication(config), effects = 0, holding = outcome !== 'normal';
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
      const original = OriginalHubAdministrativeCommands.prototype.command;
      t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
        const reply = original.call(this, kind, input), command = (input as { command?: { action?: string } }).command;
        if (kind === 'workspaceConfiguration' && command?.action === 'save') {
          effects++; if (holding) { holding = false; return reply.then(async value => { entered(); await gate;
            if (outcome === 'lost' || outcome === 'cancel-lost') throw Error('PRIVATE original configuration ACK lost'); return value;
          }); }
        }
        return reply;
      });
      const base = `/api/hub/v1/workspace/file-cards/${encodeURIComponent(workspaceFileCardResource(kind, resource))}/configuration`, headers = { cookie, 'content-type': 'application/json' };
      const send = (signal?: AbortSignal, value = body) => application.app.request(base, { method: 'PUT', headers, body: JSON.stringify(value), ...(signal ? { signal } : {}) });
      try {
        const controller = new AbortController(), pending = send(controller.signal);
        if (outcome !== 'normal') {
          const admitted = await Promise.race([admission.then(() => true), Promise.resolve(pending).then(() => false)]);
          assert.equal(admitted, true, 'Request settled before original write admission');
          assert.equal(effects, 1); if (outcome === 'cancel-lost') controller.abort();
          let settled = false; void Promise.resolve(pending).then(() => { settled = true; }); await tick(); assert.equal(settled, false);
          if (outcome === 'close') {
            const closing = application.close(); let drained = false; void closing.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
            release(); assert.equal((await pending).status, 503); await closing; assert.equal(drained, true);
          } else { release(); const response = await pending; assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE|hub_session_|ACK lost/); }
        } else { const response = await pending; assert.equal(response.status, 200, await response.clone().text()); }
        assert.equal(effects, 1, 'no automatic replay after unknown ACK or closing');
        await application.close(); application = createApplication(config);
        const read = await application.app.request(base, { headers }); assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
        const state = (await read.json()).document; assert.equal(state.revision, 1); assert.deepEqual(state.content, body.content);
        const receipt = await (await send()).json(); const { updatedAt, ...projection } = receipt;
        assert.ok(Number.isSafeInteger(updatedAt)); assert.deepEqual(projection, state);
        assert.deepEqual(await (await send()).json(), receipt, 'same mutation reconciles exact original receipt');
        assert.equal((await send(undefined, { ...body, mutationId: randomUUID() })).status, 409, 'old frontend CAS remains enforced');
        assert.equal((await send(undefined, { ...body, content: { ...body.content, title: 'Changed receipt body' } } as typeof body)).status, 409);
        assert.deepEqual((await (await application.app.request(base, { headers })).json()).document, state);
      } finally { release(); await application.close(); rmSync(root, { recursive: true, force: true }); }
    });
