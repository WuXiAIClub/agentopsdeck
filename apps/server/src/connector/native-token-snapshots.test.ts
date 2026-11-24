import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeTokenUsageStore, NativeTokenExportTooLarge } from './native-token-usage.js';
import { NativeTokenSnapshotStore, NativeTokenSnapshotConflict, NativeTokenSnapshotLimit, TOKEN_SNAPSHOT_LIMITS } from './native-token-snapshots.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

const runtime = 'codex', key = 'codex:private-session';
const selection = (requestId = randomUUID()) => ({ runtime, key, requestId, from: 0, to: 120_000, bucketMs: 60_000 } as const);
for (const denied of [false, true]) test(`application snapshot fence runs after capacity and around only original SQL (denied=${denied})`, async () => {
  const db = new DatabaseSync(':memory:'), ledger = new NativeTokenUsageStore(db), stages: string[] = [];
  let capacity = false, fenced = false, scans = 0;
  const snapshots = new NativeTokenSnapshotStore(db, Date.now, undefined, async (_bytes, write) => {
    stages.push('capacity'); assert.equal(fenced, false); assert.equal(db.isTransaction, false);
    await Promise.resolve(); capacity = true; return write();
  });
  const input = selection();
  const commit: import('../auth/application-transaction-gate.js').OriginalTransactionWrite = async write => {
    assert.equal(capacity, true); assert.equal(db.isTransaction, false); stages.push('auth');
    await Promise.resolve(); if (denied) throw Error('original_identity_revoked');
    fenced = true; try { return write(); } finally { fenced = false; stages.push('settled'); }
  };
  try {
    const result = snapshots.createAsync(input, () => {
      assert.equal(fenced, true); assert.equal(db.isTransaction, true); scans++;
      return ledger.export(runtime, key, 0, 120_000, 60_000);
    }, () => {}, commit);
    if (denied) {
      await assert.rejects(result, /original_identity_revoked/); assert.equal(scans, 0);
      assert.equal(snapshots.read(runtime, key, input.requestId), undefined); assert.deepEqual(stages, ['capacity', 'auth']);
    } else {
      const original = await result; assert.equal(scans, 1); assert.deepEqual(stages, ['capacity', 'auth', 'settled']);
      assert.deepEqual(await snapshots.createAsync(input, () => { throw Error('must not rescan'); }, () => {}, commit), original);
      assert.deepEqual(stages, ['capacity', 'auth', 'settled', 'auth', 'settled']); assert.equal(scans, 1);
    }
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});
for (const outer of [false, true]) test(`async-only snapshot refuses fresh sync creation before callbacks or DDL (outer=${outer})`, async () => {
  const db = new DatabaseSync(':memory:'); let admissions = 0, reads = 0;
  const snapshots = new NativeTokenSnapshotStore(db, Date.now, undefined, async (_bytes, write) => { admissions++; return write(); });
  try {
    if (outer) db.exec('BEGIN');
    assert.throws(() => snapshots.create(selection(), () => { reads++; throw Error('must not scan'); }), /async-admission-required/);
    assert.equal(reads, 0); assert.equal(admissions, 0); assert.equal(db.isTransaction, outer);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='native_token_snapshots'").get(), undefined);
    assert.throws(() => snapshots.create({ ...selection(), requestId: 'invalid' }, () => { reads++; throw Error(); }), /identity/);
    assert.equal(reads, 0);
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
});
test('async-only snapshot retains same-ID synchronous recovery and immutable selection without re-admission or rescan', async () => {
  const db = new DatabaseSync(':memory:'); let admissions = 0, reads = 0;
  const usage = new NativeTokenUsageStore(db, () => 10);
  const snapshots = new NativeTokenSnapshotStore(db, () => 20, undefined, async (_bytes, write) => { admissions++; return write(); });
  const input = selection(), read = () => { reads++; return usage.export(runtime, key, input.from, input.to, input.bucketMs); };
  try {
    const original = await snapshots.createAsync(input, read);
    assert.equal(admissions, 1); assert.equal(reads, 1);
    assert.deepEqual(snapshots.create(input, read), original);
    db.exec('BEGIN');
    assert.deepEqual(snapshots.create(input, read), original);
    assert.throws(() => snapshots.create({ ...input, to: 60_000 }, read), NativeTokenSnapshotConflict);
    assert.equal(db.isTransaction, true); db.exec('ROLLBACK');
    assert.deepEqual(await snapshots.createAsync(input, read), original);
    assert.equal(admissions, 1); assert.equal(reads, 1);
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
});
test('snapshot rollback reporting cannot replace original read failure', () => {
  const db = new DatabaseSync(':memory:'), original = Error('original-read'), exec = db.exec.bind(db);
  const snapshots = new NativeTokenSnapshotStore(db);
  db.exec = sql => { exec(sql); if (sql === 'ROLLBACK') throw Error('cleanup-reporting'); };
  try {
    assert.throws(() => snapshots.create(selection(), () => { throw original; }), error => error === original);
    assert.equal(db.isTransaction, false); assert.equal(snapshots.read(runtime, key, randomUUID()), undefined);
  } finally { db.close(); }
});
test('async snapshot waits before SQL, copies selection and recovers immutable receipt after lost finish ACK', async () => {
  const db = new DatabaseSync(':memory:'); let release!: () => void, entered!: () => void, admissions = 0, reads = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const ledger = new NativeTokenUsageStore(db, () => 10);
  const snapshots = new NativeTokenSnapshotStore(db, () => 20, undefined, async (bytes, write) => {
    admissions++; assert.equal(bytes, TOKEN_SNAPSHOT_LIMITS.payloadBytes + 65536); entered();
    await new Promise<void>(resolve => { release = resolve; }); await write(); throw Error('lost-finish-ack');
  });
  const input: { runtime: 'codex'; key: string; requestId: string; from: number; to: number; bucketMs: number } = { ...selection() };
  const read = () => { reads++; return ledger.export(runtime, key, 0, 120_000, 60_000); };
  try {
    const pending = snapshots.createAsync(input, read); await ready;
    assert.equal(reads, 0); assert.equal(db.isTransaction, false);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='native_token_snapshots'").get(), undefined);
    input.to = 60_000; release(); await assert.rejects(pending, /lost-finish-ack/);
    const observation = performanceDiagnostics.snapshot().events.filter(event => event.operation === 'native-token-snapshot-admission').at(-1)!;
    assert.equal(observation.category, 'failed'); assert.equal(observation.unknown, 1);
    assert.doesNotMatch(JSON.stringify(observation), /private-session|lost-finish-ack/);
    const stored = snapshots.read(runtime, key, input.requestId)!; assert.equal(stored.data.usage.to, 120_000);
    assert.deepEqual(await snapshots.createAsync({ ...input, to: 120_000 }, read), stored);
    assert.equal(reads, 1); assert.equal(admissions, 1);
    await assert.rejects(snapshots.createAsync(input, read), NativeTokenSnapshotConflict);
    assert.equal(reads, 1);
  } finally { db.close(); }
});
for (const reason of ['revoked', 'outer-transaction', 'denied'] as const) test(`async snapshot refuses ${reason} during admission without scanning or writing`, async () => {
  const db = new DatabaseSync(':memory:'); let allowed = true, reads = 0;
  const ledger = new NativeTokenUsageStore(db);
  const snapshots = new NativeTokenSnapshotStore(db, Date.now, undefined, async (_bytes, write) => {
    await Promise.resolve();
    if (reason === 'revoked') allowed = false;
    if (reason === 'outer-transaction') db.exec('BEGIN');
    if (reason === 'denied') throw Error('denied');
    return write();
  });
  try {
    await assert.rejects(snapshots.createAsync(selection(), () => { reads++; return ledger.export(runtime, key, 0, 120_000, 60_000); }, () => {
      if (!allowed) throw Error('revoked');
    }), reason === 'outer-transaction' ? /owning transaction/ : new RegExp(reason));
    assert.equal(reads, 0); assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='native_token_snapshots'").get(), undefined);
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
});
test('postcommit authority loss refuses delivery but keeps the same-ID read-only receipt', async () => {
  const db = new DatabaseSync(':memory:'); let allowed = true, reads = 0;
  const ledger = new NativeTokenUsageStore(db);
  const snapshots = new NativeTokenSnapshotStore(db, Date.now, undefined, async (_bytes, write) => {
    const result = await write(); allowed = false; return result;
  });
  const input = selection();
  try {
    await assert.rejects(snapshots.createAsync(input, () => { reads++; return ledger.export(runtime, key, 0, 120_000, 60_000); }, () => {
      if (!allowed) throw Error('revoked');
    }), /revoked/);
    assert.equal(reads, 1); assert.ok(snapshots.read(runtime, key, input.requestId)); assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});
function fixture(db: DatabaseSync) {
  const usage = new NativeTokenUsageStore(db, () => 10);
  const snapshots = new NativeTokenSnapshotStore(db, () => 20);
  const create = (requestId = randomUUID()) => usage.snapshot(runtime, key, requestId, 0, 120_000, 60_000);
  const count = () => Number(db.prepare('SELECT COUNT(*) AS n FROM native_token_snapshots').get()!.n);
  return { usage, snapshots, create, count };
}
test('new snapshot space admission precedes ledger scan; original receipts survive pressure', () => {
  const db=new DatabaseSync(':memory:');let pressure=true,reads=0,admissions=0;
  try {
    const ledger=new NativeTokenUsageStore(db,()=>10);
    const snapshots=new NativeTokenSnapshotStore(db,()=>20,(bytes,write)=>{
      admissions++;assert.equal(bytes,TOKEN_SNAPSHOT_LIMITS.payloadBytes+65536);
      if(pressure)throw Error('volume-pressure');return write();
    });
    const input=selection(),data=()=>{reads++;return ledger.export(runtime,key,input.from,input.to,input.bucketMs);};
    assert.throws(()=>snapshots.create(input,data),/volume-pressure/);
    assert.equal(reads,0);assert.equal(snapshots.read(runtime,key,input.requestId),undefined);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='native_token_snapshots'").get(),undefined);
    pressure=false;const receipt=snapshots.create(input,data);assert.equal(reads,1);
    pressure=true;assert.deepEqual(snapshots.create(input,data),receipt);assert.equal(reads,1);assert.equal(admissions,2);
    assert.throws(()=>snapshots.create({...input,to:60000},data),NativeTokenSnapshotConflict);
    db.exec('BEGIN');assert.throws(()=>snapshots.create(selection(),data),/owning transaction/);db.exec('ROLLBACK');
    assert.equal(admissions,2);assert.equal(db.isTransaction,false);
  } finally {db.close();}
});
test('usage store passes snapshot admission without gating observed usage settlement',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const ledger=new NativeTokenUsageStore(db,()=>10,()=>{throw Error('volume-pressure');});
    ledger.record(runtime,key,'observed',{inputTokens:3,outputTokens:1},'fixture',1000);
    assert.equal(ledger.export(runtime,key,0,60000,60000).observations.length,1);
    assert.throws(()=>ledger.snapshot(runtime,key,randomUUID(),0,60000,60000),/volume-pressure/);
    assert.equal(ledger.readSnapshot(runtime,key,randomUUID()),undefined);
  } finally {db.close();}
});

for (const source of ['codex', 'claude-code', 'ghcp'] as const) test(`${source}: immutable selection preserves models, cache knowledge and deduplication`, () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { usage, snapshots } = fixture(db), session = `${source}:private-session`, id = randomUUID();
    usage.record(source, session, 'private-event', { inputTokens: 100, outputTokens: 20 }, 'alpha', 59_999);
    usage.record(source, session, 'private-event', { inputTokens: 100, outputTokens: 20 }, 'alpha', 60_000);
    usage.record(source, session, 'known-zero', { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 }, 'alpha', 60_000);
    usage.record(source, session, 'known-both', { inputTokens: 5, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 }, undefined, 60_001);
    usage.record(source, session, 'excluded', { inputTokens: 9, outputTokens: 9 }, undefined, 120_000);
    const before = usage.snapshot(source, session, id, 0, 120_000, 60_000);
    assert.equal(before.data.observations.length, 3);
    assert.equal(before.modelsByKnowledge.length, 3);
    assert.deepEqual(before.modelsByKnowledge.filter(row => row.model === 'alpha').map(row => row.cacheReadTokens).sort(), [0, null]);
    assert.doesNotMatch(JSON.stringify(before), /private-session|private-event/);
    usage.record(source, session, 'late', { inputTokens: 7, outputTokens: 3 }, 'alpha', 1);
    assert.deepEqual(usage.snapshot(source, session, id.toUpperCase(), 0, 120_000, 60_000), before);
    assert.deepEqual(snapshots.read(source, session, id.toUpperCase()), before);
    const after = usage.snapshot(source, session, randomUUID(), 0, 120_000, 60_000);
    assert.equal(after.data.observations.length, 4);
    assert.notEqual(after.memberDigest, before.memberDigest);
    assert.equal(usage.range(source, session, 0, 180_000, 60_000).buckets.reduce((n, b) => n + b.samples, 0), 5);
    assert.throws(() => usage.snapshot(source, session, id, 0, 60_000, 60_000), NativeTokenSnapshotConflict);
    assert.equal(snapshots.read(source, `${source}:other`, id), undefined);
    assert.equal(snapshots.read(source === 'codex' ? 'ghcp' : 'codex', source === 'codex' ? 'ghcp:private-session' : key, id), undefined);
    before.data.observations.length = 0;
    before.modelsByKnowledge.length = 0;
    assert.equal(snapshots.read(source, session, id)!.data.observations.length, 3);
  } finally { db.close(); }
});

test('snapshot survives physical reopen with cumulative coverage frozen and original dedup retained', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-token-snapshot-')), path = join(directory, 'usage.sqlite');
  let db = new DatabaseSync(path);
  try {
    let { usage, create } = fixture(db);
    usage.cumulative(key, 'turn-1', { inputTokens: 100, outputTokens: 10 });
    usage.cumulative(key, 'turn-2', { inputTokens: 120, outputTokens: 12 });
    const id = randomUUID(), before = create(id);
    db.close(); db = new DatabaseSync(path);
    ({ usage, create } = fixture(db));
    usage.cumulative(key, 'turn-2', { inputTokens: 120, outputTokens: 12 });
    assert.deepEqual(create(id), before);
    assert.deepEqual(usage.export(runtime, key, 0, 120_000, 60_000), before.data);
    usage.cumulative(key, 'turn-3', { inputTokens: 130, outputTokens: 13 });
    assert.deepEqual(create(id), before);
    assert.equal(create().data.observations.length, 2);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('lazy schema is absent for collection/export/read; outer rollback can undo initialization and retry safely', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { usage, snapshots, create, count } = fixture(db), id = randomUUID();
    usage.record(runtime, key, 'one', { inputTokens: 1, outputTokens: 1 });
    usage.export(runtime, key, 0, 120_000, 60_000);
    assert.equal(snapshots.read(runtime, key, id), undefined);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='native_token_snapshots'").get(), undefined);
    db.exec('BEGIN'); create(id); assert.equal(count(), 1); db.exec('ROLLBACK');
    assert.equal(snapshots.read(runtime, key, id), undefined);
    assert.equal(create(id).data.observations.length, 1);
    assert.equal(count(), 1);
  } finally { db.close(); }
});

test('nested callback and INSERT failures rollback only snapshot work, not outer caller data', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { usage, snapshots, create, count } = fixture(db);
    create();
    db.exec('BEGIN');
    usage.record(runtime, key, 'outer', { inputTokens: 1, outputTokens: 2 });
    assert.throws(() => snapshots.create(selection(), () => {
      usage.record(runtime, key, 'inner', { inputTokens: 3, outputTokens: 4 });
      throw Error('injected callback failure');
    }), /injected callback failure/);
    assert.equal(db.isTransaction, true);
    db.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON native_token_snapshots BEGIN SELECT RAISE(ABORT,'injected insert failure'); END");
    assert.throws(() => create(), /injected insert failure/);
    assert.equal(db.isTransaction, true);
    db.exec('DROP TRIGGER fail_snapshot; COMMIT');
    assert.equal(count(), 1);
    assert.equal(usage.export(runtime, key, 0, 120_000, 60_000).observations.length, 1);
    assert.equal(create().data.observations.length, 1);
  } finally { db.close(); }
});

