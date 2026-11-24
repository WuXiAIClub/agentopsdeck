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

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const path = '/api/workspace-agent/v1/board';
for (const backend of ['json', 'sqlite'] as const) {
  for (const outcome of ['read-cancel', 'read-close', 'update-lost', 'update-close', 'update-cancel', 'update-cancel-lost'] as const) {
    test(`actual ${backend} machine ${outcome} retains original bearer, CAS and durable receipt`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'application-board-machine-'));
      const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: 'isolated-board-admin',
        AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-board-vault',
        AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
        ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
      // Seed and close before the application's sole original writer opens.
      const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
      const member = seed.createUser('Original machine owner'), id = randomUUID();
      seed.boards.save(member.id, 'default', { title: 'Original private board', tasks: [
        { id, title: 'Original task', status: 'todo', detail: 'Original private detail', tags: ['keep'], priority: 'high', dueDate: '2026-10-17' },
      ], revision: 0, mutationId: randomUUID() });
      const grant = seed.boardCapabilities.issue(member.id, 'default', { taskIds: [id], fields: ['status', 'detail'], expiresAt: Date.now() + 60_000 })!;
      const document = { revision: 1, mutationId: randomUUID(), tasks: [{ id, status: 'doing' as const }] };
      await seed.close();
      let release!: () => void, entered!: () => void, originals = 0;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const arrived = new Promise<void>(resolve => { entered = resolve; });
      const action = outcome.startsWith('read') ? 'read' : 'update';
      const original = OriginalHubAdministrativeCommands.prototype.command;
      t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
        const result = original.call(this, kind, input);
        if (kind !== 'boardMachine' || (input as { action: string }).action !== action || ++originals !== 1) return result;
        return result.then(async value => {
          entered(); await gate;
          if (outcome.endsWith('lost')) throw Error('PRIVATE original machine reply ' + grant.token);
          return value;
        });
      });
      let application = createApplication(config);
      const controller = new AbortController(), headers = { authorization: 'Bearer ' + grant.token };
      const request = () => application.app.request(path, { method: action === 'read' ? 'GET' : 'POST',
        headers, signal: controller.signal, ...(action === 'update' ? { body: JSON.stringify(document) } : {}) });
      const pending = request();
      try {
        await arrived;
        if (outcome.includes('cancel')) controller.abort();
        let drained = false;
        const closing = outcome.endsWith('close') ? application.close().then(() => { drained = true; }) : undefined;
        if (closing) {
          await tick(); assert.equal(drained, false);
          assert.equal((await application.app.request(path, { headers })).status, 503);
        }
        if (outcome === 'read-cancel') {
          assert.equal((await pending).status, 499); assert.equal(originals, 1);
        }
        release();
        const response = await pending;
        assert.equal(response.status, outcome === 'read-cancel' ? 499 : outcome === 'update-cancel' ? 200 : 503);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.doesNotMatch(await response.text(), /PRIVATE|aod_board_/);
        await closing; await application.close();
        assert.equal(originals, 1, 'no hidden replay');
        const reopened = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
        try {
          assert.equal(reopened.boardCapabilities.authorized(grant.token), true);
          const board = reopened.boards.get(member.id, 'default');
          assert.equal(board.revision, action === 'update' ? 2 : 1);
          assert.equal(board.tasks[0]!.status, action === 'update' ? 'doing' : 'todo');
          assert.deepEqual(board.tasks[0]!.tags, ['keep']); assert.equal(board.tasks[0]!.priority, 'high');
          assert.equal(reopened.boardCapabilities.events(member.id, 'default').filter(event => event.event === 'updated').length, action === 'update' ? 1 : 0);
        } finally { await reopened.close(); }
        application = createApplication(config);
        assert.equal((await application.app.request(path, { headers })).status, 200);
        if (action === 'update') {
          // Explicit retry of the SAME mutation reconciles the original receipt,
          // never generates a replacement mutation or a second update audit.
          const retry = await application.app.request(path, { method: 'POST', headers, body: JSON.stringify(document) });
          assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), { status: 'saved', revision: 2, mutationId: document.mutationId });
          const conflict = await application.app.request(path, { method: 'POST', headers,
            body: JSON.stringify({ ...document, mutationId: randomUUID() }) });
          assert.equal(conflict.status, 409);
        }
        await application.close();
        const old = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
        try {
          assert.equal(old.boardCapabilities.events(member.id, 'default').filter(event => event.event === 'updated').length, action === 'update' ? 1 : 0);
          assert.equal(old.boardCapabilities.revoke(member.id, 'default', grant.capability.id), true);
        } finally { await old.close(); }
        application = createApplication(config);
        assert.equal((await application.app.request(path, { headers })).status, 401);
      } finally {
        release(); await application.close(); rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
