import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { PerformanceDiagnostics, type PerformanceTrace } from '../diagnostics/performance.js';
import { AuthPersistenceError } from './private-store.js';
import { AuthRoutePersistence } from './route-persistence.js';
import { AsyncSqliteAuthOwner } from './async-sqlite-owner.js';
import { createDeckSession } from './passkeys.js';

type Fault = 'start' | 'add' | 'reportPending' | 'finish';
class FailingObservation extends PerformanceDiagnostics {
  calls = 0;
  constructor(private readonly fault: Fault) { super(() => {}); }
  override start(): PerformanceTrace {
    const fail = (phase: Fault) => { if (phase === this.fault) { this.calls++; throw Error('private-observer-failure'); } };
    fail('start');
    return { add: () => fail('add'), reportPending: () => fail('reportPending'), finish: () => fail('finish') };
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

for (const fault of ['start', 'add', 'reportPending', 'finish'] as const) {
  test(`observer ${fault} failure cannot change the original successful result or leak its reservation`, async () => {
    const diagnostics = new FailingObservation(fault), port = new AuthRoutePersistence(diagnostics, 2);
    const original = deferred<boolean>();
    let calls = 0, finished = false;
    const pending = port.run(4, () => { calls++; return original.promise; });
    void pending.then(() => { finished = true; });
    await delay(12);
    assert.equal(port.pending, 1); assert.equal(calls, 1); assert.equal(finished, false);
    original.resolve(false);
    assert.deepEqual(await pending, { value: false });
    assert.equal(port.pending, 0); assert.equal(calls, 1); assert.ok(diagnostics.calls > 0);
    assert.deepEqual(await port.run(4, () => true), { value: true });
    assert.equal(port.pending, 0);
  });
  test(`observer ${fault} failure cannot conceal an unknown original mutation or cause a retry`, async () => {
    const port = new AuthRoutePersistence(new FailingObservation(fault), 2);
    let calls = 0;
    await assert.rejects(port.run(4, async () => {
      calls++; await delay(12); throw Error('private-original-mutation-outcome');
    }), error => error instanceof AuthPersistenceError && error.message === 'auth_persistence_failed');
    assert.equal(calls, 1); assert.equal(port.pending, 0);
    // Only original Promise settlement is observed here, not an SQL rollback.
  });
}

for (const fault of ['start', 'add', 'finish'] as const) {
  test(`observer ${fault} failure cannot dispatch on explicit missing-proof refusal`, () => {
    const port = new AuthRoutePersistence(new FailingObservation(fault));
    assert.throws(() => port.refuse(6), AuthPersistenceError);
    assert.equal(port.pending, 0);
  });
  test(`observer ${fault} failure cannot overfill, prematurely release or permanently exhaust the 256 slots`, async () => {
    const port = new AuthRoutePersistence(new FailingObservation(fault));
    const held = deferred<boolean>();
    const originals = Array.from({ length: 256 }, () => port.run(6, () => held.promise));
    let excess = 0;
    try {
      assert.equal(port.pending, 256);
      await assert.rejects(port.run(6, () => { excess++; return true; }), AuthPersistenceError);
      assert.equal(excess, 0); assert.equal(port.pending, 256);
    } finally { held.resolve(true); await Promise.all(originals); }
    assert.equal(port.pending, 0);
    assert.deepEqual(await port.run(6, () => true), { value: true });
  });
}

test('diagnostic failure preserves a real complete async auth owner session transaction, single issue and exact final read', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-auth-observation-')); chmodSync(dir, 0o700);
  const digest = createHash('sha256').update('disposable-observation-fixture-key').digest('hex');
  const owner = new AsyncSqliteAuthOwner({ file: join(dir, 'auth.sqlite'), legacyFiles: [], accessKeyDigest: digest },
    new PerformanceDiagnostics(() => {}));
  t.after(async () => { await owner.closeForShutdown(); rmSync(dir, { recursive: true, force: true }); });
  await owner.open();
  const port = new AuthRoutePersistence(new FailingObservation('finish'));
  const token = createDeckSession();
  let issues = 0;
  await port.run(4, () => {
    issues++; return owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: digest } });
  });
  assert.equal(issues, 1); assert.equal(port.pending, 0);
  assert.equal((await port.run(6, () => owner.command('sessionCurrent', { token }))).value, true);
  assert.equal(owner.snapshot().pending, 0); assert.equal(owner.snapshot().unavailable, false);
  assert.equal(owner.snapshot().ownerExitConfirmed, false);
  assert.equal(await owner.command('deleteSession', { token }), true);
  assert.equal((await port.run(6, () => owner.command('sessionCurrent', { token }))).value, false);
  assert.equal(issues, 1);
});
