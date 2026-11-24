import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
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
import { performanceDiagnostics, PerformanceDiagnostics } from './diagnostics/performance.js';

for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true])
  for (const outcome of ['normal', 'remote-lost', 'projection-lost', 'cancel', 'close'] as const)
    test(`application connector user ${backend}/${member}/${outcome}: original cookie, single effect, reopen`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'application-connector-user-authority-'));
      const administratorKey = 'isolated-connector-user-administrator', node = 'node_' + randomUUID();
      const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
        AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
        AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-connector-user-vault',
        AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
        AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
        AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
        ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
      const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
      const userId = member ? seed.createUser('Original member').id : 'default', key = seed.identities.issueKey(userId);
      if (!member) (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(userId);
      const cookie = 'agentopsdeck_session=' + seed.identities.createSession(key.token)!;
      seed.upsertConnection({ id: 'target', ownerUserId: userId, kind: 'remote', label: 'Original node',
        connectorUrl: 'http://connector-user-fixture.invalid', credentialToken: 'PRIVATE_TOKEN' });
      seed.pinConnectionNode('target', userId, seed.connectionAuthority('target', userId)!, node);
      await seed.close();
      let application = createApplication(config), effects = 0, targets = 0, projections = 0, hold = outcome !== 'normal';
      let release!: () => void, entered!: () => void, drained = false;
      const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
      const rows: string[] = [], diagnostics = new PerformanceDiagnostics(line => { rows.push(line); });
      const originalStart = performanceDiagnostics.start.bind(performanceDiagnostics);
      t.mock.method(performanceDiagnostics, 'start', (...args: Parameters<typeof performanceDiagnostics.start>) =>
        args[0] === 'hub-connector-user-change' || args[0] === 'hub-connector-user-http' ? diagnostics.start(...args) : originalStart(...args));
      const original = OriginalHubAdministrativeCommands.prototype.command;
      t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
        if (kind === 'connectionTarget') targets++;
        const reply = original.call(this, kind, input);
        if (kind !== 'connectionSnapshot') return reply;
        projections++;
        if (hold && outcome !== 'remote-lost') {
          hold = false;
          return reply.then(async value => { entered(); await gate;
            if (outcome === 'projection-lost') throw Error('PRIVATE projection reply lost');
            return value;
          });
        }
        return reply;
      });
      t.mock.method(globalThis, 'fetch', async (raw: Request | string | URL, init?: RequestInit) => {
        const request = raw instanceof Request ? raw : new Request(raw, init), url = new URL(request.url);
        assert.equal(url.origin, 'http://connector-user-fixture.invalid');
        assert.equal(request.headers.get(EXPECTED_NODE_HEADER), node);
        assert.equal(request.headers.get('authorization'), 'Bearer PRIVATE_TOKEN');
        assert.equal(url.pathname, request.method === 'POST' ? '/api/connector/v1/users' : '/api/connector/v1/users/original-user');
        assert.ok(['POST', 'PATCH'].includes(request.method));
        assert.deepEqual(await request.json(), { label: 'Private label' }); effects++;
        if (hold && outcome === 'remote-lost') { hold = false; throw Error('PRIVATE remote ACK lost'); }
        return Response.json({ user: { id: 'original-user', label: 'Private label', createdAt: 1, updatedAt: 2 }, updatedAt: 2 }, {
          status: request.method === 'POST' ? 201 : 200,
          headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: node },
        });
      });
      const request = (method: 'POST' | 'PATCH', signal?: AbortSignal) => application.app.request(
        '/api/hub/v1/connections/target/connector-users' + (method === 'PATCH' ? '/original-user' : ''), {
          method, ...(signal ? { signal } : {}), headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Private label' }),
        });
      const expect = async (pending: Response | Promise<Response>, status: number) => {
        const response = await pending, body = await response.text(); assert.equal(response.status, status, body);
        assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.doesNotMatch(body, /PRIVATE_TOKEN|reply lost|ACK lost|credentialToken/);
        if (status < 300) {
          const value = JSON.parse(body); assert.equal(value.user.id, 'original-user'); assert.equal(value.connection.id, 'target');
          assert.equal(value.connection.supported, true); assert.equal(value.connection.userCount, 1);
          assert.deepEqual(value.connection.users, [value.user]); assert.equal(value.updatedAt, 2);
        } else assert.doesNotMatch(body, /Private label|original-user/);
      };
      try {
        const abort = new AbortController(), pending = request('POST', abort.signal);
        if (outcome === 'projection-lost' || outcome === 'cancel' || outcome === 'close') {
          await admission; assert.equal(effects, 1);
          if (outcome === 'cancel') abort.abort();
          if (outcome === 'cancel' || outcome === 'close') {
            const closing = application.close().then(() => { drained = true; });
            await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
            release(); await expect(pending, 503); await closing; assert.equal(drained, true);
          } else { release(); await expect(pending, 503); }
        } else await expect(pending, outcome === 'normal' ? 201 : 502);
        assert.equal(effects, 1, 'late errors never replay the admitted remote mutation');
        await application.close(); application = createApplication(config);
        await expect(request('PATCH'), 200); assert.equal(effects, 2);
        assert.ok(targets >= 4); assert.ok(projections >= 1);
        const events = rows.map(line => JSON.parse(line)).filter(row => row.operation === 'hub-connector-user-change' && row.phase === 'finished');
        assert.equal(events.length, 2); assert.equal(events[0].admitted, 1);
        const httpEvents = rows.map(line => JSON.parse(line)).filter(row => row.operation === 'hub-connector-user-http' && row.phase === 'finished');
        assert.equal(httpEvents.length, 2, 'HTTP and transaction outcomes each have one distinct event per request');
        assert.equal(events[0].unknown, outcome === 'remote-lost' ? 1 : undefined);
        assert.equal(events[0].settled, outcome === 'remote-lost' ? undefined : 1);
        assert.doesNotMatch(rows.join('\n'), /PRIVATE|Private label|original-user|connector-user-fixture/);
      } finally { release(); await application.close(); rmSync(root, { recursive: true, force: true }); }
    });
