import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono } from 'hono';
import { CodexAppServer } from '../codex/app-server.js';
import { DeckStore } from '../projection/deck-store.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { registerSessionSettingsRoutes } from './session-settings-http.js';

const threadId = 'synthetic-settings-journal', sessionKey = `codex:${threadId}`;
const model = 'synthetic-model';

for (const payload of [{ title: 'Saved title' }, { model, thinking: 'high' }, { model, thinking: null }]) {
  test(`settings ACK survives actual journal failure; a new projection epoch rebuilds saved settings (${JSON.stringify(payload)})`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-settings-journal-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'connector.sqlite');
    const nativeReads: string[] = [];
    let writes = 0;
    const open = () => {
      const users = new ConnectorUserStore(file);
      const db = (users as unknown as { db: DatabaseSync }).db;
      users.events.beginEpoch(); // Same boundary as a fresh owning runtime.
      const store = new DeckStore({ eventLog: users.events,
        sessionTitlesFile: join(directory, 'titles.json'), sessionThinkingOverridesFile: join(directory, 'thinking.json') });
      const codex = new CodexAppServer({ enabled: true, command: 'never-run', defaultCwd: directory,
        defaultModel: 'synthetic-default', approvalPolicy: 'never', store, runtimeOverridesFile: join(directory, 'models.json'),
        turnQueue: users.turns, executions: users.codexExecutions, authorizeTurn: () => false });
      // Only synthetic read responses. No process, native writes, or worker.
      const transport = codex as unknown as { ensureStarted(): Promise<void>; request(method: string): Promise<unknown> };
      transport.ensureStarted = async () => {};
      transport.request = async method => {
        nativeReads.push(method);
        const thread = { id: threadId, name: 'Native title', turns: [] };
        if (method === 'thread/list') return { data: [thread] };
        assert.equal(method, 'thread/read', 'rebuild must not execute a native command');
        return { thread };
      };
      const rename = store.renameSession.bind(store), update = codex.updateSessionRuntime.bind(codex);
      store.renameSession = (...args) => { writes++; return rename(...args); };
      codex.updateSessionRuntime = (...args) => { writes++; return update(...args); };
      const app = new Hono();
      registerSessionSettingsRoutes(app, '/sessions/:sessionKey', { store, codex, receipts: users.commands,
        settingsAdmission: key => users.canChangeSettings(key), actor: () => 'synthetic-actor',
        sessionKey: () => sessionKey, refreshSessions: async () => {},
        gateway: { requestBound: () => assert.fail('no Gateway traffic') } as any });
      const path = `/sessions/${encodeURIComponent(sessionKey)}`;
      return { users, db, store, codex,
        patch: () => app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json', 'idempotency-key': 'saved-command' }, body: JSON.stringify(payload) }),
        receipt: () => app.request(`${path}/settings-commands/saved-command`),
        close: async () => { await codex.close(); users.close(); } };
    };
    let current = open();
    t.after(() => current.close());
    current.store.upsertSession({ sessionKey, source: 'codex', agentId: 'codex', title: 'Original', status: 'idle', model: 'old' });
    current.store.persistSessionThinkingOverride(sessionKey, 'medium');
    const oldCursor = current.store.latestEventId()!;
    current.db.exec("CREATE TRIGGER reject_settings_projection BEFORE INSERT ON connector_events BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
    assert.equal((await current.patch()).status, 200);
    const accepted = (await (await current.receipt()).json() as any).command;
    assert.equal(accepted.state, 'accepted');
    assert.equal(writes, 1);
    assert.throws(() => current.store.latestEventId(), /unavailable/);
    assert.equal(current.users.commands.sessionSettingsPending(sessionKey), false);
    current.db.exec('DROP TRIGGER reject_settings_projection');
    // A healthy database alone is insufficient to resume the old event stream.
    current.store.append('session.updated', { sessionKey });
    assert.throws(() => current.users.events.latestEventId(), /unavailable/);
    assert.equal((await current.patch()).status, 200);
    assert.equal(writes, 1);
    await current.close();
    current = open();
    assert.equal(current.users.events.hasEvent(oldCursor), false, 'old cursor requires reset, never silent continuation');
    await current.codex.refreshSessions();
    const snapshot = current.store.getSession(sessionKey)!;
    if ('title' in payload) assert.equal(snapshot.title, payload.title);
    else {
      assert.equal(snapshot.model, model);
      assert.equal(snapshot.thinkingLevel, payload.thinking ?? undefined);
      if (payload.thinking === null) assert.equal(Object.hasOwn(snapshot, 'thinkingLevel'), false);
    }
    assert.deepEqual(nativeReads, ['thread/list'], 'saved settings rebuild without scanning history');
    await current.codex.refreshSession(sessionKey);
    assert.deepEqual(nativeReads, ['thread/list', 'thread/read']);
    const newCursor = current.store.latestEventId();
    assert.notEqual(newCursor, oldCursor);
    assert.deepEqual((await (await current.receipt()).json() as any).command, accepted);
    assert.equal((await current.patch()).status, 200);
    assert.equal(current.store.latestEventId(), newCursor, 'receipt recovery must not publish the historical result');
    assert.equal(writes, 1, 'neither rehydration nor receipt recovery repeats the settings write');
  });
}
