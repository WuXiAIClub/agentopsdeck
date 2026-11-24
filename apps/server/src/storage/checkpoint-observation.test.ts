import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { checkpointOwnedWalAsync } from './owned-sqlite.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

async function flush() { for (let index = 0; index < 20; index++) await Promise.resolve(); }

for (const step of [1, 2, 3, 4]) test(`held checkpoint stage ${step} warns without settling or replaying SQL`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new DatabaseSync(':memory:');
  const rows: Record<string, unknown>[] = [];
  let release!: () => void, samples = 0, admissions = 0, bodies = 0, settled = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const work = checkpointOwnedWalAsync(db, '/nonexistent-private-checkpoint-token.db', {
    diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line))),
    sample: async () => { samples++; if (step === 1 && samples === 1 || step === 3 && samples === 2) await held; return 0; },
    admission: async (_root, _charge, write) => {
      admissions++; if (step === 2) await held;
      const result = await write(); bodies++;
      if (step === 4) await held;
      return result;
    },
  });
  void work.then(() => { settled = true; });
  try {
    await flush(); t.mock.timers.tick(29_999); await flush(); assert.equal(rows.length, 0);
    t.mock.timers.tick(1); await flush();
    assert.equal(rows.length, 1); assert.equal(rows[0]!.phase, 'pending');
    assert.equal(rows[0]!.step, step); assert.equal(rows[0]!.pending, 1);
    assert.equal(rows[0]!.unknown, Number(step === 4));
    assert.equal(settled, false); assert.equal(bodies, Number(step === 4));
    const original = { samples, admissions, bodies };
    t.mock.timers.tick(120_000); await flush();
    assert.equal(rows.length, 1); assert.equal(settled, false);
    assert.deepEqual({ samples, admissions, bodies }, original, 'warning cannot restart the original operation');
    assert.doesNotMatch(JSON.stringify(rows), /private|token|nonexistent|PRAGMA/);
    release(); const result = await work;
    assert.equal(result.deferred, false); assert.equal(samples, 2); assert.equal(admissions, 1); assert.equal(bodies, 1);
    assert.equal(rows.length, 2); assert.equal(rows[1]!.phase, 'finished');
    assert.equal(rows[0]!.sequence, rows[1]!.sequence); assert.equal(rows[0]!.instance, rows[1]!.instance);
    assert.equal(rows[1]!.unknown, undefined, 'pending observation does not change final counters');
    t.mock.timers.tick(120_000); await flush(); assert.equal(rows.length, 2);
  } finally { release(); await work; db.close(); }
});

test('checkpoint failure clears its observation timer and does not log exception content', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new DatabaseSync(':memory:'), rows: Record<string, unknown>[] = [];
  try {
    await assert.rejects(checkpointOwnedWalAsync(db, '/private-sample-path', {
      diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line))),
      sample: async () => { throw Error('secret sample failure'); },
    }), /secret sample failure/);
    assert.equal(rows.length, 1); assert.equal(rows[0]!.phase, 'finished'); assert.equal(rows[0]!.category, 'failed');
    t.mock.timers.tick(120_000); await flush(); assert.equal(rows.length, 1);
    assert.doesNotMatch(JSON.stringify(rows), /private|secret|failure/);
  } finally { db.close(); }
});

test('checkpoint pending diagnostic sink failure does not settle the original release', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new DatabaseSync(':memory:');
  let release!: () => void, completed = false, reports = 0, bodies = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const work = checkpointOwnedWalAsync(db, '/nonexistent-checkpoint.db', {
    sample: async () => 0,
    diagnostics: new PerformanceDiagnostics(() => { reports++; throw Error('private sink'); }),
    admission: async (_root, _charge, write) => { const result = await write(); bodies++; await held; return result; },
  });
  void work.then(() => { completed = true; });
  try {
    await flush(); assert.doesNotThrow(() => t.mock.timers.tick(30_000)); await flush();
    assert.equal(reports, 1); assert.equal(completed, false); assert.equal(bodies, 1);
    release(); assert.equal((await work).deferred, false); assert.equal(bodies, 1); assert.equal(reports, 2);
  } finally { release(); await work; db.close(); }
});

for (const reason of ['owner-unavailable', 'wal-growth']) test(`deferred ${reason} checkpoint awaiting release warns without claiming SQL execution`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new DatabaseSync(':memory:'), rows: Record<string, unknown>[] = [];
  let release!: () => void, available = true, samples = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const work = checkpointOwnedWalAsync(db, '/nonexistent-checkpoint.db', {
    available: () => available,
    sample: async () => ++samples === 2 ? 5 : 0,
    diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line))),
    admission: async (_root, _charge, write) => {
      if (reason === 'owner-unavailable') available = false;
      const result = await write(); assert.deepEqual(result, { deferred: true });
      await held; return result;
    },
  });
  try {
    await flush(); t.mock.timers.tick(30_000); await flush();
    assert.equal(rows.length, 1); assert.equal(rows[0]!.step, 4); assert.equal(rows[0]!.unknown, 0);
    release(); assert.deepEqual(await work, { deferred: true });
    assert.equal(rows[1]!.unknown, undefined); assert.equal(rows[1]!.deferred, 1);
  } finally { release(); await work; db.close(); }
});

test('observed executed checkpoint cannot acknowledge an owner closed while release was pending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new DatabaseSync(':memory:'), rows: Record<string, unknown>[] = [];
  let release!: () => void, bodies = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const work = checkpointOwnedWalAsync(db, '/nonexistent-checkpoint.db', {
    sample: async () => 0,
    diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line))),
    admission: async (_root, _charge, write) => { const result = await write(); bodies++; await held; return result; },
  });
  // Register rejection immediately; neither the warning nor the closed owner grants success.
  const rejected = assert.rejects(work);
  try {
    await flush(); t.mock.timers.tick(30_000); await flush();
    assert.equal(rows[0]!.phase, 'pending'); assert.equal(rows[0]!.unknown, 1);
    db.close(); release(); await rejected;
    assert.equal(rows[1]!.category, 'failed'); assert.equal(rows[1]!.unknown, 1); assert.equal(bodies, 1);
    t.mock.timers.tick(120_000); await flush(); assert.equal(rows.length, 2);
  } finally { release(); await rejected; if (db.isOpen) db.close(); }
});
