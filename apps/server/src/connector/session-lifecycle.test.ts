import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono } from 'hono';
import { CommandReceipts } from '../commands/receipts.js';
import { registerDeletionReceipts } from '../commands/http.js';
import { SessionDeletionConflict } from '../commands/turn-queue.js';
import { ConnectorUserStore } from './connector-user-store.js';

const scope = (actor: string, session = 's') => JSON.stringify(['delete', JSON.stringify([actor, session])]);
const turn = (id = 'one', sessionKey = 's') => ({ id, sessionKey, createdAt: 1, payload: { actorId: 'alice', text: 'keep me' } });
const claim = (store: ConnectorUserStore, actor = 'alice', key = 'delete', session = 's') =>
  store.commands.claim(scope(actor, session), key, {}, false, undefined,
    () => !store.commands.sessionDeletion(session) && store.canDeleteSession(session));

const settingsScope = (actor = 'alice', session = 's') => JSON.stringify(['settings', JSON.stringify([actor, session])]);
const claimSettings = (store: ConnectorUserStore, actor = 'alice', key = 'settings', session = 's') =>
  store.commands.claim(settingsScope(actor, session), key, { model: 'synthetic' }, false, undefined,
    () => !store.commands.sessionDeletion(session) && !store.commands.sessionSettingsPending(session) && store.canChangeSettings(session));

const claimAsync = (store: ConnectorUserStore, actor = 'alice', key = 'delete', session = 's') =>
  store.commands.claimAsync(scope(actor, session), key, {}, false, undefined,
    () => !store.commands.sessionDeletion(session) && store.canDeleteSession(session));
const claimSettingsAsync = (store: ConnectorUserStore, actor = 'alice', key = 'settings', session = 's') =>
  store.commands.claimAsync(settingsScope(actor, session), key, { model: 'synthetic' }, false, undefined,
    () => !store.commands.sessionDeletion(session) && !store.commands.sessionSettingsPending(session) && store.canChangeSettings(session));

// Fresh disk claims now wait before entering their original transaction. Probe
// the competing SQLite writer directly INSIDE that decision, then exercise the
// actual awaited competitor after commit. Never await inside a SQL callback.
function lockedWriterProbe(file: string) {
  const probe = new DatabaseSync(file);
  try { assert.throws(() => probe.exec('BEGIN IMMEDIATE'), /locked/); }
  finally { probe.close(); }
}

for (const runtime of ['openclaw', 'codex'] as const) for (const outcome of ['accepted', 'rejected', 'outcome_unknown'] as const) {
  test(`${runtime} settings ${outcome} keeps messages editable in FIFO but gates dispatch across reopen`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-settings-start-')), file = join(directory, 'synthetic.sqlite');
    let store = new ConnectorUserStore(file);
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    assert.equal((await claimSettingsAsync(store)).fresh, true);
    await store.turns.enqueueAsync(runtime, turn()); await store.turns.enqueueAsync(runtime, turn('second'));
    assert.equal(store.turns.edit<any>(runtime, 's', 'one', payload => ({ ...payload, text: 'edited' })), true);
    assert.equal(store.turns.cancel(runtime, 's', 'second'), true);
    assert.equal(store.turns.start(runtime, 's', 'one'), false);
    assert.equal(store.turns.head<any>(runtime, 's')!.payload.text, 'edited');
    assert.equal(store.turns.head(runtime, 's')!.state, 'queued');
    assert.equal(runtime === 'codex' ? store.codexExecutions.begin('s', 'one', 'synthetic-connection') : store.openClawExecutions.begin('s', 'one'), false);
    store.close(); store = new ConnectorUserStore(file);
    assert.equal(store.turns.start(runtime, 's', 'one'), false);
    if (outcome !== 'outcome_unknown') store.commands.settle(settingsScope(), 'settings', { status: outcome === 'accepted' ? 200 : 409, body: { ok: true } });
    assert.equal(store.turns.start(runtime, 's', 'one'), outcome !== 'outcome_unknown');
    await store.turns.enqueueAsync(runtime, turn('other', 'independent'));
    assert.equal(store.turns.start(runtime, 'independent', 'other'), true);
  });
}

