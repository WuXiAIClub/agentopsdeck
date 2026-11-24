import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';

const tick = () => new Promise<void>(yes => setImmediate(yes));
for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true])
  for (const operation of ['save', 'issue', 'revoke'] as const) for (const outcome of ['normal', 'lost', 'cancel-lost', 'close'] as const) {
    test(`application board ${backend}/${member ? 'member' : 'administrator'}/${operation}/${outcome}: original durable state, no automatic replay`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'application-board-'));
      const administratorKey = 'isolated-board-administrator';
      const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
        AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-board-vault',
        AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
        AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
        AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
        ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
      const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
      const userId = member ? seed.createUser('Board member').id : 'default';
      const key = seed.identities.issueKey(userId), cookie = `agentopsdeck_session=${seed.identities.createSession(key.token)!}`;
      const taskId = randomUUID(), body = { title: 'Saved board', revision: 1, mutationId: randomUUID(),
        tasks: [{ id: taskId, title: 'Task', detail: 'PRIVATE_BOARD_BODY', status: 'todo' as const, tags: ['preserve'], priority: 'high' as const, dueDate: '2026-10-20' }] };
      seed.boards.save(userId, 'default', { ...body, title: 'Original board', revision: 0, mutationId: randomUUID() });
      const grant = { taskIds: [taskId], fields: ['status' as const], expiresAt: Date.now() + 60_000 };
      const issued = operation === 'revoke' ? seed.boardCapabilities.issue(userId, 'default', grant)! : undefined;
      await seed.close();
      let application = createApplication(config), effects = 0, holding = outcome !== 'normal';
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
      const original = OriginalHubAdministrativeCommands.prototype.command;
      t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
        const reply = original.call(this, kind, input);
        const command = (input as { command?: { action?: string } }).command;
        if ((kind === 'workspaceBoard' || kind === 'boardCapability') && command?.action === operation) {
          effects++;
          if (holding) { holding = false; return reply.then(async value => { entered(); await gate;
            if (outcome === 'lost' || outcome === 'cancel-lost') throw Error('PRIVATE original board ACK lost'); return value;
          }); }
        }
        return reply;
      });
      const base = '/api/hub/v1/workspace/boards/default', headers = { cookie, 'content-type': 'application/json' };
      const send = (signal?: AbortSignal) => application.app.request(base + (operation === 'save' ? '' : '/capabilities'
        + (operation === 'revoke' ? '/' + issued!.capability.id : '')), { headers, ...(signal ? { signal } : {}),
        method: operation === 'save' ? 'PUT' : operation === 'issue' ? 'POST' : 'DELETE',
        ...(operation === 'revoke' ? {} : { body: JSON.stringify(operation === 'save' ? body : grant) }) });
      try {
        const controller = new AbortController(), pending = send(controller.signal);
        if (outcome !== 'normal') {
          await admission; assert.equal(effects, 1);
          if (outcome === 'cancel-lost') controller.abort();
          let settled = false; void Promise.resolve(pending).then(() => { settled = true; });
          await tick(); assert.equal(settled, false, 'original admitted ACK remains owned');
          if (outcome === 'close') {
            const closing = application.close(); let drained = false; void closing.then(() => { drained = true; });
            await tick(); assert.equal(drained, false); release();
            assert.equal((await pending).status, 503); await closing; assert.equal(drained, true);
          } else { release(); const response = await pending; assert.equal(response.status, 503);
            assert.doesNotMatch(await response.text(), /PRIVATE|aod_board_|hub_session_|ACK lost/); }
        } else assert.equal((await pending).status, operation === 'issue' ? 201 : 200);
        await application.close(); application = createApplication(config);
        const read = await application.app.request(operation === 'save' ? base : base + '/capabilities', { headers });
        assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
        const state = await read.json();
        if (operation === 'save') {
          assert.equal(state.revision, 2); assert.equal(state.title, body.title); assert.deepEqual(state.tasks, body.tasks);
          assert.equal((await send()).status, 200, 'explicit same mutationId observes original receipt');
          const conflict = await application.app.request(base, { method: 'PUT', headers,
            body: JSON.stringify({ ...body, mutationId: randomUUID() }) });
          assert.equal(conflict.status, 409, 'old tab CAS cannot overwrite committed state');
          assert.equal((await (await application.app.request(base, { headers })).json()).revision, 2);
        } else {
          assert.equal(state.capabilities.length, 1, 'lost issuance never implicitly grants twice');
          assert.equal(state.capabilities[0].revokedAt === null, operation === 'issue');
          assert.doesNotMatch(JSON.stringify(state), /aod_board_|token|PRIVATE/);
          const audit = await application.app.request(base + '/audit', { headers }); assert.equal(audit.status, 200);
          assert.equal((await audit.json()).events.length, operation === 'issue' ? 1 : 2);
          assert.equal((await application.app.request(base + '/capabilities/invalid', { method: 'DELETE', headers })).status, 404);
          assert.equal(effects, 1, 'reopen and queries do not issue/revoke again');
        }
      } finally { release(); await application.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
