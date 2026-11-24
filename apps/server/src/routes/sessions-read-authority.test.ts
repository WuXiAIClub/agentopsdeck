import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { DeckStore } from '../projection/deck-store.js';
import { createTestTurnQueue } from '../openclaw/turn-queue.test-fixture.js';
import { registerSessionRoutes } from './sessions.js';
import type { SessionReadActor } from '../auth/session-read-authority.js';

const key = 'agent:main:dashboard:PRIVATE-retained';
const encoded = encodeURIComponent(key);
const paths = ['/api/sessions/state', `/api/sessions/${encoded}`, `/api/sessions/${encoded}/messages`,
  `/api/sessions/${encoded}/messages/PRIVATE-message`, `/api/sessions/${encoded}/activity`];
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t: TestContext, actor: SessionReadActor, waitMs = 30_000) {
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-session-read-authority-'));
  const store = new DeckStore({ sessionTitlesFile: join(directory, 'titles.json') });
  store.upsertSession({ sessionKey: key, agentId: 'main', title: 'PRIVATE original session', status: 'running', hasActiveRun: true });
  store.addMessage({ id: 'PRIVATE-message', sessionKey: key, role: 'assistant', text: 'PRIVATE retained response', createdAt: 1 });
  const turns = createTestTurnQueue({ store });
  let refreshes = 0, refresh = async () => {}, synchronousCalls = 0;
  const app = new Hono();
  app.onError(error => error instanceof HTTPException ? error.getResponse()
    : Response.json({ error: 'unexpected_route_error' }, { status: 500 }));
  const routes = registerSessionRoutes(app, {
    store, queue: turns.queue, commands: turns.commands, observeActor: actor, readWaitMs: waitMs,
    queueActor: () => { synchronousCalls++; return undefined; },
    gateway: { request: () => assert.fail('Read cannot execute'), requestBound: () => assert.fail('Read cannot execute') } as any,
    refreshSessions: async () => { refreshes++; await refresh(); }, refreshMessages: async () => { refreshes++; await refresh(); },
    deletionAdmission: () => false, settingsAdmission: () => false, normalizeError: () => 'unavailable',
    resolveExplicitChannelRoute: () => undefined, mirrorAssistantReplyToChannel: async () => assert.fail('Read cannot send'),
  });
  t.after(async () => { await routes.close(); await turns.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, store, routes, refreshes: () => refreshes, synchronousCalls: () => synchronousCalls,
    setRefresh(value: () => Promise<void>) { refresh = value; } };
}

for (const path of paths) {
  test(`legacy GET ${path.split('/').at(-1)} awaits the real observation port and retains response shape`, async t => {
    let calls = 0;
    const f = await fixture(t, async () => { calls++; await Promise.resolve(); return 'PRIVATE-actor'; });
    const response = await f.app.request(path);
    assert.equal(response.status, 200); assert.ok(calls >= 2); assert.equal(f.synchronousCalls(), 0);
    const body = await response.json();
    if (path.endsWith('/messages')) {
      assert.equal(body.messages[0].text, 'PRIVATE retained response'); assert.equal(body.totalCount, 1);
      assert.equal(typeof body.revision, 'string');
    } else if (path.endsWith('/PRIVATE-message')) assert.equal(body.message.text, 'PRIVATE retained response');
    else if (path.endsWith('/state')) assert.equal(body.groups[0].sessions[0].sessionKey, key);
    else if (!path.endsWith('/activity')) assert.equal(body.sessionKey, key);
    assert.equal(f.store.getSession(key)?.hasActiveRun, true, 'Read cannot release the running session');
    assert.equal(f.store.getMessages(key).length, 1, 'Retained history is not deleted or replayed');
  });

  for (const change of ['revoke', 'switch', 'reject'] as const) {
    test(`legacy GET ${path.split('/').at(-1)} prevents stale delivery after ${change}`, async t => {
      let calls = 0;
      const f = await fixture(t, async () => {
        if (++calls === 1) return 'PRIVATE-actor';
        if (change === 'reject') throw Error('PRIVATE SELECT token');
        return change === 'revoke' ? undefined : 'PRIVATE-other-actor';
      });
      const response = await f.app.request(path);
      assert.equal(response.status, change === 'reject' ? 503 : 403);
      assert.doesNotMatch(await response.text(), /PRIVATE|SELECT|token/); assert.equal(f.synchronousCalls(), 0);
      assert.equal(f.store.getSession(key)?.hasActiveRun, true); assert.equal(f.store.getMessages(key).length, 1);
    });
  }
  test(`legacy GET ${path.split('/').at(-1)} denies before reading history when actor is absent`, async t => {
    const f = await fixture(t, async () => undefined);
    assert.equal((await f.app.request(path)).status, 403); assert.equal(f.refreshes(), 0);
  });
}

for (const path of paths.slice(0, 3)) for (const change of ['revoke', 'switch', 'abort'] as const) {
  test(`legacy GET ${path.split('/').at(-1)} rechecks after suspended history/projection refresh: ${change}`, async t => {
    let actor: string | undefined = 'PRIVATE-actor';
    const entered = held<void>(), release = held<void>(), controller = new AbortController();
    const f = await fixture(t, async () => actor);
    f.setRefresh(async () => { entered.resolve(); await release.promise; });
    const response = f.app.request(path, { signal: controller.signal });
    await entered.promise;
    if (change === 'abort') controller.abort(); else actor = change === 'revoke' ? undefined : 'PRIVATE-other';
    release.resolve();
    const result = await response;
    assert.equal(result.status, change === 'abort' ? 408 : 403);
    assert.doesNotMatch(await result.text(), /PRIVATE/); assert.equal(f.refreshes(), 1, 'No automatic history retry');
    assert.equal(f.store.getSession(key)?.hasActiveRun, true);
  });
}

test('an awaited read observation is never reused for synchronous preference mutation', async t => {
  let observations = 0;
  const f = await fixture(t, async () => { observations++; return 'PRIVATE-actor'; });
  assert.equal((await f.app.request(`/api/sessions/${encoded}/messages`)).status, 200);
  const before = observations;
  const response = await f.app.request(`/api/sessions/${encoded}/pin`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned: true }),
  });
  assert.equal(response.status, 403); assert.equal(f.store.isSessionPinned(key), false);
  assert.equal(observations, before, 'Mutation still checks the original synchronous effect boundary');
  assert.ok(f.synchronousCalls() > 0);
});