for (const runtime of ['openclaw', 'codex'] as const) test(`${runtime} dispatch/preparation and uncertain delivery reject settings before writes`, t => {
  const store = new ConnectorUserStore(':memory:'); t.after(() => store.close());
  store.turns.enqueue(runtime, turn());
  assert.equal(store.turns.start(runtime, 's', 'one'), true);
  assert.equal(claimSettings(store).receipt.state, 'rejected', 'queue claim covers awaits before execution.begin');
  assert.equal(runtime === 'codex' ? store.codexExecutions.begin('s', 'one', 'synthetic-connection', true) : store.openClawExecutions.begin('s', 'one'), true);
  store.turns.uncertain(runtime, 'one');
  assert.equal(claimSettings(store, 'bob', 'unknown').receipt.state, 'rejected');
  store.turns.complete(runtime, 'one');
  assert.equal(claimSettings(store, 'bob', 'orphan').receipt.state, 'rejected', 'a preparation/orphan fact alone still closes the gate');
});

for (const first of ['settings', 'turn'] as const) test(`${first} admission wins the same SQLite writer transaction, never both`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-settings-turn-lock-')), file = join(directory, 'synthetic.sqlite');
  const a = new ConnectorUserStore(file), b = new ConnectorUserStore(file);
  t.after(() => { b.close(); a.close(); rmSync(directory, { recursive: true, force: true }); });
  await a.turns.enqueueAsync('codex', turn());
  if (first === 'settings') {
    await a.commands.claimAsync(settingsScope(), 'settings', {}, false, undefined, () => {
      assert.throws(() => b.turns.start('codex', 's', 'one'), /locked/); return true;
    });
    assert.equal(b.turns.start('codex', 's', 'one'), false);
  } else {
    // Use the existing start callback to attempt the other writer inside BEGIN.
    const pending = a.commands.sessionSettingsPending.bind(a.commands);
    a.commands.sessionSettingsPending = key => {
      lockedWriterProbe(file); return pending(key);
    };
    assert.equal(a.turns.start('codex', 's', 'one'), true);
    assert.equal((await claimSettingsAsync(b)).receipt.state, 'rejected');
  }
});

for (const outcome of ['accepted', 'rejected', 'outcome_unknown'] as const) test(`settings ${outcome} controls deletion admission across reopen without exposing actor receipts`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-settings-lifecycle-'));
  const file = join(directory, 'synthetic.sqlite');
  let store = new ConnectorUserStore(file);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal((await claimSettingsAsync(store)).fresh, true);
  assert.equal(store.commands.sessionSettingsPending('s'), true);
  assert.equal(store.commands.sessionSettingsPending('other'), false);
  assert.equal(store.commands.get(settingsScope('bob'), 'settings'), undefined);
  assert.equal((await claimAsync(store, 'bob', 'during-settings')).receipt.state, 'rejected');
  assert.equal((await claimSettingsAsync(store, 'bob', 'concurrent-settings')).receipt.state, 'rejected');
  assert.equal(store.commands.settle(settingsScope(), 'settings', { status: 502, body: {} }).state, 'outcome_unknown');
  if (outcome !== 'outcome_unknown') store.commands.settle(settingsScope(), 'settings', { status: outcome === 'accepted' ? 200 : 409, body: { ok: true } });
  store.close(); store = new ConnectorUserStore(file);
  assert.equal(store.commands.sessionSettingsPending('s'), outcome === 'outcome_unknown');
  assert.equal((await claimSettingsAsync(store)).fresh, false, 'same command never replays even after terminal outcome');
  assert.equal((await claimAsync(store, 'bob', 'during-settings')).receipt.state, 'rejected', 'old rejection never becomes a fresh deletion');
  assert.equal((await claimAsync(store, 'bob', 'later-delete')).fresh, outcome !== 'outcome_unknown');
});

