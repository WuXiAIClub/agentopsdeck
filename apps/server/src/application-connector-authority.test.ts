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

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true])
  for (const outcome of ['normal', 'lost', 'cancel', 'cancel-only', 'close'] as const) {
    test(`application HTTP Connector ${backend}/${member ? 'member' : 'administrator'}/${outcome} retains original authority and saved login`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'application-connector-authority-'));
      const administratorKey = 'isolated-connector-administrator';
      const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
        AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-connector-vault',
        AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
        AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
        AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
        ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
      const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
      const userId = member ? seed.createUser('Connector member').id : 'default';
      const key = seed.identities.issueKey(userId), cookie = `agentopsdeck_session=${seed.identities.createSession(key.token)!}`;
      const node = 'node_' + randomUUID();
      seed.upsertConnection({ id: 'node', ownerUserId: userId, kind: 'remote', label: 'Original node', connectorUrl: 'http://authority-fixture.invalid', credentialToken: 'PRIVATE_DAILY' });
      seed.updateMaintenanceCredential('node', 'PRIVATE_MAINTENANCE', userId);
      seed.pinConnectionNode('node', userId, seed.connectionAuthority('node', userId)!, node);
      await seed.close(); // Never open a second writer alongside the application.
      let application = createApplication(config), remote = 0, reads = 0, hold = outcome !== 'normal', drained = false;
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
      const original = OriginalHubAdministrativeCommands.prototype.command;
      t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
        const payload = input as { command?: { action?: string } };
        const reply = original.call(this, kind, input);
        if (kind === 'connectorAccess') {
          reads++;
          if (payload.command?.action === 'open' && hold) {
            hold = false;
            return reply.then(async value => { entered(); await gate;
              if (outcome === 'lost') throw Error('PRIVATE original authority reply lost');
              return value;
            });
          }
        }
        return reply;
      });
      t.mock.method(globalThis, 'fetch', async (raw: Request | string | URL, init?: RequestInit) => {
        const request = raw instanceof Request ? raw : new Request(raw, init);
        assert.equal(new URL(request.url).origin, 'http://authority-fixture.invalid');
        assert.equal(request.headers.get(EXPECTED_NODE_HEADER), node);
        const maintenance = new URL(request.url).pathname.endsWith('/gateway/model-set');
        assert.equal(request.headers.get('authorization'), maintenance ? 'Bearer PRIVATE_MAINTENANCE' : 'Bearer PRIVATE_DAILY');
        remote++;
        return Response.json({ ok: true }, { headers: {
          [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: node,
        } });
      });
      const path = '/api/hub/v1/connections/node/capabilities';
      const expect = async (response: Response | Promise<Response>, status: number) => {
        const value = await response, text = await value.text(); assert.equal(value.status, status, text);
        assert.doesNotMatch(text, /PRIVATE|Bearer|credentialToken|reply lost/);
        assert.equal(value.headers.get('set-cookie'), null); return text;
      };
      try {
        const controller = new AbortController();
        const pending = application.app.request(path, { headers: { cookie }, signal: controller.signal });
        if (outcome !== 'normal') {
          await admission; assert.equal(remote, 0); assert.equal(reads, 1);
          if (outcome === 'cancel' || outcome === 'cancel-only') controller.abort();
          if (outcome === 'cancel' || outcome === 'close') {
            const closing = application.close(); void closing.then(() => { drained = true; });
            await tick(); assert.equal(drained, false);
            release(); await expect(pending, 503); // Shutdown outranks cancellation; original ACK still drains.
            await closing; assert.equal(drained, true);
          } else { release(); await expect(pending, outcome === 'cancel-only' ? 499 : 503); }
          assert.equal(reads, 1); assert.equal(remote, 0); // No synchronous fallback or hidden retry.
        } else {
          await expect(pending, 200); assert.ok(reads >= 3); assert.equal(remote, 1);
          for (const suffix of ['files/agents/fixture', 'gateway/model-set'])
            await expect(application.app.request(`/api/hub/v1/connections/node/${suffix}`, { headers: { cookie } }), 200);
          assert.equal(remote, 3);
        }
        await application.close(); application = createApplication(config);
        const before = remote;
        await expect(application.app.request(path, { headers: { cookie } }), 200);
        assert.equal(remote, before + 1);
        await expect(application.app.request(path, { headers: { cookie, 'x-agentopsdeck-key': 'hub_key_' + 'z'.repeat(43) } }), 401);
        assert.equal(remote, before + 1);
      } finally { release(); await application.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
