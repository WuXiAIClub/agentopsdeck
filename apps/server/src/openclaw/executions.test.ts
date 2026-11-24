import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { OpenClawExecutions } from './executions.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

for (const source of ['commit', 'journal', 'evidence', 'gateway-sync', 'gateway-observe', 'recovery-gateway', 'recovery-sync', 'recovery-evidence', 'recovery-journal'] as const)
  test(`OpenClaw ${source} async participant cannot escape its original execution transaction`, async () => {
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
    db.exec('CREATE TABLE late_effect(value INTEGER)'); const insert = db.prepare('INSERT INTO late_effect VALUES(1)');
    let release!: () => void, late: Promise<void> | undefined, enabled = false, calls = 0, notifications = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const callback = () => { if (!enabled) return; calls++; return late = (async () => { await held; insert.run(); })(); };
    const facts = new OpenClawExecutions(db, undefined, undefined, undefined,
      { appendInTransaction: source.endsWith('journal') ? callback : () => {}, changes: { notify: () => { notifications++; } } } as any,
      undefined, {
        syncExecutionInTransaction: source.endsWith('sync') ? callback : () => {},
        observeFinalInTransaction: source === 'gateway-observe' ? callback : () => {},
        recoverGatewayInTransaction: source === 'recovery-gateway' ? callback : () => {},
      }, { recordExecutionInTransaction: source.endsWith('evidence') ? callback : () => {} });
    try {
      facts.begin('s', 'command'); enabled = true; notifications = 0;
      assert.throws(() => source.startsWith('recovery-') ? facts.recoverInterrupted()
        : source === 'gateway-observe' ? facts.observe('s', { runId: 'run', phase: 'running' })
          : facts.acknowledge('s', 'command', 'run', source === 'commit' ? callback : undefined), /must be synchronous/);
      assert.equal(calls, 1); assert.equal(notifications, 0); assert.equal(raw.isTransaction, false);
      const original = JSON.parse((raw.prepare('SELECT fact FROM connector_openclaw_executions').get() as any).fact);
      assert.equal(original.phase, 'starting'); assert.equal(original.runId, undefined);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      assert.throws(() => facts.get('s'), StorageConnectionUnavailable);
      const observed = new Promise<void>((resolve, reject) => Promise.prototype.then.call(late, resolve, reject));
      const rejected = assert.rejects(observed, StorageConnectionUnavailable); release(); await rejected;
      assert.deepEqual(raw.prepare('SELECT * FROM late_effect').all(), []);
    } finally { release(); if (late) await late.catch(() => {}); db.close(); }
  });

function fixture(t: test.TestContext, limits: { rows?: number; bytes?: number } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let clock = 100;
  return { db, executions: new OpenClawExecutions(db, limits.rows, limits.bytes, () => clock++), turns: new TurnQueue(db) };
}

for (const operation of ['change', 'recovery'] as const) {
  for (const failure of ['begin', 'automatic-rollback', 'rollback', 'commit-ack'] as const) {
    test(`execution ${operation} preserves original ${failure} failure without replay`, t => {
      const { executions: runs, db } = fixture(t);
      runs.begin('private-session', 'private-command');
      const original = new Error('private-original'), exec = db.exec.bind(db);
      let settlements = 0, rollbacks = 0;
      db.exec = sql => {
        if (sql === 'BEGIN IMMEDIATE' && failure === 'begin') throw original;
        if (sql === 'ROLLBACK') { rollbacks++; if (failure === 'rollback') throw new Error('secondary rollback failure'); }
        if (sql === 'COMMIT') {
          settlements++;
          if (failure === 'automatic-rollback') exec('ROLLBACK');
          if (failure === 'commit-ack') exec('COMMIT');
          throw original;
        }
        return exec(sql);
      };
      try {
        assert.throws(() => operation === 'recovery' ? runs.recoverInterrupted() : runs.uncertain('private-session', 'private-command'), e => e === original);
        assert.equal(settlements, failure === 'begin' ? 0 : 1);
        assert.equal(rollbacks, failure === 'rollback' ? 1 : 0);
        assert.equal(runs.get('private-session')?.phase, failure === 'commit-ack' || failure === 'rollback' ? 'unknown' : 'starting');
      } finally { db.exec = exec; if (db.isTransaction) exec('ROLLBACK'); }
    });
  }
}

