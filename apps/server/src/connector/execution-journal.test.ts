import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorEventLog } from './event-log.js';
import { DeckStore } from '../projection/deck-store.js';
import { OpenClawTurnQueue } from '../openclaw/turn-queue.js';

function fixture(t: test.TestContext) {
  const users = new ConnectorUserStore(':memory:');
  t.after(() => users.close());
  const db = (users as unknown as { db: DatabaseSync }).db;
  const store = new DeckStore({ eventLog: users.events });
  store.bindOpenClawExecutions(users.openClawExecutions, () => 'connection');
  store.upsertSession({ sessionKey: 'dashboard:synthetic', title: 'Synthetic', agentId: 'synthetic', status: 'idle', lastActiveAt: 1 });
  return { users, db, store, runs: users.openClawExecutions, log: users.events };
}

test('execution commits its invalidation before any optional in-memory projection callback', async t => {
  const { runs, log, db, store } = fixture(t);
  const before = log.latestEventId(), revision = store.changes.revision;
  const statements: string[] = [], exec = db.exec.bind(db);
  db.exec = sql => { statements.push(sql); exec(sql); };
  const abort = new AbortController();
  const wake = store.changes.wait(revision, abort.signal);
  t.after(() => abort.abort());
  assert.equal(runs.begin('dashboard:synthetic', 'command'), true);
  assert.deepEqual(statements, ['BEGIN IMMEDIATE', 'COMMIT']);
  const events = log.getEventsSince(before);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'run.updated');
  assert.equal(events[0]?.sessionKey, 'dashboard:synthetic');
  assert.deepEqual(events[0]?.payload, { invalidation: true, executionRevision: runs.get('dashboard:synthetic')!.revision });
  assert.equal(store.changes.revision, revision + 1, 'commit wakes existing SSE waiters');
  await wake;
  assert.equal(store.getSessionExecution('dashboard:synthetic')?.runtime?.phase, 'starting', 'admission is not evidence of runtime start');
  assert.equal(store.getSessionExecution('dashboard:synthetic')?.sourceCursor, events[0]?.id);
  const head = log.latestEventId();
  assert.equal(runs.begin('dashboard:synthetic', 'command'), false);
  assert.equal(log.latestEventId(), head, 'rejected replay adds no journal work');
});

test('terminal and history facts advance snapshot cursors without requiring projection callbacks', t => {
  const { runs, log, store } = fixture(t), key = 'dashboard:synthetic';
  runs.begin(key, 'command'); runs.bindGatewayConnection(key, 'command', 'connection');
  runs.acknowledge(key, 'command', 'native');
  const cursor = log.latestEventId();
  runs.observe(key, { runId: 'native', gatewayConnectionId: 'connection', phase: 'completed' });
  const terminal = store.getSessionExecution(key)!;
  assert.equal(terminal.runtime?.phase, 'completed'); assert.equal(terminal.runtime?.sync, 'syncing');
  assert.notEqual(terminal.sourceCursor, cursor);
  runs.observe(key, { runId: 'native', gatewayConnectionId: 'connection', phase: 'completed' });
  assert.equal(log.latestEventId(), terminal.sourceCursor, 'duplicate evidence does not grow the journal');
  runs.setHistorySync(key, runs.get(key)!.historySync!.revision, 'current');
  assert.equal(store.getSessionExecution(key)?.runtime?.sync, 'current');
  assert.equal(log.getEventsSince(cursor).length, 2);
  assert.equal(store.getSessionsState().groups[0]?.sessions[0]?.status, 'idle');
  assert.equal(JSON.stringify(log.getEventsSince(cursor)).includes('native'), false);
});

test('a replacement event epoch fences old execution writes before committing facts', t => {
  const { runs, db, log } = fixture(t);
  runs.begin('dashboard:synthetic', 'command');
  const fact = runs.get('dashboard:synthetic');
  const replacement = new ConnectorEventLog(db); replacement.beginEpoch();
  const head = replacement.latestEventId();
  assert.throws(() => runs.acknowledge('dashboard:synthetic', 'command', 'native'), /epoch changed/);
  assert.deepEqual(runs.get('dashboard:synthetic'), fact);
  assert.equal(replacement.latestEventId(), head);
  assert.throws(() => log.latestEventId(), /unavailable/);
});

