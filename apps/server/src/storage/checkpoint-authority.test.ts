import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { checkpointOwnedWalAsync } from './owned-sqlite.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { recoverableConnection, connectionRecoverySnapshot } from './connection-recovery.js';

for (const hook of ['check', 'available'] as const) for (const phase of [1, 2, 3, 4, 5, 6]) {
  test(`checkpoint ${hook} refuses Promise authority at original phase ${phase}`, async t => {
    const raw = new DatabaseSync(':memory:');
    t.after(() => { if (raw.isOpen) raw.close(); });
    const rows: Record<string, unknown>[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
    const db = recoverableConnection(raw, diagnostics);
    let checks = 0, sql = 0, getters = 0;
    const value = Object.defineProperty(Promise.resolve(hook === 'available' ? true : undefined), 'then', {
      get() { getters++; throw Error('private-getter'); },
    });
    const callback = (() => ++checks === phase ? value : hook === 'available' ? true : undefined) as never;
    const prepare = raw.prepare.bind(raw);
    t.mock.method(raw, 'prepare', (sqlText: string) => { if (sqlText.includes('wal_checkpoint')) sql++; return prepare(sqlText); });
    await assert.rejects(checkpointOwnedWalAsync(db, '/nonexistent-private-authority.db', {
      [hook]: callback, diagnostics, sample: async () => 0,
      admission: async (_root, _bytes, write) => write(),
    }));
    assert.equal(checks, phase); assert.equal(sql, Number(phase === 6)); assert.equal(getters, 0);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    const event = rows.find(row => row.operation === 'owned-wal-checkpoint')!;
    assert.equal(event.category, 'failed'); assert.equal(event.unknown ?? 0, Number(phase === 6));
    assert.doesNotMatch(JSON.stringify(rows), /private|nonexistent|wal_checkpoint/);
  });
}

for (const hook of ['check', 'available'] as const) {
  test(`checkpoint native async ${hook} is denied before its body starts`, async t => {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close()); let calls = 0;
    const callback = (async () => { calls++; return true; }) as never;
    await assert.rejects(checkpointOwnedWalAsync(db, ':memory:', { [hook]: callback }));
    assert.equal(calls, 0);
  });
  for (const invalid of ['boolean', 'thenable', 'getter'] as const) {
    test(`checkpoint ${hook} rejects invalid ${invalid} without coercion`, async t => {
      const db = new DatabaseSync(':memory:'); t.after(() => db.close()); let touched = 0;
      const value = invalid === 'boolean' ? (hook === 'check' ? true : 'true')
        : invalid === 'thenable' ? { then() { touched++; } }
        : Object.defineProperty({}, 'then', { get() { touched++; throw Error('private-getter'); } });
      await assert.rejects(checkpointOwnedWalAsync(db, ':memory:', { [hook]: (() => value) as never }));
      assert.equal(touched, 0);
    });
  }
}

test('checkpoint escaped check rolls back its original writes and fences captured late SQL', async t => {
  const raw = new DatabaseSync(':memory:'); t.after(() => { if (raw.isOpen) raw.close(); });
  raw.exec('CREATE TABLE evidence(value INTEGER)');
  const db = recoverableConnection(raw), statement = db.prepare('INSERT INTO evidence VALUES(1)');
  let resume!: () => void;
  const held = new Promise<void>(resolve => { resume = resolve; });
  let late!: Promise<unknown>;
  await assert.rejects(checkpointOwnedWalAsync(db, ':memory:', { check: (() => {
    statement.run();
    late = held.then(() => statement.run());
    return late;
  }) as never }));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM evidence').get()!.n, 0);
  assert.equal(raw.isTransaction, false);
  const denied = assert.rejects(late); resume(); await denied;
  assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
});
