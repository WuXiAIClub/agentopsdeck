import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateNativeTokenUsageExport, NATIVE_TOKEN_EXPORT_LIMIT } from '@agentopsdeck/shared';
import { NativeTokenUsageStore, NativeTokenExportTooLarge } from './native-token-usage.js';

for (const runtime of ['codex', 'claude-code', 'ghcp'] as const) test(`${runtime}: export reconciles models, unknown cache and minute boundaries without raw identities`, () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new NativeTokenUsageStore(db, () => 10), key = `${runtime}:private-session`;
    const counts = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 };
    store.record(runtime, key, 'private-first-event', counts, 'alpha', 59_999);
    store.record(runtime, key, 'private-first-event', counts, 'alpha', 60_000);
    store.record(runtime, key, 'private-second-event', counts, 'beta', 60_000);
    store.record(runtime, key, 'private-third-event', { inputTokens: 40, outputTokens: 5 }, undefined, 60_001);
    store.record(runtime, key, 'end-excluded', counts, 'alpha', 120_000);
    if (runtime === 'codex') store.cumulative(key, 'baseline', { inputTokens: 1000, outputTokens: 200 });
    const result = store.export(runtime, key, 0, 120_000, 60_000);
    assert.equal(result.observations.length, 3);
    assert.deepEqual(result.observations.map(row => row.observedAt), [59_999, 60_000, 60_001]);
    assert.deepEqual(result.usage.buckets.map(row => row.inputTokens), [100, 140]);
    assert.equal(result.usage.buckets[1]!.cacheReadTokens, null);
    assert.doesNotMatch(JSON.stringify(result), /private-session|private-first-event|private-second-event|private-third-event/);
    assert.deepEqual(validateNativeTokenUsageExport(result), result);
    assert.deepEqual(store.export(runtime, key, 1, 59_999, 60_000).observations, []);
    assert.throws(() => store.export(runtime, 'wrong:key', 0, 60_000, 60_000));
    assert.throws(() => store.export(runtime, key, 0, 32 * 86_400_000, 60_000));
  } finally { db.close(); }
});

test('export identity survives reopen and replay; selected range can be empty', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-token-export-')), path = join(directory, 'usage.sqlite');
  let db = new DatabaseSync(path);
  try {
    let store = new NativeTokenUsageStore(db, () => 1);
    store.record('codex', 'codex:fixture', 'event', { inputTokens: 1, outputTokens: 2 });
    const before = store.export('codex', 'codex:fixture', 0, 60_000, 60_000);
    db.close(); db = new DatabaseSync(path); store = new NativeTokenUsageStore(db, () => 2);
    store.record('codex', 'codex:fixture', 'event', { inputTokens: 1, outputTokens: 2 });
    assert.deepEqual(store.export('codex', 'codex:fixture', 0, 60_000, 60_000), before);
    assert.equal(store.export('codex', 'codex:fixture', 60_000, 120_000, 60_000).observations.length, 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('4096 rows succeed, 4097 fail explicitly with no truncation or deletion', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new NativeTokenUsageStore(db, () => 1), key = 'ghcp:fixture';
    for (let i = 0; i < NATIVE_TOKEN_EXPORT_LIMIT; i++) store.record('ghcp', key, String(i), { inputTokens: 1, outputTokens: 1 });
    assert.equal(store.export('ghcp', key, 0, 60_000, 60_000).observations.length, NATIVE_TOKEN_EXPORT_LIMIT);
    store.record('ghcp', key, 'overflow', { inputTokens: 1, outputTokens: 1 });
    assert.throws(() => store.export('ghcp', key, 0, 60_000, 60_000), NativeTokenExportTooLarge);
    assert.equal(store.range('ghcp', key, 0, 60_000, 60_000).buckets[0]!.samples, NATIVE_TOKEN_EXPORT_LIMIT + 1);
  } finally { db.close(); }
});

test('validator rejects forged, duplicated, unsorted, out-of-range and unreconciled observations', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new NativeTokenUsageStore(db);
    store.record('codex', 'codex:fixture', 'a', { inputTokens: 1, outputTokens: 2 }, 'alpha', 10);
    store.record('codex', 'codex:fixture', 'b', { inputTokens: 3, outputTokens: 4, cacheReadTokens: 1 }, 'beta', 20);
    const value = store.export('codex', 'codex:fixture', 0, 60_000, 60_000);
    for (const mutate of [
      (v: any) => { v.version = 2; }, (v: any) => { v.observations[0].identity = 'raw-id'; },
      (v: any) => { v.observations[1].identity = v.observations[0].identity; },
      (v: any) => { v.observations.reverse(); }, (v: any) => { v.observations[0].observedAt = 60_000; },
      (v: any) => { v.observations[0].model = 'unknown'; }, (v: any) => { v.observations[0].inputTokens++; },
      (v: any) => { v.observations[0].cacheReadTokens = 0; }, (v: any) => { v.observations.pop(); },
      (v: any) => { v.observations[0].inputTokens = Number.MAX_SAFE_INTEGER + 1; },
      (v: any) => { delete v.usage.buckets[0].models; }, (v: any) => { v.observations[0] = null; },
    ]) { const invalid = structuredClone(value); mutate(invalid); assert.throws(() => validateNativeTokenUsageExport(invalid)); }
    const extra = { ...value, secret: 'removed', observations: value.observations.map(row => ({ ...row, rawEvent: 'removed' })) };
    assert.deepEqual(validateNativeTokenUsageExport(extra), value);
  } finally { db.close(); }
});