test('startup fact recovery and all of its invalidations form one transaction', t => {
  const { runs, db, log } = fixture(t);
  runs.begin('a', 'one'); runs.begin('b', 'two');
  const facts = [runs.get('a'), runs.get('b')], cursor = log.latestEventId();
  db.exec("CREATE TRIGGER reject_recovery BEFORE INSERT ON connector_events WHEN json_extract(new.body, '$.sessionKey') = 'b' BEGIN SELECT RAISE(ABORT, 'synthetic startup failure'); END");
  assert.throws(() => runs.recoverInterrupted(), /synthetic startup failure/);
  assert.deepEqual([runs.get('a'), runs.get('b')], facts);
  assert.equal(new ConnectorEventLog(db).latestEventId(), cursor);
});

test('real queue does not resend after dispatch succeeds but the ACK journal fails, including reopen', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-queue-journal-')), file = join(dir, 'connector.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let sends = 0;
  for (const reopen of [false, true]) {
    const users = new ConnectorUserStore(file), db = (users as unknown as { db: DatabaseSync }).db;
    const store = new DeckStore({ eventLog: users.events });
    if (reopen) { db.exec('DROP TRIGGER reject_ack'); users.events.beginEpoch(); }
    store.upsertSession({ sessionKey: 'dashboard:synthetic', title: 'Synthetic', status: 'idle', lastActiveAt: 1 });
    const queue = new OpenClawTurnQueue({ turns: users.turns, executions: users.openClawExecutions, store,
      authorizeTurn: () => true, refreshSessions: async () => {}, refreshMessages: async () => {}, mirror: async () => {},
      send: async () => {
        sends++;
        db.exec("CREATE TRIGGER reject_ack BEFORE INSERT ON connector_events BEGIN SELECT RAISE(ABORT, 'synthetic ACK failure'); END");
        return { runId: 'native' };
      } });
    const reconcile = () => (queue as unknown as { reconcile(key: string): Promise<void> }).reconcile('dashboard:synthetic');
    try {
      if (!reopen) {
        await queue.enqueueAsync({ id: 'command', sessionKey: 'dashboard:synthetic', createdAt: 1,
          payload: { message: 'synthetic', deliveryMode: 'web-only', media: [] } });
        await assert.rejects(reconcile(), /unavailable/);
        await assert.rejects(reconcile(), /unavailable/);
        assert.equal(users.turns.head('openclaw', 'dashboard:synthetic')?.state, 'dispatching');
      } else {
        await reconcile(); await reconcile();
        assert.equal(users.openClawExecutions.get('dashboard:synthetic')?.phase, 'unknown');
        assert.equal(users.turns.head('openclaw', 'dashboard:synthetic')?.state, 'outcome_unknown');
      }
      assert.equal(sends, 1);
    } finally { await queue.close(); users.close(); }
  }
});

test('ACK, queue removal and invalidation roll back together on journal failure', t => {
  const { users, runs, log, db, store } = fixture(t);
  users.turns.enqueue('openclaw', { sessionKey: 'dashboard:synthetic', id: 'command', createdAt: 1, payload: {} });
  users.turns.start('openclaw', 'dashboard:synthetic', 'command');
  runs.begin('dashboard:synthetic', 'command');
  const fact = runs.get('dashboard:synthetic'), cursor = log.latestEventId();
  db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON connector_events BEGIN SELECT RAISE(ABORT, 'synthetic journal failure'); END");
  assert.throws(() => runs.acknowledge('dashboard:synthetic', 'command', 'native', () => users.turns.complete('openclaw', 'command')), /synthetic journal failure/);
  assert.deepEqual(runs.get('dashboard:synthetic'), fact);
  assert.equal(users.turns.head('openclaw', 'dashboard:synthetic')?.state, 'dispatching');
  assert.throws(() => store.getSessionExecution('dashboard:synthetic'), /unavailable/);
  assert.equal(new ConnectorEventLog(db).latestEventId(), cursor);
  assert.equal(runs.begin('dashboard:synthetic', 'command'), false, 'already dispatched identity cannot be readmitted');
});

