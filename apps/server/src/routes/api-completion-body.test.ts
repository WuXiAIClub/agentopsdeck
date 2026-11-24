import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { AOD_MODEL_SET_ID, MAX_MESSAGE_CHARS, MAX_TEXT_MESSAGE_BODY_BYTES } from '@agentopsdeck/shared';
import { DeckStore } from '../projection/deck-store.js';
import { createTestTurnQueue } from '../openclaw/turn-queue.test-fixture.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { loadConfig } from '../config.js';
import { MAX_TOTAL_MEDIA_BYTES } from '../messages/send-message.js';
import { registerConnectorRoutes } from './connector.js';
import { registerSessionRoutes } from './sessions.js';

const sessionKey = 'agent:main:web:direct:fixture';
const messageLimit = MAX_TOTAL_MEDIA_BYTES * 4 / 3 + MAX_TEXT_MESSAGE_BODY_BYTES;
type Mode = 'local' | 'connector';
function fixture(t: TestContext, mode: Mode) {
  const root = mkdtempSync(join(tmpdir(), 'aod-api-body-'));
  const config = loadConfig({ HOME: root, AOD_DATA_DIR: root, AOD_OPENCLAW_HOME: root,
    AOD_OPENCLAW_CONFIG_FILE: join(root, 'openclaw.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'update.json') });
  config.gatewayWsUrl = 'ws://fixture.invalid';
  writeFileSync(config.nativeFileRoots.configFile, '{}');
  const store = new DeckStore({ sessionTitlesFile: join(root, 'titles.json') });
  store.upsertSession({ sessionKey, agentId: 'main', title: 'Fixture', status: 'idle' });
  let preferenceWrites = 0;
  for (const method of ['archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession'] as const) {
    const original = store[method].bind(store);
    t.mock.method(store, method, (key: string) => { preferenceWrites++; return original(key); });
  }
  const turns = createTestTurnQueue({ store }), users = new ConnectorUserStore(':memory:');
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'));
  const credential = tokens.create({ label: 'fixture', scopes: ['sessions:create', 'messages:send', 'messages:read', 'models:write'] });
  let actor: string | undefined = 'fixture', nativeCalls = 0, queueCalls = 0, claims = 0;
  const receipts = mode === 'local' ? turns.commands : users.commands;
  const originalClaim = receipts.claimAsync.bind(receipts);
  t.mock.method(receipts, 'claimAsync', (...args: Parameters<typeof receipts.claimAsync>) => { claims++; return originalClaim(...args); });
  t.mock.method(turns.queue, 'enqueueAsync', async (...args: Parameters<typeof turns.queue.enqueueAsync>) => {
    args[2]?.(); queueCalls++;
  });
  const gateway = { connectionId: () => 'fixture', request: async () => assert.fail('No unbound native request'),
    requestBound: async (_method: string, _params: unknown, _timeout: unknown, check?: () => void) => {
      check?.(); nativeCalls++; return { payload: { key: sessionKey }, connectionId: 'fixture' };
    } };
  const app = new Hono();
  const shared = { store, gateway: gateway as any, refreshSessions: async () => {}, refreshMessages: async () => {},
    normalizeError: () => 'unavailable' };
  const routes = mode === 'local'
    ? registerSessionRoutes(app, { ...shared, queue: turns.queue, commands: receipts, queueActor: () => actor,
      resolveExplicitChannelRoute: () => undefined, mirrorAssistantReplyToChannel: async () => assert.fail('No mirror'),
      deletionAdmission: () => false, settingsAdmission: () => false })
    : registerConnectorRoutes(app, { ...shared, config, tokens, connectorUsers: users, openclawQueue: turns.queue,
      fallbackAgents: () => [], sessionSnapshotReady: () => true, historySnapshotReady: () => true, isAuthorizedRequest: () => false });
  t.after(async () => { await routes.close(); await turns.close(); users.close(); rmSync(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const createPath = mode === 'local' ? '/api/agents/main/sessions' : '/api/connector/v1/agents/main/sessions';
  const messagePath = `${mode === 'local' ? '/api' : '/api/connector/v1'}/sessions/${encodeURIComponent(sessionKey)}/messages`;
  return { controller, createPath, messagePath, config,
    counts: () => ({ claims, nativeCalls, queueCalls }),
    preferenceWrites: () => preferenceWrites,
    preferences: () => ({ archived: store.isSessionArchived(sessionKey), pinned: store.isSessionPinned(sessionKey) }),
    revoke: () => { actor = undefined; tokens.revoke(credential.record.id); },
    send(path: string, body: BodyInit | null, authorized = true, method = 'POST') {
      return Promise.resolve(app.fetch(new Request(`http://test${path}`, { method, body,
        headers: { 'content-type': 'application/json', 'content-length': '1',
          ...(authorized ? { authorization: `Bearer ${credential.token}` } : {}) },
        signal: controller.signal, duplex: 'half' } as RequestInit)));
    },
  };
}

function oversized(size: number, onCancel: () => void = () => {}) {
  let remaining = size;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (!remaining) return controller.close();
    const count = Math.min(remaining, 65536); remaining -= count; controller.enqueue(new Uint8Array(count).fill(32));
  }, cancel: onCancel }, { highWaterMark: 0 });
}

for (const mode of ['local', 'connector'] as const) {
  for (const target of ['createPath', 'messagePath'] as const) {
    test(`${mode} ${target}: actual oversized bytes fail before receipts or dispatch`, async t => {
      const f = fixture(t, mode); let cancelled = 0;
      const response = await f.send(f[target], oversized((target === 'createPath' ? 65536 : messageLimit) + 1, () => { cancelled++; }));
      assert.equal(response.status, 413); assert.equal(cancelled, 1);
      assert.deepEqual(f.counts(), { claims: 0, nativeCalls: 0, queueCalls: 0 });
    });
    for (const body of ['{', 'null', '[]']) {
      test(`${mode} ${target}: invalid body ${body} cannot claim or dispatch`, async t => {
        const f = fixture(t, mode);
        assert.equal((await f.send(f[target], body)).status, 400);
        assert.deepEqual(f.counts(), { claims: 0, nativeCalls: 0, queueCalls: 0 });
      });
    }
    for (const stop of ['revoke', 'abort', 'timeout'] as const) {
      test(`${mode} ${target}: ${stop} while reading cannot admit work`, async t => {
        const f = fixture(t, mode); let entered!: () => void, cancelled = 0;
        const reading = new Promise<void>(resolve => { entered = resolve; });
        const stream = new ReadableStream<Uint8Array>({ pull(controller) {
          entered();
          if (stop === 'revoke') { f.revoke(); controller.enqueue(new TextEncoder().encode('{}')); controller.close(); }
        }, cancel() { cancelled++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
        if (stop === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
        const flight = f.send(f[target], stream); await reading;
        if (stop === 'abort') f.controller.abort();
        if (stop === 'timeout') t.mock.timers.tick(10000);
        assert.equal((await flight).status, stop === 'revoke' ? 403 : 408);
        assert.equal(cancelled, stop === 'revoke' ? 0 : 1);
        assert.deepEqual(f.counts(), { claims: 0, nativeCalls: 0, queueCalls: 0 });
      });
    }
  }
  test(`${mode} creation: exactly 64KiB JSON is cached, claimed once and delivered unchanged`, async t => {
    const f = fixture(t, mode), prefix = JSON.stringify({ label: 'Fixture label', idempotencyKey: 'fixture-create' });
    const response = await f.send(f.createPath, prefix + ' '.repeat(65536 - Buffer.byteLength(prefix)));
    assert.equal(response.status, mode === 'local' ? 200 : 201);
    assert.equal((await response.json()).key, sessionKey);
    assert.deepEqual(f.counts(), { claims: 1, nativeCalls: 1, queueCalls: 0 });
  });
  test(`${mode} message: maximally escaped text remains accepted without provider dispatch`, async t => {
    const f = fixture(t, mode);
    const text = 'a'.repeat(MAX_MESSAGE_CHARS), body = `{"message":"${'\\u0061'.repeat(MAX_MESSAGE_CHARS)}","idempotencyKey":"fixture-text"}`;
    assert.ok(Buffer.byteLength(body) > MAX_MESSAGE_CHARS); assert.equal(JSON.parse(body).message, text);
    const response = await f.send(f.messagePath, body);
    assert.equal(response.status, 200); assert.equal((await response.json()).status, 'queued');
    assert.deepEqual(f.counts(), { claims: mode === 'local' ? 0 : 1, nativeCalls: 0, queueCalls: 1 });
  });
  test(`${mode} message: exact media-inclusive byte ceiling is accepted`, async t => {
    const f = fixture(t, mode), prefix = JSON.stringify({ message: 'fixture', idempotencyKey: 'fixture-limit' });
    const response = await f.send(f.messagePath, prefix + ' '.repeat(messageLimit - Buffer.byteLength(prefix)));
    assert.equal(response.status, 200); assert.equal((await response.json()).status, 'queued');
    assert.equal(f.counts().queueCalls, 1);
  });
}

const reconcilePath = '/api/connector/v1/gateway/model-set/reconcile';
for (const body of ['{', 'null', '[]', '{}', JSON.stringify({ setId: AOD_MODEL_SET_ID, models: [] }), ' '.repeat(8193)]) {
  test(`legacy model reconcile: rejects invalid or oversized body (${body.length} bytes) without changing config`, async t => {
    const f = fixture(t, 'connector'), before = readFileSync(f.config.nativeFileRoots.configFile);
    const response = await f.send(reconcilePath, body);
    assert.equal(response.status, body.length > 8192 ? 413 : 400);
    assert.deepEqual(readFileSync(f.config.nativeFileRoots.configFile), before);
    assert.deepEqual(f.counts(), { claims: 0, nativeCalls: 0, queueCalls: 0 });
  });
}
test('legacy model reconcile: exact 8KiB dry-run preserves config', async t => {
  const f = fixture(t, 'connector'), before = readFileSync(f.config.nativeFileRoots.configFile);
  const prefix = JSON.stringify({ setId: AOD_MODEL_SET_ID, dryRun: true });
  assert.equal((await f.send(reconcilePath, prefix + ' '.repeat(8192 - Buffer.byteLength(prefix)))).status, 200);
  assert.deepEqual(readFileSync(f.config.nativeFileRoots.configFile), before);
});
test('legacy model reconcile: denied admission does not pull body', async t => {
  const f = fixture(t, 'connector'); let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({ pull() { pulls++; assert.fail('Denied body was read'); } }, { highWaterMark: 0 });
  assert.equal((await f.send(reconcilePath, stream, false)).status, 403); assert.equal(pulls, 0);
});
test('legacy model reconcile: revoke while reading prevents reconciliation', async t => {
  const f = fixture(t, 'connector'), before = readFileSync(f.config.nativeFileRoots.configFile);
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    f.revoke(); controller.enqueue(new TextEncoder().encode(JSON.stringify({ setId: AOD_MODEL_SET_ID }))); controller.close();
  } }, { highWaterMark: 0 });
  assert.equal((await f.send(reconcilePath, stream)).status, 403);
  assert.deepEqual(readFileSync(f.config.nativeFileRoots.configFile), before);
});

for (const action of ['archive', 'pin'] as const) {
  const field = action === 'archive' ? 'archived' : 'pinned';
  const preferencePath = `/api/connector/v1/sessions/${encodeURIComponent(sessionKey)}/${action}`;
  for (const body of [null, '', ' ', '{']) {
    test(`legacy ${action}: deliberate empty/malformed JSON defaults to true (${JSON.stringify(body)})`, async testContext => {
      const harness = fixture(testContext, 'connector');
      const response = await harness.send(preferencePath, body, true, 'PATCH');
      assert.equal(response.status, 200); assert.equal((await response.json())[field], true);
      assert.equal(harness.preferences()[field], true); assert.equal(harness.preferenceWrites(), 1);
      assert.deepEqual(harness.counts(), { claims: 0, nativeCalls: 0, queueCalls: 0 });
    });
  }
  test(`legacy ${action}: exact 64KiB body and explicit false preserve preference semantics`, async testContext => {
    const harness = fixture(testContext, 'connector'), prefix = JSON.stringify({ [field]: true });
    const response = await harness.send(preferencePath, prefix + ' '.repeat(65536 - Buffer.byteLength(prefix)), true, 'PATCH');
    assert.equal(response.status, 200); assert.equal((await response.json())[field], true);
    assert.equal(harness.preferences()[field], true);
    const cleared = await harness.send(preferencePath, JSON.stringify({ [field]: false }), true, 'PATCH');
    assert.equal(cleared.status, 200); assert.equal((await cleared.json())[field], false);
    assert.equal(harness.preferences()[field], false); assert.equal(harness.preferenceWrites(), 2);
  });
  test(`legacy ${action}: actual oversized bytes cannot default into a preference write`, async testContext => {
    const harness = fixture(testContext, 'connector'); let cancelled = 0;
    const response = await harness.send(preferencePath, oversized(65537, () => { cancelled++; }), true, 'PATCH');
    assert.equal(response.status, 413); assert.equal(cancelled, 1);
    assert.equal(harness.preferenceWrites(), 0); assert.deepEqual(harness.preferences(), { archived: false, pinned: false });
  });
  test(`legacy ${action}: denied admission does not pull the body or write`, async testContext => {
    const harness = fixture(testContext, 'connector'); let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull() { pulls++; assert.fail('Denied preference body was read'); } }, { highWaterMark: 0 });
    assert.equal((await harness.send(preferencePath, stream, false, 'PATCH')).status, 403);
    assert.equal(pulls, 0); assert.equal(harness.preferenceWrites(), 0);
  });
  test(`legacy ${action}: already aborted request cannot write`, async testContext => {
    const harness = fixture(testContext, 'connector'); harness.controller.abort();
    assert.equal((await harness.send(preferencePath, JSON.stringify({ [field]: true }), true, 'PATCH')).status, 408);
    assert.equal(harness.preferenceWrites(), 0); assert.deepEqual(harness.preferences(), { archived: false, pinned: false });
  });
  for (const stop of ['revoke', 'abort', 'timeout'] as const) {
    test(`legacy ${action}: ${stop} during upload cannot default into a preference write`, async testContext => {
      const harness = fixture(testContext, 'connector'); let entered!: () => void, cancelled = 0;
      const reading = new Promise<void>(resolve => { entered = resolve; });
      const stream = new ReadableStream<Uint8Array>({ pull(controller) {
        entered();
        if (stop === 'revoke') { harness.revoke(); controller.enqueue(new TextEncoder().encode('{')); controller.close(); }
      }, cancel() { cancelled++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
      if (stop === 'timeout') testContext.mock.timers.enable({ apis: ['setTimeout'] });
      const flight = harness.send(preferencePath, stream, true, 'PATCH'); await reading;
      if (stop === 'abort') harness.controller.abort();
      if (stop === 'timeout') testContext.mock.timers.tick(10000);
      assert.equal((await flight).status, stop === 'revoke' ? 403 : 408);
      assert.equal(cancelled, stop === 'revoke' ? 0 : 1);
      assert.equal(harness.preferenceWrites(), 0); assert.deepEqual(harness.preferences(), { archived: false, pinned: false });
      assert.deepEqual(harness.counts(), { claims: 0, nativeCalls: 0, queueCalls: 0 });
    });
  }
  test(`legacy ${action}: failed transport cannot default into a preference write`, async testContext => {
    const harness = fixture(testContext, 'connector');
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('Synthetic preference transport failure')); } }, { highWaterMark: 0 });
    assert.equal((await harness.send(preferencePath, stream, true, 'PATCH')).status, 500);
    assert.equal(harness.preferenceWrites(), 0); assert.deepEqual(harness.preferences(), { archived: false, pinned: false });
  });
}
