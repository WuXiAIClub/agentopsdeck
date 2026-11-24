import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateNativeCumulativeCoverage, validateNativeTokenUsage } from '@agentopsdeck/shared';
import { NativeTokenUsageStore } from './native-token-usage.js';

const counts = (inputTokens: number, cacheReadTokens?: number) => ({ inputTokens, outputTokens: inputTokens / 10,
  ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }) });
const range = (store: NativeTokenUsageStore, key = 'codex:fixture') => store.range('codex', key, 0, 3_600_000, 60_000);

test('first cumulative baseline is visible but never added to bucket totals, for any selected period', () => {
  const db = new DatabaseSync(':memory:'); let now = 10;
  try {
    const store = new NativeTokenUsageStore(db, () => now);
    assert.equal(range(store).cumulativeCoverage, undefined);
    store.cumulative('codex:fixture', 'turn', counts(1000, 300));
    const first = range(store);
    assert.deepEqual(first.buckets, []); assert.equal(first.observedSince, null);
    assert.deepEqual(first.cumulativeCoverage, { trackedSince: 10, initialBaseline: { ...counts(1000, 300), observedAt: 10 }, lastRegressionAt: null, lastCacheGapAt: null });
    now = 20; store.cumulative('codex:fixture', 'turn', counts(1050, 320));
    const next = range(store);
    assert.equal(next.buckets[0]!.inputTokens, 50); assert.equal(next.buckets[0]!.outputTokens, 5);
    assert.equal(next.buckets[0]!.cacheReadTokens, 20);
    assert.deepEqual(next.cumulativeCoverage, first.cumulativeCoverage);
    const otherPeriod = store.range('codex', 'codex:fixture', 60_000, 120_000, 60_000);
    assert.deepEqual(otherPeriod.buckets, []); assert.deepEqual(otherPeriod.cumulativeCoverage, first.cumulativeCoverage);
    next.cumulativeCoverage!.initialBaseline!.inputTokens = 9999;
    assert.equal(range(store).cumulativeCoverage!.initialBaseline!.inputTokens, 1000, 'callers cannot mutate saved evidence');
    assert.deepEqual(range(store, 'codex:other').cumulativeCoverage, undefined);
    assert.equal(store.range('ghcp', 'ghcp:fixture', 0, 60_000, 60_000).cumulativeCoverage, undefined);
  } finally { db.close(); }
});

test('regression is diagnosed without guessing resets or charging duplicate cumulative samples', () => {
  const db = new DatabaseSync(':memory:'); let now = 10;
  try {
    const store = new NativeTokenUsageStore(db, () => now);
    store.cumulative('codex:fixture', 'first', counts(1000, 300));
    now = 20; store.cumulative('codex:fixture', 'next', counts(1100, 350));
    now = 30; store.cumulative('codex:fixture', 'late', counts(1000, 300));
    const diagnosed = range(store);
    assert.equal(diagnosed.cumulativeCoverage!.lastRegressionAt, 30);
    assert.equal(diagnosed.buckets[0]!.inputTokens, 100);
    const changes = Number(db.prepare('SELECT total_changes() AS n').get()!.n);
    store.cumulative('codex:fixture', 'late', counts(1000, 300));
    assert.equal(Number(db.prepare('SELECT total_changes() AS n').get()!.n), changes, 'identical rejection at the same timestamp does not rewrite');
    now = 40; store.cumulative('codex:fixture', 'replay', counts(1100, 350));
    now = 50; store.cumulative('codex:fixture', 'later', counts(1200, 400));
    assert.equal(range(store).buckets[0]!.inputTokens, 200);
    assert.equal(range(store).cumulativeCoverage!.lastRegressionAt, 30, 'accepted samples do not erase a known gap');
    now = 5; store.cumulative('codex:fixture', 'old', counts(900, 200));
    assert.equal(range(store).cumulativeCoverage!.lastRegressionAt, 30, 'clock reversal does not move evidence backwards');
  } finally { db.close(); }
});

test('cache disappearance and reappearance remain unknown instead of a fabricated delta', () => {
  const db = new DatabaseSync(':memory:'); let now = 10;
  try {
    const store = new NativeTokenUsageStore(db, () => now);
    store.cumulative('codex:fixture', 'first', counts(1000, 300));
    now = 20; store.cumulative('codex:fixture', 'gap', counts(1100));
    assert.equal(range(store).cumulativeCoverage!.lastCacheGapAt, 20);
    now = 30; store.cumulative('codex:fixture', 'return', counts(1200, 400));
    now = 40; store.cumulative('codex:fixture', 'continuous', counts(1300, 450));
    const data = range(store);
    assert.equal(data.cumulativeCoverage!.lastCacheGapAt, 30);
    assert.equal(data.buckets[0]!.cacheReadTokens, null);
    assert.equal(data.buckets[0]!.inputTokens, 300);
    now = 50; store.cumulative('codex:fixture', 'cache-regression', counts(1400, 200));
    assert.equal(range(store).cumulativeCoverage!.lastRegressionAt, 50);
    assert.equal(range(store).buckets[0]!.inputTokens, 300, 'cache regression still rejects the whole ambiguous sample');
  } finally { db.close(); }
});