test('connection projection keyset visits managed facts in bounded primary-key pages', (t) => {
  const { executions: runs, db } = fixture(t);
  const expected = Array.from({ length: 75 }, (_, index) => String(index).padStart(3, '0'));
  for (const key of [...expected].reverse()) runs.begin(key, 'command');
  assert.equal(runs.sessionPage('', 500).length, 64);
  assert.deepEqual(runs.sessionPage('070', 2), ['071', '072']);
  const visited: string[] = [];
  for (;;) {
    const page = runs.sessionPage(visited.at(-1));
    if (!page.length) break;
    visited.push(...page);
  }
  assert.deepEqual(visited, expected);
  assert.match(JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN SELECT session_key FROM connector_openclaw_executions
    WHERE session_key > ? ORDER BY session_key LIMIT ?`).all('', 64)), /USING COVERING INDEX sqlite_autoindex_connector_openclaw_executions/);
});

test('terminal history work survives empty queues, successor admission and stale reads', (t) => {
  const { executions: runs, turns } = fixture(t);
  runs.begin('s', 'one'); runs.acknowledge('s', 'one', 'r1');
  runs.observe('s', { runId: 'r1', phase: 'completed' });
  const first = runs.get('s')!.historySync!;
  assert.equal(first.state, 'pending');
  assert.deepEqual(turns.sessionPage('openclaw'), []);
  assert.deepEqual(runs.historyPage(), ['s']);
  runs.setHistorySync('s', first.revision, 'error');
  assert.equal(runs.get('s')!.phase, 'completed', 'read failure cannot reopen execution');
  runs.begin('s', 'two'); runs.acknowledge('s', 'two', 'r2');
  assert.equal(runs.setHistorySync('s', first.revision, 'current'), true, 'session sync is independent of successor admission');
  assert.deepEqual(runs.historyPage(), []);
  runs.observe('s', { runId: 'r2', phase: 'failed' });
  assert.equal(runs.setHistorySync('s', first.revision, 'current'), false, 'an old read cannot clear a newer terminal');
  assert.deepEqual(runs.historyPage(), ['s']);
  assert.equal(runs.get('s')!.historySync!.revision, first.revision + 1);
  const second = runs.get('s')!.historySync!;
  runs.observe('s', { runId: 'r2', phase: 'failed' });
  assert.deepEqual(runs.get('s')!.historySync, second, 'duplicate terminal does not add work');
});

test('startup restores history work including legacy terminals without recovering execution from history', (t) => {
  const { executions: runs, db } = fixture(t);
  runs.begin('s', 'one'); runs.acknowledge('s', 'one', 'r1');
  runs.observe('s', { runId: 'r1', phase: 'completed' });
  const revision = runs.get('s')!.historySync!.revision;
  runs.setHistorySync('s', revision, 'current');
  runs.recoverInterrupted();
  assert.deepEqual(runs.historyPage(), ['s']);
  assert.equal(runs.setHistorySync('s', revision, 'current'), false);
  assert.equal(runs.get('s')!.phase, 'completed');
  db.exec("UPDATE connector_openclaw_executions SET fact = json_remove(fact, '$.historySync')");
  runs.recoverInterrupted();
  assert.equal(runs.get('s')!.historySync!.state, 'pending');
  runs.begin('s', 'two');
  runs.recoverInterrupted();
  assert.equal(runs.get('s')!.phase, 'unknown');
  assert.deepEqual(runs.historyPage(), ['s']);
});

test('history keyset pages are bounded and indexed, and completing reads releases all scheduling work', (t) => {
  const { executions: runs, db } = fixture(t);
  for (let index = 0; index < 75; index++) {
    const key = String(index).padStart(3, '0');
    runs.begin(key, 'command'); runs.acknowledge(key, 'command', 'run');
    runs.observe(key, { runId: 'run', phase: 'completed' });
  }
  assert.equal(runs.historyPage('', 500).length, 64);
  assert.deepEqual(runs.historyPage('070', 2), ['071', '072']);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT session_key FROM connector_openclaw_executions
    WHERE session_key > ? AND json_extract(fact, '$.historySync.state') IN ('pending', 'error')
    ORDER BY session_key LIMIT ?`).all('', 16);
  assert.match(JSON.stringify(plan), /connector_openclaw_history_sync/);
  let after = '', visited = 0;
  for (;;) {
    const page = runs.historyPage(after);
    if (!page.length) break;
    for (const key of page) { runs.setHistorySync(key, runs.get(key)!.historySync!.revision, 'current'); visited++; }
    after = page.at(-1)!;
  }
  assert.equal(visited, 75); assert.deepEqual(runs.historyPage(), []);
});