test('failure after inserting an invalidation rolls back event retention and queue removal', t => {
  const { users, runs, db, log, store } = fixture(t);
  users.turns.enqueue('openclaw', { sessionKey: 'dashboard:synthetic', id: 'command', createdAt: 1, payload: {} });
  users.turns.start('openclaw', 'dashboard:synthetic', 'command'); runs.begin('dashboard:synthetic', 'command');
  const cursor = log.latestEventId(), fact = runs.get('dashboard:synthetic'), revision = store.changes.revision;
  assert.throws(() => runs.acknowledge('dashboard:synthetic', 'command', 'native', () => {
    assert.notEqual(log.latestEventId(), cursor, 'event insert participates in the outer transaction');
    users.turns.complete('openclaw', 'command'); throw new Error('synthetic commit failure');
  }), /synthetic commit failure/);
  assert.equal(log.latestEventId(), cursor);
  assert.deepEqual(runs.get('dashboard:synthetic'), fact);
  assert.equal(users.turns.head('openclaw', 'dashboard:synthetic')?.state, 'dispatching');
  assert.equal(store.changes.revision, revision, 'rolled back writes do not advertise a new cursor');
  assert.equal(db.isTransaction, false);
});

for (const checkpoint of ['before', 'after'] as const) test(`process exit ${checkpoint} ACK commit preserves fact/event/queue atomicity`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-execution-journal-')), file = join(dir, 'connector.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = `
    import { ConnectorUserStore } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? './connector-user-store.ts' : './connector-user-store.js', import.meta.url).href)};
    const users = new ConnectorUserStore(${JSON.stringify(file)}), runs = users.openClawExecutions;
    await users.turns.enqueueAsync('openclaw', { sessionKey:'dashboard:synthetic', id:'command', createdAt:1, payload:{} });
    users.turns.start('openclaw','dashboard:synthetic','command'); runs.begin('dashboard:synthetic','command');
    const exec = users.db.exec.bind(users.db);
    users.db.exec = sql => {
      if (sql === 'COMMIT' && ${JSON.stringify(checkpoint)} === 'before') process.exit(0);
      exec(sql);
      if (sql === 'COMMIT' && ${JSON.stringify(checkpoint)} === 'after') process.exit(0);
    };
    runs.acknowledge('dashboard:synthetic','command','native', () => users.turns.complete('openclaw','command'));
    process.exit(2);
  `;
  const child = spawnSync(process.execPath, [...(import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  const users = new ConnectorUserStore(file); t.after(() => users.close());
  const head = users.events.latestEventId();
  const events = users.events.getEventsSince(head.replace(/:\d+$/, ':0'));
  assert.equal(events.length, checkpoint === 'before' ? 1 : 2);
  assert.equal(users.openClawExecutions.get('dashboard:synthetic')?.runId, checkpoint === 'before' ? undefined : 'native');
  assert.equal(users.turns.hasPending('openclaw', 'dashboard:synthetic'), checkpoint === 'before');
  users.events.beginEpoch(); users.openClawExecutions.recoverInterrupted();
  assert.equal(users.events.hasEvent(head), false);
  assert.equal(users.openClawExecutions.get('dashboard:synthetic')?.phase, 'unknown');
  assert.equal(users.openClawExecutions.begin('dashboard:synthetic', 'command'), false);
  assert.equal(users.openClawExecutions.begin('dashboard:synthetic', 'successor'), false);
  assert.equal(users.events.getEventsSince(users.events.latestEventId().replace(/:\d+$/, ':0')).length, 1, 'startup recovery also journals its fact');
});