test('UPDATE, DELETE and REPLACE cannot change evidence; checksum corruption fails closed', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { create, snapshots, count } = fixture(db), id = randomUUID(), value = create(id);
    assert.throws(() => db.exec("UPDATE native_token_snapshots SET payload='{}'"), /immutable/);
    assert.throws(() => db.exec('DELETE FROM native_token_snapshots'), /immutable/);
    assert.throws(() => db.exec('INSERT OR REPLACE INTO native_token_snapshots SELECT * FROM native_token_snapshots'), /immutable/);
    assert.equal(count(), 1);
    assert.deepEqual(snapshots.read(runtime, key, id), value);
    db.exec("DROP TRIGGER native_token_snapshots_no_update; UPDATE native_token_snapshots SET payload='{}'");
    assert.throws(() => snapshots.read(runtime, key, id), /integrity/);
    assert.throws(() => create(id), /integrity/);
  } finally { db.close(); }
});

test('checksum-valid but unreconciled snapshot is rejected', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { create, snapshots } = fixture(db), id = randomUUID();
    const value = create(id); value.memberDigest = '0'.repeat(64);
    const payload = JSON.stringify(value);
    db.exec('DROP TRIGGER native_token_snapshots_no_update');
    db.prepare('UPDATE native_token_snapshots SET payload=?,checksum=?').run(payload, createHash('sha256').update(payload).digest('hex'));
    assert.throws(() => snapshots.read(runtime, key, id), /reconciliation/);
  } finally { db.close(); }
});

