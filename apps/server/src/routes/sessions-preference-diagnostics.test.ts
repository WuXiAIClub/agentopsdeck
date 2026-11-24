import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';
import { createTestTurnQueue } from '../openclaw/turn-queue.test-fixture.js';
import { registerSessionRoutes } from './sessions.js';

const preferences = [
  { route: 'visibility', field: 'hidden', set: 'hideSession', get: 'isSessionHidden', step: 1 },
  { route: 'archive', field: 'archived', set: 'archiveSession', get: 'isSessionArchived', step: 2 },
  { route: 'pin', field: 'pinned', set: 'pinSession', get: 'isSessionPinned', step: 3 },
] as const;
async function fixture(t: TestContext, preference: typeof preferences[number]) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-preference-diagnostics-'));
  const path = join(root, 'PRIVATE-preference.json');
  const store = new DeckStore({ hiddenSessionsFile: path, archivedSessionsFile: path, pinnedSessionsFile: path });
  const key = 'agent:main:dashboard:PRIVATE-session';
  store.upsertSession({ sessionKey: key, agentId: 'main', title: 'PRIVATE title', status: 'idle' });
  const turns = createTestTurnQueue({ store });
  t.after(async () => { await turns.close(); await rm(root, { recursive: true, force: true }); });
  const rows: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  t.mock.method(performanceDiagnostics, 'start', (operation: Parameters<PerformanceDiagnostics['start']>[0]) => diagnostics.start(operation));
  let actor: string | undefined = 'PRIVATE-actor';
  let readHook = async () => {};
  const app = new Hono();
  app.onError(() => Response.json({ error: 'unavailable' }, { status: 500 }));
  registerSessionRoutes(app, { store, queue: turns.queue, commands: turns.commands,
    gateway: { request: async () => assert.fail('No native execution'), requestBound: async () => assert.fail('No native execution') } as any,
    deletionAdmission: () => false, settingsAdmission: () => false, queueActor: () => actor,
    refreshSessions: async () => assert.fail('No refresh'), refreshMessages: async () => assert.fail('No history retry'),
    resolveExplicitChannelRoute: () => undefined, mirrorAssistantReplyToChannel: async () => assert.fail('No resend'),
    normalizeError: () => 'unavailable' });
  const controller = new AbortController();
  return { store, key, path, diagnostics, rows, controller,
    setActor(value: string | undefined) { actor = value; },
    setReadHook(value: () => Promise<void>) { readHook = value; },
    send() {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({ async pull(c) {
        if (!sent) { sent = true; c.enqueue(new TextEncoder().encode(JSON.stringify({ [preference.field]: true, private: 'PRIVATE body' }))); return; }
        await readHook(); c.close();
      } }, { highWaterMark: 0 });
      return app.request(`/api/sessions/${encodeURIComponent(key)}/${preference.route}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body, signal: controller.signal, duplex: 'half' } as RequestInit); },
    events() { return rows.filter(row => row.operation === 'session-preference-change'); },
    assertRedacted() { assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|agent:main|preference\.json/); },
  };
}

for (const preference of preferences) {
  for (const change of ['none', 'revoke', 'abort'] as const) {
    test(`${preference.route} logs ${change} without disclosing saved content or authority`, async t => {
      const f = await fixture(t, preference);
      f.setReadHook(async () => {
        if (change === 'revoke') f.setActor(undefined);
        if (change === 'abort') f.controller.abort();
      });
      const response = await f.send();
      // Fixture error handler intentionally maps all errors; authority behavior
      // and its real 403/408 responses are independently asserted by the matrix.
      assert.equal(response.status, change === 'none' ? 200 : 500);
      assert.equal(f.events().length, 1);
      const row = f.events()[0]!;
      assert.equal(row.phase, 'finished'); assert.equal(row.step, preference.step);
      assert.equal(row[change === 'none' ? 'settled' : 'deferred'], 1);
      assert.equal(row.unknown, undefined);
      assert.equal(row.cancelled, change === 'abort' ? 1 : undefined);
      assert.equal(f.store[preference.get](f.key), change === 'none');
      f.assertRedacted();
    });
  }
  for (const afterWrite of [false, true]) {
    test(`${preference.route} never claims rollback or repeats an unknown save (after write=${afterWrite})`, async t => {
      const f = await fixture(t, preference);
      const original = f.store[preference.set].bind(f.store);
      let writes = 0;
      t.mock.method(f.store, preference.set, (key: string) => {
        writes++;
        if (afterWrite) original(key);
        throw Error('PRIVATE write error');
      });
      assert.equal((await f.send()).status, 500);
      assert.equal(writes, 1);
      assert.equal(f.events().length, 1);
      const row = f.events()[0]!;
      assert.equal(row.unknown, 1); assert.equal(row.deferred, undefined); assert.equal(row.settled, undefined);
      if (afterWrite) assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), [f.key]);
      f.assertRedacted();
    });
  }
  for (const revoke of [false, true]) {
    test(`${preference.route} pending observation does not complete, release or resend a held save (revoke=${revoke})`, async t => {
      const f = await fixture(t, preference);
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      f.setReadHook(async () => { enter(); await held; });
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let finished = false;
      const flight = Promise.resolve(f.send()).then(response => { finished = true; return response; });
      try {
        await entered;
        t.mock.timers.tick(1_000);
        assert.equal(finished, false);
        assert.equal(f.store[preference.get](f.key), false);
        assert.equal(f.events().length, 1);
        const pending = f.events()[0]!;
        assert.equal(pending.phase, 'pending'); assert.equal(pending.pending, 1);
        assert.equal(pending.step, preference.step); assert.equal(pending.unknown, undefined);
        // One observation, not a recurring unbounded log or a timeout unlock.
        t.mock.timers.tick(1_000); assert.equal(f.events().length, 1);
        if (revoke) f.setActor(undefined);
      } finally { release(); }
      assert.equal((await flight).status, revoke ? 500 : 200);
      assert.equal(f.store[preference.get](f.key), !revoke);
      assert.equal(f.events().length, 2);
      const final = f.events()[1]!;
      assert.equal(final.sequence, f.events()[0]!.sequence);
      assert.equal(final[revoke ? 'deferred' : 'settled'], 1);
      assert.equal(final.phase, 'finished');
      f.assertRedacted();
    });
  }
}
