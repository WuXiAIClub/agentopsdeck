import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono } from 'hono';
import { CodexAppServer } from '../codex/app-server.js';
import { CodexExecutions } from '../codex/executions.js';
import { CommandReceipts } from '../commands/receipts.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { DeckStore } from '../projection/deck-store.js';
import type { GatewayWsClient } from '../gateway/ws-client.js';
import { registerSessionSettingsRoutes } from './session-settings-http.js';

const native = 'codex:synthetic-settings-http', alias = 'local:synthetic-alias';
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-settings-http-'));
  const db = new DatabaseSync(join(dir, 'receipts.sqlite')), receipts = new CommandReceipts(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const titles = join(dir, 'titles.json'), models = join(dir, 'models.json'), thinking = join(dir, 'thinking.json');
  const store = new DeckStore({ sessionTitlesFile: titles, sessionThinkingOverridesFile: thinking });
  store.upsertSession({ sessionKey: native, agentId: 'codex', source: 'codex', title: 'Original', status: 'running', model: 'old' });
  const codex = new CodexAppServer({ enabled: false, command: 'never-run', defaultCwd: dir, defaultModel: 'default-model', approvalPolicy: 'never',
    store, runtimeOverridesFile: models, turnQueue: new TurnQueue(db), executions: new CodexExecutions(db), authorizeTurn: () => false });
  const app = new Hono();
  registerSessionSettingsRoutes(app, '/sessions/:sessionKey', { store, codex, receipts,
    settingsAdmission: () => true, // Adapter persistence fixture has no worker.
    gateway: { requestBound: () => assert.fail('no Gateway/native execution') } as unknown as GatewayWsClient,
    actor: () => 'actor', sessionKey: c => c.req.param('sessionKey') === alias ? native : c.req.param('sessionKey')!, refreshSessions: async () => {} });
  const patch = (key: string, payload: object) => app.request(`/sessions/${encodeURIComponent(key)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', 'idempotency-key': 'same-key' }, body: JSON.stringify(payload),
  });
  const read = (key: string) => app.request(`/sessions/${encodeURIComponent(key)}/settings-commands/same-key`);
  return { store, receipts, titles, models, thinking, patch, read };
}

test('native/alias settings share one receipt, while each response presents the requested address', async t => {
  const f = fixture(t), payload = { title: 'Renamed' };
  const first = await f.patch(alias, payload);
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json() as any).settings, payload);
  f.store.renameSession = () => assert.fail('same receipt must not write again');
  for (const key of [native, alias]) {
    const replay = await f.patch(key, payload);
    assert.equal(replay.status, 200); assert.equal((await replay.json() as any).sessionKey, key);
    const saved = (await (await f.read(key)).json() as any).command;
    assert.equal(saved.state, 'accepted'); assert.deepEqual(saved.result.body, { sessionKey: key, settings: payload });
  }
  const stored = f.receipts.get(JSON.stringify(['settings', JSON.stringify(['actor', native])]), 'same-key')!;
  assert.deepEqual(stored.result!.body, { sessionKey: native, settings: payload });
  assert.equal(f.store.getSession(native)!.status, 'running');
});

test('settings accept model IDs from another provider without a vendor-specific allowlist', async t => {
  const f = fixture(t);
  const response = await f.patch(native, { model: 'example-provider/custom-model' });
  assert.equal(response.status, 200);
  assert.equal(f.store.getSession(native)?.model, 'example-provider/custom-model');
});

for (const stage of ['title', 'model', 'thinking', 'ack'] as const) test(`actual settings HTTP ${stage} persistence failure stays unknown and cannot repeat`, async t => {
  const f = fixture(t), model = 'synthetic-model';
  if (stage !== 'ack') mkdirSync(stage === 'title' ? f.titles : stage === 'model' ? f.models : f.thinking);
  else {
    const settle = f.receipts.settle.bind(f.receipts);
    f.receipts.settle = (scope, key, result) => {
      if (result.status === 200) throw new Error('synthetic ACK disk failure');
      return settle(scope, key, result);
    };
  }
  let projections = 0;
  f.store.append = () => { projections++; assert.fail('failed save/ACK must not project'); };
  const payload = stage === 'title' ? { title: 'New title' } : { model, thinking: 'high' };
  assert.equal((await f.patch(native, payload)).status, 202);
  assert.equal((await (await f.read(alias)).json() as any).command.state, 'outcome_unknown');
  assert.equal(f.receipts.sessionSettingsPending(native), true);
  f.store.renameSession = () => assert.fail('unknown must not repeat');
  assert.equal((await f.patch(alias, payload)).status, 202);
  assert.equal(projections, 0);
  if (stage === 'ack' || stage === 'thinking') assert.equal(JSON.parse(readFileSync(f.models, 'utf8'))['synthetic-settings-http'], model);
});

test('actual settings HTTP title ACK survives projection failure and remains a bounded settings patch', async t => {
  const f = fixture(t);
  f.store.append = () => { throw new Error('synthetic projection failure'); };
  const response = await f.patch(native, { title: 'Saved' });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.command.state, 'accepted');
  assert.deepEqual(body.settings, { title: 'Saved' });
  assert.equal('status' in body, false); assert.equal('messages' in body, false);
  assert.equal(JSON.parse(readFileSync(f.titles, 'utf8'))[native], 'Saved');
});

for (const thinking of [undefined, 'high', null] as const) test(`actual Codex settings HTTP preserves committed thinking in the final snapshot (${thinking})`, async t => {
  const f = fixture(t), model = 'synthetic-model';
  f.store.persistSessionThinkingOverride(native, 'medium');
  const payload = { model, ...(thinking === undefined ? {} : { thinking }) };
  const response = await f.patch(native, payload);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.command.state, 'accepted');
  const expectedThinking = thinking === undefined ? 'medium' : thinking ?? undefined;
  const lastEvent = f.store.getEventsSince().at(-1)!;
  for (const session of [f.store.getSession(native)!, lastEvent.payload as any]) {
    assert.equal(session.model, model);
    assert.equal(session.thinkingLevel, expectedThinking);
    assert.equal(session.status, 'running');
    if (thinking === null) assert.equal(Object.hasOwn(session, 'thinkingLevel'), false);
  }
  assert.equal(lastEvent.type, 'session.updated');
  if (thinking === undefined) assert.equal(Object.hasOwn(body.settings, 'thinkingLevel'), false);
  else assert.equal(body.settings.thinkingLevel, thinking);
  const revision = f.store.changes.revision;
  assert.equal((await f.patch(alias, payload)).status, 200);
  assert.equal((await (await f.read(native)).json() as any).command.state, 'accepted');
  assert.equal(f.store.changes.revision, revision, 'receipt replay/GET must not project an old settings result');
});
