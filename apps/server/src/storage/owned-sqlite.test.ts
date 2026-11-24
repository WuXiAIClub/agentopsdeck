import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { checkpointOwnedWalAsync } from './owned-sqlite.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { StorageAdmissionDeferred } from './work-admission.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
test('real WAL checkpoint uses original exclusive owner and FULL durability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-owned-checkpoint-')), file = join(root, 'state.db');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES(\'committed\')');
    let admitted = 0;
    const result = await checkpointOwnedWalAsync(db, file, {
      admission: async (_root, bytes, write) => { assert.ok(bytes > 65536); admitted++; await turn(); return write(); },
    });
    assert.equal(admitted, 1); assert.equal(result.deferred, false);
    if (!result.deferred) { assert.equal(result.busy, 0); assert.ok(result.checkpointedFrames > 0); }
    assert.equal(db.prepare('SELECT value FROM evidence').get()!.value, 'committed');
    assert.equal(db.prepare('PRAGMA synchronous').get()!.synchronous, 2);
    assert.equal(db.prepare('PRAGMA locking_mode').get()!.locking_mode, 'exclusive');
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test('same-owner WAL growth while awaiting admission defers instead of exceeding charged bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-checkpoint-growth-')), file = join(root, 'state.db');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence(value TEXT)');
    assert.deepEqual(await checkpointOwnedWalAsync(db, file, {
      admission: async (_root, _bytes, write) => { db.prepare('INSERT INTO evidence VALUES(?)').run('x'.repeat(100_000)); return write(); },
    }), { deferred: true });
    assert.equal(db.prepare('SELECT count(*) AS n FROM evidence').get()!.n, 1);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
test('checkpoint yields during admission, stays on owning DB and logs phases without paths', async () => {
  const db = new DatabaseSync(':memory:'), rows: any[] = [];
  let release!: () => void, entered!: () => void, charges = 0;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const work = checkpointOwnedWalAsync(db, '/private/nonexistent-fixture.db', {
    sample: async () => 0,
    diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line))),
    admission: async (root, bytes, write) => {
      charges++; assert.equal(bytes, 65536);
      entered(); await new Promise<void>(resolve => { release = resolve; });
      return write();
    },
  });
  try {
    await entry; let responsive = false; await turn(); responsive = true;
    assert.equal(responsive, true); assert.equal(rows.length, 0);
    release(); const result = await work;
    assert.equal(result.deferred, false); assert.equal(charges, 1);
    assert.equal(rows[0].operation, 'owned-wal-checkpoint');
    for (const key of ['queueMs', 'sampleMs', 'bodyMs']) assert.ok(rows[0][key] >= 0);
    assert.doesNotMatch(JSON.stringify(rows), /private|fixture|SELECT|PRAGMA/);
  } finally { db.close(); }
});

for (const mode of ['close', 'transaction', 'growth', 'revoke'] as const) {
  test(`checkpoint rechecks ${mode} after async admission without SQL or replay`, async () => {
    const db = new DatabaseSync(':memory:'); let open = true, allowed = true, samples = 0, callbacks = 0;
    try {
      const work = checkpointOwnedWalAsync(db, '/nonexistent-fixture.db', {
        available: () => open,
        check: () => { if (!allowed) throw Error('revoked'); },
        sample: async () => ++samples === 1 ? 0 : 10,
        admission: async (_root, _bytes, write) => {
          if (mode === 'close') { open = false; db.close(); }
          if (mode === 'transaction') db.exec('BEGIN');
          if (mode === 'revoke') allowed = false;
          callbacks++; return write();
        },
      });
      if (mode === 'revoke') await assert.rejects(work, /revoked/);
      else assert.deepEqual(await work, { deferred: true });
      assert.equal(callbacks, 1);
      if (mode === 'transaction') assert.equal(db.isTransaction, true);
    } finally { if (open) { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); } }
  });
}

test('denied admission differs from lost release after SQL; neither retries', async () => {
  const db = new DatabaseSync(':memory:'); let calls = 0;
  try {
    assert.deepEqual(await checkpointOwnedWalAsync(db, '/nonexistent.db', { sample: async () => 0,
      admission: async () => { throw new StorageAdmissionDeferred('coordinator-unavailable'); } }), { deferred: true });
    const rows: any[] = [];
    await assert.rejects(checkpointOwnedWalAsync(db, '/nonexistent.db', { sample: async () => 0,
      diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line))),
      admission: async (_root, _bytes, write) => { calls++; await write(); throw new StorageAdmissionDeferred('coordinator-unavailable'); },
    }), /unavailable/);
    assert.equal(calls, 1); assert.equal(rows[0].unknown, 1); assert.equal(rows[0].category, 'failed');
  } finally { db.close(); }
});

test('throwing diagnostic sink cannot change checkpoint outcome', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.equal((await checkpointOwnedWalAsync(db, undefined, {
      diagnostics: new PerformanceDiagnostics(() => { throw Error('sink'); }),
    })).deferred, false);
  } finally { db.close(); }
});
