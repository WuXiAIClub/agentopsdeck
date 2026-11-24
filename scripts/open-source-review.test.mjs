import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReview } from './open-source-review.mjs';

const file = { path: 'src/synthetic.ts', sha256: 'a'.repeat(64), size: 12 };
const record = { ...file, kind: 'runtime', depth: 'semantic', disposition: 'no-finding',
  checks: ['complete-file-and-callers'], notes: 'Synthetic authority entry and caller inspected.', findings: [] };

test('complete current evidence is distinct from publication authorization', () => {
  const result = validateReview([record], [file]);
  assert.equal(result.passed, true);
  assert.equal(result.complete, true);
  assert.deepEqual(result.byDepth, { semantic: 1 });
});

test('empty, duplicate and malformed inventories cannot approve a review', () => {
  for (const inventory of [null, [], [file, file], [null], [{ ...file, sha256: 'invalid' }],
    [{ ...file, size: -1 }]]) {
    const result = validateReview(inventory?.length ? [record] : [], inventory);
    assert.equal(result.passed, false);
    assert.equal(result.complete, false);
  }
});

test('missing, duplicate, unexpected and changed files cannot disappear from coverage', () => {
  for (const [records, inventory, category] of [
    [[], [file], 'missing-record'],
    [[record, record], [file], 'duplicate-record'],
    [[{ ...record, path: 'unassigned.ts' }], [file], 'unexpected-path'],
    [[record], [{ ...file, sha256: 'b'.repeat(64) }], 'stale-record'],
    [[record], [{ ...file, size: 13 }], 'stale-record'],
  ]) {
    const result = validateReview(records, inventory);
    assert.equal(result.passed, false);
    assert.equal(result.complete, false);
    assert.ok(result.errors.some(error => error.category === category));
  }
});

test('structural scanning and unresolved findings never become completed semantic review', () => {
  for (const partial of [
    { ...record, depth: 'structural' },
    { ...record, depth: 'pending', disposition: 'pending' },
    { ...record, depth: 'asset', kind: 'asset', disposition: 'pending' },
    { ...record, disposition: 'finding', findings: ['SYNTHETIC-1'] },
  ]) {
    const result = validateReview([partial], [file]);
    assert.equal(result.passed, true);
    assert.equal(result.complete, false);
  }
});

test('malformed or insufficient review evidence fails without returning source contents', () => {
  const malformed = [null, { ...record, checks: [] }, { ...record, notes: '' },
    { ...record, depth: 'pending' }, { ...record, disposition: 'finding' },
    { ...record, depth: 'skimmed' }, { ...record, findings: [null] }];
  for (const candidate of malformed) {
    const result = validateReview([candidate], [file]);
    assert.equal(result.passed, false);
    assert.equal(result.complete, false);
    assert.equal(JSON.stringify(result).includes(record.notes), false);
  }
  assert.equal(validateReview(null, [file]).passed, false);
});

test('runtime code cannot be relabeled as assets or hide findings under no-finding', () => {
  for (const candidate of [
    { ...record, depth: 'asset' },
    { ...record, disposition: 'no-finding', findings: ['SYNTHETIC-1'] },
    { ...record, disposition: 'not-applicable', findings: ['SYNTHETIC-1'] },
  ]) {
    const result = validateReview([candidate], [file]);
    assert.equal(result.passed, false);
    assert.equal(result.complete, false);
  }
});