test('legacy baselines never masquerade as the preserved original cumulative snapshot', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new NativeTokenUsageStore(db, () => 300);
    db.prepare('INSERT INTO native_token_baselines VALUES(?,?,?,?)').run('codex', 'codex:fixture', 100, JSON.stringify(counts(1000)));
    assert.equal(range(store).cumulativeCoverage, undefined, 'GET does not migrate legacy state');
    store.cumulative('codex:fixture', 'later', counts(1100));
    assert.deepEqual(range(store).cumulativeCoverage, { trackedSince: 300, initialBaseline: null, lastRegressionAt: null, lastCacheGapAt: null });
    assert.equal(range(store).buckets[0]!.inputTokens, 100);
    assert.equal(db.prepare('SELECT observed_at FROM native_token_baselines').get()!.observed_at, 100, 'original baseline row timestamp remains intact');
  } finally { db.close(); }
});

test('a zero-delta cache interruption is recorded without inventing a usage event', () => {
  const db = new DatabaseSync(':memory:'); let now = 10;
  try {
    const store = new NativeTokenUsageStore(db, () => now);
    store.cumulative('codex:fixture', 'first', counts(1000, 300));
    now = 20; store.cumulative('codex:fixture', 'missing', counts(1000));
    assert.deepEqual(range(store).buckets, []);
    assert.equal(range(store).cumulativeCoverage!.lastCacheGapAt, 20);
    now = 30; store.cumulative('codex:fixture', 'return', counts(1100, 350));
    assert.equal(range(store).buckets[0]!.cacheReadTokens, null);
    const before = range(store);
    for (const invalid of [-1, NaN, Infinity, 8_640_000_000_000_001]) {
      now = invalid;
      assert.throws(() => store.cumulative('codex:fixture', 'bad-clock', counts(900)), /observation time/);
      assert.deepEqual(range(store), before, 'invalid collection time cannot corrupt saved diagnostics');
    }
  } finally { db.close(); }
});

test('coverage survives reopening and is rolled back with samples and the cumulative baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-token-coverage-'));
  const path = join(root, 'fixture.sqlite'); let db = new DatabaseSync(path); let now = 10;
  try {
    let store = new NativeTokenUsageStore(db, () => now);
    store.cumulative('codex:fixture', 'first', counts(1000, 300));
    now = 20; store.cumulative('codex:fixture', 'late', counts(900, 200));
    const before = range(store);
    db.close(); db = new DatabaseSync(path); store = new NativeTokenUsageStore(db, () => now);
    assert.deepEqual(range(store), before);
    db.exec(`CREATE TEMP TRIGGER reject_coverage BEFORE UPDATE ON native_token_baselines BEGIN SELECT RAISE(ABORT,'fixture coverage failure'); END; BEGIN`);
    now = 30;
    assert.throws(() => store.cumulative('codex:fixture', 'gap', counts(1100)), /fixture coverage failure/);
    assert.throws(() => store.cumulative('codex:fixture', 'late', counts(800)), /fixture coverage failure/);
    db.exec('COMMIT; DROP TRIGGER reject_coverage');
    assert.deepEqual(range(store), before, 'caught failures must not leak samples or diagnostics into caller commit');
    store.cumulative('codex:fixture', 'gap', counts(1100));
    const after = range(store);
    assert.equal(after.buckets[0]!.inputTokens, 100); assert.equal(after.cumulativeCoverage!.lastCacheGapAt, 30);
    assert.equal(after.cumulativeCoverage!.lastRegressionAt, 20);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('untrusted coverage is validated and projects numeric fields only; old responses remain valid', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new NativeTokenUsageStore(db, () => 10);
    store.cumulative('codex:fixture', 'first', counts(1000));
    const data = range(store), coverage = data.cumulativeCoverage!;
    assert.deepEqual(validateNativeTokenUsage(data), data);
    const { cumulativeCoverage: _, ...legacy } = data;
    assert.deepEqual(validateNativeTokenUsage(legacy), legacy);
    for (const invalid of [null, [], {}, { ...coverage, trackedSince: -1 }, { ...coverage, trackedSince: 9e15 },
      { ...coverage, lastRegressionAt: '10' }, { ...coverage, lastCacheGapAt: 9 },
      { ...coverage, initialBaseline: {} }, { ...coverage, initialBaseline: { ...coverage.initialBaseline, observedAt: 9 } },
      { ...coverage, initialBaseline: { ...coverage.initialBaseline, inputTokens: Number.MAX_SAFE_INTEGER + 1 } }]) {
      assert.throws(() => validateNativeTokenUsage({ ...data, cumulativeCoverage: invalid }));
    }
    assert.throws(() => validateNativeTokenUsage({ ...data, runtime: 'ghcp', inputAccounting: 'provider-defined' }));
    assert.deepEqual(validateNativeCumulativeCoverage({ ...coverage, note: 'discard', initialBaseline: { ...coverage.initialBaseline, secret: 'discard' } }), coverage);
  } finally { db.close(); }
});

test('malformed persisted coverage fails closed without replacing evidence or accepting new usage', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new NativeTokenUsageStore(db, () => 100);
    db.prepare('INSERT INTO native_token_baselines VALUES(?,?,?,?)').run('codex', 'codex:fixture', 10, JSON.stringify({ ...counts(1000), coverage: { trackedSince: 10 } }));
    const before = db.prepare('SELECT data FROM native_token_baselines').get()!.data;
    assert.throws(() => range(store), /coverage/);
    assert.throws(() => store.cumulative('codex:fixture', 'new', counts(1100)), /coverage/);
    assert.equal(db.prepare('SELECT data FROM native_token_baselines').get()!.data, before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM native_token_samples').get()!.n, 0);
  } finally { db.close(); }
});