test('history facts survive SQLite reopen and startup invalidates reads from the discarded in-memory projection', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-history-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'synthetic.sqlite');
  let database = new DatabaseSync(file);
  let runs = new OpenClawExecutions(database);
  runs.begin('s', 'one'); runs.acknowledge('s', 'one', 'r');
  runs.observe('s', { runId: 'r', phase: 'completed' });
  const revision = runs.get('s')!.historySync!.revision;
  runs.setHistorySync('s', revision, 'error'); database.close();
  database = new DatabaseSync(file);
  try {
    runs = new OpenClawExecutions(database);
    assert.equal(runs.get('s')!.historySync!.state, 'error', 'read handles do not mutate facts');
    runs.recoverInterrupted();
    assert.equal(runs.get('s')!.phase, 'completed');
    assert.equal(runs.setHistorySync('s', revision, 'current'), false);
    assert.deepEqual(runs.historyPage(), ['s']);
    assert.equal(runs.setHistorySync('s', runs.get('s')!.historySync!.revision, 'current'), true);
    assert.deepEqual(runs.historyPage(), []);
  } finally { database.close(); }
});

test('CLI completion and pre-run rejection do not invent native history work', (t) => {
  const { executions: runs } = fixture(t);
  runs.begin('cli', 'one'); runs.useCli('cli', 'one'); runs.finishCli('cli', 'one', 'completed');
  runs.begin('rejected', 'one'); runs.rejectBeforeRun('rejected', 'one');
  assert.deepEqual(runs.historyPage(), []);
  runs.recoverInterrupted();
  assert.deepEqual(runs.historyPage(), []);
});

test('recovery pages select only bound unresolved facts on the accepting connection', (t) => {
  const { executions: runs } = fixture(t);
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
    runs.begin(key, `command-${key}`);
    if (key !== 'f') runs.bindGatewayConnection(key, `command-${key}`, key === 'e' ? 'other-connection' : 'connection');
    if (key !== 'd') runs.acknowledge(key, `command-${key}`, `run-${key}`);
  }
  runs.observe('b', { runId: 'run-b', phase: 'completed', gatewayConnectionId: 'connection' });
  runs.unownedActivity('c');
  assert.deepEqual(runs.recoveryPage('connection'), ['a']);
  assert.deepEqual(runs.recoveryPage('other-connection'), ['e']);
  assert.deepEqual(runs.recoveryPage(undefined), []);
  assert.deepEqual(runs.recoveryPage('connection', 'a'), []);
  assert.equal(runs.recoveryCandidate('a', 'new-connection'), undefined);
  assert.equal(runs.recoveryCandidate('c', 'connection'), undefined);
  assert.equal(runs.recoveryCandidate('d', 'connection'), undefined);
  const candidate = runs.recoveryCandidate('a', 'connection')!;
  runs.recoverInterrupted();
  assert.equal(runs.completeFromQuery(candidate), false, 'startup invalidates a previously captured query version');
  assert.equal(runs.get('a')?.phase, 'unknown');
  assert.deepEqual(runs.recoveryPage('new-process-connection'), []);
  assert.equal(runs.recoveryCandidate('a', 'connection'), undefined, 'old connection cannot grant takeover after restart');
  assert.equal(runs.completeFromQuery(runs.get('a')!), false, 'even a fresh revision is not takeover authority');
  assert.deepEqual(runs.recoveryPage('connection'), []);
});