test('per-session and total caps fail closed, but same-request retries remain available', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { usage, create, count } = fixture(db), id = randomUUID(), before = create(id);
    for (let i = 1; i < TOKEN_SNAPSHOT_LIMITS.perSession; i++) create();
    assert.throws(() => create(), NativeTokenSnapshotLimit);
    for (let i = TOKEN_SNAPSHOT_LIMITS.perSession; i < TOKEN_SNAPSHOT_LIMITS.total; i++) {
      usage.snapshot(runtime, `codex:session-${i}`, randomUUID(), 0, 120_000, 60_000);
    }
    assert.equal(count(), TOKEN_SNAPSHOT_LIMITS.total);
    assert.throws(() => usage.snapshot(runtime, 'codex:new', randomUUID(), 0, 120_000, 60_000), NativeTokenSnapshotLimit);
    assert.deepEqual(create(id), before);
  } finally { db.close(); }
});

test('4097 members and unsafe sums reject snapshots without removing ledger evidence', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { usage, create, count } = fixture(db);
    create();
    for (let i = 0; i < 4097; i++) usage.record(runtime, key, String(i), { inputTokens: 1, outputTokens: 1 });
    assert.throws(() => create(), NativeTokenExportTooLarge);
    assert.equal(count(), 1);
    assert.equal(usage.range(runtime, key, 0, 120_000, 60_000).buckets[0]!.samples, 4097);
    usage.record('ghcp', 'ghcp:overflow', 'a', { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 });
    usage.record('ghcp', 'ghcp:overflow', 'b', { inputTokens: 1, outputTokens: 1 });
    assert.throws(() => usage.snapshot('ghcp', 'ghcp:overflow', randomUUID(), 0, 120_000, 60_000));
    assert.equal(count(), 1);
  } finally { db.close(); }
});

