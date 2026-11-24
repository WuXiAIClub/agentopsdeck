import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeTokenUsageStore, nativeTokenCounts } from './native-token-usage.js';
import { nativeCacheHitRate, tokenUsageRange, validateNativeTokenUsage } from '@agentopsdeck/shared';
import { codexCumulativeUsage } from '../codex/usage.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { SdkExecutionJournal } from './sdk-execution-journal.js';

const hour = 3_600_000;
test('one reconciled result keeps one observation time when the clock crosses a minute', () => {
  const db = new DatabaseSync(':memory:'); let now = 1;
  try {
    const clock = () => now++;
    const ledger = new NativeTokenUsageStore(db, clock);
    const journal = new SdkExecutionJournal(db, 'claude-code', clock, undefined, undefined, undefined, ledger);
    const turns = new TurnQueue(db), key = 'claude-code:clock';
    journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 1 });
    turns.enqueue('claude-code', { id: 'turn', sessionKey: key, createdAt: 1, payload: { text: 'fixture', actorId: 'owner' } });
    const ref = journal.begin({ key, id: 'execution', epoch: 'epoch' }, ['turn'], turns)!;
    now = 59_999;
    assert.equal(journal.recordMetrics(ref, { eventId: 'result', sequence: 1,
      usage: { scope: 'last-turn', inputTokens: 30, outputTokens: 3 },
      reconciledCalls: [{ id: 'a', model: 'a', inputTokens: 10, outputTokens: 1 }, { id: 'b', model: 'b', inputTokens: 20, outputTokens: 2 }] }), true);
    const buckets = ledger.range('claude-code', key, 0, 120_000, 60_000).buckets;
    assert.deepEqual(buckets.map(b => [b.at, b.inputTokens, b.samples]), [[0, 30, 2]]);
    assert.equal(db.prepare('SELECT COUNT(DISTINCT observed_at) AS n FROM native_token_samples').get()!.n, 1);
  } finally { db.close(); }
});

test('SDK metric commit failure clears its transaction and event fence before retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-metric-commit-')), file = join(root, 'fixture.sqlite');
  const db = new DatabaseSync(file); let reader: DatabaseSync | undefined;
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0');
    const ledger = new NativeTokenUsageStore(db, () => 1);
    const journal = new SdkExecutionJournal(db, 'claude-code', () => 1, undefined, undefined, undefined, ledger);
    const turns = new TurnQueue(db), key = 'claude-code:locked';
    journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 1 });
    turns.enqueue('claude-code', { id: 'turn', sessionKey: key, createdAt: 1, payload: { text: 'fixture', actorId: 'owner' } });
    const ref = journal.begin({ key, id: 'execution', epoch: 'epoch' }, ['turn'], turns)!;
    const sample = { eventId: 'result', sequence: 1, usage: { scope: 'last-turn', inputTokens: 10, outputTokens: 2 } };
    reader = new DatabaseSync(file);
    reader.exec('BEGIN'); reader.prepare('SELECT COUNT(*) FROM sdk_agent_metric_events').get();
    assert.throws(() => journal.recordMetrics(ref, sample), /locked|busy/i);
    assert.equal(db.isTransaction, false, 'failed owned commit must not leave a write transaction');
    assert.equal(journal.session(key)?.metrics?.sequence, 0);
    reader.exec('ROLLBACK');
    assert.equal(journal.recordMetrics(ref, sample), true);
    assert.equal(ledger.range('claude-code', key, 0, hour, hour).buckets[0]?.inputTokens, 10);
    assert.equal(journal.recordMetrics(ref, { ...sample, sequence: 2 }), false);
  } finally { reader?.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('SDK automatic whole-transaction rollback retains original error and allows the metric retry', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new NativeTokenUsageStore(db, () => 1);
    const journal = new SdkExecutionJournal(db, 'ghcp', () => 1, undefined, undefined, undefined, ledger);
    const turns = new TurnQueue(db), key = 'ghcp:rollback';
    journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 1 });
    turns.enqueue('ghcp', { id: 'turn', sessionKey: key, createdAt: 1, payload: { text: 'fixture', actorId: 'owner' } });
    const ref = journal.begin({ key, id: 'execution', epoch: 'epoch' }, ['turn'], turns)!;
    const sample = { eventId: 'result', sequence: 1, usage: { scope: 'last-turn', inputTokens: 10, outputTokens: 2 } };
    db.exec(`CREATE TEMP TRIGGER reject_usage BEFORE INSERT ON native_token_samples BEGIN SELECT RAISE(ROLLBACK,'fixture usage rollback'); END`);
    assert.throws(() => journal.recordMetrics(ref, sample), /fixture usage rollback/);
    assert.equal(db.isTransaction, false);
    db.exec('DROP TRIGGER reject_usage');
    assert.equal(journal.recordMetrics(ref, sample), true);
    assert.equal(ledger.range('ghcp', key, 0, hour, hour).buckets[0]?.inputTokens, 10);
  } finally { db.close(); }
});

