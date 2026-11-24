import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HubExecutionLeases, type ExecutionUsageAdmission } from './execution-leases.js';
import type { NodeGrants } from './node-grants.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function fixture(now: () => number = () => 1000, admission?: ExecutionUsageAdmission,
  diagnostics = new PerformanceDiagnostics(() => {})) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE node_grants(id TEXT, version INTEGER, revoked INTEGER);
    CREATE TABLE env_connections(id TEXT, owner_user_id TEXT, authority_version INTEGER);
    CREATE TABLE command_receipts(authority_id INTEGER, state TEXT);
    CREATE TABLE parent_work(value TEXT);`);
  const leases = new HubExecutionLeases(db, {} as NodeGrants, now, 10000, diagnostics, admission);
  const insert = db.prepare(`INSERT INTO hub_execution_leases
    (grant_key,version,node_id,issuer_id,grant_id,owner_id,connection_id,principal_id,proof,actions,expires_at,state,ref,usage_pending)
    VALUES(?,1,'node','issuer','grant','owner','domain','user',?,'[]',21000,'active',?,1)`);
  for (let i = 0; i < 3; i++) insert.run(String(i), JSON.stringify({ resource: { sessionKey: String(i) } }), JSON.stringify({ id: String(i) }));
  const reserved = () => db.prepare('SELECT usage_after FROM hub_execution_leases ORDER BY id').all().map(row => row.usage_after);
  return { db, leases, reserved };
}

for (const fault of ['rejected', 'uninvoked'] as const) {
  test(`usage reservation refuses retained callback after ${fault} admission`, async t => {
    let late!: () => Promise<unknown>;
    const failure = Error('synthetic admission rejected');
    const f = fixture(undefined, async (_bytes, write) => {
      late = write; if (fault === 'rejected') throw failure; return [];
    });
    t.after(() => f.db.close());
    await assert.rejects(f.leases.usageDueAsync(), fault === 'rejected' ? error => error === failure : /not acknowledged/);
    await assert.rejects(late(), /admission ended/);
    assert.deepEqual(f.reserved(), [0, 0, 0]);
  });
}

test('mid-page database write failure rolls back every reservation, not only the failed row', () => {
  const f = fixture();
  try {
    f.db.exec(`CREATE TRIGGER failed_reservation BEFORE UPDATE OF usage_after ON hub_execution_leases
      WHEN NEW.id=2 AND NEW.usage_after>0 BEGIN SELECT RAISE(ABORT,'synthetic write fault'); END;`);
    assert.throws(() => f.leases.usageDue(), /synthetic write fault/);
    assert.deepEqual(f.reserved(), [0, 0, 0]); assert.equal(f.db.isTransaction, false);
    f.db.exec('DROP TRIGGER failed_reservation'); assert.equal(f.leases.usageDue().length, 3);
    assert.deepEqual(f.reserved(), [16000, 16000, 16000]);
  } finally { f.db.close(); }
});

function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test('empty and not-yet-due polls never enter capacity admission', async () => {
  let admissions = 0;
  const f = fixture(undefined, async (_, write) => { admissions++; return write(); });
  try {
    f.db.exec('UPDATE hub_execution_leases SET usage_pending=0');
    assert.deepEqual(await f.leases.usageDueAsync(), []);
    f.db.exec('UPDATE hub_execution_leases SET usage_pending=1, usage_after=2000');
    assert.deepEqual(await f.leases.usageDueAsync(), []);
    assert.equal(admissions, 0); assert.equal(f.db.isTransaction, false);
  } finally { f.db.close(); }
});

test('queued demand hint is re-read after admission, never an obsolete reservation', async () => {
  const gate = held(); let admissions = 0;
  const f = fixture(undefined, async (_, write) => { admissions++; await gate.promise; return write(); });
  const pending = f.leases.usageDueAsync();
  try {
    assert.equal(admissions, 1);
    f.db.exec("UPDATE hub_execution_leases SET state='revoking' WHERE id=1; UPDATE hub_execution_leases SET usage_after=2000 WHERE id=2");
    gate.release(); const page = await pending;
    assert.deepEqual(page.map(item => item.lease.id), [3]);
    assert.deepEqual(f.reserved(), [0, 2000, 16000]);
  } finally { gate.release(); await pending; f.db.close(); }
});
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

test('asynchronous capacity waits without opening the business transaction and reserves once after acknowledgment', async () => {
  const gate = held(); let admissions = 0, required = 0, checks = 0;
  const f = fixture(undefined, async (bytes, write) => { admissions++; required = bytes; await gate.promise; return write(); });
  const page = f.leases.usageDueAsync(16, () => { checks++; });
  try {
    await flush(); assert.equal(f.db.isTransaction, false); assert.deepEqual(f.reserved(), [0, 0, 0]);
    // Unrelated owner work remains runnable while physical capacity yields.
    f.db.prepare('INSERT INTO parent_work VALUES(?)').run('progress');
    gate.release(); assert.equal((await page).length, 3);
    assert.equal(admissions, 1); assert.equal(required, 65536 + 16 * 4096); assert.equal(checks, 3);
    assert.deepEqual(f.reserved(), [16000, 16000, 16000]); assert.equal(f.db.isTransaction, false);
  } finally { gate.release(); await page.catch(() => {}); f.db.close(); }
});

test('close while capacity is waiting never invokes business SQL', async () => {
  const gate = held(); const f = fixture(undefined, async (_, write) => { await gate.promise; return write(); });
  const page = f.leases.usageDueAsync(), checked = assert.rejects(page);
  await flush(); f.db.close(); gate.release(); await checked;
});

test('revoked caller lifetime while capacity is waiting leaves all retries uncharged', async () => {
  const gate = held(), original = Error('stopped'); let open = true;
  const f = fixture(undefined, async (_, write) => { await gate.promise; return write(); });
  const page = f.leases.usageDueAsync(16, () => { if (!open) throw original; });
  const checked = assert.rejects(page, error => error === original);
  try { await flush(); open = false; gate.release(); await checked; assert.deepEqual(f.reserved(), [0, 0, 0]); }
  finally { gate.release(); f.db.close(); }
});

test('lost capacity release ACK retains original durable reservation and never replays the callback', async () => {
  const original = Error('release uncertainty'), logs: string[] = []; let callbacks = 0;
  const f = fixture(undefined, async (_, write) => { callbacks++; await write(); throw original; },
    new PerformanceDiagnostics(line => logs.push(line)));
  try {
    await assert.rejects(f.leases.usageDueAsync(), error => error === original);
    assert.equal(callbacks, 1); assert.deepEqual(f.reserved(), [16000, 16000, 16000]);
    const last = JSON.parse(logs.at(-1)!); assert.equal(last.operation, 'execution-usage-admission');
    assert.equal(last.category, 'failed'); assert.equal(last.unknown, 1);
    assert.deepEqual(f.leases.usageDue(), []); assert.equal(callbacks, 1);
  } finally { f.db.close(); }
});

test('stop after SQL but before release ACK cannot return permission to query that page', async () => {
  const gate = held(), original = Error('stopped after SQL'); let open = true;
  const f = fixture(undefined, async (_, write) => { const page = await write(); await gate.promise; return page; });
  const page = f.leases.usageDueAsync(16, () => { if (!open) throw original; }), checked = assert.rejects(page, error => error === original);
  try {
    await flush(); assert.deepEqual(f.reserved(), [16000, 16000, 16000]); assert.equal(f.db.isTransaction, false);
    open = false; gate.release(); await checked; assert.deepEqual(f.reserved(), [16000, 16000, 16000]);
  } finally { gate.release(); f.db.close(); }
});

test('closed original connection after SQL cannot certify the reserved page after release', async () => {
  const gate = held(), f = fixture(undefined, async (_, write) => { const page = await write(); await gate.promise; return page; });
  const page = f.leases.usageDueAsync(), checked = assert.rejects(page);
  await flush(); assert.deepEqual(f.reserved(), [16000, 16000, 16000]); f.db.close(); gate.release(); await checked;
});

test('asynchronous API refuses an existing caller transaction before admission and after queued admission', async () => {
  const gate = held(); let admissions = 0;
  const f = fixture(undefined, async (_, write) => { admissions++; await gate.promise; return write(); });
  try {
    f.db.exec('BEGIN'); await assert.rejects(f.leases.usageDueAsync(), /original owner/); assert.equal(admissions, 0); f.db.exec('ROLLBACK');
    const page = f.leases.usageDueAsync(), checked = assert.rejects(page, /original owner/);
    await flush(); f.db.exec("BEGIN; INSERT INTO parent_work VALUES('owned');"); gate.release(); await checked;
    assert.deepEqual(f.reserved(), [0, 0, 0]); assert.equal(f.db.isTransaction, true);
    assert.equal(f.db.prepare('SELECT value FROM parent_work').get()!.value, 'owned');
  } finally { gate.release(); if (f.db.isTransaction) f.db.exec('ROLLBACK'); f.db.close(); }
});

test('capacity rejection and uninvoked callback cannot fabricate successful reservation', async () => {
  for (const admission of [async () => { throw Error('capacity'); }, async () => []]) {
    const f = fixture(undefined, admission);
    try { await assert.rejects(f.leases.usageDueAsync()); assert.deepEqual(f.reserved(), [0, 0, 0]); }
    finally { f.db.close(); }
  }
});

test('an admission adapter cannot invoke the original database command twice', async () => {
  let calls = 0;
  const f = fixture(undefined, async (_, write) => { await write(); calls++; return write(); });
  try {
    await assert.rejects(f.leases.usageDueAsync(), /already entered/); assert.equal(calls, 1);
    assert.deepEqual(f.reserved(), [16000, 16000, 16000]); assert.equal(f.db.isTransaction, false);
  } finally { f.db.close(); }
});

test('pending admission and release observations do not settle or re-enter the original reservation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const waitAfter of [false, true]) {
    const gate = held(), logs: string[] = []; let calls = 0, settled = false;
    const f = fixture(undefined, async (_, write) => {
      if (!waitAfter) await gate.promise;
      calls++; const page = await write(); if (waitAfter) await gate.promise; return page;
    }, new PerformanceDiagnostics(line => logs.push(line), () => 100));
    const page = f.leases.usageDueAsync().then(result => { settled = true; return result; });
    try {
      await flush(); t.mock.timers.tick(30000); await flush(); assert.equal(settled, false);
      const pending = logs.map(line => JSON.parse(line)).find(row => row.phase === 'pending');
      assert.equal(pending.operation, 'execution-usage-admission'); assert.equal(pending.step, waitAfter ? 3 : 1);
      assert.equal(pending.unknown, Number(waitAfter)); assert.equal(calls, Number(waitAfter));
      assert.equal(f.db.isTransaction, false); gate.release(); assert.equal((await page).length, 3); assert.equal(calls, 1);
      const final = JSON.parse(logs.at(-1)!); assert.equal(final.sequence, pending.sequence);
      const count = logs.length; t.mock.timers.tick(60000); assert.equal(logs.length, count);
    } finally { gate.release(); await page; f.db.close(); }
  }
});

test('throwing observation sink changes neither synchronous atomicity nor asynchronous result', async () => {
  const f = fixture(undefined, async (_, write) => write(), new PerformanceDiagnostics(() => { throw Error('sink'); }));
  try { assert.equal((await f.leases.usageDueAsync()).length, 3); assert.deepEqual(f.reserved(), [16000, 16000, 16000]); }
  finally { f.db.close(); }
});

test('bad persisted page cannot charge retries before all entries decode successfully', () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE hub_execution_leases SET actions='invalid JSON' WHERE id=2").run();
    assert.throws(() => f.leases.usageDue()); assert.deepEqual(f.reserved(), [0, 0, 0]);
    assert.equal(f.db.isTransaction, false);
  } finally { f.db.close(); }
});

test('reservation failure inside caller transaction preserves unrelated parent work', () => {
  const f = fixture();
  try {
    f.db.exec(`CREATE TRIGGER failed_reservation BEFORE UPDATE OF usage_after ON hub_execution_leases
      WHEN NEW.id=2 AND NEW.usage_after>0 BEGIN SELECT RAISE(ABORT,'nested write fault'); END;
      BEGIN; INSERT INTO parent_work VALUES('retained');`);
    assert.throws(() => f.leases.usageDue(), /nested write fault/);
    assert.deepEqual(f.reserved(), [0, 0, 0]); assert.equal(f.db.isTransaction, true);
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM parent_work').get()!.count, 1);
    f.db.exec('COMMIT'); assert.equal(f.db.prepare('SELECT value FROM parent_work').get()!.value, 'retained');
  } finally { if (f.db.isTransaction) f.db.exec('ROLLBACK'); f.db.close(); }
});

test('one captured clock reserves the page together and preserves original demand generations', () => {
  let now = 1000; const f = fixture(() => now++);
  try {
    f.db.prepare('UPDATE hub_execution_leases SET usage_version=id').run();
    const page = f.leases.usageDue(); assert.deepEqual(page.map(item => item.version), [1, 2, 3]);
    const after = f.reserved(); assert.equal(new Set(after).size, 1); assert.equal(page.length, 3);
    assert.deepEqual(f.leases.usageDue(), []);
  } finally { f.db.close(); }
});

test('successful inner reservation remains owned by parent until parent actually commits', () => {
  const f = fixture();
  try {
    f.db.exec('BEGIN'); assert.equal(f.leases.usageDue(2).length, 2); assert.equal(f.db.isTransaction, true);
    assert.deepEqual(f.reserved(), [16000, 16000, 0]); f.db.exec('ROLLBACK');
    assert.deepEqual(f.reserved(), [0, 0, 0]);
  } finally { if (f.db.isTransaction) f.db.exec('ROLLBACK'); f.db.close(); }
});

test('invalid limits and empty demand charge no rows and leave no transaction open', () => {
  const f = fixture();
  try {
    for (const limit of [0, -1, 33, 1.5, NaN]) assert.throws(() => f.leases.usageDue(limit), /Invalid/);
    assert.deepEqual(f.reserved(), [0, 0, 0]); f.db.exec('UPDATE hub_execution_leases SET usage_pending=0');
    assert.deepEqual(f.leases.usageDue(), []); assert.equal(f.db.isTransaction, false);
  } finally { f.db.close(); }
});
