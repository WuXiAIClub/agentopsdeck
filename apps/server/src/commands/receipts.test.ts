import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Hono } from 'hono';
import { CommandCapacity, CommandConflict, CommandReceipts, MAX_COMMAND_RESULT_BYTES, commandPayloadFingerprint } from './receipts.js';
import { registerMessageReceipts } from './http.js';
import { TurnQueue } from './turn-queue.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

test('private digest admission preserves original message identity in both directions and authorizes duplicates in transaction', async () => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  const scope = JSON.stringify(['owner', 'session']), payload = { z: ['large'.repeat(10_000)], a: { b: true } };
  let transactions = 0;
  const check = () => {}, transactionCheck = () => { assert.equal(db.isTransaction, true); transactions++; };
  try {
    const original = await receipts.claimAsync(scope, 'old', payload, true);
    const duplicate = await receipts.claimDigestAsync(scope, 'old', commandPayloadFingerprint({ a: { b: true }, z: payload.z }), check, transactionCheck);
    assert.equal(duplicate.fresh, false); assert.deepEqual(duplicate.receipt, original.receipt);
    const fresh = await receipts.claimDigestAsync(scope, 'new', commandPayloadFingerprint(payload), check, transactionCheck);
    assert.equal(fresh.fresh, true); assert.equal(receipts.authorityId(scope, 'new'), undefined);
    assert.deepEqual((await receipts.claimAsync(scope, 'new', payload, true)).receipt, fresh.receipt);
    assert.equal(transactions, 2);
    await assert.rejects(receipts.claimDigestAsync(scope, 'new', commandPayloadFingerprint({ changed: true }), check, transactionCheck), CommandConflict);
    await assert.rejects(receipts.claimDigestAsync(scope, 'new', commandPayloadFingerprint(payload), check, () => { throw Error('revoked'); }), /revoked/);
    for (const digest of ['', 'f'.repeat(63), 'F'.repeat(64), 'not-a-hash']) {
      await assert.rejects(receipts.claimDigestAsync(scope, 'invalid', digest, check, transactionCheck), CommandConflict);
    }
    await assert.rejects(receipts.claimDigestAsync(scope, 'invalid key', commandPayloadFingerprint(payload), check, transactionCheck), CommandConflict);
    assert.equal(receipts.get(scope, 'invalid'), undefined);
  } finally { db.close(); }
});

for (const participant of ['admission', 'binding'] as const) {
  test(`receipt ${participant} async participant cannot grant work or outlive its owner`, async () => {
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw), receipts = new CommandReceipts(db);
    db.exec('CREATE TABLE late_effect(value INTEGER)'); const insert = db.prepare('INSERT INTO late_effect VALUES(1)');
    let release!: () => void, late: Promise<unknown> | undefined, calls = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const callback = () => { calls++; return late = (async () => { await held; insert.run(); return true; })(); };
    try {
      const before = raw.prepare('SELECT * FROM command_receipt_usage').all();
      assert.throws(() => receipts.claim('scope', 'key', { text: 'private' }, false, undefined,
        participant === 'admission' ? callback as any : undefined,
        participant === 'binding' ? callback as any : undefined), /must be synchronous/);
      assert.equal(calls, 1); assert.equal(raw.isTransaction, false);
      assert.deepEqual(raw.prepare('SELECT * FROM command_receipts').all(), []);
      assert.deepEqual(raw.prepare('SELECT * FROM command_receipt_usage').all(), before);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      const rejected = assert.rejects(late!, StorageConnectionUnavailable); release(); await rejected;
      assert.deepEqual(raw.prepare('SELECT * FROM late_effect').all(), []);
    } finally { release(); if (late) await late.catch(() => {}); db.close(); }
  });
}

for (const operation of ['recovery', 'migration'] as const) {
  for (const failure of ['begin', 'automatic-rollback', 'rollback', 'commit-ack'] as const) {
    test(`receipt ${operation} preserves original ${failure} failure and sanitized trace`, () => {
      const db = new DatabaseSync(':memory:'), logs: any[] = [];
      const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
      const receipts = new CommandReceipts(db, undefined, undefined, undefined, undefined, diagnostics);
      if (operation === 'migration') db.exec('DROP TRIGGER command_receipt_insert_v6');
      logs.length = 0;
      const original = new Error('private-original'), exec = db.exec.bind(db);
      let commits = 0, rollbacks = 0;
      db.exec = sql => {
        if (sql === 'BEGIN IMMEDIATE' && failure === 'begin') throw original;
        if (sql === 'ROLLBACK') { rollbacks++; if (failure === 'rollback') throw new Error('secondary failure'); }
        if (sql === 'COMMIT') {
          commits++;
          if (failure === 'automatic-rollback') exec('ROLLBACK');
          if (failure === 'commit-ack') exec('COMMIT');
          throw original;
        }
        return exec(sql);
      };
      try {
        assert.throws(() => operation === 'recovery' ? receipts.recoverSettingsPrewrites()
          : new CommandReceipts(db, undefined, undefined, undefined, undefined, diagnostics), e => e === original);
        assert.equal(commits, failure === 'begin' ? 0 : 1);
        assert.equal(rollbacks, failure === 'rollback' ? 1 : 0);
        const trace = logs.find(row => row.operation === `command-receipt-${operation}`);
        assert.ok(trace); assert.equal(trace.category, 'failed');
        assert.doesNotMatch(JSON.stringify(logs), /private-original|secondary failure|BEGIN|ROLLBACK/);
      } finally { db.exec = exec; if (db.isTransaction) exec('ROLLBACK'); db.close(); }
    });
  }
}

