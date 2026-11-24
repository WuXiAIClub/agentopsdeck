import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';
import { notebookHash } from './hub/notebook-operations.js';
import { LEGACY_HUB_PRINCIPAL } from './hub/identity.js';

const tick = () => new Promise<void>(yes => setImmediate(yes));
for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true])
  for (const action of ['move', 'issue', 'revoke'] as const) for (const outcome of ['normal', 'lost', 'cancel-lost', 'close'] as const) {
    test(`application notebook control ${backend}/${member ? 'member' : 'administrator'}/${action}/${outcome}: reconcile original state without replay`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'application-notebook-control-')), adminKey = 'isolated-control-admin';
      const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: adminKey,
        AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-control-vault',
        AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
        AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
        AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
        ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
      const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], adminKey);
      const userId = seed.createUser(member ? 'Control member' : 'Control administrator').id;
      if (!member) seed.roles.setHubRole(LEGACY_HUB_PRINCIPAL, userId, 'admin', 0);
      const key = seed.identities.issueKey(userId);
      const cookie = `agentopsdeck_session=${seed.identities.createSession(key.token)!}`, resourceId = JSON.stringify(['hub-notebook', 1]);
      assert.deepEqual(seed.identities.requestPrincipal(new Request('http://fixture.invalid', { headers: { cookie } }), () => false),
        { userId, admin: !member });
      seed.notebooks.save(userId, { resourceId, revision: 0, text: 'hello world' });
      const grantInput = { facets: ['hot:read' as const], expiresAt: Date.now() + 600_000 };
      const seeded = action === 'revoke' ? seed.notebookCapabilities.issue(userId, resourceId, grantInput, null)! : undefined;
      const move = { requestId: randomUUID(), hotRevision: 1, coldRevision: 0, direction: 'archive',
        ranges: [{ start: 0, end: 5, sha256: notebookHash('hello') }] };
      await seed.close();
      let application = createApplication(config), effects = 0, holding = outcome !== 'normal';
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
      const original = OriginalHubAdministrativeCommands.prototype.command;
      t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
        const reply = original.call(this, kind, input);
        if (String(kind) === 'notebookControl' && (input as { command: { action: string } }).command.action === action) {
          effects++;
          if (holding) { holding = false; return reply.then(async value => {
            entered(); await gate;
            if (outcome === 'lost' || outcome === 'cancel-lost') throw Error('PRIVATE control ACK lost'); return value;
          }); }
        }
        return reply;
      });
      const base = '/api/hub/v1/notebooks/default', headers = { cookie, 'content-type': 'application/json' };
      const path = base + (action === 'move' ? '/moves' : '/capabilities' + (seeded ? '/' + seeded.capability.id : ''));
      const send = (signal?: AbortSignal) => application.app.request(path, { method: action === 'revoke' ? 'DELETE' : 'POST', headers,
        ...(action === 'revoke' ? {} : { body: JSON.stringify(action === 'move' ? move : grantInput) }), ...(signal ? { signal } : {}) });
      try {
        const controller = new AbortController(), pending = send(controller.signal);
        if (outcome !== 'normal') {
          await admission; assert.equal(effects, 1);
          if (outcome === 'cancel-lost') controller.abort();
          let settled = false; void Promise.resolve(pending).then(() => { settled = true; });
          await tick(); assert.equal(settled, false, 'write ACK remains owned after cancellation');
          if (outcome === 'close') {
            const closing = application.close(); let closed = false; void closing.then(() => { closed = true; });
            await tick(); assert.equal(closed, false); release(); assert.equal((await pending).status, 503); await closing;
          } else {
            release(); const response = await pending; assert.equal(response.status, 503);
            assert.doesNotMatch(await response.text(), /PRIVATE|ACK lost|aod_note_|hub_session_/);
          }
        } else assert.equal((await pending).status, action === 'issue' ? 201 : 200);
        assert.equal(effects, 1); await application.close(); application = createApplication(config);
        const read = await application.app.request(base + (action === 'move' ? '/moves/' + move.requestId : '/capabilities'), { headers });
        assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
        const state = await read.json();
        if (action === 'move') {
          assert.deepEqual(state, { hotRevision: 2, coldRevision: 1, moved: 5 });
          assert.equal((await (await application.app.request(base, { headers })).json()).text, ' world');
          assert.equal((await (await application.app.request(base + '/archive', { headers })).json()).text, 'hello');
        } else {
          assert.equal(state.capabilities.length, 1);
          assert.equal(state.capabilities[0].revokedAt !== null, action === 'revoke');
          assert.equal(state.capabilities[0].resourceId, resourceId);
          assert.equal(Object.hasOwn(state.capabilities[0], 'token'), false, 'lost issuance never reconstructs a token');
        }
        assert.equal(effects, 1, 'reopen/read never replay an unknown mutation');
      } finally { release(); await application.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