for (const first of ['settings', 'deletion'] as const) test(`two SQLite writers preserve ${first} lifecycle admission through its transaction`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-control-lock-'));
  const file = join(directory, 'synthetic.sqlite'), a = new ConnectorUserStore(file), b = new ConnectorUserStore(file);
  t.after(() => { b.close(); a.close(); rmSync(directory, { recursive: true, force: true }); });
  const originalScope = first === 'settings' ? settingsScope() : scope('alice');
  const result = await a.commands.claimAsync(originalScope, 'first', {}, false, undefined, () => {
    lockedWriterProbe(file);
    return true;
  });
  assert.equal(result.fresh, true);
  const second = await (first === 'settings' ? claimAsync(b) : claimSettingsAsync(b));
  assert.equal(second.fresh, false);
  assert.equal(second.receipt.state, 'rejected');
});

test('settings index ignores malformed/foreign scopes and uses a bounded indexed query', t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db); t.after(() => db.close());
  for (const value of ['not-json', 'null', '[]', '["settings"]', '["settings",null]', '["settings","invalid"]',
    JSON.stringify(['settings', JSON.stringify([3, 's'])]), JSON.stringify(['settings', JSON.stringify(['alice', 's', 'extra'])]),
    JSON.stringify(['owner-settings-v1', 'alice', 's']), scope('alice')]) receipts.claim(value, 'old', {});
  assert.equal(receipts.sessionSettingsPending('s'), false);
  receipts.claim(settingsScope(), 'current', {});
  assert.equal(receipts.sessionSettingsPending('s'), true);
  const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'command_receipt_pending_settings_session'").get()!.sql);
  const expression = sql.slice(sql.indexOf('(CASE') + 1, sql.indexOf(") WHERE state = 'outcome_unknown'"));
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM command_receipts WHERE ${expression} = ? AND state = 'outcome_unknown' LIMIT 1`).all('s');
  assert.match(JSON.stringify(plan), /SEARCH.*command_receipt_pending_settings_session/);
});

test('deletion index safely filters arbitrary old scopes and uses bounded indexed lookup', t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  t.after(() => db.close());
  const invalid = ['not JSON', 'null', '3', '{}', '[]', '["delete"]', '["delete",{}]',
    '["delete","invalid"]', '["delete","null"]', '["delete","{}"]',
    JSON.stringify(['delete', JSON.stringify(['alice', 's', 'extra'])]),
    JSON.stringify(['delete', JSON.stringify([3, 's'])]),
    JSON.stringify(['delete', JSON.stringify(['alice', 4])]),
    JSON.stringify(['alice', 's']), JSON.stringify(['owner-session-delete-v1', 'alice', 's'])];
  for (const value of invalid) receipts.claim(value, 'old', {});
  assert.equal(receipts.sessionDeletion('s'), undefined);
  receipts.claim(scope('alice'), 'unknown', {});
  assert.equal(receipts.sessionDeletion('s'), 'outcome_unknown');
  receipts.claim(scope('bob'), 'accepted', {});
  receipts.settle(scope('bob'), 'accepted', { status: 200, body: { ok: true } });
  assert.equal(receipts.sessionDeletion('s'), 'accepted');
  receipts.claim(scope('alice', 'other'), 'rejected', {});
  receipts.settle(scope('alice', 'other'), 'rejected', { status: 409, body: {} });
  assert.equal(receipts.sessionDeletion('other'), undefined);
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'command_receipt_deletion_session'").get() as { sql: string }).sql;
  const expression = sql.match(/ON command_receipts\s*\(([\s\S]+), state\) WHERE/)![1];
  const plan = JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN SELECT state FROM command_receipts
    WHERE ${expression} = ? AND state IN ('accepted', 'outcome_unknown') ORDER BY state LIMIT 1`).all('s'));
  assert.match(plan, /SEARCH.*command_receipt_deletion_session/);
  assert.doesNotMatch(plan, /SCAN|TEMP B-TREE/);
});