test('Claude reconciled models persist atomically, do not double count aggregate/replays, and remain result-observed-at', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-model-reconcile-'));
  const path = join(root, 'ledger.sqlite'); let now = 59_999;
  let db = new DatabaseSync(path);
  const key = 'claude-code:reconciled';
  try {
    let ledger = new NativeTokenUsageStore(db, () => now);
    let journal = new SdkExecutionJournal(db, 'claude-code', () => now, undefined, undefined, undefined, ledger);
    const turns = new TurnQueue(db);
    journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 1 });
    turns.enqueue('claude-code', { id: 'turn', sessionKey: key, createdAt: now, payload: { text: 'fixture', actorId: 'owner' } });
    const ref = journal.begin({ key, id: 'execution', epoch: 'epoch' }, ['turn'], turns)!;
    const sample = { eventId: 'result', sequence: 1, usage: { scope: 'last-turn', inputTokens: 30, outputTokens: 6 },
      reconciledCalls: [{ id: 'a', model: 'model-a', inputTokens: 10, outputTokens: 2 }, { id: 'b', model: 'model-b', inputTokens: 20, outputTokens: 4 }] };
    assert.equal(journal.recordMetrics({ ...ref, nativeSessionId: 'foreign' }, sample), false);
    // A second-row failure must roll back the first row AND the event marker.
    db.exec(`CREATE TEMP TRIGGER reject_model BEFORE INSERT ON native_token_samples WHEN NEW.model='model-b' BEGIN SELECT RAISE(ABORT,'fixture failure'); END`);
    assert.throws(() => journal.recordMetrics(ref, sample), /fixture failure/);
    assert.equal(ledger.range('claude-code', key, 0, 120_000, 60_000).buckets.length, 0);
    assert.equal(journal.session(key)?.metrics?.sequence, 0);
    db.exec('DROP TRIGGER reject_model');
    now = 60_000;
    assert.equal(journal.recordMetrics(ref, sample), true);
    assert.equal(journal.recordMetrics(ref, { ...sample, sequence: 2 }), false);
    const bucket = ledger.range('claude-code', key, 0, 120_000, 60_000).buckets[0]!;
    assert.equal(bucket.at, 60_000);
    assert.equal(bucket.inputTokens, 30); assert.equal(bucket.outputTokens, 6); assert.equal(bucket.samples, 2);
    assert.deepEqual(bucket.models?.map(m => [m.model, m.inputTokens]), [['model-a', 10], ['model-b', 20]]);
    assert.equal(bucket.cacheReadTokens, null);
    assert.equal(journal.session(key)?.metrics?.usage?.inputTokens, 30);
    db.close(); db = new DatabaseSync(path);
    ledger = new NativeTokenUsageStore(db, () => now);
    journal = new SdkExecutionJournal(db, 'claude-code', () => now, undefined, undefined, undefined, ledger);
    assert.equal(journal.recordMetrics(ref, { ...sample, sequence: 2 }), false, 'dedup survives reopen');
    assert.equal(ledger.range('claude-code', key, 0, 120_000, 60_000).buckets[0]?.inputTokens, 30);
    assert.equal(journal.recordMetrics(ref, { eventId: 'unknown', sequence: 2,
      usage: { scope: 'last-turn', inputTokens: 5, outputTokens: 1 } }), true);
    assert.equal(ledger.range('claude-code', key, 0, 120_000, 60_000).buckets[0]?.inputTokens, 35);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('GHCP cannot inject Claude reconciled-turn allocations', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = new SdkExecutionJournal(db, 'ghcp');
    assert.throws(() => journal.recordMetrics({ key: 'ghcp:a', id: 'execution', epoch: 'epoch', nativeSessionId: 'native' },
      { eventId: 'result', sequence: 1, usage: { scope: 'last-turn', inputTokens: 10, outputTokens: 2 },
        reconciledCalls: [{ id: 'a', model: 'model-a', inputTokens: 10, outputTokens: 2 }] }), /runtime/);
  } finally { db.close(); }
});
test('minute model partitions preserve unknowns, exact boundaries and immutable replay attribution', () => {
  const db = new DatabaseSync(':memory:'); let now = 299_999;
  try {
    const ledger = new NativeTokenUsageStore(db, () => now);
    ledger.record('ghcp', 'ghcp:a', '1', { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 }, 'model-a');
    ledger.record('ghcp', 'ghcp:a', '1', { inputTokens: 99, outputTokens: 9 }, 'model-b');
    ledger.record('ghcp', 'ghcp:a', '2', { inputTokens: 20, outputTokens: 4 });
    now = 300_000;
    ledger.record('ghcp', 'ghcp:a', '3', { inputTokens: 30, outputTokens: 6 }, 'model-b');
    const result = ledger.range('ghcp', 'ghcp:a', 0, 600_000, 300_000);
    assert.deepEqual(result.buckets.map(b => [b.at, b.inputTokens, b.samples]), [[0, 30, 2], [300_000, 30, 1]]);
    assert.deepEqual(result.buckets[0]!.models!.map(m => [m.model, m.inputTokens]), [[null, 20], ['model-a', 10]]);
    assert.equal(result.buckets[0]!.cacheReadTokens, null);
    assert.equal(ledger.range('ghcp', 'ghcp:a', 300_000, 600_000, 60_000).buckets.length, 1);
    for (const models of [null, {}, [], [{ ...result.buckets[0]!.models![0], inputTokens: 999 }]]) {
      assert.throws(() => validateNativeTokenUsage({ ...result, buckets: [{ ...result.buckets[0], models }] }));
    }
    assert.throws(() => tokenUsageRange(0, 86_400_000, 60_000));
  } finally { db.close(); }
});
test('legacy numeric ledger migration preserves observations without inventing model attribution', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE native_token_samples(runtime TEXT,session_key TEXT,event_id TEXT,observed_at INTEGER,
      input_tokens INTEGER,output_tokens INTEGER,cache_read INTEGER,cache_write INTEGER,PRIMARY KEY(runtime,session_key,event_id));
      INSERT INTO native_token_samples VALUES('ghcp','ghcp:a','old',1,10,2,NULL,NULL)`);
    const ledger = new NativeTokenUsageStore(db);
    assert.equal(ledger.range('ghcp', 'ghcp:a', 0, hour, hour).buckets[0]!.models![0]!.model, null);
    assert.doesNotThrow(() => new NativeTokenUsageStore(db));
  } finally { db.close(); }
});
test('cache hit denominator follows native accounting; unknown is never zero', () => {
  const counts = { inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 40 };
  assert.equal(nativeCacheHitRate('includes-cache', counts), 0.6);
  assert.equal(nativeCacheHitRate('excludes-cache', counts), 0.3);
  assert.equal(nativeCacheHitRate('provider-defined', counts), null);
  assert.equal(nativeCacheHitRate('excludes-cache', { ...counts, cacheWriteTokens: null }), null);
  assert.equal(nativeCacheHitRate('includes-cache', { ...counts, cacheReadTokens: null }), null);
  assert.equal(nativeCacheHitRate('includes-cache', { ...counts, cacheReadTokens: 101 }), null);
  assert.equal(nativeCacheHitRate('includes-cache', { ...counts, inputTokens: 0, cacheReadTokens: 0 }), null);
});
test('native counters and cumulative baselines survive closing and reopening the owned database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-native-usage-'));
  let db: DatabaseSync | undefined;
  try {
    const path = join(directory, 'usage.sqlite');
    db = new DatabaseSync(path);
    const first = new NativeTokenUsageStore(db, () => hour + 1);
    first.cumulative('codex:restart', 'turn', { inputTokens: 100, outputTokens: 10 });
    first.cumulative('codex:restart', 'turn', { inputTokens: 140, outputTokens: 20 });
    first.record('claude-code', 'claude-code:restart', 'result', { inputTokens: 8, outputTokens: 4 });
    db.close(); db = new DatabaseSync(path);
    const next = new NativeTokenUsageStore(db, () => hour * 2 + 1);
    next.cumulative('codex:restart', 'turn', { inputTokens: 140, outputTokens: 20 });
    next.cumulative('codex:restart', 'next', { inputTokens: 160, outputTokens: 30 });
    next.record('claude-code', 'claude-code:restart', 'result', { inputTokens: 8, outputTokens: 4 });
    const result = next.range('codex', 'codex:restart', 0, hour * 3, hour);
    assert.deepEqual(result.buckets.map(b => [b.at, b.inputTokens, b.outputTokens]), [[hour, 40, 10], [hour * 2, 20, 10]]);
    assert.equal(next.range('claude-code', 'claude-code:restart', 0, hour * 3, hour).buckets.length, 1);
    assert.equal(db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('native aggregate fails closed instead of returning rounded large integers', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new NativeTokenUsageStore(db, () => hour);
    ledger.record('ghcp', 'ghcp:overflow', 'one', { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 });
    ledger.record('ghcp', 'ghcp:overflow', 'two', { inputTokens: 2, outputTokens: 0 });
    assert.throws(() => ledger.range('ghcp', 'ghcp:overflow', 0, hour * 2, hour), /precision|too large/);
  } finally { db.close(); }
});
test('one model scan folds exact totals and unknown cache, rejecting cross-model overflow', () => {
  const db = new DatabaseSync(':memory:');
  const queries: string[] = [];
  const owner = new Proxy(db, { get(target, property) {
    if (property === 'prepare') return (sql: string) => { queries.push(sql); return target.prepare(sql); };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    const ledger = new NativeTokenUsageStore(owner, () => hour);
    ledger.record('ghcp', 'ghcp:fold', 'one', { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 }, 'a');
    ledger.record('ghcp', 'ghcp:fold', 'two', { inputTokens: 20, outputTokens: 4, cacheWriteTokens: 5 }, 'b');
    queries.length = 0;
    const bucket = ledger.range('ghcp', 'ghcp:fold', 0, hour * 2, hour).buckets[0]!;
    assert.equal(queries.filter(sql => /GROUP BY/.test(sql)).length, 1);
    assert.deepEqual([bucket.samples, bucket.inputTokens, bucket.outputTokens, bucket.cacheReadTokens, bucket.cacheWriteTokens], [2, 30, 6, null, 5]);
    ledger.record('ghcp', 'ghcp:overflow-model', 'one', { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }, 'a');
    ledger.record('ghcp', 'ghcp:overflow-model', 'two', { inputTokens: 1, outputTokens: 0 }, 'b');
    assert.throws(() => ledger.range('ghcp', 'ghcp:overflow-model', 0, hour * 2, hour), /precision/);
    assert.deepEqual(ledger.range('ghcp', 'ghcp:missing', 0, hour * 2, hour).buckets, []);
  } finally { db.close(); }
});
test('native counters reject estimates, invalid values and project numeric fields only', () => {
  for (const inputTokens of [-1, 1.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) assert.equal(nativeTokenCounts({ inputTokens, outputTokens: 2 }), undefined);
  assert.equal(codexCumulativeUsage({ last: { inputTokens: 10, outputTokens: 2 } }), undefined);
  assert.deepEqual(codexCumulativeUsage({ total: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 8, secret: 'not retained' } }), { inputTokens: 10, outputTokens: 2, cacheReadTokens: 8 });
});
test('native ledger isolates runtimes and sessions, dedupes, preserves missing cache and rolls back with caller', () => {
  const db = new DatabaseSync(':memory:'), ledger = new NativeTokenUsageStore(db, () => hour + 10);
  try {
    for (const runtime of ['codex', 'claude-code', 'ghcp'] as const) {
      ledger.record(runtime, `${runtime}:a`, 'same', { inputTokens: 12, outputTokens: 3 });
      ledger.record(runtime, `${runtime}:a`, 'same', { inputTokens: 999, outputTokens: 999 });
      ledger.record(runtime, `${runtime}:b`, 'same', { inputTokens: 99, outputTokens: 3 });
      const result = ledger.range(runtime, `${runtime}:a`, hour, hour * 2, hour);
      assert.deepEqual(validateNativeTokenUsage(result), result);
      assert.equal(result.buckets[0]?.inputTokens, 12); assert.equal(result.buckets[0]?.cacheReadTokens, null);
      assert.equal(result.buckets[0]?.samples, 1);
    }
    db.exec('BEGIN'); ledger.record('ghcp', 'ghcp:a', 'rollback', { inputTokens: 50, outputTokens: 1 }); db.exec('ROLLBACK');
    assert.equal(ledger.range('ghcp', 'ghcp:a', 0, hour * 2, hour).buckets[0]?.inputTokens, 12);
    assert.deepEqual(new NativeTokenUsageStore(db).range('ghcp', 'ghcp:missing', 0, hour * 2, hour).buckets, []);
  } finally { db.close(); }
});
test('Codex first cumulative sample is an unknown baseline, replay/cache regression never inflate totals', () => {
  const db = new DatabaseSync(':memory:'); let now = hour;
  let ledger = new NativeTokenUsageStore(db, () => now);
  try {
    const sample = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80 };
    ledger.cumulative('codex:a', 't1', sample);
    assert.equal(ledger.range('codex', 'codex:a', 0, hour * 3, hour).buckets.length, 0);
    now += 1;
    const next = { inputTokens: 150, outputTokens: 20, cacheReadTokens: 100 };
    ledger.cumulative('codex:a', 't1', next); ledger.cumulative('codex:a', 't1', next);
    ledger.cumulative('codex:a', 't1', { ...next, cacheReadTokens: 1 });
    ledger.cumulative('codex:a', 't1', next); ledger.cumulative('codex:a', 'old', sample);
    ledger = new NativeTokenUsageStore(db, () => now);
    ledger.cumulative('codex:a', 't2', { inputTokens: 200, outputTokens: 30, cacheReadTokens: 120 });
    const bucket = ledger.range('codex', 'codex:a', 0, hour * 3, hour).buckets[0]!;
    assert.deepEqual(bucket, { at: hour, samples: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: null,
      models: [{ model: null, samples: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: null }] });
    db.exec('BEGIN'); ledger.cumulative('codex:a', 't3', { inputTokens: 250, outputTokens: 40 }); db.exec('ROLLBACK');
    assert.deepEqual(ledger.range('codex', 'codex:a', 0, hour * 3, hour).buckets[0], bucket);
  } finally { db.close(); }
});
test('missing cache telemetry retains its high-water mark across reopen without bridging an unknown interval', () => {
  const db = new DatabaseSync(':memory:'); let now = 1;
  let ledger = new NativeTokenUsageStore(db, () => now);
  const sample = (inputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number) => ({ inputTokens, outputTokens: 1,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }), ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }) });
  try {
    ledger.cumulative('codex:a', 'first', sample(100, 80, 10));
    ledger.cumulative('codex:a', 'known', sample(150, 100, 20));
    now = 60_000;
    ledger.cumulative('codex:a', 'missing', sample(200));
    ledger = new NativeTokenUsageStore(db, () => now);
    ledger.cumulative('codex:a', 'late', sample(220, 90, 15));
    ledger.cumulative('codex:a', 'still-late', sample(230, 95, 18));
    ledger.cumulative('codex:a', 'restored', sample(250, 120, 30));
    let result = ledger.range('codex', 'codex:a', 0, 180_000, 60_000);
    assert.deepEqual(result.buckets.map(b => [b.inputTokens, b.samples, b.cacheReadTokens]), [[50, 1, 20], [100, 2, null]],
      'late cache values must not replace the retained watermark or produce duplicate samples');
    now = 120_000;
    ledger.cumulative('codex:a', 'continuous', sample(300, 140, 40));
    result = ledger.range('codex', 'codex:a', 0, 180_000, 60_000);
    assert.equal(result.buckets[2]?.cacheReadTokens, 20);
    assert.equal(result.buckets[2]?.cacheWriteTokens, 10);
    assert.equal(result.buckets[1]?.cacheWriteTokens, null, 'an unknown interval never becomes zero or a bridged cache delta');
  } finally { db.close(); }
});
test('cumulative sample and baseline failure roll back together inside a caller-owned transaction', () => {
  const db = new DatabaseSync(':memory:'), ledger = new NativeTokenUsageStore(db, () => 1);
  try {
    ledger.cumulative('codex:a', 'first', { inputTokens: 10, outputTokens: 1 });
    db.exec(`CREATE TABLE unrelated(value INTEGER); BEGIN; INSERT INTO unrelated VALUES(1);
      CREATE TEMP TRIGGER reject_baseline BEFORE UPDATE ON native_token_baselines BEGIN SELECT RAISE(ABORT, 'fixture baseline failure'); END;`);
    assert.throws(() => ledger.cumulative('codex:a', 'next', { inputTokens: 20, outputTokens: 2 }), /fixture baseline failure/);
    assert.equal(db.isTransaction, true, 'do not abort caller-owned work');
    assert.equal(ledger.range('codex', 'codex:a', 0, hour, hour).buckets.length, 0, 'sample insert must roll back with the failed baseline');
    db.exec('DROP TRIGGER reject_baseline; COMMIT');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM unrelated').get()!.n, 1);
    ledger.cumulative('codex:a', 'next', { inputTokens: 20, outputTokens: 2 });
    assert.equal(ledger.range('codex', 'codex:a', 0, hour, hour).buckets[0]?.inputTokens, 10);
  } finally { db.close(); }
});
test('invalid persisted baseline is not silently replaced by a new guessed baseline', () => {
  const db = new DatabaseSync(':memory:'), ledger = new NativeTokenUsageStore(db, () => 1);
  try {
    for (const data of [{ inputTokens: -1, outputTokens: 1 },
      { inputTokens: 1, outputTokens: 1, cacheHighWater: { cacheReadTokens: -1 } }]) {
      db.prepare('INSERT OR REPLACE INTO native_token_baselines VALUES(?,?,?,?)').run('codex', 'codex:a', 1, JSON.stringify(data));
      assert.throws(() => ledger.cumulative('codex:a', 'next', { inputTokens: 20, outputTokens: 2 }), /baseline/);
      assert.equal(db.isTransaction, false);
      assert.equal(db.prepare('SELECT data FROM native_token_baselines').get()!.data, JSON.stringify(data));
    }
  } finally { db.close(); }
});
test('cumulative commit blocked by a reader rolls back instead of leaving an open write transaction', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-token-commit-')), file = join(root, 'fixture.sqlite');
  const db = new DatabaseSync(file), reader = new DatabaseSync(file), ledger = new NativeTokenUsageStore(db, () => 1);
  try {
    db.exec('PRAGMA busy_timeout=0');
    ledger.cumulative('codex:a', 'first', { inputTokens: 10, outputTokens: 1 });
    // A second connection exists only for this disposable fixture, never a
    // production DB. Rollback-journal mode forces failure at RELEASE/COMMIT.
    reader.exec('BEGIN'); reader.prepare('SELECT COUNT(*) FROM native_token_baselines').get();
    assert.throws(() => ledger.cumulative('codex:a', 'next', { inputTokens: 20, outputTokens: 2 }), /locked/);
    assert.equal(db.isTransaction, false);
    reader.exec('COMMIT');
    assert.deepEqual(ledger.range('codex', 'codex:a', 0, hour, hour).buckets, []);
    ledger.cumulative('codex:a', 'next', { inputTokens: 20, outputTokens: 2 });
    assert.equal(ledger.range('codex', 'codex:a', 0, hour, hour).buckets[0]?.inputTokens, 10);
  } finally { reader.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
test('SQLite-triggered whole-transaction rollback preserves the original failure and permits recovery', () => {
  const db = new DatabaseSync(':memory:'), ledger = new NativeTokenUsageStore(db, () => 1);
  try {
    ledger.cumulative('codex:a', 'first', { inputTokens: 10, outputTokens: 1 });
    db.exec(`CREATE TEMP TRIGGER reject_baseline BEFORE UPDATE ON native_token_baselines BEGIN SELECT RAISE(ROLLBACK, 'fixture full rollback'); END;`);
    assert.throws(() => ledger.cumulative('codex:a', 'next', { inputTokens: 20, outputTokens: 2 }), /fixture full rollback/);
    assert.equal(db.isTransaction, false);
    db.exec('DROP TRIGGER reject_baseline');
    assert.deepEqual(ledger.range('codex', 'codex:a', 0, hour, hour).buckets, []);
    ledger.cumulative('codex:a', 'next', { inputTokens: 20, outputTokens: 2 });
    assert.equal(ledger.range('codex', 'codex:a', 0, hour, hour).buckets[0]?.inputTokens, 10);
  } finally { db.close(); }
});
test('range and response validation reject coercion, oversized windows, forged scopes and unordered buckets', () => {
  assert.deepEqual(tokenUsageRange('0', String(hour), String(hour)), { from: 0, to: hour, bucketMs: hour });
  for (const values of [[0, 32 * 86_400_000, hour], [0, hour, 1], [true, hour, hour], ['', hour, hour], ['1e3', hour, hour], [hour, 0, hour]]) assert.throws(() => tokenUsageRange(...values as [unknown, unknown, unknown]));
  const db = new DatabaseSync(':memory:'), ledger = new NativeTokenUsageStore(db, () => 1);
  try {
    ledger.record('ghcp', 'ghcp:a', 'a', { inputTokens: 12, outputTokens: 3 });
    const result = ledger.range('ghcp', 'ghcp:a', 0, hour, hour);
    for (const bad of [{ ...result, attribution: 'all-agents' }, { ...result, inputAccounting: 'includes-cache' }, { ...result, buckets: [...result.buckets, ...result.buckets] }, { ...result, buckets: [{ ...result.buckets[0], inputTokens: -1 }] }]) assert.throws(() => validateNativeTokenUsage(bad));
  } finally { db.close(); }
});
for (const runtime of ['claude-code', 'ghcp'] as const) test(`${runtime}: native ledger follows execution fences and atomic metric event dedup`, () => {
  const db = new DatabaseSync(':memory:'), ledger = new NativeTokenUsageStore(db, () => 1000);
  const journal = new SdkExecutionJournal(db, runtime, () => 1000, undefined, undefined, undefined, ledger), turns = new TurnQueue(db);
  const key = `${runtime}:a`;
  try {
    journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 1 });
    turns.enqueue(runtime, { id: 'turn', sessionKey: key, createdAt: 1000, payload: { text: 'fixture', actorId: 'owner' } });
    const ref = journal.begin({ key, id: 'execution', epoch: 'epoch' }, ['turn'], turns)!;
    const sample = { eventId: 'event', sequence: 1, usage: { scope: runtime === 'ghcp' ? 'last-call' : 'last-turn', inputTokens: 12, outputTokens: 3 } };
    assert.equal(journal.recordMetrics({ ...ref, epoch: 'old' }, sample), false);
    assert.equal(journal.recordMetrics(ref, sample), true);
    assert.equal(journal.recordMetrics(ref, { ...sample, sequence: 2 }), false);
    journal.observeTerminal(ref, 'completed', turns); journal.confirmSettled(ref);
    assert.equal(journal.recordMetrics(ref, { ...sample, eventId: 'late', sequence: 3 }), false);
    assert.equal(ledger.range(runtime, key, 0, hour, hour).buckets[0]?.inputTokens, 12);
  } finally { db.close(); }
});