test('stored byte budget counts actual bytes and oversized evidence cannot be read', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { create, snapshots, count } = fixture(db), id = randomUUID(), before = create(id);
    // Isolated corrupt-storage fixture: the capacity query must not ignore
    // unreadable existing evidence or silently delete it to make more room.
    db.prepare('INSERT INTO native_token_snapshots VALUES(?,?,?,?,zeroblob(?),?)')
      .run(runtime, 'codex:large-fixture', randomUUID(), '[]', TOKEN_SNAPSHOT_LIMITS.totalBytes, 'fixture');
    assert.throws(() => create(), NativeTokenSnapshotLimit);
    assert.equal(count(), 2);
    assert.deepEqual(create(id), before);
    const oversizedId = db.prepare('SELECT request_id FROM native_token_snapshots WHERE session_key=?').get('codex:large-fixture')!.request_id as string;
    assert.throws(() => snapshots.read(runtime, 'codex:large-fixture', oversizedId), /integrity/);
  } finally { db.close(); }
});

test('SQLite whole-transaction rollback preserves original failure and permits identical request retry', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { create, count } = fixture(db), id = randomUUID();
    create();
    db.exec("CREATE TRIGGER rollback_snapshot BEFORE INSERT ON native_token_snapshots BEGIN SELECT RAISE(ROLLBACK,'injected rollback'); END");
    assert.throws(() => create(id), /injected rollback/);
    assert.equal(db.isTransaction, false);
    assert.equal(count(), 1);
    db.exec('DROP TRIGGER rollback_snapshot');
    const result = create(id);
    assert.deepEqual(create(id), result);
    assert.equal(count(), 2);
  } finally { db.close(); }
});