test('recovery pagination is capped and uses its partial index instead of scanning terminal facts', (t) => {
  const { executions: runs, db } = fixture(t);
  for (let index = 0; index < 70; index++) {
    const key = String(index).padStart(3, '0');
    runs.begin(key, key); runs.bindGatewayConnection(key, key, 'connection'); runs.acknowledge(key, key, key);
  }
  assert.equal(runs.recoveryPage('connection', '', 1000).length, 64);
  assert.equal(runs.recoveryPage('connection', '063', 1000).length, 6);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT session_key FROM connector_openclaw_executions
    WHERE json_extract(fact, '$.gatewayConnectionId') = ? AND session_key > ?
      AND json_extract(fact, '$.phase') NOT IN ('completed', 'failed') AND json_extract(fact, '$.origin') = 'gateway'
      AND json_extract(fact, '$.reason') IS NOT 'restarted'
      AND json_extract(fact, '$.fenced') IS NOT 1 AND json_extract(fact, '$.runId') IS NOT NULL
    ORDER BY session_key LIMIT ?`).all('connection', '', 16) as { detail: string }[];
  assert.ok(plan.some((row) => row.detail.includes('USING INDEX connector_openclaw_recovery')));
  assert.ok(plan.every((row) => !row.detail.includes('TEMP B-TREE')));
});

test('recovery revision detects same-clock ABA; duplicate evidence does not invalidate a read', (t) => {
  const { db } = fixture(t);
  const runs = new OpenClawExecutions(db, undefined, undefined, () => 100);
  runs.begin('s', 'c'); runs.bindGatewayConnection('s', 'c', 'connection'); runs.acknowledge('s', 'c', 'r');
  runs.observe('s', { runId: 'r', phase: 'running', gatewayConnectionId: 'connection' });
  const candidate = runs.recoveryCandidate('s', 'connection')!;
  runs.observe('s', { runId: 'r', phase: 'waiting', gatewayConnectionId: 'connection' });
  runs.observe('s', { runId: 'r', phase: 'running', gatewayConnectionId: 'connection' });
  assert.equal(runs.get('s')?.updatedAt, candidate.updatedAt);
  assert.equal(runs.completeFromQuery(candidate), false);
  const fresh = runs.recoveryCandidate('s', 'connection')!;
  runs.observe('s', { runId: 'r', phase: 'running', gatewayConnectionId: 'connection' });
  assert.equal(runs.completeFromQuery(fresh), true);
  assert.equal(runs.completeFromQuery(fresh), false);
  assert.equal(runs.begin('s', 'next'), true);
  assert.equal(runs.completeFromQuery(fresh), false);
});

test('connection identity conflicts and invalid inputs cannot rebind a recovery source', (t) => {
  const { executions: runs } = fixture(t);
  runs.begin('s', 'c'); runs.bindGatewayConnection('s', 'c', 'first'); runs.acknowledge('s', 'c', 'r');
  const candidate = runs.recoveryCandidate('s', 'first')!;
  assert.equal(runs.bindGatewayConnection('s', 'wrong-command', 'second'), false);
  assert.throws(() => runs.bindGatewayConnection('s', 'c', ''), /connection identity/);
  assert.throws(() => runs.bindGatewayConnection('s', 'c', 'x'.repeat(513)), /connection identity/);
  runs.bindGatewayConnection('s', 'c', 'second');
  assert.equal(runs.get('s')?.phase, 'unknown');
  assert.deepEqual(runs.recoveryPage('first'), []);
  assert.deepEqual(runs.recoveryPage('second'), []);
  assert.equal(runs.completeFromQuery(candidate), false);
});

test('bound execution events require the ACK connection, not merely the same run string', (t) => {
  const { executions: runs } = fixture(t);
  runs.begin('s', 'c'); runs.bindGatewayConnection('s', 'c', 'one'); runs.acknowledge('s', 'c', 'r');
  const accepted = runs.get('s');
  for (const gatewayConnectionId of [undefined, 'two']) {
    assert.equal(runs.observe('s', { runId: 'r', phase: 'completed', gatewayConnectionId }), false);
    assert.deepEqual(runs.get('s'), accepted);
  }
  runs.observe('s', { runId: 'r', phase: 'completed', gatewayConnectionId: 'one' });
  assert.equal(runs.get('s')?.phase, 'completed');
});

test('early event correlation includes connection identity and rejects legacy unbound completion', (t) => {
  const { executions: runs } = fixture(t);
  runs.begin('s', 'c');
  runs.observe('s', { runId: 'r', phase: 'failed', gatewayConnectionId: 'other' });
  runs.observe('s', { runId: 'r', phase: 'completed', gatewayConnectionId: 'one' });
  runs.bindGatewayConnection('s', 'c', 'one'); runs.acknowledge('s', 'c', 'r');
  assert.equal(runs.get('s')?.phase, 'completed');
  runs.begin('legacy', 'c'); runs.acknowledge('legacy', 'c', 'r');
  assert.equal(runs.observe('legacy', { runId: 'r', phase: 'completed', gatewayConnectionId: 'one' }), false);
  assert.equal(runs.get('legacy')?.phase, 'starting');
});

test('foreign connection activity before or after ACK fences instead of releasing a run', (t) => {
  const { executions: runs } = fixture(t);
  for (const early of [false, true]) {
    const key = String(early);
    runs.begin(key, 'c');
    if (!early) { runs.bindGatewayConnection(key, 'c', 'one'); runs.acknowledge(key, 'c', 'r'); }
    runs.observe(key, { runId: 'r', phase: 'running', gatewayConnectionId: 'two' });
    if (early) { runs.bindGatewayConnection(key, 'c', 'one'); runs.acknowledge(key, 'c', 'r'); }
    assert.equal(runs.get(key)?.phase, 'unknown');
    assert.equal(runs.get(key)?.reason, 'unowned_run');
    assert.equal(runs.begin(key, 'next'), false);
  }
});

test('execution admission requires a fresh command and a terminal predecessor', (t) => {
  const { executions: runs } = fixture(t);
  assert.equal(runs.begin('session', 'command'), true);
  assert.equal(runs.begin('session', 'command'), false);
  assert.equal(runs.begin('session', 'next'), false);
  runs.acknowledge('session', 'command', 'remote-run');
  assert.equal(runs.get('session')?.phase, 'starting', 'accepted is not evidence of running');
  assert.equal(runs.get('session')?.runId, 'remote-run');
  runs.observe('session', { runId: 'remote-run', phase: 'completed' });
  assert.equal(runs.begin('session', 'command'), false, 'same command never admits again');
  assert.equal(runs.begin('session', 'next'), true);
  assert.equal(runs.get('session')?.runId, undefined, 'new command does not inherit run identity');
});

test('terminal before ACK is selected by opaque remote identity, never command identity', (t) => {
  const { executions: runs } = fixture(t);
  runs.begin('session', 'command');
  runs.observe('session', { runId: 'previous-run', phase: 'failed' });
  runs.observe('session', { runId: 'command', phase: 'failed' });
  runs.observe('session', { runId: 'remote-run', phase: 'completed' });
  runs.observe('session', { runId: 'remote-run', phase: 'running' });
  assert.equal(runs.get('session')?.phase, 'starting', 'unbound evidence cannot end the current dispatch');
  runs.acknowledge('session', 'command', 'remote-run');
  const completed = runs.get('session');
  assert.equal(completed?.phase, 'completed');
  assert.ok(completed?.completedAt);
  runs.acknowledge('session', 'command', 'remote-run');
  runs.observe('session', { runId: 'remote-run', phase: 'waiting' });
  assert.deepEqual(runs.get('session'), completed, 'duplicate ACK and late activity cannot reopen completion');
});

test('old command callbacks, wrong-session events and missing or mismatched run IDs do not change current execution', (t) => {
  const { executions: runs } = fixture(t);
  runs.begin('session', 'one');
  runs.acknowledge('session', 'one', 'r1');
  runs.observe('session', { runId: 'r1', phase: 'completed' });
  runs.begin('session', 'two');
  runs.acknowledge('session', 'two', 'r2');
  const current = runs.get('session');
  assert.equal(runs.acknowledge('session', 'one', 'r1', () => assert.fail('stale receipt must not commit')), false);
  assert.equal(runs.uncertain('session', 'one'), false);
  assert.equal(runs.observe('session', { runId: 'r1', phase: 'completed' }), false);
  assert.equal(runs.observe('other', { runId: 'r2', phase: 'completed' }), false);
  assert.equal(runs.observe('session', { runId: '', phase: 'completed' }), false);
  assert.deepEqual(runs.get('session'), current);
});

test('missing ACK identity and lost ACK retain an execution barrier until correlated evidence exists', (t) => {
  const { executions: runs } = fixture(t);
  runs.begin('session', 'command');
  runs.acknowledge('session', 'command', undefined);
  assert.equal(runs.get('session')?.reason, 'run_unbound');
  runs.uncertain('session', 'command');
  runs.observe('session', { runId: 'remote', phase: 'completed' });
  assert.equal(runs.get('session')?.phase, 'unknown');
  assert.equal(runs.begin('session', 'next'), false);
  runs.acknowledge('session', 'command', 'remote');
  assert.equal(runs.get('session')?.phase, 'completed');
  runs.uncertain('session', 'command');
  assert.equal(runs.get('session')?.phase, 'completed', 'a transport error cannot erase correlated completion');
});

test('conflicting ACK identities and terminal evidence fail closed instead of rebinding', (t) => {
  const { executions: runs } = fixture(t);
  runs.begin('ack', 'command');
  runs.acknowledge('ack', 'command', 'r1');
  runs.acknowledge('ack', 'command', 'r2');
  assert.equal(runs.get('ack')?.runId, 'r1');
  assert.equal(runs.get('ack')?.reason, 'ack_conflict');
  for (const early of [true, false]) {
    const key = `terminal-${early}`;
    runs.begin(key, 'command');
    if (!early) runs.acknowledge(key, 'command', 'run');
    runs.observe(key, { runId: 'run', phase: 'completed' });
    runs.observe(key, { runId: 'run', phase: 'failed' });
    if (early) runs.acknowledge(key, 'command', 'run');
    assert.equal(runs.get(key)?.reason, 'terminal_conflict');
    assert.equal(runs.get(key)?.completedAt, undefined);
    runs.observe(key, { runId: 'run', phase: 'completed' });
    assert.equal(runs.begin(key, 'next'), false);
  }
});

test('early evidence is bounded, body-free, coalesced per run, and overflow never invents a terminal outcome', (t) => {
  const { executions: runs, db } = fixture(t);
  runs.begin('session', 'command');
  db.exec(`CREATE TABLE execution_writes (count INTEGER); INSERT INTO execution_writes VALUES (0);
    CREATE TRIGGER count_execution_writes AFTER UPDATE ON connector_openclaw_executions BEGIN UPDATE execution_writes SET count = count + 1; END;`);
  for (let n = 0; n < 100; n++) runs.observe('session', { runId: 'run', phase: 'running', body: 'DO NOT STORE' } as any);
  const read = () => JSON.parse((db.prepare('SELECT fact FROM connector_openclaw_executions').get() as { fact: string }).fact);
  assert.equal(read().pending.length, 1);
  assert.equal(db.prepare('SELECT count FROM execution_writes').get()?.count, 1, 'identical observations do not rewrite SQLite');
  assert.equal(JSON.stringify(read()).includes('DO NOT STORE'), false);
  for (let n = 0; n < 7; n++) runs.observe('session', { runId: `other-${n}`, phase: 'completed' });
  assert.equal(read().pending.length, 8);
  runs.observe('session', { runId: 'overflow', phase: 'completed' });
  assert.equal(read().pending.length, 0);
  runs.acknowledge('session', 'command', 'run');
  assert.equal(runs.get('session')?.reason, 'evidence_overflow');
  assert.equal(runs.begin('session', 'next'), false);
});

test('CLI completion is command-bound, survives early callback, and never manufactures a Gateway run ID', (t) => {
  const { executions: runs } = fixture(t);
  runs.begin('session', 'one');
  assert.equal(runs.finishCli('session', 'one', 'completed'), false);
  assert.equal(runs.useCli('session', 'one'), true);
  runs.finishCli('session', 'one', 'completed');
  runs.acknowledgeCli('session', 'one');
  assert.equal(runs.get('session')?.phase, 'completed');
  assert.equal(runs.get('session')?.runId, undefined);
  runs.begin('session', 'two');
  runs.useCli('session', 'two');
  runs.acknowledgeCli('session', 'two');
  assert.equal(runs.finishCli('session', 'one', 'failed'), false);
  assert.equal(runs.observe('session', { runId: 'two', phase: 'completed' }), false);
  assert.equal(runs.get('session')?.phase, 'running');
  runs.finishCli('session', 'two', 'failed');
  assert.equal(runs.get('session')?.phase, 'failed');
});

test('execution and queue changes commit or roll back together without a second database', (t) => {
  const { executions: runs, turns } = fixture(t);
  turns.enqueue('openclaw', { id: 'command', sessionKey: 'session', createdAt: 1, payload: {} });
  assert.throws(() => runs.begin('session', 'command', () => {
    assert.equal(turns.start('openclaw', 'session', 'command'), true);
    throw new Error('receipt failed');
  }), /receipt failed/);
  assert.equal(runs.get('session'), undefined);
  assert.equal(turns.head('openclaw', 'session')?.state, 'queued');
  runs.begin('session', 'command', () => { assert.equal(turns.start('openclaw', 'session', 'command'), true); });
  assert.throws(() => runs.acknowledge('session', 'command', 'run', () => {
    turns.complete('openclaw', 'command');
    throw new Error('commit failed');
  }), /commit failed/);
  assert.equal(runs.get('session')?.runId, undefined);
  assert.equal(turns.head('openclaw', 'session')?.state, 'dispatching');
  runs.acknowledge('session', 'command', 'run', () => turns.complete('openclaw', 'command'));
  assert.equal(turns.head('openclaw', 'session'), undefined);
  assert.equal(runs.get('session')?.runId, 'run');
});

test('accepted execution survives queue deletion and restart; opening a reader does not recover the live writer', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-execution-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'connector.sqlite');
  let connector = new ConnectorUserStore(file);
  try {
    connector.openClawExecutions.begin('session', 'command');
    connector.openClawExecutions.acknowledge('session', 'command', 'remote');
    connector.openClawExecutions.observe('session', { runId: 'remote', phase: 'running' });
    connector.openClawExecutions.begin('early', 'early-command');
    connector.openClawExecutions.observe('early', { runId: 'early-remote', phase: 'completed' });
    const reader = new ConnectorUserStore(file);
    try { assert.equal(reader.openClawExecutions.get('session')?.phase, 'running'); } finally { reader.close(); }
    connector.close();
    connector = new ConnectorUserStore(file);
    connector.openClawExecutions.recoverInterrupted();
    assert.equal(connector.openClawExecutions.get('early')?.phase, 'unknown');
    assert.equal(connector.openClawExecutions.begin('early', 'new-command'), false);
    assert.equal(connector.openClawExecutions.acknowledge('early', 'early-command', 'early-remote'), false);
    assert.equal(connector.openClawExecutions.get('early')?.reason, 'restarted', 'pre-ACK evidence cannot grant takeover after restart');
    assert.equal(connector.openClawExecutions.get('session')?.reason, 'restarted');
    assert.equal(connector.openClawExecutions.get('session')?.runId, 'remote');
    assert.equal(connector.openClawExecutions.begin('session', 'next'), false);
    assert.equal(connector.openClawExecutions.observe('session', { runId: 'remote', phase: 'completed' }), false);
    assert.equal(connector.openClawExecutions.get('session')?.reason, 'restarted');
    connector.openClawExecutions.recoverInterrupted();
    assert.equal(connector.openClawExecutions.get('session')?.reason, 'restarted');
  } finally { connector.close(); }
});

for (const state of ['unbound', 'bound', 'accepted', 'send_unknown', 'cli_starting', 'cli_running'] as const) {
  test(`restarted OpenClaw ${state} rejects all old lifecycle callbacks without ACK commits`, (t) => {
    const { executions: runs, turns } = fixture(t);
    turns.enqueue('openclaw', { id: 'one', sessionKey: 's', createdAt: 1, payload: {} });
    turns.enqueue('openclaw', { id: 'two', sessionKey: 's', createdAt: 2, payload: {} });
    turns.start('openclaw', 's', 'one');
    runs.begin('s', 'one');
    if (state.startsWith('cli')) {
      runs.useCli('s', 'one');
      if (state === 'cli_running') runs.acknowledgeCli('s', 'one');
    } else if (state !== 'unbound') {
      runs.bindGatewayConnection('s', 'one', 'old');
      if (state === 'accepted') runs.acknowledge('s', 'one', 'native');
      if (state === 'send_unknown') runs.uncertain('s', 'one');
    }
    runs.recoverInterrupted(); turns.recoverInterrupted('openclaw');
    const before = runs.get('s');
    let commits = 0;
    const commit = () => { commits++; turns.complete('openclaw', 'one'); };
    const callbacks = [
      () => runs.bindGatewayConnection('s', 'one', 'old'),
      () => runs.bindGatewayConnection('s', 'one', 'replacement'),
      () => runs.acknowledge('s', 'one', 'native', commit),
      () => runs.acknowledge('s', 'one', undefined, commit),
      () => runs.acknowledgeCli('s', 'one', commit),
      () => runs.finishCli('s', 'one', 'completed'),
      () => runs.finishCli('s', 'one', 'failed'),
      () => runs.uncertain('s', 'one'),
      () => runs.rejectBeforeRun('s', 'one'),
      () => runs.useCli('s', 'one'),
      () => runs.unownedActivity('s'),
      () => runs.completeFromQuery(before!),
      ...(['running', 'waiting', 'unknown', 'completed', 'failed'] as const).map((phase) =>
        () => runs.observe('s', { runId: 'native', phase, gatewayConnectionId: 'old' })),
    ];
    for (const callback of callbacks) {
      assert.equal(callback(), false);
      assert.deepEqual(runs.get('s'), before, 'old callbacks must preserve reason, revision and pending ownership');
    }
    assert.equal(commits, 0);
    assert.equal(turns.head('openclaw', 's')?.state, 'outcome_unknown');
    assert.equal(turns.list('openclaw').find((turn) => turn.id === 'two')?.state, 'queued');
    assert.equal(runs.begin('s', 'two'), false);
    assert.deepEqual(runs.recoveryPage('old'), []);
    assert.equal(runs.recoveryCandidate('s', 'old'), undefined);
  });
}

test('capacity rejection rolls back facts and queue changes without evicting execution barriers', (t) => {
  const { executions: runs, turns } = fixture(t, { rows: 1 });
  runs.begin('one', 'command');
  turns.enqueue('openclaw', { id: 'two', sessionKey: 'two', createdAt: 1, payload: {} });
  assert.throws(() => runs.begin('two', 'two', () => { turns.start('openclaw', 'two', 'two'); }), /capacity/);
  assert.equal(turns.head('openclaw', 'two')?.state, 'queued');
  assert.equal(runs.get('one')?.phase, 'starting');
  runs.acknowledge('one', 'command', 'run');
  runs.observe('one', { runId: 'run', phase: 'completed' });
  assert.equal(runs.begin('one', 'next'), true, 'same-session replacement consumes no additional row');
  const limited = fixture(t, { bytes: 1024 }).executions;
  assert.throws(() => limited.begin('x'.repeat(1024), 'command'), /capacity/);
  assert.equal(limited.get('x'.repeat(1024)), undefined);
});

test('execution input bounds reject malformed identity and lifecycle vocabulary', (t) => {
  const { executions: runs } = fixture(t);
  assert.throws(() => runs.begin('', 'command'), /identity/);
  assert.throws(() => runs.begin('session', '命'.repeat(171)), /identity/);
  runs.begin('session', 'command');
  assert.equal(runs.observe('session', { runId: 'run', phase: 'not_running' } as any), false);
  assert.equal(runs.observe('session', { runId: 'x'.repeat(513), phase: 'completed' }), false);
  runs.acknowledge('session', 'command', { id: 'not-an-id' });
  assert.equal(runs.get('session')?.phase, 'unknown');
});

test('a full storage quota still allows bound execution to complete or record conflicts', (t) => {
  const { executions: runs, db } = fixture(t);
  const sessionKey = 's'.repeat(300);
  runs.begin(sessionKey, 'command');
  runs.acknowledge(sessionKey, 'command', 'run');
  const bytes = Number(db.prepare('SELECT bytes FROM connector_openclaw_execution_usage').get()?.bytes);
  const full = new OpenClawExecutions(db, 4096, bytes);
  full.observe(sessionKey, { runId: 'run', phase: 'completed' });
  assert.equal(full.get(sessionKey)?.phase, 'completed');
  full.setHistorySync(sessionKey, full.get(sessionKey)!.historySync!.revision, 'error');
  full.setHistorySync(sessionKey, full.get(sessionKey)!.historySync!.revision, 'current');
  full.recoverInterrupted();
  assert.equal(full.get(sessionKey)!.historySync!.state, 'pending');
  full.observe(sessionKey, { runId: 'run', phase: 'failed' });
  assert.equal(full.get(sessionKey)?.reason, 'terminal_conflict');
  assert.equal(db.prepare('SELECT bytes FROM connector_openclaw_execution_usage').get()?.bytes, bytes);
});