test('receipt evidence checks duplicates without rewriting unchanged completion or settling its owner', () => {
  const db = new DatabaseSync(':memory:'), rows: any[] = [], prepares = new Map<string, number>();
  const prepare = db.prepare.bind(db);
  db.prepare = sql => { prepares.set(sql, (prepares.get(sql) ?? 0) + 1); return prepare(sql); };
  const receipts = new CommandReceipts(db, undefined, undefined, undefined, undefined,
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
  const scope = JSON.stringify(['private-actor', 'private-session']);
  const accept = (scope: string, key: string, runtime: string, mirror: number) => {
    receipts.claim(scope, key, {}); receipts.settle(scope, key, { status: 200, body: { idempotencyKey: 'private-run' } });
    prepare('UPDATE command_receipts SET native_runtime = ?, native_mirror = ? WHERE scope = ? AND command_key = ?').run(runtime, mirror, scope, key);
  };
  try {
    accept(scope, 'key', 'openclaw', 1);
    db.exec(`CREATE TABLE evidence_writes (field TEXT);
      CREATE TRIGGER count_execution_update AFTER UPDATE OF native_completed_at ON command_receipts
        BEGIN INSERT INTO evidence_writes VALUES ('execution'); END;
      CREATE TRIGGER count_mirror_update AFTER UPDATE OF mirror_completed_at ON command_receipts
        BEGIN INSERT INTO evidence_writes VALUES ('mirror'); END;`);
    const count = () => Number((prepare('SELECT count(*) AS n FROM evidence_writes').get() as any).n);
    const fact = { sessionKey: 'private-session', commandId: 'private-run', phase: 'completed', completedAt: 123 };
    const job = { sessionKey: 'private-session', idempotencyKey: 'private-run', actorId: 'private-actor', deliveryState: 'sent' };
    rows.length = 0; db.exec('BEGIN IMMEDIATE');
    receipts.recordExecutionInTransaction(db, 'openclaw', fact); assert.equal(count(), 1);
    receipts.recordExecutionInTransaction(db, 'openclaw', fact); assert.equal(count(), 1);
    receipts.recordExecutionInTransaction(db, 'openclaw', { ...fact, completedAt: 124 }); assert.equal(count(), 2);
    receipts.recordExecutionInTransaction(db, 'openclaw', { ...fact, reason: 'restarted' }); assert.equal(count(), 3);
    receipts.recordExecutionInTransaction(db, 'openclaw', { sessionKey: fact.sessionKey, commandId: fact.commandId, phase: 'running' }); assert.equal(count(), 3);
    receipts.recordMirrorInTransaction(db, job); assert.equal(count(), 4);
    const firstMirror = prepare('SELECT mirror_completed_at AS n FROM command_receipts').get();
    receipts.recordMirrorInTransaction(db, job); assert.equal(count(), 4);
    assert.deepEqual(prepare('SELECT mirror_completed_at AS n FROM command_receipts').get(), firstMirror);
    receipts.recordMirrorInTransaction(db, { ...job, deliveryState: 'unknown' }); assert.equal(count(), 5);
    receipts.recordMirrorInTransaction(db, { ...job, deliveryState: 'unknown' }); assert.equal(count(), 5);
    assert.equal(db.isTransaction, true); db.exec('ROLLBACK'); assert.equal(count(), 0);
    assert.deepEqual(rows.map(row => row.changed), [1, 0, 1, 1, 0, 1, 0, 1, 0]);
    for (const row of rows) { assert.equal(row.records, 1); assert.equal(row.settled, undefined); assert.equal(typeof row.bodyMs, 'number'); }
    assert.doesNotMatch(JSON.stringify(rows), /private-|SELECT|UPDATE/);
    for (const [sql, n] of prepares) if (sql.startsWith('SELECT scope, command_key, native_mirror FROM command_receipts')
      || sql.startsWith('UPDATE command_receipts SET native_completed_at = ?')
      || sql.startsWith('UPDATE command_receipts SET mirror_completed_at = CASE')) assert.equal(n, 1, sql);
    const lookup = [...prepares.keys()].find(sql => sql.startsWith('SELECT scope, command_key, native_mirror FROM command_receipts'))!;
    const plan = JSON.stringify(prepare(`EXPLAIN QUERY PLAN ${lookup}`).all('openclaw', 'private-run'));
    assert.match(plan, /SEARCH.*command_receipt_native_target/); assert.doesNotMatch(plan, /SCAN/);
    assert.throws(() => receipts.recordExecutionInTransaction(db, 'openclaw', fact), /owning transaction/);
    db.exec('BEGIN');
    receipts.recordExecutionInTransaction(db, 'codex', fact);
    receipts.recordExecutionInTransaction(db, 'openclaw', { ...fact, sessionKey: 'foreign' });
    receipts.recordMirrorInTransaction(db, { ...job, actorId: 'foreign' });
    assert.equal(count(), 0); db.exec('ROLLBACK');
    accept(JSON.stringify(['other', 'private-session']), 'duplicate', 'openclaw', 1);
    db.exec('BEGIN');
    receipts.recordExecutionInTransaction(db, 'openclaw', fact); receipts.recordMirrorInTransaction(db, job);
    assert.equal(count(), 0); assert.equal(rows.at(-1).records, 2); assert.equal(rows.at(-1).changed, 0);
    db.exec('ROLLBACK');
  } finally { db.close(); }
});

test('receipt evidence write failures are logged without owning rollback or replacing the exception', () => {
  const db = new DatabaseSync(':memory:'), logs: any[] = [];
  const receipts = new CommandReceipts(db, undefined, undefined, undefined, undefined,
    new PerformanceDiagnostics(line => logs.push(JSON.parse(line))));
  const scope = JSON.stringify(['actor', 'session']);
  try {
    receipts.claim(scope, 'key', {}); receipts.settle(scope, 'key', { status: 200, body: { idempotencyKey: 'run' } });
    db.prepare('UPDATE command_receipts SET native_runtime = ?, native_mirror = 1 WHERE scope = ?').run('openclaw', scope);
    db.exec(`CREATE TRIGGER reject_execution_evidence BEFORE UPDATE OF native_completed_at ON command_receipts
      BEGIN SELECT RAISE(ABORT, 'private evidence failure'); END;
      CREATE TRIGGER reject_mirror_evidence BEFORE UPDATE OF mirror_completed_at ON command_receipts
      BEGIN SELECT RAISE(ABORT, 'private evidence failure'); END; BEGIN IMMEDIATE;`);
    for (const work of [() => receipts.recordExecutionInTransaction(db, 'openclaw',
      { sessionKey: 'session', commandId: 'run', phase: 'completed', completedAt: 1 }),
    () => receipts.recordMirrorInTransaction(db, { sessionKey: 'session', actorId: 'actor', idempotencyKey: 'run', deliveryState: 'sent' })]) {
      assert.throws(work, /private evidence failure/); assert.equal(db.isTransaction, true);
      const row = logs.at(-1); assert.equal(row.operation, 'command-receipt-evidence');
      assert.equal(row.category, 'failed'); assert.equal(row.records, 1);
      assert.equal(row.settled, undefined); assert.equal(row.rollbackMs, undefined);
      assert.doesNotMatch(JSON.stringify(row), /private|session|actor|SELECT|UPDATE/);
    }
    db.exec('ROLLBACK');
  } finally { db.close(); }
});

test('queue command page resolves only unique accepted actor mappings with a bounded indexed lookup', () => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  try {
    const accept = (scope: string, key: string, id: unknown) => {
      receipts.claim(scope, key, {}); receipts.settle(scope, key, { status: 200, body: { idempotencyKey: id, private: 'never return' } });
    };
    accept('alice', 'original', 'runtime/空'); accept('bob', 'other', 'runtime/空');
    receipts.claim('alice', 'unknown', {});
    receipts.claim('alice', 'rejected', {}); receipts.settle('alice', 'rejected', { status: 409, body: { idempotencyKey: 'rejected' } });
    accept('alice', 'not-string', 12);
    assert.deepEqual(receipts.queueCommandKeys('alice', ['runtime/空', 'unknown', 'rejected', '12']), ['original', null, null, null]);
    assert.deepEqual(receipts.queueCommandKeys('bob', ['runtime/空']), ['other']);
    assert.deepEqual(receipts.queueCommandKeys('missing', ['runtime/空']), [null]);
    accept('alice', 'ambiguous', 'runtime/空');
    assert.deepEqual(receipts.queueCommandKeys('alice', ['runtime/空']), [null]);
    assert.equal(receipts.queueCommandKeys('alice', Array(64).fill('missing')).length, 64);
    assert.throws(() => receipts.queueCommandKeys('alice', Array(65).fill('missing')), CommandConflict);
    for (const id of ['', 'a'.repeat(513)]) assert.throws(() => receipts.queueCommandKeys('alice', [id]), CommandConflict);
    assert.deepEqual(receipts.queueCommandKeys('alice', []), []);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT command_key FROM command_receipts WHERE scope = ?
      AND state = 'accepted' AND json_valid(result) AND json_extract(result, '$.body.idempotencyKey') = ? LIMIT 2`).all('alice', 'runtime/空');
    assert.match(JSON.stringify(plan), /SEARCH.*command_receipt_queue_target/);
    assert.doesNotMatch(JSON.stringify(plan), /SCAN/);
  } finally { db.close(); }
});

test('queue command mapping index migrates and reopens without altering receipts or usage', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-queue-map-')), 'receipts.sqlite');
  let db = new DatabaseSync(file), receipts = new CommandReceipts(db);
  receipts.claim('scope', 'key', {}); receipts.settle('scope', 'key', { status: 200, body: { idempotencyKey: 'runtime' } });
  const before = receipts.get('scope', 'key'), usage = db.prepare('SELECT * FROM command_receipt_usage').get();
  db.exec('DROP INDEX command_receipt_queue_target'); db.close();
  db = new DatabaseSync(file); receipts = new CommandReceipts(db);
  try {
    assert.deepEqual(receipts.queueCommandKeys('scope', ['runtime']), ['key']);
    assert.deepEqual(receipts.get('scope', 'key'), before);
    assert.deepEqual(db.prepare('SELECT * FROM command_receipt_usage').get(), usage);
    new CommandReceipts(db);
    assert.deepEqual(receipts.queueCommandKeys('scope', ['runtime']), ['key']);
  } finally { db.close(); }
});

test('delivery reverse lookup is scope-bound, indexed, bounded and never settles unknown commands', () => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  try {
    receipts.claim('scope', 'browser-key', {}, true, 7);
    receipts.claim('other', 'browser-key', {}, true, 8);
    const delivery = receipts.deliveryKey('scope', 'browser-key');
    assert.deepEqual(receipts.deliveryCommands('scope', [delivery, 'missing']), [{ key: 'browser-key', state: 'outcome_unknown', authorityId: 7 }, null]);
    assert.deepEqual(receipts.deliveryCommands('other', [delivery]), [null]);
    assert.equal(receipts.get('scope', 'browser-key')?.state, 'outcome_unknown');
    receipts.claim('scope', 'legacy', {});
    assert.deepEqual(receipts.deliveryCommands('scope', ['legacy']), [null], 'no invented fallback delivery mapping');
    assert.throws(() => receipts.deliveryCommands('scope', Array(65).fill(delivery)), CommandConflict);
    assert.throws(() => receipts.deliveryCommands('scope', ['bad/key']), CommandConflict);
    receipts.claim('scope', 'ambiguous', {}, true, 7);
    db.prepare('UPDATE command_receipts SET delivery_key = ? WHERE scope = ? AND command_key = ?').run(delivery, 'scope', 'ambiguous');
    assert.deepEqual(receipts.deliveryCommands('scope', [delivery]), [null]);
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT command_key, state, authority_id FROM command_receipts WHERE scope = ? AND delivery_key = ? LIMIT 2').all('scope', delivery);
    assert.match(JSON.stringify(plan), /SEARCH.*command_receipt_delivery/); assert.doesNotMatch(JSON.stringify(plan), /SCAN/);
  } finally { db.close(); }
});

for (const method of ['edit', 'cancel'] as const) {
  test(`${method}: queue mutation and receipt roll back together; only committed cancellation wakes scheduling`, () => {
    const db = new DatabaseSync(':memory:'), other = new DatabaseSync(':memory:');
    const receipts = new CommandReceipts(db), queue = new TurnQueue(db), foreign = new CommandReceipts(other);
    queue.enqueue('codex', { id: 'one', sessionKey: 's', createdAt: 1, payload: { text: 'before' } });
    const version = queue.version('codex', 's', 'one')!;
    const mutate = (commit: (db: DatabaseSync) => void, expected = version) => method === 'edit'
      ? queue.edit('codex', 's', 'one', () => ({ text: 'after' }), expected, commit)
      : queue.cancel('codex', 's', 'one', expected, commit);
    const usage = () => [db.prepare('SELECT * FROM connector_turn_usage').get(), db.prepare('SELECT * FROM command_receipt_usage').get()];
    let wakes = 0; queue.onAdmission(() => { wakes++; });
    try {
      receipts.claim('s', 'key', {}); foreign.claim('s', 'key', {});
      const before = usage(), commit = receipts.queueCommit('s', 'key', { status: 200, body: { ok: true } });
      assert.equal(mutate(() => assert.fail('stale version must not call receipt'), '1:999'), false);
      assert.throws(() => mutate(foreign.queueCommit('s', 'key', { status: 200, body: {} })), /share a database/);
      assert.throws(() => mutate(database => { commit(database); throw new Error('synthetic rollback'); }), /rollback/);
      const tight = new CommandReceipts(db, 20_000, Number(before[1]!.bytes));
      assert.throws(() => mutate(tight.queueCommit('s', 'key', { status: 200, body: { value: 'x'.repeat(128) } })), CommandCapacity);
      assert.equal(receipts.get('s', 'key')?.state, 'outcome_unknown');
      assert.equal(queue.version('codex', 's', 'one'), version);
      assert.deepEqual(queue.head('codex', 's')?.payload, { text: 'before' });
      assert.deepEqual(usage(), before); assert.equal(wakes, 0);
      assert.equal(mutate(commit), true);
      assert.equal(receipts.get('s', 'key')?.state, 'accepted');
      assert.equal(wakes, method === 'cancel' ? 1 : 0);
      assert.equal(mutate(() => assert.fail('old version must not commit twice')), false);
    } finally { db.close(); other.close(); }
  });

  for (const crash of ['before-commit', 'after-commit']) test(`${method}: process exit ${crash} preserves atomic mutation outcome`, () => {
    const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-mutation-crash-')), 'commands.sqlite');
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      import { CommandReceipts } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? './receipts.ts' : './receipts.js', import.meta.url).href)};
      import { TurnQueue } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? './turn-queue.ts' : './turn-queue.js', import.meta.url).href)};
      const db = new DatabaseSync(${JSON.stringify(file)}), receipts = new CommandReceipts(db), queue = new TurnQueue(db);
      queue.enqueue('codex', { id: 'one', sessionKey: 's', createdAt: 1, payload: { text: 'before' } });
      receipts.claim('scope', 'key', {});
      const settle = receipts.queueCommit('scope', 'key', { status: 200, body: { ok: true } });
      const commit = database => { settle(database); if (${JSON.stringify(crash)} === 'before-commit') process.exit(0); };
      if (${JSON.stringify(method)} === 'edit') queue.edit('codex', 's', 'one', () => ({ text: 'after' }), '1:1', commit);
      else queue.cancel('codex', 's', 'one', '1:1', commit);
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, [...(import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const db = new DatabaseSync(file), receipts = new CommandReceipts(db), queue = new TurnQueue(db);
    try {
      const committed = crash === 'after-commit';
      assert.equal(receipts.get('scope', 'key')?.state, committed ? 'accepted' : 'outcome_unknown');
      assert.equal(queue.version('codex', 's', 'one'), !committed ? '1:1' : method === 'edit' ? '1:2' : undefined);
      assert.equal(receipts.claim('scope', 'key', {}).fresh, false, 'unknown never authorizes retry');
    } finally { db.close(); }
  });
}

test('authority provenance is atomic, private, immutable and never grafted onto legacy uncertainty', () => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  try {
    receipts.claim('legacy', 'key', {});
    assert.equal(receipts.authorityId('legacy', 'key'), undefined);
    assert.throws(() => receipts.claim('legacy', 'key', {}, true, 1), CommandConflict);
    const claimed = receipts.claim('bound', 'key', {}, true, 1);
    assert.equal(claimed.receipt.state, 'outcome_unknown');
    assert.equal(receipts.authorityId('bound', 'key'), 1);
    assert.equal(Object.hasOwn(claimed.receipt, 'authorityId'), false);
    assert.equal(receipts.claim('bound', 'key', {}, true, 1).fresh, false);
    assert.throws(() => receipts.claim('bound', 'key', {}, true, 2), CommandConflict);
    assert.throws(() => receipts.claim('bound', 'key', {}, true), CommandConflict);
    for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => receipts.claim('bad', 'key', {}, true, id), CommandConflict);
    }
    db.exec(`CREATE TRIGGER fail_bound_insert BEFORE INSERT ON command_receipts
      WHEN new.authority_id = 3 BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END`);
    assert.throws(() => receipts.claim('failed', 'key', {}, true, 3));
    assert.equal(receipts.get('failed', 'key'), undefined);
    assert.equal(receipts.authorityId('failed', 'key'), undefined);
    assert.equal(db.prepare('SELECT rows FROM command_receipt_usage').get()!.rows, 2);
  } finally { db.close(); }
});

test('private digest claims retain canonical identity, immutable authority and transaction checks', async () => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  const digest = commandPayloadFingerprint({ nested: { b: 2, a: 1 }, text: 'original' });
  const canonical = commandPayloadFingerprint({ text: 'original', nested: { a: 1, b: 2 } });
  let checks = 0;
  const checked = () => { checks++; }, transaction = () => { assert.equal(db.isTransaction, true); };
  try {
    assert.equal(digest, canonical);
    const first = await receipts.claimDigestAsync('bound', 'key', digest, checked, transaction, 7);
    const delivery = receipts.deliveryKey('bound', 'key');
    assert.equal(first.fresh, true); assert.ok(checks >= 2);
    assert.deepEqual(receipts.matchDigest('bound', 'key', canonical), first.receipt);
    assert.equal((await receipts.claimDigestAsync('bound', 'key', canonical, checked, transaction, 7)).fresh, false);
    for (const authority of [undefined, 8]) {
      await assert.rejects(receipts.claimDigestAsync('bound', 'key', digest, checked, transaction, authority), CommandConflict);
    }
    await assert.rejects(receipts.claimDigestAsync('bound', 'key', digest, checked, () => { throw Error('revoked under BEGIN'); }, 7), /revoked under BEGIN/);
    await assert.rejects(receipts.claimDigestAsync('new', 'key', digest, checked, () => { throw Error('revoked under BEGIN'); }, 7), /revoked under BEGIN/);
    assert.equal(receipts.get('new', 'key'), undefined);
    assert.equal(receipts.authorityId('bound', 'key'), 7); assert.equal(receipts.deliveryKey('bound', 'key'), delivery);
    assert.throws(() => receipts.matchDigest('bound', 'key', commandPayloadFingerprint({ different: true })), CommandConflict);
    for (const bad of ['', 'x'.repeat(64), digest.toUpperCase()]) {
      await assert.rejects(receipts.claimDigestAsync('bound', 'key', bad, checked, transaction, 7), CommandConflict);
      assert.throws(() => receipts.matchDigest('bound', 'key', bad), CommandConflict);
    }
    receipts.claim('legacy', 'old', { nested: { a: 1, b: 2 }, text: 'original' });
    assert.equal((await receipts.claimDigestAsync('legacy', 'old', canonical, checked, transaction)).fresh, false);
    assert.equal(receipts.deliveryKey('legacy', 'old'), 'old');
    await assert.rejects(receipts.claimDigestAsync('legacy', 'old', canonical, checked, transaction, 7), CommandConflict);
    assert.equal(db.prepare('SELECT rows FROM command_receipt_usage').get()!.rows, 2);
  } finally { db.close(); }
});

test('isolated delivery keys persist per receipt across scopes and restart, without rewriting legacy mappings', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-delivery-key-')), 'commands.sqlite');
  let db = new DatabaseSync(file);
  // Actual previous schema: the migration must not guess a new downstream key
  // for a request that may already have been executed under its original key.
  db.exec(`CREATE TABLE command_receipts (scope TEXT NOT NULL, command_key TEXT NOT NULL, id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    result TEXT, PRIMARY KEY(scope, command_key));
    INSERT INTO command_receipts VALUES ('legacy', 'old', 'old-id', 'fingerprint', 'outcome_unknown', 1, 1, NULL)`);
  let receipts = new CommandReceipts(db);
  try {
    assert.equal(receipts.deliveryKey('legacy', 'old'), 'old');
    assert.throws(() => receipts.deliveryKey('missing', 'old'), CommandConflict);
    receipts.claim('user-a', 'same', { message: 'same' }, true);
    receipts.claim('user-b', 'same', { message: 'same' }, true);
    const a = receipts.deliveryKey('user-a', 'same'), b = receipts.deliveryKey('user-b', 'same');
    assert.notEqual(a, b); assert.notEqual(a, 'same');
    assert.equal(receipts.get('user-a', 'same')?.key, 'same', 'caller key stays unchanged');
    assert.equal(receipts.claim('user-a', 'same', { message: 'same' }, true).fresh, false);
    assert.equal(receipts.deliveryKey('user-a', 'same'), a);
    receipts.claim('compatibility', 'raw', {});
    assert.equal(receipts.claim('compatibility', 'raw', {}, true).fresh, false);
    assert.equal(receipts.deliveryKey('compatibility', 'raw'), 'raw');
    db.close(); db = new DatabaseSync(file); receipts = new CommandReceipts(db);
    assert.equal(receipts.deliveryKey('user-a', 'same'), a);
    assert.equal(receipts.deliveryKey('user-b', 'same'), b);
    assert.equal(receipts.deliveryKey('legacy', 'old'), 'old');
  } finally { db.close(); }
});

test('receipt recovery verifies the persisted delivery key, not a matching caller key from another scope', async () => {
  const db = new DatabaseSync(':memory:');
  const receipts = new CommandReceipts(db);
  receipts.claim('actor', 'caller-key', {}, true);
  const deliveryKey = receipts.deliveryKey('actor', 'caller-key');
  const queries: string[] = [];
  let returnedKey = 'caller-key';
  const app = new Hono();
  registerMessageReceipts(app, '/sessions/:sessionKey', { receipts, isolatedDelivery: true, scope: () => 'actor', recover: async (_c, key) => {
    queries.push(key);
    return { id: 'upstream', key: returnedKey, state: 'accepted', createdAt: 1, updatedAt: 2,
      result: { status: 200, body: { ok: true, idempotencyKey: 'queue-id' } } };
  } });
  try {
    const first = await (await app.request('/sessions/s/commands/caller-key')).json() as any;
    assert.equal(first.command.state, 'outcome_unknown');
    returnedKey = deliveryKey;
    const second = await (await app.request('/sessions/s/commands/caller-key')).json() as any;
    assert.equal(second.command.state, 'accepted');
    assert.equal(second.command.key, 'caller-key');
    assert.equal(second.command.result.body.idempotencyKey, 'queue-id');
    assert.deepEqual(queries, [deliveryKey, deliveryKey]);
  } finally { db.close(); }
});

test('queue and receipt rollback together, without wakeup, on failure or quota rejection', () => {
  const db = new DatabaseSync(':memory:'), otherDb = new DatabaseSync(':memory:');
  const receipts = new CommandReceipts(db, 10, 1200), queue = new TurnQueue(db), otherQueue = new TurnQueue(otherDb);
  const turn = { id: 'turn-one', sessionKey: 'session', createdAt: 1, payload: { text: 'test' } };
  const result = { status: 200, body: { idempotencyKey: turn.id, status: 'queued' } };
  let wakes = 0; queue.onAdmission(() => { wakes++; });
  receipts.claim('scope', 'key', {});
  const commit = receipts.queueCommit('scope', 'key', result);
  try {
    assert.throws(() => otherQueue.enqueue('openclaw', turn, commit), /share a database/);
    assert.equal(otherQueue.list('openclaw').length, 0);
    assert.throws(() => queue.enqueue('openclaw', turn, (database) => { commit(database); throw new Error('injected commit failure'); }), /injected/);
    assert.equal(receipts.get('scope', 'key')?.state, 'outcome_unknown');
    assert.deepEqual({ ...db.prepare('SELECT rows, bytes FROM connector_turn_usage').get() }, { rows: 0, bytes: 0 });
    assert.throws(() => queue.enqueue('openclaw', turn, receipts.queueCommit('scope', 'key', { status: 200, body: { value: 'x'.repeat(1200) } })), CommandCapacity);
    assert.equal(queue.list('openclaw').length, 0);
    assert.equal(wakes, 0);
    queue.enqueue('openclaw', turn, commit);
    assert.equal(wakes, 1);
    assert.equal(receipts.get('scope', 'key')?.state, 'accepted');
    assert.throws(() => queue.enqueue('openclaw', { ...turn, id: 'different' }, commit), CommandConflict);
    assert.equal(queue.list('openclaw').length, 1);
  } finally { db.close(); otherDb.close(); }
});

for (const crash of ['before-commit', 'after-commit']) {
  test(`process exit ${crash} cannot split queue acceptance from receipt`, () => {
    const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-admission-crash-')), 'commands.sqlite');
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      import { CommandReceipts } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? './receipts.ts' : './receipts.js', import.meta.url).href)};
      import { TurnQueue } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? './turn-queue.ts' : './turn-queue.js', import.meta.url).href)};
      const db = new DatabaseSync(${JSON.stringify(file)}), receipts = new CommandReceipts(db), queue = new TurnQueue(db);
      receipts.claim('scope', 'key', { text: 'one task' });
      const commit = receipts.queueCommit('scope', 'key', { status: 200, body: { idempotencyKey: 'one', status: 'queued' } });
      if (${JSON.stringify(crash)} === 'after-commit') queue.onAdmission(() => process.exit(0));
      queue.enqueue('openclaw', { id: 'one', sessionKey: 'session', createdAt: 1, payload: { text: 'one task' } }, (database) => {
        commit(database);
        if (${JSON.stringify(crash)} === 'before-commit') process.exit(0);
      });
      process.exit(1);
    `;
    const child = spawnSync(process.execPath, [...(import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const db = new DatabaseSync(file), receipts = new CommandReceipts(db), queue = new TurnQueue(db);
    try {
      assert.equal(receipts.get('scope', 'key')?.state, crash === 'after-commit' ? 'accepted' : 'outcome_unknown');
      assert.equal(queue.list('openclaw').length, crash === 'after-commit' ? 1 : 0);
      assert.equal(receipts.claim('scope', 'key', { text: 'one task' }).fresh, false, 'crash does not authorize redispatch');
    } finally { db.close(); }
  });
}

test('durable claims retain unknown after restart and bind key to canonical content and scope', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-receipts-')), 'commands.sqlite');
  let db = new DatabaseSync(file);
  let receipts = new CommandReceipts(db);
  const first = receipts.claim('a', 'key', { text: 'secret-not-in-ledger', a: 1 });
  assert.equal(first.fresh, true);
  assert.equal(first.receipt.state, 'outcome_unknown');
  db.close(); db = new DatabaseSync(file); receipts = new CommandReceipts(db);
  try {
    const replay = receipts.claim('a', 'key', { a: 1, text: 'secret-not-in-ledger' });
    assert.equal(replay.fresh, false);
    assert.equal(replay.receipt.id, first.receipt.id);
    assert.equal(replay.receipt.state, 'outcome_unknown');
    assert.throws(() => receipts.claim('a', 'key', { text: 'different' }), CommandConflict);
    assert.equal(receipts.claim('b', 'key', { text: 'different' }).fresh, true);
    assert.equal(receipts.get('c', 'key'), undefined);
    assert.equal(readFileSync(file).includes(Buffer.from('secret-not-in-ledger')), false);
    receipts.settle('a', 'key', { status: 200, body: { ok: true, runId: 'one' } });
    receipts.settle('a', 'key', { status: 400, body: { error: 'late stale result' } });
    assert.equal(receipts.get('a', 'key')!.result!.body.runId, 'one');
  } finally { db.close(); }
});

test('capacity is bounded without evicting uncertain identities or response secrets', () => {
  const db = new DatabaseSync(':memory:');
  const receipts = new CommandReceipts(db, 2, 2048);
  try {
    receipts.claim('a', 'one', {});
    receipts.claim('a', 'two', {});
    assert.throws(() => receipts.claim('a', 'three', {}), CommandCapacity);
    assert.equal(receipts.claim('a', 'one', {}).fresh, false);
    assert.equal(receipts.settle('a', 'one', { status: 502, body: { error: 'upstream-token' } }).state, 'outcome_unknown');
    assert.equal(receipts.settle('a', 'one', { status: 200, body: { data: 'x'.repeat(2048) } }).state, 'outcome_unknown');
    const rejected = receipts.settle('a', 'two', { status: 403, body: { error: 'upstream-token' } });
    assert.equal(rejected.state, 'rejected');
    assert.equal(JSON.stringify(rejected).includes('upstream-token'), false);
  } finally { db.close(); }
});

for (const operation of ['create', 'settings', 'update', 'maintenance']) for (const state of ['accepted', 'rejected'] as const) test(`${operation} ${state} consumes its reserved result space and releases unused capacity`, () => {
  const db = new DatabaseSync(':memory:'), scope = JSON.stringify([operation, JSON.stringify(['alice', 'codex'])]);
  const budget = Buffer.byteLength(scope) + 512 + MAX_COMMAND_RESULT_BYTES;
  const receipts = new CommandReceipts(db, 10, budget);
  const usage = () => Number(db.prepare('SELECT bytes FROM command_receipt_usage').get()!.bytes);
  try {
    const original = receipts.claim(scope, 'create', {}).receipt;
    assert.equal(usage(), budget);
    assert.throws(() => receipts.claim(scope, 'other', {}), CommandCapacity);
    assert.equal(receipts.claim(scope, 'create', {}).fresh, false);
    assert.deepEqual(new CommandReceipts(db).get(scope, 'create'), original);
    assert.equal(usage(), budget, 'reopen neither releases nor double-reserves uncertainty');
    const result = state === 'accepted' ? { status: 201, body: { key: '中'.repeat(2000) } }
      : { status: 409, body: { error: 'private rejection' } };
    assert.equal(receipts.settle(scope, 'create', result).state, state, 'full budget still permits the original ACK');
    const saved = receipts.get(scope, 'create')!;
    assert.equal(usage(), Buffer.byteLength(scope) + 512 + Math.max(128, Buffer.byteLength(JSON.stringify(saved.result))));
    receipts.claim('a', 'message', {});
    assert.deepEqual(receipts.settle(scope, 'create', { status: 502, body: {} }), saved);
    db.prepare('DELETE FROM command_receipts').run();
    assert.equal(usage(), 0);
  } finally { db.close(); }
});

for (const operation of ['create', 'settings', 'update', 'maintenance']) test(`${operation} maximum result fits its reservation; oversized metadata stays unknown`, () => {
  const db = new DatabaseSync(':memory:'), scope = JSON.stringify([operation, 'scope']);
  const receipts = new CommandReceipts(db, 10, Buffer.byteLength(scope) + 512 + MAX_COMMAND_RESULT_BYTES);
  try {
    receipts.claim(scope, 'create', {});
    const result = { status: 201, body: { key: '' } };
    result.body.key = 'x'.repeat(MAX_COMMAND_RESULT_BYTES - Buffer.byteLength(JSON.stringify(result)));
    assert.equal(receipts.settle(scope, 'create', { ...result, body: { key: `${result.body.key}x` } }).state, 'outcome_unknown');
    assert.equal(receipts.settle(scope, 'create', result).state, 'accepted');
  } finally { db.close(); }
});

test('control reservation classifier agrees with SQLite for legacy and structured scopes', () => {
  for (const scope of ['legacy', '{', 'null', '42', '"create"', '{}', '[]', '["create"]', '["create",null,3]', '["create",null]', '["delete","x"]', '["settings",null]', '["settings"]', '["settings",null,3]', '[["settings"],null]', '["update",null]', '["update"]', '["update",null,3]', '[["update"],null]', '["maintenance",null]', '["maintenance"]', '["maintenance",null,3]', '[["maintenance"],null]']) {
    const db = new DatabaseSync(':memory:');
    const reserve = ['["create",null]', '["settings",null]', '["update",null]', '["maintenance",null]'].includes(scope) ? MAX_COMMAND_RESULT_BYTES : 128;
    try {
      const budget = Buffer.byteLength(scope) + 512 + reserve, receipts = new CommandReceipts(db, 10, budget);
      receipts.claim(scope, 'key', {});
      assert.equal(Number(db.prepare('SELECT bytes FROM command_receipt_usage').get()!.bytes), budget, scope);
      assert.throws(() => receipts.claim(scope, 'next', {}), CommandCapacity);
    } finally { db.close(); }
  }
});

test('v2 receipt budget upgrades creation reservations atomically and preserves old facts', () => {
  const db = new DatabaseSync(':memory:'), scope = JSON.stringify(['create', 'scope']);
  try {
    const receipts = new CommandReceipts(db);
    receipts.claim(scope, 'pending', {});
    receipts.claim(scope, 'done', {}); receipts.settle(scope, 'done', { status: 201, body: { key: 'native:old' } });
    const facts = db.prepare('SELECT * FROM command_receipts ORDER BY command_key').all();
    // Recreate the previous fixed-reservation accounting without changing rows.
    for (const name of ['insert', 'update', 'delete']) db.exec(`DROP TRIGGER command_receipt_${name}_v6`);
    db.exec(`UPDATE command_receipt_usage SET bytes = (SELECT sum(length(cast(scope AS BLOB)) + max(coalesce(length(cast(result AS BLOB)),0),128) + 512) FROM command_receipts);
      CREATE TRIGGER command_receipt_insert_v2 AFTER INSERT ON command_receipts BEGIN SELECT 1; END;
      CREATE TRIGGER command_receipt_update_v2 AFTER UPDATE OF result ON command_receipts BEGIN SELECT 1; END;
      CREATE TRIGGER command_receipt_delete_v2 AFTER DELETE ON command_receipts BEGIN SELECT 1; END;
      CREATE TRIGGER synthetic_failure BEFORE UPDATE ON command_receipt_usage BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
    const before = db.prepare('SELECT * FROM command_receipt_usage').get();
    assert.throws(() => new CommandReceipts(db), /synthetic failure/);
    assert.deepEqual(db.prepare('SELECT * FROM command_receipt_usage').get(), before);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='command_receipt_insert_v2'").get());
    db.exec('DROP TRIGGER synthetic_failure');
    const upgraded = new CommandReceipts(db, 10, 1);
    assert.deepEqual(db.prepare('SELECT * FROM command_receipts ORDER BY command_key').all(), facts);
    assert.equal(Number(db.prepare('SELECT bytes FROM command_receipt_usage').get()!.bytes), Number(before!.bytes) + MAX_COMMAND_RESULT_BYTES - 128);
    assert.throws(() => upgraded.claim(scope, 'new', {}), CommandCapacity);
    assert.equal(upgraded.settle(scope, 'pending', { status: 201, body: { key: 'native:recovered' } }).state, 'accepted');
    assert.equal(Number(db.prepare('SELECT bytes FROM command_receipt_usage').get()!.bytes), Number(before!.bytes));
  } finally { db.close(); }
});

for (const operation of ['settings', 'update', 'maintenance']) test(`${operation} reservation migration rolls back atomically, survives reopen and preserves over-budget facts`, t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-settings-budget-'));
  const file = join(directory, 'receipts.sqlite');
  let db = new DatabaseSync(file);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const scope = JSON.stringify([operation, JSON.stringify(['alice', 'native:session'])]);
  const creation = JSON.stringify(['create', 'scope']);
  const previousVersion = operation === 'maintenance' ? 'v6' : operation === 'update' ? 'v4' : 'v3';
  const previousScopes = operation === 'maintenance' ? "'create','settings','update'" : operation === 'update' ? "'create','settings'" : "'create'";
  const receipts = new CommandReceipts(db);
  for (const key of ['pending', 'accepted', 'rejected']) receipts.claim(scope, key, {}, true, 7);
  receipts.settle(scope, 'accepted', { status: 200, body: { sessionKey: 'native:session', model: 'model' } });
  receipts.settle(scope, 'rejected', { status: 409, body: {} });
  receipts.claim(creation, 'pending', {});
  const facts = db.prepare('SELECT * FROM command_receipts ORDER BY scope, command_key').all();
  const bytes = (row = '') => `CASE WHEN ${row}result IS NULL THEN CASE
    WHEN json_extract(${row}scope, '$[0]') IN (${previousScopes}) THEN ${MAX_COMMAND_RESULT_BYTES} ELSE 128 END
    ELSE max(length(cast(${row}result AS BLOB)),128) END`;
  for (const name of ['insert', 'update', 'delete']) db.exec(`DROP TRIGGER command_receipt_${name}_v6`);
  db.exec(`UPDATE command_receipt_usage SET bytes = (SELECT sum(length(cast(scope AS BLOB)) + ${bytes()} + 512) FROM command_receipts);
    CREATE TRIGGER command_receipt_insert_${previousVersion} AFTER INSERT ON command_receipts BEGIN
      UPDATE command_receipt_usage SET rows = rows + 1, bytes = bytes + length(cast(new.scope AS BLOB)) + ${bytes('new.')} + 512;
    END;
    CREATE TRIGGER command_receipt_update_${previousVersion} AFTER UPDATE OF result ON command_receipts BEGIN
      UPDATE command_receipt_usage SET bytes = bytes + ${bytes('new.')} - ${bytes('old.')};
    END;
    CREATE TRIGGER command_receipt_delete_${previousVersion} AFTER DELETE ON command_receipts BEGIN
      UPDATE command_receipt_usage SET rows = rows - 1, bytes = bytes - length(cast(old.scope AS BLOB)) - ${bytes('old.')} - 512;
    END;
    CREATE TRIGGER synthetic_failure BEFORE UPDATE ON command_receipt_usage BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END`);
  const before = db.prepare('SELECT * FROM command_receipt_usage').get()!;
  assert.throws(() => new CommandReceipts(db), /synthetic migration failure/);
  assert.deepEqual(db.prepare('SELECT * FROM command_receipt_usage').get(), before);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE ?").get(`command_receipt_%_${previousVersion}`)!.n, 3);
  assert.deepEqual(db.prepare('SELECT * FROM command_receipts ORDER BY scope, command_key').all(), facts);
  db.exec('DROP TRIGGER synthetic_failure');
  db.close(); db = new DatabaseSync(file);
  const upgraded = new CommandReceipts(db, 10, 1);
  const usage = () => Number(db.prepare('SELECT bytes FROM command_receipt_usage').get()!.bytes);
  assert.equal(usage(), Number(before.bytes) + MAX_COMMAND_RESULT_BYTES - 128);
  assert.deepEqual(db.prepare('SELECT * FROM command_receipts ORDER BY scope, command_key').all(), facts);
  assert.throws(() => upgraded.claim(scope, 'new', {}), CommandCapacity);
  assert.equal(upgraded.claim(scope, 'pending', {}, true, 7).fresh, false);
  const result = { status: 200, body: { sessionKey: 'native:session', model: '中'.repeat(2000) } };
  assert.equal(upgraded.settle(scope, 'pending', result).state, 'accepted');
  const settledUsage = usage(), settled = upgraded.get(scope, 'pending');
  assert.equal(settledUsage, Number(before.bytes) - 128 + Buffer.byteLength(JSON.stringify(result)));
  assert.equal(upgraded.authorityId(scope, 'pending'), 7);
  db.close(); db = new DatabaseSync(file);
  const reopened = new CommandReceipts(db, 10, 1);
  assert.equal(usage(), settledUsage);
  assert.deepEqual(reopened.get(scope, 'pending'), settled);
  assert.equal(reopened.sessionSettingsPending('native:session'), false);
  assert.equal(reopened.get(creation, 'pending')!.state, 'outcome_unknown');
});

test('maintenance reservations retain committed v6 discovery names and do not remigrate on reopen', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const receipts = new CommandReceipts(db);
    const scope = JSON.stringify(['maintenance', JSON.stringify(['node', 'alice', 'pause'])]);
    const original = receipts.claim(scope, 'original', {}).receipt;
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN
      ('command_receipt_insert_v6', 'command_receipt_update_v6', 'command_receipt_delete_v6') ORDER BY name`).all();
    assert.equal(names.length, 3);
    const before = db.prepare('SELECT * FROM command_receipt_usage').get();
    db.exec("CREATE TRIGGER synthetic_failure BEFORE UPDATE ON command_receipt_usage BEGIN SELECT RAISE(ABORT, 'unexpected remigration'); END");
    const reopened = new CommandReceipts(db);
    assert.deepEqual(reopened.get(scope, 'original'), original);
    assert.deepEqual(db.prepare('SELECT * FROM command_receipt_usage').get(), before);
    db.exec('DROP TRIGGER synthetic_failure');
    reopened.claim('legacy', 'another', {});
    assert.equal(db.prepare('SELECT rows FROM command_receipt_usage').get()!.rows, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM command_receipts').get()!.count, 2);
  } finally { db.close(); }
});

test('claim reserves a small final receipt even when later admissions exhaust the byte budget', () => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 10, 2 * (512 + 128 + 1));
  const usage = () => Number(db.prepare('SELECT bytes FROM command_receipt_usage').get()!.bytes);
  try {
    receipts.claim('a', 'first', {});
    receipts.claim('b', 'last', {});
    assert.equal(usage(), 1282);
    assert.throws(() => receipts.claim('c', 'overflow', {}), CommandCapacity);
    const tooLarge = receipts.settle('a', 'first', { status: 200, body: { text: 'x'.repeat(128) } });
    assert.equal(tooLarge.state, 'outcome_unknown');
    assert.equal(receipts.settle('a', 'first', { status: 200, body: { ok: true, status: 'delete_accepted' } }).state, 'accepted');
    assert.equal(receipts.settle('b', 'last', { status: 409, body: { private: 'never persist' } }).state, 'rejected');
    assert.equal(usage(), 1282);
    const before = receipts.get('a', 'first');
    assert.deepEqual(new CommandReceipts(db).get('a', 'first'), before);
    assert.equal(usage(), 1282, 'reopening does not reserve twice');
    db.prepare('DELETE FROM command_receipts WHERE scope = ?').run('b');
    assert.equal(usage(), 641, 'deleting a receipt releases its entire reserved allowance');
  } finally { db.close(); }
});

test('legacy receipt accounting migrates atomically without changing command facts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // Prior schema and accounting, including pre-existing identities/results.
    db.exec(`CREATE TABLE command_receipts (scope TEXT NOT NULL, command_key TEXT NOT NULL, id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      result TEXT, delivery_key TEXT, authority_id INTEGER, PRIMARY KEY(scope,command_key));
      CREATE TABLE command_receipt_usage(singleton INTEGER PRIMARY KEY, rows INTEGER NOT NULL, bytes INTEGER NOT NULL);
      INSERT INTO command_receipt_usage VALUES(1,0,0);
      CREATE TRIGGER command_receipt_insert AFTER INSERT ON command_receipts BEGIN
        UPDATE command_receipt_usage SET rows = rows + 1, bytes = bytes + length(cast(new.scope AS BLOB)) + coalesce(length(cast(new.result AS BLOB)),0) + 512;
      END;
      CREATE TRIGGER command_receipt_update AFTER UPDATE OF result ON command_receipts BEGIN
        UPDATE command_receipt_usage SET bytes = bytes + coalesce(length(cast(new.result AS BLOB)),0) - coalesce(length(cast(old.result AS BLOB)),0);
      END;
      CREATE TRIGGER command_receipt_delete AFTER DELETE ON command_receipts BEGIN
        UPDATE command_receipt_usage SET rows = rows - 1, bytes = bytes - length(cast(old.scope AS BLOB)) - coalesce(length(cast(old.result AS BLOB)),0) - 512;
      END;`);
    const insert = db.prepare('INSERT INTO command_receipts VALUES(?,?,?,?,?,?,?,?,?,?)');
    insert.run('a', 'pending', 'original-id', 'hash', 'outcome_unknown', 1, 2, null, 'original-delivery', 7);
    const result = JSON.stringify({ status: 200, body: { text: '中'.repeat(100) } });
    insert.run('b', 'accepted', 'second-id', 'hash', 'accepted', 3, 4, result, null, null);
    const facts = db.prepare('SELECT * FROM command_receipts ORDER BY scope').all();
    const oldUsage = db.prepare('SELECT * FROM command_receipt_usage').get();
    db.exec(`CREATE TRIGGER synthetic_accounting_failure BEFORE UPDATE ON command_receipt_usage BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END`);
    assert.throws(() => new CommandReceipts(db), /synthetic migration failure/);
    assert.deepEqual(db.prepare('SELECT * FROM command_receipt_usage').get(), oldUsage);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='command_receipt_insert'").get(), 'failed upgrade retains old triggers');
    db.exec('DROP TRIGGER synthetic_accounting_failure');
    const receipts = new CommandReceipts(db, 10, 1); // Existing data may exceed the new budget; never evict it.
    assert.deepEqual(db.prepare('SELECT * FROM command_receipts ORDER BY scope').all().map(({ binding_json, retained_bytes, native_runtime, native_mirror, native_completed_at, mirror_completed_at, settings_dispatch_phase, ...row }) => {
      assert.equal(binding_json, null); assert.equal(retained_bytes, 0);
      assert.equal(native_runtime, null); assert.equal(native_mirror, null); assert.equal(native_completed_at, null);
      assert.equal(mirror_completed_at, null);
      assert.equal(settings_dispatch_phase, null, 'legacy unknown writes must never be reclassified as proven prewrite');
      return row;
    }), facts.map(row => ({ ...row })));
    const expected = 2 * (512 + 1) + 128 + Buffer.byteLength(result);
    assert.equal(Number(db.prepare('SELECT bytes FROM command_receipt_usage').get()!.bytes), expected);
    assert.throws(() => receipts.claim('a', 'new', {}), CommandCapacity);
    assert.equal(receipts.settle('a', 'pending', { status: 200, body: { ok: true, status: 'delete_accepted' } }).state, 'accepted');
    assert.equal(Number(db.prepare('SELECT bytes FROM command_receipt_usage').get()!.bytes), expected, 'settlement consumes the reservation without increasing migration debt');
    assert.equal(receipts.deliveryKey('a', 'pending'), 'original-delivery');
    assert.equal(receipts.authorityId('a', 'pending'), 7);
    new CommandReceipts(db);
    assert.equal(Number(db.prepare('SELECT bytes FROM command_receipt_usage').get()!.bytes), expected);
  } finally { db.close(); }
});