test('adding the deletion index preserves every legacy receipt and usage fact', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const old = new CommandReceipts(db);
  for (const session of ['unknown', 'accepted', 'rejected', 'quotes"/中文:%2F']) {
    old.claim(scope('alice', session), 'old', {}, true, 3);
    if (session === 'accepted' || session === 'rejected') old.settle(scope('alice', session), 'old',
      { status: session === 'accepted' ? 200 : 409, body: { ok: true } });
  }
  old.claim('legacy non-JSON', 'old', {});
  db.exec('DROP INDEX command_receipt_deletion_session');
  const rows = db.prepare('SELECT * FROM command_receipts ORDER BY scope').all();
  const usage = db.prepare('SELECT * FROM command_receipt_usage').all();
  const upgraded = new CommandReceipts(db);
  assert.equal(upgraded.sessionDeletion('unknown'), 'outcome_unknown');
  assert.equal(upgraded.sessionDeletion('accepted'), 'accepted');
  assert.equal(upgraded.sessionDeletion('rejected'), undefined);
  assert.equal(upgraded.sessionDeletion('quotes"/中文:%2F'), 'outcome_unknown');
  assert.equal(upgraded.sessionDeletion('quotes"/中文:/'), undefined, 'native identity is never decoded again');
  assert.deepEqual(db.prepare('SELECT * FROM command_receipts ORDER BY scope').all(), rows);
  assert.deepEqual(db.prepare('SELECT * FROM command_receipt_usage').all(), usage);
});

test('session exclusion crosses actors, persists rejected receipts and never re-evaluates duplicate admission', t => {
  const store = new ConnectorUserStore(':memory:'); t.after(() => store.close());
  const original = claim(store);
  const other = claim(store, 'bob');
  assert.equal(original.fresh, true);
  assert.equal(other.fresh, false);
  assert.equal(other.receipt.state, 'rejected');
  assert.equal(other.receipt.result?.status, 409);
  assert.equal(store.commands.get(scope('bob'), 'delete')?.id, other.receipt.id);
  assert.equal(store.commands.get(scope('bob'), 'alice-command'), undefined);
  assert.equal(claim(store, 'bob', 'different').receipt.state, 'rejected');
  assert.equal(claim(store, 'alice', 'delete', 'unrelated').fresh, true);
  assert.deepEqual(store.commands.claim(scope('alice'), 'delete', {}, false, undefined,
    () => { throw new Error('must not recheck'); }).receipt, original.receipt);
  store.commands.settle(scope('alice'), 'delete', { status: 403, body: {} });
  assert.equal(claim(store, 'bob').receipt.id, other.receipt.id, 'a rejected key never becomes a new attempt');
  assert.equal(claim(store, 'bob', 'after-rejection').fresh, true);
});

for (const runtime of ['openclaw', 'codex']) for (const state of ['queued', 'blocked', 'dispatching', 'outcome_unknown'] as const) {
  test(`${runtime}/${state}: pending work rejects deletion without changing queue, version or payload`, t => {
    const store = new ConnectorUserStore(':memory:'); t.after(() => store.close());
    store.turns.enqueue(runtime, { ...turn(), state });
    const before = store.turns.list(runtime), version = store.turns.version(runtime, 's', 'one');
    assert.equal(claim(store).receipt.state, 'rejected');
    assert.deepEqual(store.turns.list(runtime), before);
    assert.equal(store.turns.version(runtime, 's', 'one'), version);
    assert.equal(store.commands.sessionDeletion('s'), undefined, 'a rejected deletion cannot fence the original work');
    if (state === 'queued') assert.equal(store.turns.start(runtime, 's', 'one'), true);
  });
}

