import assert from 'node:assert/strict';
import test from 'node:test';
import { captionSelection, captionTitleBudget } from './caption-priority.js';

test('names have priority over spacing and actions; only More is reserved', () => {
  assert.equal(captionTitleBudget(600, 52), 52);
  assert.equal(captionTitleBudget(300, 52), 52);
  assert.equal(captionTitleBudget(600, 520), 520);
  assert.equal(captionTitleBudget(600, 800), 576);
  assert.equal(captionTitleBudget(300, 800), 276);
  assert.equal(captionTitleBudget(100, 800), 76);
  assert.equal(captionTitleBudget(10, 800), 0);
  assert.equal(captionTitleBudget(300, 800, 18), 282);
  assert.equal(captionTitleBudget(100, 0), 0);
});

test('all items fit without reserving an unnecessary More button', () => {
  assert.deepEqual(captionSelection([{ width: 24, priority: 0 }, { width: 24, priority: 100 }], 51, 24), { overflow: false, hidden: new Set() });
});
test('lowest priority disappears first regardless of DOM position', () => {
  const items = [90, 0, 100, 40].map(priority => ({ width: 24, priority }));
  assert.deepEqual(captionSelection(items, 80, 24).hidden, new Set([1, 3]));
  assert.deepEqual(items.map(item => item.priority), [90, 0, 100, 40], 'input order stays unchanged');
});
test('wide high-priority action cannot be displaced by smaller low-priority icons', () => {
  const items = [{ width: 90, priority: 100 }, { width: 10, priority: 0 }, { width: 10, priority: 20 }];
  assert.deepEqual(captionSelection(items, 100, 24).hidden, new Set([1, 2, 0]));
});
test('equal priorities retain leftmost controls and account for exact gaps', () => {
  const items = [24, 24, 24].map(width => ({ width, priority: 50 }));
  assert.deepEqual(captionSelection(items, 77, 24).hidden, new Set([2, 1]));
  assert.deepEqual(captionSelection(items, 78, 24).hidden, new Set());
  assert.deepEqual(captionSelection([...items, ...items], 78, 24).hidden, new Set([5, 4, 3, 2]));
});
test('empty and zero-width controls consume no space; no budget hides every real control', () => {
  assert.deepEqual(captionSelection([], 0, 24), { overflow: false, hidden: new Set() });
  assert.deepEqual(captionSelection([{ width: 0, priority: 100 }, { width: 24, priority: 10 }], 0, 24), { overflow: true, hidden: new Set([1]) });
});
test('shrinking monotonically removes lower priorities; expanding restores them', () => {
  const items = [10, 90, 40, 100, 40].map((priority, index) => ({ priority, width: 20 + index * 11 }));
  let previous = new Set<number>();
  for (let budget = 300; budget >= 0; budget--) {
    const { hidden } = captionSelection(items, budget, 24);
    for (const index of previous) assert.ok(hidden.has(index));
    for (const index of hidden) for (const [other, item] of items.entries()) {
      if (!hidden.has(other)) assert.ok(item.priority >= items[index]!.priority);
    }
    previous = hidden;
  }
  assert.equal(captionSelection(items, 300, 24).hidden.size, 0);
});
test('an action promoted at runtime takes priority without reordering items', () => {
  const items = [{ width: 24, priority: 60 }, { width: 24, priority: 100 }, { width: 24, priority: 90 }];
  assert.deepEqual(captionSelection(items, 51, 24).hidden, new Set([0, 2]));
  items[0]!.priority = 110;
  assert.deepEqual(captionSelection(items, 51, 24).hidden, new Set([2, 1]));
});
