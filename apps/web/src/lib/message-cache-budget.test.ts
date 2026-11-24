import assert from 'node:assert/strict';
import test from 'node:test';
import { fitMessageCache } from './message-cache-budget.js';

const messages = (count: number, text = 'reply') => Array.from({ length: count }, (_, i) => ({
  id: String(i), sessionKey: 'synthetic', role: 'assistant' as const, text, createdAt: i,
}));

test('cache retains 200 ordinary rows and accounts for older hidden rows', () => {
  const rows = messages(240);
  const cached = fitMessageCache({ messages: rows, hiddenCount: 50, updatedAt: 123 }, 200, 1_500_000)!;
  assert.deepEqual(cached.messages, rows.slice(-200));
  assert.equal(cached.hiddenCount, 90);
  assert.equal(cached.updatedAt, 123);
});

test('oversized long-tool history keeps the latest full reply within UTF-16 budget', () => {
  const rows = [...messages(199, '工具输出'.repeat(4_000)), ...messages(1, 'The latest final reply')];
  const entry = { messages: rows, hiddenCount: 750, updatedAt: 456 };
  const cached = fitMessageCache(entry, 200, 1.5 * 1024 * 1024)!;
  assert.ok(cached.messages.length > 0 && cached.messages.length < 200);
  assert.deepEqual(cached.messages, rows.slice(-cached.messages.length));
  assert.equal(cached.messages.at(-1)?.text, 'The latest final reply');
  assert.equal(cached.hiddenCount, 750 + 200 - cached.messages.length);
  assert.ok(JSON.stringify(cached).length * 2 <= 1.5 * 1024 * 1024);
  assert.equal(entry.messages.length, 200);
});

test('one oversized newest row cannot be replaced by an older row or truncated text', () => {
  assert.equal(fitMessageCache({ messages: [...messages(1), ...messages(1, 'x'.repeat(10_000))] }, 200, 1024), undefined);
  assert.deepEqual(fitMessageCache({ messages: [], hiddenCount: 0 }, 200, 1024), { messages: [], hiddenCount: 0 });
});

test('a fitting complete tail needs only one serialization', () => {
  const entry = { messages: messages(240), hiddenCount: 17 };
  const stringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = ((...args: Parameters<typeof stringify>) => { calls++; return stringify(...args); }) as typeof stringify;
  try {
    const result = fitMessageCache(entry, 200, 1_500_000)!;
    assert.equal(calls, 1);
    assert.deepEqual(result.messages, entry.messages.slice(-200));
    assert.equal(result.hiddenCount, 57);
  } finally { JSON.stringify = stringify; }
});

test('full-tail fast path matches the previous fitter at exact UTF-16 boundaries', () => {
  const original = (entry: { messages: ReturnType<typeof messages>; hiddenCount?: number; updatedAt: number }, maxMessages: number, maxBytes: number) => {
    const count = entry.messages.length;
    const tail = (n: number) => ({ ...entry, messages: entry.messages.slice(count - n), hiddenCount: (entry.hiddenCount ?? 0) + count - n });
    const fits = (value: typeof entry) => JSON.stringify(value).length * 2 <= maxBytes;
    let low = count ? 1 : 0, high = Math.min(count, maxMessages);
    if (high < low || !fits(tail(low))) return undefined;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (fits(tail(middle))) low = middle; else high = middle - 1; }
    return tail(low);
  };
  for (const count of [0, 1, 2, 9, 10, 99, 200, 240]) for (const limit of [0, 1, 40, 200]) {
    const entry = { messages: messages(count, '缓存😀\n"'), hiddenCount: 99, updatedAt: 42 };
    const before = JSON.stringify(entry);
    const fullBytes = JSON.stringify({ ...entry, messages: entry.messages.slice(count - Math.min(count, limit)), hiddenCount: 99 + count - Math.min(count, limit) }).length * 2;
    for (const bytes of [0, 64, 512, fullBytes - 2, fullBytes, fullBytes + 2, 1_500_000]) {
      assert.deepEqual(fitMessageCache(entry, limit, bytes), original(entry, limit, bytes), `${count}/${limit}/${bytes}`);
      assert.equal(JSON.stringify(entry), before);
    }
  }
});
