import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { CodexAppServer } from '../codex/app-server.js';
import { OpenClawTurnQueue } from '../openclaw/turn-queue.js';
import type { GatewayWsClient } from '../gateway/ws-client.js';
import { DeckStore } from '../projection/deck-store.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { registerSessionSettingsRoutes } from './session-settings-http.js';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function fixture(runtime: 'openclaw' | 'codex') {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-settings-dispatch-'));
  const db = new ConnectorUserStore(join(directory, 'synthetic.sqlite'));
  const sessionKey = runtime === 'codex' ? 'codex:synthetic' : 'agent:synthetic:dashboard:settings';
  const store = new DeckStore({ sessionTitlesFile: join(directory, 'titles.json') });
  store.upsertSession({ sessionKey, agentId: runtime === 'codex' ? 'codex' : 'synthetic', title: 'Original', status: 'idle', hasActiveRun: false });
  assert.ok(store.getSession(sessionKey), 'synthetic session must be user-facing');
  let started = 0;
  const dispatched: any[] = [];
  const hooks = { settings: async () => {}, prepare: async () => {}, send: async () => {} };
  const openclaw = new OpenClawTurnQueue({ store, turns: db.turns, executions: db.openClawExecutions,
    authorizeTurn: () => true, refreshSessions: async () => {}, refreshMessages: async () => {}, mirror: async () => {},
    send: async () => { started++; await hooks.send(); return { runId: 'native-run' }; } });
  const codex = new CodexAppServer({ store, turnQueue: db.turns, executions: db.codexExecutions,
    enabled: true, command: 'must-not-launch', defaultCwd: directory, defaultModel: 'synthetic', approvalPolicy: 'never', authorizeTurn: () => true });
  const bridge = codex as any;
  bridge.connectionId = 'synthetic-connection';
  // These settings-boundary tests invoke private drain after history validation.
  bridge.threadRefreshResult.set(sessionKey, { at: 0, available: true });
  bridge.ensureStarted = async () => { await hooks.prepare(); };
  bridge.ensureThreadLoaded = async () => {};
  bridge.request = async (method: string, params: unknown) => {
    assert.equal(method, 'turn/start'); dispatched.push(params); started++; await hooks.send(); return { turn: { id: 'native-run' } };
  };
  const app = new Hono();
  registerSessionSettingsRoutes(app, '/sessions/:sessionKey', { store, codex, receipts: db.commands,
    actor: () => 'synthetic-owner', sessionKey: c => c.req.param('sessionKey')!, settingsAdmission: key => db.canChangeSettings(key),
    gateway: { requestBound: () => assert.fail('title settings must not invoke Gateway') } as unknown as GatewayWsClient,
    refreshSessions: () => hooks.settings() });
  return { db, store, sessionKey, hooks, dispatched, started: () => started,
    patch: async (key = 'settings', title = 'Renamed') => app.request(`/sessions/${encodeURIComponent(sessionKey)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ title }),
    }),
    model: async (body: { model: string | null; thinking?: string | null }, key = 'model-settings') => app.request(`/sessions/${encodeURIComponent(sessionKey)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body),
    }),
    enqueue: async () => {
      if (runtime === 'codex') return (await codex.send(sessionKey, 'keep queued', [], { actorId: 'synthetic-owner' })).idempotencyKey;
      await openclaw.enqueueAsync({ id: 'message', sessionKey, createdAt: 1, payload: { actorId: 'synthetic-owner', message: 'keep queued', media: [], deliveryMode: 'web-only' } });
      return 'message';
    },
    drain: (): Promise<void> => runtime === 'codex' ? bridge.drainQueuedTurn(sessionKey) : (openclaw as any).reconcile(sessionKey),
    close: async () => { await openclaw.close(); await codex.close(); db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

for (const runtime of ['openclaw', 'codex'] as const) test(`${runtime} actual worker leaves admitted input queued while HTTP settings awaits`, async () => {
  const f = fixture(runtime), entered = latch(), release = latch();
  let patch: Promise<Response> | undefined;
  try {
    f.hooks.settings = async () => { entered.release(); await release.promise; };
    patch = f.patch(); await entered.promise;
    const id = await f.enqueue(); await f.drain();
    assert.equal(f.started(), 0); assert.equal(f.db.turns.head(runtime, f.sessionKey)?.id, id);
    assert.equal(f.db.turns.head(runtime, f.sessionKey)?.state, 'queued');
    release.release(); assert.equal((await patch).status, 200);
    await f.drain(); assert.equal(f.started(), 1);
    assert.equal(f.db.turns.head(runtime, f.sessionKey), undefined);
    assert.equal(f.store.getMessages(f.sessionKey).find(message => message.id === id)?.status, 'sent');
  } finally { release.release(); await patch; await f.close(); }
});

for (const runtime of ['openclaw', 'codex'] as const) for (const outcome of ['rejected', 'unknown'] as const) {
  test(`${runtime} actual settings ${outcome} releases startup only for a proven prewrite rejection`, async () => {
    const f = fixture(runtime), entered = latch(), release = latch();
    let patch: Promise<Response> | undefined;
    try {
      f.hooks.settings = async () => { entered.release(); await release.promise; };
      if (outcome === 'unknown') f.store.renameSession = () => { throw new Error('synthetic write failure after begin'); };
      patch = f.patch('settings', outcome === 'rejected' ? '' : 'Renamed'); await entered.promise;
      const id = await f.enqueue(); await f.drain(); assert.equal(f.started(), 0);
      release.release(); assert.equal((await patch).status, outcome === 'rejected' ? 400 : 202);
      await f.drain();
      assert.equal(f.started(), outcome === 'rejected' ? 1 : 0);
      if (outcome === 'unknown') {
        assert.equal(f.db.turns.head(runtime, f.sessionKey)?.id, id);
        assert.equal(f.db.turns.head(runtime, f.sessionKey)?.state, 'queued');
        assert.equal((await f.patch('new-settings')).status, 409);
      } else assert.equal(f.db.turns.head(runtime, f.sessionKey), undefined);
    } finally { release.release(); await patch; await f.close(); }
  });
}

for (const runtime of ['openclaw', 'codex'] as const) for (const outcome of ['ack', 'lost-ack'] as const) {
  test(`${runtime} actual dispatch ${outcome} closes HTTP settings admission without dropping input`, async () => {
    const f = fixture(runtime), entered = latch(), release = latch();
    let drain: Promise<void> | undefined;
    try {
      f.hooks.send = async () => { entered.release(); await release.promise; if (outcome === 'lost-ack') throw new Error('synthetic lost ACK'); };
      const id = await f.enqueue(); drain = f.drain();
      await Promise.race([entered.promise, drain.then(() => assert.fail('worker returned before native dispatch'))]);
      assert.equal((await f.patch()).status, 409); assert.equal(f.store.getSession(f.sessionKey)?.title, 'Original');
      assert.equal(f.db.turns.head(runtime, f.sessionKey)?.id, id);
      release.release(); await drain;
      assert.equal((await f.patch()).status, 409, 'a rejected identity never changes into a new settings command');
      if (runtime === 'openclaw' && outcome === 'ack') {
        assert.equal((await f.patch('ack-only')).status, 409, 'Gateway acceptance alone does not prove startup finished');
        f.store.ingestGatewayEvent({ event: 'run.started', payload: { sessionKey: f.sessionKey, runId: 'native-run' } });
      }
      assert.equal((await f.patch('new-settings')).status, outcome === 'ack' ? 200 : 409);
      if (outcome === 'lost-ack') assert.equal(f.db.turns.head(runtime, f.sessionKey)?.state, 'outcome_unknown');
      assert.equal(f.started(), 1);
    } finally { release.release(); await drain; await f.close(); }
  });
}

test('Codex preparation leaves input editable and applies completed settings before atomic begin', async () => {
  const f = fixture('codex'), entered = latch(), release = latch();
  let drain: Promise<void> | undefined;
  try {
    f.hooks.prepare = async () => { entered.release(); await release.promise; };
    await f.enqueue(); drain = f.drain();
    await Promise.race([entered.promise, drain.then(() => assert.fail('worker returned before thread preparation'))]);
    assert.equal(f.db.codexExecutions.get(f.sessionKey), undefined);
    assert.equal(f.db.turns.head('codex', f.sessionKey)?.state, 'queued');
    assert.equal((await f.patch()).status, 200);
    release.release(); await drain; assert.equal(f.started(), 1);
    assert.equal(f.store.getSession(f.sessionKey)?.title, 'Renamed');
  } finally { release.release(); await drain; await f.close(); }
});

for (const reset of [false, true]) test(`Codex preparation dispatches latest committed model/thinking settings (reset: ${reset})`, async () => {
  const f = fixture('codex'), entered = latch(), release = latch();
  let drain: Promise<void> | undefined;
  try {
    if (reset) assert.equal((await f.model({ model: 'previous', thinking: 'high' }, 'previous-settings')).status, 200);
    f.hooks.prepare = async () => { entered.release(); await release.promise; };
    await f.enqueue(); drain = f.drain();
    await Promise.race([entered.promise, drain.then(() => assert.fail('worker returned before preparation'))]);
    assert.equal((await f.model({ model: reset ? null : 'latest-provider-model', thinking: reset ? null : 'low' })).status, 200);
    assert.equal(f.started(), 0); assert.equal(f.db.codexExecutions.get(f.sessionKey), undefined);
    release.release(); await drain;
    assert.equal(f.started(), 1);
    assert.equal(f.dispatched[0]?.model, reset ? 'synthetic' : 'latest-provider-model');
    assert.equal(f.dispatched[0]?.effort, reset ? undefined : 'low');
  } finally { release.release(); await drain; await f.close(); }
});

for (const runtime of ['openclaw', 'codex'] as const) test(`${runtime} draining leaves admitted messages queued without native dispatch`, async () => {
  const f = fixture(runtime);
  try {
    const id = await f.enqueue();
    f.db.stopTurnStarts();
    await f.drain();
    assert.equal(f.started(), 0);
    assert.equal(f.db.turns.head(runtime, f.sessionKey)?.id, id);
    assert.equal(f.db.turns.head(runtime, f.sessionKey)?.state, 'queued');
    assert.equal(f.store.getMessages(f.sessionKey).find(row => row.id === id)?.status, 'queued');
  } finally { await f.close(); }
});

test('Codex draining during thread loading defers a proven unsent turn, not unknown', async () => {
  const f = fixture('codex'), entered = latch(), release = latch();
  let drain: Promise<void> | undefined;
  try {
    f.hooks.prepare = async () => { entered.release(); await release.promise; };
    const id = await f.enqueue(); drain = f.drain();
    await Promise.race([entered.promise, drain.then(() => assert.fail('worker returned before loading'))]);
    assert.equal(f.db.turns.head('codex', f.sessionKey)?.state, 'queued');
    assert.equal(f.db.codexExecutions.get(f.sessionKey), undefined);
    f.db.stopTurnStarts();
    release.release(); await drain;
    assert.equal(f.started(), 0);
    assert.equal(f.db.codexExecutions.get(f.sessionKey), undefined);
    assert.equal(f.db.turns.head('codex', f.sessionKey)?.state, 'queued');
    assert.equal(f.store.getMessages(f.sessionKey).find(row => row.id === id)?.status, 'queued');
    assert.equal(f.store.getSession(f.sessionKey)?.hasActiveRun, false);
  } finally { release.release(); await drain; await f.close(); }
});
