import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { DeckStore } from '../projection/deck-store.js';
import { registerSessionRoutes } from './sessions.js';
import { createTestTurnQueue } from '../openclaw/turn-queue.test-fixture.js';
import { performanceDiagnostics, PerformanceDiagnostics } from '../diagnostics/performance.js';

const preferences = [
  { route: 'visibility', field: 'hidden', set: 'hideSession', get: 'isSessionHidden', step: 1 },
  { route: 'archive', field: 'archived', set: 'archiveSession', get: 'isSessionArchived', step: 2 },
  { route: 'pin', field: 'pinned', set: 'pinSession', get: 'isSessionPinned', step: 3 },
] as const;
async function fixture(t: TestContext, preference: typeof preferences[number]) {
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-preference-body-'));
  const file = join(directory, 'PRIVATE.json');
  const store = new DeckStore({ hiddenSessionsFile: file, archivedSessionsFile: file, pinnedSessionsFile: file });
  const key = 'agent:main:dashboard:PRIVATE';
  store.upsertSession({ sessionKey: key, agentId: 'main', status: 'idle', title: 'PRIVATE' });
  store[preference.set](key);
  const bytes = await readFile(file, 'utf8'), revision = store.changes.revision;
  const turns = createTestTurnQueue({ store });
  t.after(async () => { await turns.close(); await rm(directory, { recursive: true, force: true }); });
  const rows: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  t.mock.method(performanceDiagnostics, 'start', (operation: Parameters<PerformanceDiagnostics['start']>[0]) => diagnostics.start(operation));
  let actor: string | undefined = 'PRIVATE actor';
  const controller = new AbortController(), app = new Hono();
  registerSessionRoutes(app, { store, queue: turns.queue, commands: turns.commands, queueActor: () => actor,
    gateway: { request: () => assert.fail('No native request'), requestBound: () => assert.fail('No native request') } as any,
    refreshSessions: async () => assert.fail('No session refresh'), refreshMessages: async () => assert.fail('No history replay'),
    resolveExplicitChannelRoute: () => undefined, mirrorAssistantReplyToChannel: async () => assert.fail('No message send'),
    deletionAdmission: () => false, settingsAdmission: () => false, normalizeError: () => 'unavailable' });
  return { store, controller, rows, setActor(value: string | undefined) { actor = value; },
    send(body: BodyInit | null, headers: Record<string, string> = {}) {
      const request = new Request(`http://test/api/sessions/${encodeURIComponent(key)}/${preference.route}`, {
        method: 'PATCH', body, headers: { 'content-type': 'application/json', ...headers },
        signal: controller.signal, duplex: 'half',
      } as RequestInit);
      return Promise.resolve(app.fetch(request));
    },
    async unchanged() { assert.equal(store[preference.get](key), true); assert.equal(store.changes.revision, revision);
      assert.equal(await readFile(file, 'utf8'), bytes); },
    redacted() { assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|agent:main|Request body|Invalid JSON|\.json/); },
  };
}

