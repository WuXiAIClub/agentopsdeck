import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SessionSummary } from '@agentopsdeck/shared';
import { CodexAppServer } from '../codex/app-server.js';
import { CodexExecutions } from '../codex/executions.js';
import { CommandReceipts } from '../commands/receipts.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { DeckStore } from '../projection/deck-store.js';

const sessionKey = 'codex:synthetic-settings';
const original: SessionSummary = { sessionKey, agentId: 'codex', source: 'codex', title: 'Original', status: 'idle', model: 'old-model' };
const scope = JSON.stringify(['settings', JSON.stringify(['actor', sessionKey])]);
function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-settings-ack-'));
  const db = new DatabaseSync(join(directory, 'receipts.sqlite')), receipts = new CommandReceipts(db);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const options = { sessionTitlesFile: join(directory, 'titles.json'), sessionThinkingOverridesFile: join(directory, 'thinking.json') };
  const store = new DeckStore(options);
  store.upsertSession(original);
  const runtimeOverridesFile = join(directory, 'models.json');
  const codex = new CodexAppServer({ enabled: false, command: 'never-run', defaultCwd: directory, defaultModel: 'default-model', approvalPolicy: 'never',
    store, runtimeOverridesFile, turnQueue: new TurnQueue(db), executions: new CodexExecutions(db), authorizeTurn: () => false });
  receipts.claim(scope, 'settings-key', {});
  const acknowledge = (session: SessionSummary) => receipts.settle(scope, 'settings-key', { status: 200,
    body: { sessionKey: session.sessionKey, title: session.title, model: session.model, thinkingLevel: session.thinkingLevel } });
  return { directory, db, receipts, options, store, runtimeOverridesFile, codex, acknowledge };
}

for (const thinking of [undefined, 'high', null] as const) test(`Codex final settings snapshot matches saved thinking, not the prewrite session (${thinking})`, t => {
  const f = fixture(t);
  f.store.persistSessionThinkingOverride(sessionKey, 'medium');
  let acknowledged: SessionSummary | undefined;
  const result = f.codex.updateSessionRuntime(sessionKey, {
    model: 'new-model', ...(thinking === undefined ? {} : { thinking }),
  }, session => { acknowledged = session; f.acknowledge(session); });
  const expectedThinking = thinking === undefined ? 'medium' : thinking ?? undefined;
  const lastEvent = f.store.getEventsSince().at(-1)!;
  for (const session of [acknowledged!, result, f.store.getSession(sessionKey)!, lastEvent.payload as SessionSummary]) {
    assert.equal(session.model, 'new-model');
    assert.equal(session.thinkingLevel, expectedThinking);
    assert.equal(session.title, original.title);
    assert.equal(session.status, original.status);
    if (thinking === null) assert.equal(Object.hasOwn(session, 'thinkingLevel'), false);
  }
  assert.equal(lastEvent.type, 'session.updated');
  assert.equal(f.receipts.get(scope, 'settings-key')!.state, 'accepted');
  assert.equal(JSON.parse(readFileSync(f.options.sessionThinkingOverridesFile, 'utf8'))[sessionKey], expectedThinking);
});

for (const thinking of [undefined, 'high', null] as const) test(`Codex settings ACK precedes projection and follows both local saves (thinking=${thinking})`, t => {
  const f = fixture(t);
  f.store.persistSessionThinkingOverride(sessionKey, 'medium');
  const before = f.store.getSession(sessionKey)!;
  f.store.append = () => { throw new Error('synthetic projection failure'); };
  let acks = 0;
  assert.throws(() => f.codex.updateSessionRuntime(sessionKey, { model: 'new-model', ...(thinking === undefined ? {} : { thinking }) }, session => {
    acks++;
    assert.equal(JSON.parse(readFileSync(f.runtimeOverridesFile, 'utf8'))['synthetic-settings'], 'new-model');
    assert.equal(JSON.parse(readFileSync(f.options.sessionThinkingOverridesFile, 'utf8'))[sessionKey], thinking === undefined ? 'medium' : thinking ?? undefined);
    assert.equal(f.store.getSession(sessionKey)!.model, before.model, 'ACK precedes model projection');
    assert.equal(f.store.getSession(sessionKey)!.thinkingLevel, 'medium', 'ACK precedes thinking projection');
    f.acknowledge(session);
  }), /synthetic projection failure/);
  assert.equal(acks, 1);
  const saved = new CommandReceipts(f.db).get(scope, 'settings-key')!;
  assert.equal(saved.state, 'accepted');
  assert.equal(saved.result!.body.model, 'new-model');
  assert.equal(saved.result!.body.thinkingLevel, thinking === undefined ? 'medium' : thinking ?? undefined);
  const restored = new DeckStore(f.options);
  restored.upsertSession(original);
  assert.equal(restored.getSession(sessionKey)!.thinkingLevel, thinking === undefined ? 'medium' : thinking ?? undefined);
});