for (const result of ['outcome_unknown', 'accepted'] as const) {
  test(`${result}: deletion fences both queues and execution/preparation after database reopen`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-lifecycle-'));
    const file = join(directory, 'synthetic.sqlite');
    let store = new ConnectorUserStore(file);
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    assert.equal((await claimAsync(store)).fresh, true);
    if (result === 'accepted') store.commands.settle(scope('alice'), 'delete', { status: 200, body: { ok: true, status: 'delete_accepted' } });
    const receipt = store.commands.get(scope('alice'), 'delete');
    store.close(); store = new ConnectorUserStore(file);
    assert.deepEqual(store.commands.get(scope('alice'), 'delete'), receipt);
    assert.equal(store.commands.sessionDeletion('s'), result);
    for (const runtime of ['openclaw', 'codex']) {
      let acknowledged = false;
      await assert.rejects(store.turns.enqueueAsync(runtime, turn(), () => { acknowledged = true; }), SessionDeletionConflict);
      assert.equal(acknowledged, false);
      assert.deepEqual(store.turns.list(runtime), []);
      await store.turns.enqueueAsync(runtime, turn('other', 'other'));
      assert.equal(store.turns.start(runtime, 'other', 'other'), true);
    }
    assert.equal(store.openClawExecutions.begin('s', 'late'), false);
    assert.equal(store.codexExecutions.begin('s', 'late', 'connection'), false);
    assert.equal(store.codexExecutions.begin('s', 'late', 'connection', true), false);
    assert.equal(store.openClawExecutions.get('s'), undefined);
    assert.equal(store.codexExecutions.get('s'), undefined);
  });
}

test('legacy deletion coexisting with queue fences start/edit but permits explicit cancellation', t => {
  const store = new ConnectorUserStore(':memory:'); t.after(() => store.close());
  store.turns.enqueue('openclaw', turn());
  const version = store.turns.version('openclaw', 's', 'one');
  store.commands.claim(scope('alice'), 'legacy', {});
  assert.equal(store.turns.start('openclaw', 's', 'one'), false);
  assert.equal(store.turns.edit('openclaw', 's', 'one', () => { throw new Error('must not edit'); }), false);
  assert.equal(store.turns.version('openclaw', 's', 'one'), version);
  assert.equal(store.turns.cancel('openclaw', 's', 'one', version), true);
  assert.equal(store.commands.sessionDeletion('s'), 'outcome_unknown');
});

test('receipt admission exceptions roll back and release the transaction', t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db); t.after(() => db.close());
  assert.throws(() => receipts.claim(scope('alice'), 'delete', {}, false, undefined,
    () => { throw new Error('synthetic read failure'); }), /synthetic read failure/);
  assert.equal(receipts.get(scope('alice'), 'delete'), undefined);
  assert.equal(receipts.claim(scope('alice'), 'delete', {}).fresh, true);
});

for (const first of ['deletion', 'queue'] as const) test(`two SQLite connections: ${first} admission holds the write lock through its decision`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-lifecycle-lock-'));
  const file = join(directory, 'synthetic.sqlite');
  const a = new ConnectorUserStore(file), b = new ConnectorUserStore(file);
  t.after(() => { b.close(); a.close(); rmSync(directory, { recursive: true, force: true }); });
  if (first === 'deletion') {
    const result = await a.commands.claimAsync(scope('alice'), 'delete', {}, false, undefined, () => {
      lockedWriterProbe(file);
      return a.canDeleteSession('s');
    });
    assert.equal(result.fresh, true);
    await assert.rejects(b.turns.enqueueAsync('openclaw', turn()), SessionDeletionConflict);
    assert.equal((await claimAsync(b, 'bob')).receipt.state, 'rejected');
    assert.deepEqual(a.turns.list('openclaw'), []);
  } else {
    await a.turns.enqueueAsync('openclaw', turn(), () => lockedWriterProbe(file));
    assert.equal(b.commands.get(scope('bob'), 'delete'), undefined);
    assert.equal((await claimAsync(b, 'bob')).receipt.state, 'rejected');
    assert.equal(a.turns.start('openclaw', 's', 'one'), true);
  }
});