for (const preference of preferences) {
  for (const [label, value, expected] of [
    ['true', JSON.stringify({ [preference.field]: true }), true],
    ['false', JSON.stringify({ [preference.field]: false }), false],
    ['absent', null, true], ['empty', '', true], ['malformed', '{', true], ['whitespace', '  ', true],
    ['empty object', '{}', true], ['number', '7', true], ['array', '[]', true],
  ] as const) {
    test(`${preference.route}: bounded body keeps legacy ${label} value and response`, async t => {
      const f = await fixture(t, preference), response = await f.send(value);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(Object.keys(body).sort(), ['ok', 'sessionKey', preference.field, 'updatedAt'].sort());
      assert.equal(body[preference.field], expected); assert.equal(f.store[preference.get]('agent:main:dashboard:PRIVATE'), expected);
      assert.equal(f.rows.at(-1)?.settled, 1); f.redacted();
    });
  }
  for (const change of ['revoke', 'switch', 'abort'] as const) {
    test(`${preference.route}: actual request stream ${change} cannot save`, async t => {
      const f = await fixture(t, preference); let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({ pull(c) {
        if (++pulls === 1) c.enqueue(new TextEncoder().encode(JSON.stringify({ [preference.field]: false })));
        else { if (change === 'abort') f.controller.abort(); else f.setActor(change === 'switch' ? 'replacement' : undefined); c.close(); }
      } }, { highWaterMark: 0 });
      assert.equal((await f.send(stream)).status, change === 'abort' ? 408 : 403);
      assert.equal(pulls, 2); await f.unchanged(); assert.equal(f.rows.at(-1)?.deferred, 1); f.redacted();
    });
  }
  for (const stop of ['timeout', 'abort'] as const) {
    test(`${preference.route}: ${stop} ends pre-write body wait even if source cancellation never settles`, async t => {
      const f = await fixture(t, preference); let enter!: () => void, release!: () => void, cancelled = 0;
      const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
      let lateAttempted = false;
      const stream = new ReadableStream<Uint8Array>({ async pull(c) {
        enter(); await held; lateAttempted = true;
        try { c.enqueue(new TextEncoder().encode(JSON.stringify({ [preference.field]: false }))); c.close(); } catch { /* reader already cancelled */ }
      }, cancel() { cancelled++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const flight = f.send(stream);
      try {
        await entered; t.mock.timers.tick(1_000);
        const preferenceRows = () => f.rows.filter(row => row.operation === 'session-preference-change');
        assert.equal(preferenceRows().length, 1); assert.equal(preferenceRows()[0]?.phase, 'pending');
        if (stop === 'abort') f.controller.abort(); else t.mock.timers.tick(9_000);
        assert.equal((await flight).status, 408); assert.equal(cancelled, 1);
        await f.unchanged(); assert.equal(preferenceRows().length, 2); assert.equal(preferenceRows()[1]?.deferred, 1);
        assert.equal(preferenceRows()[1]?.unknown, undefined);
        assert.equal(preferenceRows()[1]?.timedOut, stop === 'timeout' ? 1 : undefined);
        assert.equal(preferenceRows()[1]?.cancelled, stop === 'abort' ? 1 : undefined);
        assert.equal(preferenceRows()[1]?.sequence, preferenceRows()[0]?.sequence); f.redacted();
      } finally { release(); }
      await Promise.resolve(); await Promise.resolve(); assert.equal(lateAttempted, true); await f.unchanged();
      t.mock.timers.tick(120_000); assert.equal(f.rows.filter(row => row.operation === 'session-preference-change').length, 2, 'no late save, retry or recurring timer');
    });
  }
  test(`${preference.route}: oversize actual bytes refuse instead of malformed-body default write`, async t => {
    const f = await fixture(t, preference);
    assert.equal((await f.send(' '.repeat(65_537), { 'content-length': '1' })).status, 413);
    await f.unchanged(); assert.equal(f.rows.at(-1)?.deferred, 1); f.redacted();
  });
  test(`${preference.route}: exactly bounded body remains accepted`, async t => {
    const f = await fixture(t, preference), prefix = JSON.stringify({ [preference.field]: false });
    assert.equal((await f.send(prefix + ' '.repeat(65_536 - Buffer.byteLength(prefix)))).status, 200);
    assert.equal(f.store[preference.get]('agent:main:dashboard:PRIVATE'), false); f.redacted();
  });
  test(`${preference.route}: denied admission never pulls body`, async t => {
    const f = await fixture(t, preference); f.setActor(undefined); let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull() { pulls++; assert.fail('Denied request must not read'); } }, { highWaterMark: 0 });
    assert.equal((await f.send(stream)).status, 403); assert.equal(pulls, 0); await f.unchanged(); f.redacted();
  });
}