test('missing, pending and final receipt lookups never permit cached recovery results', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const receipts = new CommandReceipts(db), app = new Hono();
    registerMessageReceipts(app, '/sessions/:sessionKey', { receipts, scope: c => c.req.param('sessionKey')! });
    const read = async (status: number, state?: string) => {
      const response = await app.request('/sessions/s/commands/late');
      assert.equal(response.status, status);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      if (state) assert.equal((await response.json() as any).command.state, state);
    };
    await read(404);
    receipts.claim('s', 'late', {}); await read(200, 'outcome_unknown');
    receipts.settle('s', 'late', { status: 202, body: { ok: true, status: 'queued' } });
    await read(200, 'accepted');
  } finally { db.close(); }
});

test('duplicate while awaiting execution never dispatches twice and completed receipt is replayed', async () => {
  const db = new DatabaseSync(':memory:');
  const app = new Hono();
  const receipts = new CommandReceipts(db);
  let calls = 0, finish!: () => void, received!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const started = new Promise<void>((resolve) => { received = resolve; });
  registerMessageReceipts(app, '/sessions/:sessionKey', { receipts, scope: (c) => c.req.param('sessionKey') ?? '' });
  app.post('/sessions/:sessionKey/messages', async (c) => {
    calls++; received(); await held;
    return c.json({ ok: true, runId: 'one', key: c.get('commandKey') });
  });
  const request = (text = 'message') => app.request('/sessions/s/messages', { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'stable' }, body: JSON.stringify({ message: text }) });
  try {
    const pending = request(); await started;
    const unknown = await request();
    assert.equal(unknown.status, 202);
    assert.equal((await unknown.json() as any).command.state, 'outcome_unknown');
    assert.equal((await request('different')).status, 409);
    finish();
    const first = await (await pending).json();
    assert.deepEqual(await (await request()).json(), first);
    assert.equal(calls, 1);
    assert.equal((await (await app.request('/sessions/s/commands/stable')).json() as any).command.state, 'accepted');
    assert.equal((await app.request('/sessions/other/commands/stable')).status, 404);
  } finally { finish(); db.close(); }
});

