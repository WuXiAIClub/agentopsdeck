import assert from 'node:assert/strict';
import test from 'node:test';
import { enforceCacheStorageBudget } from './cache-storage-budget.js';

const budget = { rootPrefix: 'agentopsdeck.cache.', messagePrefix: 'agentopsdeck.cache.account.messages.', maxSessions: 40, maxBytes: 4 * 1024 * 1024 };
class MemoryStorage implements Storage {
  data = new Map<string, string>();
  failedRemovals = new Set<string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
  removeItem(key: string) { if (this.failedRemovals.has(key)) throw new Error('denied'); this.data.delete(key); }
}
const row = (store: MemoryStorage, id: number, text = 'cached history', cachedAt = id) => {
  const key = `${budget.messagePrefix}${id}`;
  store.setItem(key, JSON.stringify({ cachedAt, messages: [{ text }] }));
  return key;
};

// Original eager enforcement as an independent behavioral oracle. Keep fault,
// namespace and corrupt-entry behavior, not just an idealized eviction policy.
function eager(store: Storage, limits = budget) {
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) { const key = store.key(i); if (key?.startsWith(limits.rootPrefix)) keys.push(key); }
    const entries: Array<{ key: string; bytes: number; cachedAt: number }> = [];
    let total = 0;
    for (const key of keys) {
      const raw = store.getItem(key) ?? '', bytes = (key.length + raw.length) * 2;
      total += bytes;
      if (/\.messages\.[^.]+$/.test(key)) {
        let cachedAt = 0;
        try { const value = JSON.parse(raw)?.cachedAt; cachedAt = typeof value === 'number' && Number.isFinite(value) ? value : 0; } catch { /* original fallback */ }
        entries.push({ key, bytes, cachedAt });
      }
    }
    if (entries.length > limits.maxSessions) {
      for (const entry of [...entries].sort((a, b) => a.cachedAt - b.cachedAt).slice(0, entries.length - limits.maxSessions)) {
        try { store.removeItem(entry.key); total -= entry.bytes; } catch { /* original best effort */ }
      }
    }
    if (total > limits.maxBytes) {
      for (const entry of entries.filter(e => store.getItem(e.key) !== null).sort((a, b) => a.cachedAt - b.cachedAt)) {
        if (total <= limits.maxBytes) break;
        try { store.removeItem(entry.key); total -= entry.bytes; } catch { /* original best effort */ }
      }
    }
  } catch { /* original best effort */ }
}

test('under-budget enforcement skips all JSON decoding and changes no stored bytes', () => {
  const store = new MemoryStorage();
  for (let i = 0; i < 17; i++) row(store, i, '工具'.repeat(1000));
  const original = [...store.data], parse = JSON.parse;
  let calls = 0;
  try {
    JSON.parse = (...args: Parameters<typeof JSON.parse>) => { calls++; return parse(...args); };
    enforceCacheStorageBudget(store, budget);
  } finally { JSON.parse = parse; }
  assert.equal(calls, 0);
  assert.deepEqual([...store.data], original);
});

test('session-count pressure preserves original oldest-first eviction', () => {
  const store = new MemoryStorage();
  for (let i = 0; i < 43; i++) row(store, i, 'history', 43 - i);
  enforceCacheStorageBudget(store, budget);
  assert.equal(store.length, 40);
  for (const i of [40, 41, 42]) assert.equal(store.getItem(`${budget.messagePrefix}${i}`), null);
});

test('fresh reads see same-key other-tab replacement, removal and additions', () => {
  const store = new MemoryStorage();
  row(store, 0); row(store, 1);
  enforceCacheStorageBudget(store, budget);
  row(store, 0, 'new history', 100);
  row(store, 2, 'third history', 2);
  enforceCacheStorageBudget(store, { ...budget, maxSessions: 2 });
  assert.equal(store.getItem(`${budget.messagePrefix}1`), null);
  store.removeItem(`${budget.messagePrefix}0`);
  row(store, 3);
  enforceCacheStorageBudget(store, { ...budget, maxSessions: 2 });
  assert.equal(store.length, 2);
});

