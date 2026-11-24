import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Hono } from 'hono';
import { DeckStore } from '../projection/deck-store.js';
import { registerSessionRoutes } from './sessions.js';
import { createTestTurnQueue } from '../openclaw/turn-queue.test-fixture.js';

for (const preference of [{ route: 'visibility', field: 'hidden', set: 'hideSession', get: 'isSessionHidden' },
  { route: 'archive', field: 'archived', set: 'archiveSession', get: 'isSessionArchived' },
  { route: 'pin', field: 'pinned', set: 'pinSession', get: 'isSessionPinned' }] as const) {
for (const mode of ['stable-promise', 'stable-object', 'async-function'] as const) {
  test(`${preference.route} must deny ${mode} instead of treating it as actor identity`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-actor-regression-'));
    const file = join(directory, 'hidden.json');
    const store = new DeckStore({ hiddenSessionsFile: file, archivedSessionsFile: file, pinnedSessionsFile: file });
    const key = 'agent:main:dashboard:synthetic';
    store.upsertSession({ sessionKey: key, agentId: 'main', title: 'Synthetic', status: 'idle' });
    store[preference.set](key);
    const before = await readFile(file, 'utf8');
    const turns = createTestTurnQueue({ store });
    t.after(async () => { await turns.close(); await rm(directory, { recursive: true, force: true }); });
    const actor: unknown = mode === 'stable-promise' ? Promise.resolve('owner') : {};
    let calls = 0;
    const queueActor = mode === 'async-function' ? async () => { calls++; return 'owner'; }
      : () => { calls++; return actor; };
    const app = new Hono();
    registerSessionRoutes(app, { store, queue: turns.queue, commands: turns.commands, queueActor: queueActor as any,
      gateway: { request: () => assert.fail('No native request'), requestBound: () => assert.fail('No native request') } as any,
      refreshSessions: async () => assert.fail('No refresh'), refreshMessages: async () => assert.fail('No replay'),
      resolveExplicitChannelRoute: () => undefined, mirrorAssistantReplyToChannel: async () => assert.fail('No send'),
      deletionAdmission: () => false, settingsAdmission: () => false, normalizeError: () => 'unavailable' });
    const response = await app.request(`/api/sessions/${encodeURIComponent(key)}/${preference.route}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [preference.field]: false }),
    });
    assert.equal(response.status, 403);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(store[preference.get](key), true);
    if (mode === 'async-function') assert.equal(calls, 0, 'Do not start asynchronous authorization');
  });
}
}
