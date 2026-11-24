import assert from 'node:assert/strict';
import test from 'node:test';
import { createAsyncRuntimeProjection } from './async-runtime-projection.js';
import { ExecutionProjectionChanged } from './execution-projection-inventory.js';

function gate() { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() }; }
const tick = () => new Promise<void>(r => setImmediate(r));

test('whole projection preserves moving-inventory type but never downgrades a hard sibling failure', async () => {
  let hard = false, reads = 0;
  const projection = createAsyncRuntimeProjection([
    async () => { reads++; throw new ExecutionProjectionChanged(); },
    async () => { if (hard) throw Error('original owner failed'); },
  ]);
  try {
    await assert.rejects(projection.refresh(), ExecutionProjectionChanged);
    assert.equal(reads, 1); assert.throws(projection.assertCurrent);
    hard = true;
    await assert.rejects(projection.refresh(), error => error instanceof Error
      && !(error instanceof ExecutionProjectionChanged) && error.message === 'Runtime projection refresh failed');
    assert.equal(reads, 2); assert.throws(projection.assertCurrent);
  } finally { await projection.close(); }
});

test('whole runtime projection merges a fresh successor and never certifies a partial fragment', async () => {
  const held = gate(); let first = 0, second = 0;
  const projection = createAsyncRuntimeProjection([async () => { if (++first === 1) await held.promise; }, async () => { second++; }]);
  try {
    assert.throws(projection.assertCurrent);
    const original = projection.refresh(); await tick();
    const fresh = projection.refresh(); assert.equal(original, fresh);
    held.resolve(); await fresh;
    assert.equal(first, 2); assert.equal(second, 2); projection.assertCurrent();
    await projection.refresh({ maxAgeMs: 60_000 }); assert.equal(first, 2);
  } finally { held.resolve(); await projection.close(); }
});

test('failed fragment retains all physical siblings and close cannot be hidden by Promise.then', async () => {
  const held = gate(), entered = gate(); let completed = false, closed = false;
  const projection = createAsyncRuntimeProjection([async () => { throw Error('synthetic'); },
    async () => { entered.resolve(); await held.promise; completed = true; }]);
  const work = projection.refresh(); void work.catch(() => {}); await entered.promise;
  Object.defineProperty(work, 'then', { value: undefined });
  const closing = projection.close().then(() => { closed = true; });
  try {
    await tick(); assert.equal(closed, false); assert.equal(completed, false);
    assert.throws(projection.assertCurrent); await assert.rejects(projection.refresh());
    held.resolve(); await assert.rejects(async () => { await work; }); await closing;
    assert.equal(completed, true); assert.equal(closed, true);
  } finally { held.resolve(); await closing; }
});

test('failed scans never become ready and a later explicit scan uses all original fragments', async () => {
  let failed = true, reads = 0;
  const projection = createAsyncRuntimeProjection([async () => { reads++; if (failed) throw Error('synthetic'); }]);
  try {
    await assert.rejects(projection.refresh()); assert.throws(projection.assertCurrent);
    failed = false; await projection.refresh(); assert.equal(reads, 2); projection.assertCurrent();
  } finally { await projection.close(); }
});