test('invalid identities, times and callback selection fail without residual transaction', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { usage, snapshots, create, count } = fixture(db);
    create();
    const data = () => usage.export(runtime, key, 0, 120_000, 60_000);
    for (const change of [{ key: 'ghcp:wrong' }, { key: 'codex:' }, { key: 'codex:bad\nkey' }, { requestId: 'invalid' }, { to: -1 }, { bucketMs: 0 }]) {
      assert.throws(() => snapshots.create({ ...selection(), ...change }, data));
    }
    assert.throws(() => new NativeTokenSnapshotStore(db, () => NaN).create(selection(), data), /time/);
    assert.throws(() => snapshots.create({ ...selection(), to: 60_000 }, data), /selection mismatch/);
    assert.equal(count(), 1);
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test('model totals across individually safe buckets still reject snapshot precision overflow', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { usage, snapshots, create } = fixture(db), id = randomUUID();
    usage.record(runtime, key, 'a', { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }, 'alpha', 1);
    usage.record(runtime, key, 'b', { inputTokens: 1, outputTokens: 0 }, 'alpha', 60_001);
    assert.equal(usage.export(runtime, key, 0, 120_000, 60_000).usage.buckets.length, 2);
    assert.throws(() => create(id), /precision exceeded/);
    assert.equal(snapshots.read(runtime, key, id), undefined);
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test('concurrent WAL ledger change cannot commit a stale transaction; retry captures the new membership', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-token-snapshot-wal-')), path = join(directory, 'usage.sqlite');
  const db = new DatabaseSync(path), writer = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0');
    const { usage, snapshots, create, count } = fixture(db);
    const other = new NativeTokenUsageStore(writer, () => 10), id = randomUUID();
    create();
    assert.throws(() => snapshots.create(selection(id), () => {
      const before = usage.export(runtime, key, 0, 120_000, 60_000);
      other.record(runtime, key, 'concurrent', { inputTokens: 1, outputTokens: 2 });
      return before;
    }), /locked|busy/);
    assert.equal(db.isTransaction, false);
    assert.equal(count(), 1);
    assert.equal(snapshots.read(runtime, key, id), undefined);
    assert.equal(create(id).data.observations.length, 1);
    assert.equal(count(), 2);
  } finally { writer.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('pinned reader commit failure leaves no receipt and the original request can retry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-token-snapshot-lock-')), path = join(directory, 'usage.sqlite');
  const db = new DatabaseSync(path), reader = new DatabaseSync(path);
  try {
    const { create, count } = fixture(db), id = randomUUID();
    create(); db.exec('PRAGMA busy_timeout=0');
    reader.exec('BEGIN'); reader.prepare('SELECT COUNT(*) FROM native_token_snapshots').get();
    assert.throws(() => create(id), /locked|busy/);
    assert.equal(db.isTransaction, false);
    assert.equal(count(), 1);
    reader.exec('ROLLBACK');
    const receipt = create(id);
    assert.deepEqual(create(id), receipt);
    assert.equal(count(), 2);
  } finally { reader.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