test('a timed-out GET retains the original read until close can drain it; no automatic lookup retry', async t => {
  const gate = held<string | undefined>(); let calls = 0, closed = false;
  const f = await fixture(t, () => { calls++; return gate.promise; }, 5);
  assert.equal((await f.app.request(paths[2]!)).status, 503);
  assert.equal(f.routes.pending, 1); assert.equal(calls, 1); assert.equal(f.refreshes(), 0);
  const closing = f.routes.close().then(() => { closed = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false);
  gate.resolve('PRIVATE-late'); await closing;
  assert.equal(f.routes.pending, 0); assert.equal(calls, 1);
  assert.equal((await f.app.request(paths[2]!)).status, 503); assert.equal(calls, 1);
});

for (const path of paths.slice(0, 3)) for (const ending of ['timeout', 'abort'] as const) {
  test(`legacy GET ${path.split('/').at(-1)} ends ${ending} while original refresh is unresolved`, { timeout: 5000 }, async t => {
    const entered = held<void>(), release = held<void>(), controller = new AbortController();
    let calls = 0, closed = false;
    const f = await fixture(t, async () => { calls++; return 'PRIVATE-actor'; }, ending === 'timeout' ? 40 : 1000);
    f.setRefresh(async () => { entered.resolve(); await release.promise; });
    const response = f.app.request(path, { signal: controller.signal });
    try {
      await entered.promise; const before = calls;
      if (ending === 'abort') controller.abort();
      const result = await response;
      assert.equal(result.status, ending === 'abort' ? 408 : 503);
      assert.doesNotMatch(await result.text(), /PRIVATE|SELECT|Bearer/);
      assert.equal(f.routes.pending, 1); assert.equal(f.refreshes(), 1);
      const closing = f.routes.close().then(() => { closed = true; });
      await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false);
      assert.equal((await f.app.request(path)).status, 503); assert.equal(calls, before);
      assert.equal(f.store.getSession(key)?.hasActiveRun, true);
      assert.equal(f.store.getMessages(key)[0]?.text, 'PRIVATE retained response');
      release.resolve(); await closing;
      assert.equal(f.routes.pending, 0); assert.equal(calls, before); assert.equal(f.refreshes(), 1);
    } finally { release.resolve(); await response; await f.routes.close(); }
  });
}
