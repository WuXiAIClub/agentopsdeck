import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { DeckStore } from '../projection/deck-store.js';
import { registerSessionRoutes } from './sessions.js';
import { createTestTurnQueue } from '../openclaw/turn-queue.test-fixture.js';

const preferences = [
  { route: 'visibility', field: 'hidden', set: 'hideSession', unset: 'unhideSession', get: 'isSessionHidden' },
  { route: 'archive', field: 'archived', set: 'archiveSession', unset: 'unarchiveSession', get: 'isSessionArchived' },
  { route: 'pin', field: 'pinned', set: 'pinSession', unset: 'unpinSession', get: 'isSessionPinned' },
] as const;

for (const preference of preferences) for (const next of [false, true]) {
  for (const change of ['none', 'revoke', 'switch', 'abort'] as const) {
    test(`legacy ${preference.route}=${next} preserves original authority across body read: ${change}`, async t => {
      const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-legacy-preference-'));
      const paths = { hidden: join(root, 'hidden.json'), archived: join(root, 'archived.json'), pinned: join(root, 'pinned.json') };
      const store = new DeckStore({ hiddenSessionsFile: paths.hidden, archivedSessionsFile: paths.archived,
        pinnedSessionsFile: paths.pinned });
      const key = 'agent:main:dashboard:preference-authority';
      store.upsertSession({ sessionKey: key, agentId: 'main', title: 'Retained session', status: 'idle' });
      // Seed a real legacy preference file before taking the original snapshot.
      store[preference.set](key);
      if (next) store[preference.unset](key);
      const original = await readFile(paths[preference.field], 'utf8');
      const revision = store.getSessionsState({ includeHidden: true, includeArchived: true }).revision;
      const turns = createTestTurnQueue({ store });
      t.after(async () => { await turns.close(); await rm(root, { recursive: true, force: true }); });
      let actor: string | undefined = 'original-owner';
      const controller = new AbortController();
      const app = new Hono();
      let reads = 0;
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (!sent) { sent = true; c.enqueue(new TextEncoder().encode(JSON.stringify({ [preference.field]: next }))); return; }
          reads++;
          if (change === 'revoke') actor = undefined;
          if (change === 'switch') actor = 'replacement-owner';
          if (change === 'abort') controller.abort();
          c.close();
        },
      }, { highWaterMark: 0 });
      registerSessionRoutes(app, { store, queue: turns.queue, commands: turns.commands,
        gateway: { request: async () => assert.fail('Preference changes cannot execute native commands'),
          requestBound: async () => assert.fail('Preference changes cannot execute native commands') } as any,
        deletionAdmission: key => turns.canDeleteSession(key), settingsAdmission: key => turns.canChangeSettings(key),
        queueActor: () => actor, refreshSessions: async () => assert.fail('Preferences must not refresh or resume sessions'),
        refreshMessages: async () => assert.fail('Preferences must not retry history'),
        resolveExplicitChannelRoute: () => undefined, mirrorAssistantReplyToChannel: async () => assert.fail('No mirror sends'),
        normalizeError: () => 'unavailable' });
      const response = await app.request(`/api/sessions/${encodeURIComponent(key)}/${preference.route}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: stream, signal: controller.signal, duplex: 'half',
      } as RequestInit);
      assert.equal(reads, 1, 'The authority transition occurs after admission, during the real body read');
      assert.equal(response.status, change === 'none' ? 200 : change === 'abort' ? 408 : 403);
      assert.equal(store[preference.get](key), change === 'none' ? next : !next);
      if (change === 'none') {
        const body = await response.json();
        assert.equal(typeof body.updatedAt, 'number');
        assert.deepEqual(body, { ok: true, sessionKey: key, [preference.field]: next, updatedAt: body.updatedAt });
        assert.deepEqual(JSON.parse(await readFile(paths[preference.field], 'utf8')), next ? [key] : []);
      } else {
        assert.equal(await readFile(paths[preference.field], 'utf8'), original, 'Original persisted preference remains byte-identical');
        assert.equal(store.getSessionsState({ includeHidden: true, includeArchived: true }).revision, revision,
          'No denied preference event or projection update');
      }
    });
  }
}