for (const stage of ['model', 'thinking'] as const) test(`Codex ${stage} save failure leaves the settings receipt unknown and never calls ACK`, t => {
  const f = fixture(t);
  mkdirSync(stage === 'model' ? f.runtimeOverridesFile : f.options.sessionThinkingOverridesFile);
  let acks = 0;
  assert.throws(() => f.codex.updateSessionRuntime(sessionKey, { model: 'new-model', thinking: 'high' }, () => { acks++; }), /session_preference_persistence_failed/);
  assert.equal(acks, 0);
  assert.equal(f.store.getSession(sessionKey)!.model, 'old-model');
  assert.equal(f.store.getSession(sessionKey)!.thinkingLevel, undefined,
    'failed durable thinking save cannot publish an in-memory override');
  assert.equal(f.receipts.get(scope, 'settings-key')!.state, 'outcome_unknown');
  assert.equal(f.receipts.sessionSettingsPending(sessionKey), true);
  if (stage === 'thinking') assert.equal(JSON.parse(readFileSync(f.runtimeOverridesFile, 'utf8'))['synthetic-settings'], 'new-model', 'partial local write is real, not a proven rejection');
});

test('Codex failed ACK storage stops subsequent projection but does not undo partially observed settings', t => {
  const f = fixture(t);
  let projected = 0;
  f.store.append = () => { projected++; throw new Error('projection must not be reached'); };
  assert.throws(() => f.codex.updateSessionRuntime(sessionKey, { model: 'new-model', thinking: 'high' }, () => {
    throw new Error('synthetic ACK storage failure');
  }), /synthetic ACK storage failure/);
  assert.equal(projected, 0);
  assert.equal(f.store.getSession(sessionKey)!.model, 'old-model');
  assert.equal(f.store.getSession(sessionKey)!.thinkingLevel, 'high', 'read overlay is not proof of durable ACK');
  assert.equal(JSON.parse(readFileSync(f.runtimeOverridesFile, 'utf8'))['synthetic-settings'], 'new-model');
  assert.equal(JSON.parse(readFileSync(f.options.sessionThinkingOverridesFile, 'utf8'))[sessionKey], 'high');
  assert.equal(f.receipts.get(scope, 'settings-key')!.state, 'outcome_unknown');
});

test('title ACK follows saved override and survives projection failure and reload', t => {
  const f = fixture(t);
  const revision = f.store.changes.revision;
  f.store.append = () => { throw new Error('synthetic projection failure'); };
  assert.throws(() => f.store.renameSession(sessionKey, '  New title  ', session => {
    assert.equal(JSON.parse(readFileSync(f.options.sessionTitlesFile, 'utf8'))[sessionKey], 'New title');
    assert.equal(f.store.changes.revision, revision, 'no projection notification before ACK');
    f.acknowledge(session);
  }), /synthetic projection failure/);
  assert.equal(new CommandReceipts(f.db).get(scope, 'settings-key')!.state, 'accepted');
  const restored = new DeckStore(f.options);
  restored.upsertSession(original);
  assert.equal(restored.getSession(sessionKey)!.title, 'New title');
});

test('title save failure cannot call ACK; receipt stays unknown', t => {
  const f = fixture(t);
  mkdirSync(f.options.sessionTitlesFile);
  assert.throws(() => f.store.renameSession(sessionKey, 'New title', () => assert.fail('save did not complete')), /session_preference_persistence_failed/);
  assert.equal(f.receipts.get(scope, 'settings-key')!.state, 'outcome_unknown');
  assert.equal(f.store.getSession(sessionKey)!.title, original.title, 'failed durable save does not publish a title');
});

test('title ACK storage failure stops projection without rolling back saved override', t => {
  const f = fixture(t);
  const revision = f.store.changes.revision;
  assert.throws(() => f.store.renameSession(sessionKey, 'New title', () => { throw new Error('synthetic ACK storage failure'); }), /synthetic ACK storage failure/);
  assert.equal(f.store.changes.revision, revision);
  assert.equal(JSON.parse(readFileSync(f.options.sessionTitlesFile, 'utf8'))[sessionKey], 'New title');
  assert.equal(f.receipts.get(scope, 'settings-key')!.state, 'outcome_unknown');
});

test('missing/deleted sessions and invalid title do not produce a local ACK', t => {
  const f = fixture(t), ack = () => assert.fail('no local setting was accepted');
  assert.equal(f.store.renameSession('missing', 'title', ack), undefined);
  assert.throws(() => f.codex.updateSessionRuntime('codex:missing', { model: 'model' }, ack), /session not found/);
  for (const title of ['', ' ', 'x'.repeat(121)]) assert.throws(() => f.store.renameSession(sessionKey, title, ack), /session title/);
  const deleted = new DeckStore({ sessionDeleted: () => true });
  assert.equal(deleted.renameSession(sessionKey, 'title', ack), undefined);
  assert.equal(deleted.persistSessionThinkingOverride(sessionKey, 'high', ack), undefined);
});