test('lost acknowledgement reconciles by receipt lookup only, never by a second POST', async () => {
  const db = new DatabaseSync(':memory:');
  const receipts = new CommandReceipts(db);
  const app = new Hono();
  let posts = 0, queries = 0;
  registerMessageReceipts(app, '/sessions/:sessionKey', { receipts, scope: (c) => c.req.param('sessionKey') ?? '',
    recover: async () => { queries++; return { id: 'remote', key: 'stable', state: 'accepted', createdAt: 1, updatedAt: 2, result: { status: 200, body: { ok: true, runId: 'one' } } }; } });
  app.post('/sessions/:sessionKey/messages', (c) => { posts++; return c.json({ error: 'lost ack' }, 502); });
  const request = () => app.request('/sessions/s/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'm', idempotencyKey: 'stable' }) });
  try {
    assert.equal((await request()).status, 202);
    const replay = await request();
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as any).runId, 'one');
    assert.equal(posts, 1); assert.equal(queries, 1);
    await request(); assert.equal(queries, 1);
  } finally { db.close(); }
});

test('untrusted receipt lookup cannot settle the wrong key or contradictory state', async () => {
  for (const upstream of [
    { key: 'other', state: 'accepted', result: { status: 200, body: {} } },
    { key: 'stable', state: 'accepted', result: { status: 403, body: {} } },
    { key: 'stable', state: 'rejected', result: { status: 200, body: {} } },
    { key: 'stable', state: 'accepted', result: { status: 200, body: [] } },
  ]) {
    const db = new DatabaseSync(':memory:');
    const receipts = new CommandReceipts(db);
    receipts.claim('s', 'stable', {});
    const app = new Hono();
    registerMessageReceipts(app, '/sessions/:sessionKey', { receipts, scope: () => 's', recover: async () => upstream as any });
    try {
      const response = await app.request('/sessions/s/commands/stable');
      assert.equal((await response.json() as any).command.state, 'outcome_unknown');
    } finally { db.close(); }
  }
});

test('conflicting header and body keys fail before command admission', async () => {
  const db = new DatabaseSync(':memory:');
  const receipts = new CommandReceipts(db);
  const app = new Hono();
  registerMessageReceipts(app, '/sessions/:sessionKey', { receipts, scope: () => 's' });
  app.post('/sessions/:sessionKey/messages', () => { assert.fail('must not dispatch'); });
  try {
    const result = await app.request('/sessions/s/messages', { method: 'POST', headers: { 'idempotency-key': 'header', 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'body', message: 'task' }) });
    assert.equal(result.status, 400);
    assert.equal(receipts.get('s', 'header'), undefined);
    assert.equal(receipts.get('s', 'body'), undefined);
  } finally { db.close(); }
});