for (const runtime of ['openclaw', 'codex']) test(`${runtime}: running, unknown and unsynced terminal evidence prevents deletion`, t => {
  const store = new ConnectorUserStore(':memory:'); t.after(() => store.close());
  assert.equal(store.canDeleteSession('s'), true, 'no local work is only a local admission check');
  if (runtime === 'openclaw') store.openClawExecutions.begin('s', 'command');
  else store.codexExecutions.begin('s', 'command', 'connection');
  assert.equal(claim(store, 'alice', 'starting').receipt.state, 'rejected');
  if (runtime === 'openclaw') store.openClawExecutions.acknowledge('s', 'command', 'run');
  else store.codexExecutions.acknowledge('s', 'command', 'connection', 'run', () => {});
  assert.equal(claim(store, 'alice', 'running').receipt.state, 'rejected');
  if (runtime === 'openclaw') store.openClawExecutions.observe('s', { runId: 'run', phase: 'completed' });
  else store.codexExecutions.observe('s', 'connection', 'run', 'completed');
  assert.equal(claim(store, 'alice', 'syncing').receipt.state, 'rejected');
  if (runtime === 'openclaw') {
    store.openClawExecutions.setHistorySync('s', store.openClawExecutions.get('s')!.historySync!.revision, 'current');
  } else store.codexExecutions.settleHistory(store.codexExecutions.get('s')!, 'current');
  assert.equal(store.canDeleteSession('s'), true);
  if (runtime === 'openclaw') {
    store.openClawExecutions.begin('s', 'successor'); store.openClawExecutions.recoverInterrupted();
  } else {
    store.codexExecutions.begin('s', 'successor', 'connection'); store.codexExecutions.recoverInterrupted();
  }
  assert.equal(claim(store, 'alice', 'restarted').receipt.state, 'rejected');
});

test('conflicting late evidence prevents deletion of a previously completed run', t => {
  const store = new ConnectorUserStore(':memory:'); t.after(() => store.close());
  const runs = store.openClawExecutions;
  runs.begin('s', 'command'); runs.acknowledge('s', 'command', 'run');
  runs.observe('s', { runId: 'run', phase: 'completed' });
  runs.setHistorySync('s', runs.get('s')!.historySync!.revision, 'current');
  assert.equal(store.canDeleteSession('s'), true);
  runs.acknowledge('s', 'command', 'conflicting-run');
  assert.equal(store.canDeleteSession('s'), false);
  assert.equal(claim(store).receipt.state, 'rejected');
});

test('HTTP concurrent actors get private durable conflict receipts, not a second native deletion', async t => {
  const store = new ConnectorUserStore(':memory:'); t.after(() => store.close());
  const app = new Hono();
  let release!: () => void, enter!: () => void, effects = 0;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { enter = resolve; });
  for (const prefix of ['/sessions', '/legacy']) {
    registerDeletionReceipts(app, `${prefix}/:sessionKey`, { receipts: store.commands,
      scope: c => JSON.stringify([c.req.header('actor'), c.req.param('sessionKey')]),
      deletionAdmission: c => store.canDeleteSession(c.req.param('sessionKey')!) });
    app.delete(`${prefix}/:sessionKey`, async c => {
      effects++; enter(); await wait;
      c.get('acknowledgeDeletion')({ status: 200, body: { ok: true, status: 'delete_accepted' } });
      return c.json({ ok: true });
    });
  }
  const request = (actor: string, key: string, prefix = '/sessions') => app.request(`${prefix}/s`,
    { method: 'DELETE', headers: { actor, 'idempotency-key': key } });
  const first = request('alice', 'original'); await started;
  try {
    for (const [actor, key, prefix] of [['bob', 'different', '/legacy'], ['alice', 'new', '/sessions']] as const) {
      const response = await request(actor, key, prefix);
      assert.equal(response.status, 409);
      assert.equal((await response.json() as any).command.state, 'rejected');
    }
    assert.equal((await app.request('/sessions/s/deletion-commands/original', { headers: { actor: 'bob' } })).status, 404);
    assert.equal((await request('alice', 'original', '/legacy')).status, 202);
    assert.throws(() => store.turns.enqueue('codex', turn()), SessionDeletionConflict);
    assert.equal(effects, 1);
  } finally { release(); }
  assert.equal((await first).status, 200);
  assert.equal((await request('alice', 'original')).status, 200);
  assert.equal(effects, 1);
});