test('pressure never removes drafts, receipts, session lists or another application cache', () => {
  const store = new MemoryStorage();
  const preserved = ['agentopsdeck.draft', 'agentopsdeck.receipt', 'agentopsdeck.cache.account.sessions', 'another-app.cache.other.messages.1'];
  for (const key of preserved) store.setItem(key, 'x'.repeat(500));
  row(store, 1); row(store, 2);
  enforceCacheStorageBudget(store, { ...budget, maxBytes: 10 });
  assert.deepEqual([...store.data.keys()], preserved);
});

test('global byte pressure evicts old scopes before new histories', () => {
  const store = new MemoryStorage();
  const oldKey = 'agentopsdeck.cache.v2.old.backend.messages.1';
  store.setItem(oldKey, JSON.stringify({ cachedAt: 1, messages: [{ text: 'x'.repeat(6000) }] }));
  const newKey = row(store, 2, 'fresh', 2);
  enforceCacheStorageBudget(store, { ...budget, maxBytes: 1000 });
  assert.equal(store.getItem(oldKey), null); assert.notEqual(store.getItem(newKey), null);
  assert.ok([...store.data].reduce((sum, [key, raw]) => sum + (key.length + raw.length) * 2, 0) <= 1000);
});

test('global count pressure is bounded across accounts and backends', () => {
  const store = new MemoryStorage();
  for (let index = 0; index < 50; index++) store.setItem(`agentopsdeck.cache.v2.scope-${index}.backend.messages.1`, JSON.stringify({ cachedAt: index }));
  const fresh = row(store, 51);
  enforceCacheStorageBudget(store, budget);
  assert.equal(store.length, 40); assert.notEqual(store.getItem(fresh), null);
  assert.equal(store.getItem('agentopsdeck.cache.v2.scope-0.backend.messages.1'), null);
});

test('failed old-scope eviction does not prevent global budget recovery from other disposable histories', () => {
  const store = new MemoryStorage(), oldKey = 'agentopsdeck.cache.v2.old.backend.messages.1';
  store.setItem(oldKey, JSON.stringify({ cachedAt: 0, text: 'x'.repeat(100) })); store.failedRemovals.add(oldKey);
  row(store, 1, 'x'.repeat(500)); row(store, 2, 'x'.repeat(500));
  enforceCacheStorageBudget(store, { ...budget, maxBytes: 500 });
  assert.deepEqual([...store.data.keys()], [oldKey]);
  assert.ok([...store.data].reduce((sum, [key, raw]) => sum + (key.length + raw.length) * 2, 0) <= 500);
});

test('lazy enforcement matches eager baseline across pressure, corruption and removal failures', () => {
  for (let scenario = 0; scenario < 160; scenario++) {
    const expected = new MemoryStorage(), actual = new MemoryStorage();
    for (let i = 0; i < scenario % 49; i++) {
      const key = row(expected, i, '中文'.repeat((i * 19 + scenario) % 500), (i * 17) % 11);
      if (i % 13 === 0) expected.setItem(key, '{invalid');
      if (i % 17 === 0) expected.setItem(key, 'null');
      if (i % 19 === 0) expected.failedRemovals.add(key);
    }
    expected.setItem('agentopsdeck.cache.other.messages.1', 'other namespace');
    expected.setItem('agentopsdeck.draft', 'unsent draft');
    actual.data = new Map(expected.data); actual.failedRemovals = new Set(expected.failedRemovals);
    const limits = { ...budget, maxSessions: scenario % 3 ? 40 : 7, maxBytes: scenario % 2 ? budget.maxBytes : 4000 };
    eager(expected, limits); enforceCacheStorageBudget(actual, limits);
    assert.deepEqual([...actual.data], [...expected.data], `scenario ${scenario}`);
  }
});

test('unavailable Storage APIs remain best effort', () => {
  for (const operation of ['length', 'key', 'getItem', 'removeItem']) {
    const store = new MemoryStorage(); row(store, 1);
    const failing = new Proxy(store, { get(target, property) {
      if (property === operation) { if (operation === 'length') throw new Error('denied'); return () => { throw new Error('denied'); }; }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    assert.doesNotThrow(() => enforceCacheStorageBudget(failing, { ...budget, maxSessions: 0 }));
  }
});
