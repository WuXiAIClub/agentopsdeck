import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcilePage } from './reconciliation-page.js';

function held() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }

test('held original retains a slot while later originals and bounded follow-ups progress', async () => {
  const gate = held(), seen: number[] = []; let active = 0, peak = 0, settled = false;
  const page = reconcilePage([0, 1, 2, 3, 4, 5], async id => {
    seen.push(id); active++; peak = Math.max(peak, active);
    try { if (id === 0) await gate.promise; return id < 6 ? [id + 6] : []; }
    finally { active--; }
  }, () => true, 12).then(() => { settled = true; });
  try {
    await flush(); assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11]);
    assert.equal(settled, false); assert.ok(peak <= 4);
    gate.release(); await page;
    assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i));
  } finally { gate.release(); await page; }
});

test('four retained slots block new work and fencing drains every original without replacement', async () => {
  const gate = held(), seen: number[] = []; let open = true, settled = false;
  const page = reconcilePage([0, 1, 2, 3, 4, 5], async id => { seen.push(id); await gate.promise; return [id + 6]; },
    () => open, 12).then(() => { settled = true; });
  try {
    await flush(); assert.deepEqual(seen, [0, 1, 2, 3]); open = false;
    await flush(); assert.equal(settled, false); gate.release(); await page;
    assert.deepEqual(seen, [0, 1, 2, 3]);
  } finally { gate.release(); await page; }
});

test('close between slot reservation and invocation starts no IO', async () => {
  let open = true, calls = 0;
  const page = reconcilePage([0, 1, 2, 3, 4], async () => { calls++; }, () => open);
  open = false; await page; assert.equal(calls, 0);
});

test('dynamic follow-ups restart idle slots but keep total concurrency bounded', async () => {
  const gate = held(), seen: number[] = []; let active = 0, peak = 0;
  const page = reconcilePage([0], async id => {
    seen.push(id); active++; peak = Math.max(peak, active);
    try { if (!id) { await gate.promise; return [1, 2, 3, 4, 5, 6]; } await Promise.resolve(); }
    finally { active--; }
  }, () => true, 7);
  await flush(); assert.deepEqual(seen, [0]); gate.release(); await page;
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6]); assert.equal(peak, 4);
});

test('failure selection follows admitted order, not settlement speed, and waits held originals', async () => {
  const gate = held(), original = Error('original'), later = Error('later'); let settled = false;
  const page = reconcilePage([0, 1, 2, 3, 4], id => {
    if (id === 0) return gate.promise.then(() => { throw original; });
    if (id === 1) throw later;
    return Promise.resolve();
  }, () => true);
  const checked = assert.rejects(page, error => error === original).then(() => { settled = true; });
  await flush(); assert.equal(settled, false); gate.release(); await checked;
});

test('undefined rejection remains a rejection rather than a successful empty result', async () => {
  let rejected = false;
  await reconcilePage([0], () => Promise.reject(undefined), () => true).then(
    () => assert.fail('undefined failure must not settle successfully'), error => { rejected = true; assert.equal(error, undefined); });
  assert.equal(rejected, true);
});

test('invalid capacity starts nothing and follow-up overflow does not skip original drain', async () => {
  let calls = 0;
  for (const limit of [-1, 0, 1.5, NaN, Infinity, 1025]) {
    await assert.rejects(reconcilePage([1], async () => { calls++; }, () => true, limit), /Invalid/);
  }
  assert.equal(calls, 0);
  const gate = held(); let settled = false;
  const page = reconcilePage([0, 1], async id => { if (!id) { await gate.promise; return; } return [2, 3]; }, () => true, 3);
  const checked = assert.rejects(page, /capacity exceeded/).then(() => { settled = true; });
  await flush(); assert.equal(settled, false); gate.release(); await checked;
});

test('admission callback failure fences unstarted work and retains active originals', async () => {
  const gate = held(), fault = Error('admission'); let calls = 0, checks = 0, settled = false;
  // First four admission checks and four invocation checks succeed; the ninth
  // check is the attempted next item after a slot frees.
  const page = reconcilePage([0, 1, 2, 3, 4, 5], async id => { calls++; if (!id) await gate.promise; },
    () => { if (++checks === 9) throw fault; return true; });
  const checked = assert.rejects(page, error => error === fault).then(() => { settled = true; });
  await flush(); assert.equal(calls, 4); assert.equal(settled, false); gate.release(); await checked;
});

test('invocation callback failure fences every reserved but unstarted item', async () => {
  let checks = 0, calls = 0; const fault = Error('invocation');
  await assert.rejects(reconcilePage([0, 1, 2, 3, 4], async () => { calls++; }, () => {
    if (++checks === 5) throw fault; return true;
  }), error => error === fault);
  assert.equal(calls, 0);
});

test('empty page settles without invoking work or authority callback', async () => {
  await reconcilePage([], async () => assert.fail('work'), () => { assert.fail('admission'); });
});
