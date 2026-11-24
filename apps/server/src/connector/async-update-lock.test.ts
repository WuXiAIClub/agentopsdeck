import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncUpdateLockOwner, AsyncUpdateLockCleanup, AsyncUpdateLockRecovery, UpdateLockBusy,
  type OriginalUpdateLockOwner } from './async-update-lock.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
const silent = new PerformanceDiagnostics(() => {});
class FakeWorker extends EventEmitter {
  messages: unknown[] = [];
  terminations = 0;
  postMessage(value: unknown) { this.messages.push(value); }
  terminate() { this.terminations++; return Promise.resolve(1); }
}
class HeldOwner implements OriginalUpdateLockOwner {
  exitConfirmed = false;
  retirements = 0;
  resolves = false;
  private resolve!: () => void;
  private readonly exit = new Promise<void>(resolve => { this.resolve = resolve; });
  acquire() { return Promise.resolve(); }
  assertHeld() { if (this.exitConfirmed) throw Error('owner lost'); }
  retire() { this.retirements++; }
  waitForExit() { return this.resolves ? Promise.resolve() : this.exit; }
  exitNow() { this.exitConfirmed = true; this.resolve(); }
}
test('lock worker ready is admission evidence but close ACK and fulfilled termination are never physical exit', async () => {
  const fake = new FakeWorker(), owner = new AsyncUpdateLockOwner('/synthetic/never-opened', silent, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'acquired' }); await owner.acquire(); owner.assertHeld();
  let releases = 0;
  const cleanup = new AsyncUpdateLockCleanup([owner], () => { releases++; }, silent, 1);
  assert.equal(await cleanup.run(), false); assert.equal(releases, 0); assert.equal(owner.exitConfirmed, false);
  assert.throws(() => owner.assertHeld(), /unavailable/);
  assert.deepEqual(fake.messages, ['close']);
  fake.emit('message', { kind: 'closed' }); // Invalid ACK only requests original retirement.
  assert.equal(await cleanup.run(), false); assert.equal(releases, 0);
  fake.emit('exit', 0);
  assert.equal(await cleanup.run(), true); assert.equal(releases, 1);
  assert.equal(await cleanup.run(), true); assert.equal(releases, 1);
});
test('malformed acquisition, worker error and numeric busy classification do not grant lock authority', async () => {
  for (const message of [{ kind: 'acquired', path: '/secret' }, { kind: 'failed', busy: 'true' }, { kind: 'failed', busy: true }]) {
    const fake = new FakeWorker(), owner = new AsyncUpdateLockOwner('/unused', silent, () => fake as unknown as Worker);
    fake.emit('message', message);
    await assert.rejects(owner.acquire(), message.busy === true ? UpdateLockBusy : /unavailable/);
    assert.throws(() => owner.assertHeld(), /unavailable/); assert.equal(owner.exitConfirmed, false);
    fake.emit('exit', 1); await owner.waitForExit(); assert.equal(owner.exitConfirmed, true);
  }
  const fake = new FakeWorker(), owner = new AsyncUpdateLockOwner('/unused', silent, () => fake as unknown as Worker);
  fake.emit('error', Error('secret')); await assert.rejects(owner.acquire(), /unavailable/);
  fake.emit('exit', 1); await owner.waitForExit();
});
test('unexpected physical lock worker exit invalidates ready owner health', async () => {
  const fake = new FakeWorker(), owner = new AsyncUpdateLockOwner('/unused', silent, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'acquired' }); await owner.acquire(); owner.assertHeld();
  fake.emit('exit', 0); assert.throws(() => owner.assertHeld(), /unavailable/);
  owner.retire(); assert.deepEqual(fake.messages, []);
});
test('missing lock readiness becomes unknown without granting replacement or accepting fulfilled termination', async () => {
  const fake = new FakeWorker();
  fake.postMessage = () => { throw Error('lost close transport'); };
  const owner = new AsyncUpdateLockOwner('/unused', silent, () => fake as unknown as Worker, 1);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(owner.acquire(), /unavailable/);
    assert.equal(fake.terminations, 1);
    assert.equal(owner.exitConfirmed, false, 'fulfilled termination is not physical exit');
    fake.emit('message', { kind: 'acquired' }); assert.throws(() => owner.assertHeld(), /unavailable/);
    let released = 0;
    const cleanup = new AsyncUpdateLockCleanup([owner], () => { released++; }, silent, 1);
    assert.equal(await cleanup.run(), false); assert.equal(released, 0);
    fake.emit('exit', 1);
    assert.equal(await cleanup.run(), true); assert.equal(released, 1);
  } finally { clearTimeout(keepAlive); fake.emit('exit', 1); }
});
test('whole lock group remains fenced until every original exit, despite fulfilled waits and cooldown', async () => {
  const first = new HeldOwner(), second = new HeldOwner(); second.resolves = true;
  let released = 0, now = 0;
  const cleanup = new AsyncUpdateLockCleanup([first, second], () => { released++; }, silent, 1);
  const recovery = new AsyncUpdateLockRecovery(() => now);
  first.exitNow(); assert.equal(await cleanup.run(), false); assert.equal(released, 0);
  recovery.retain(['a', 'b'], cleanup);
  assert.equal(await recovery.recover('a'), false);
  now = 1000; assert.equal(await recovery.recover('b'), false); assert.equal(released, 0);
  second.exitNow(); now = 2000;
  assert.equal(await recovery.recover('a'), true); assert.equal(released, 1); assert.equal(recovery.hasPending(), false);
  assert.equal(await recovery.recover('b'), true); assert.equal(released, 1);
});
test('lock cleanup publishes single flight before original callback or diagnostics reentry', async () => {
  const held = new HeldOwner(); held.exitNow(); let releases = 0;
  let cleanup!: AsyncUpdateLockCleanup, nested: Promise<boolean> | undefined;
  cleanup = new AsyncUpdateLockCleanup([held], () => { releases++; nested = cleanup.run(); }, silent, 1);
  const flight = cleanup.run(); assert.equal(cleanup.run(), flight);
  assert.equal(await flight, true); assert.equal(nested, flight); assert.equal(releases, 1);
});
test('async or unknown release cannot be repeated or accepted as lock group settlement', async () => {
  for (const mode of ['async', 'thenable', 'throw'] as const) {
    const held = new HeldOwner(); held.exitNow(); let calls = 0;
    const release = mode === 'async' ? async () => { calls++; }
      : mode === 'thenable' ? () => { calls++; return { then() { assert.fail('thenable must not be called'); } }; }
      : () => { calls++; throw Error('lost release acknowledgement'); };
    const cleanup = new AsyncUpdateLockCleanup([held], release as () => void, silent, 1);
    assert.equal(await cleanup.run(), false); assert.equal(await cleanup.run(), false);
    assert.equal(calls, mode === 'async' ? 0 : 1);
  }
});
test('lock cleanup diagnostics failure cannot prevent original retirement and release', async () => {
  const held = new HeldOwner(); held.exitNow(); let releases = 0;
  const broken = new PerformanceDiagnostics(() => { throw Error('sink failure'); }, () => { throw Error('clock failure'); });
  const cleanup = new AsyncUpdateLockCleanup([held], () => { releases++; }, broken, 1);
  assert.equal(await cleanup.run(), true); assert.equal(releases, 1); assert.equal(held.retirements, 0);
});
test('recovery never revisits an exited original owner while an unresolved peer retires', async () => {
  const exited = new HeldOwner(), pending = new HeldOwner(); exited.exitNow();
  let releases = 0;
  exited.retire = () => { assert.fail('physical exit needs no further retirement'); };
  const cleanup = new AsyncUpdateLockCleanup([exited, pending], () => { releases++; }, silent, 1);
  assert.equal(await cleanup.run(), false); assert.equal(releases, 0);
  assert.equal(pending.retirements, 1);
  pending.exitNow(); assert.equal(await cleanup.run(), true); assert.equal(releases, 1);
  assert.equal(pending.retirements, 1, 'confirmed peer exit is final evidence too');
});
test('real exclusive lock worker retains inode, excludes another process and permits acquisition only after physical exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'async-update-lock-')), file = join(dir, 'lock.sqlite');
  const first = new AsyncUpdateLockOwner(file, silent);
  try {
    await first.acquire(); first.assertHeld();
    const inode = statSync(file).ino;
    // External process exclusion is exercised in update-service.test.ts, not
    // through another same-process descriptor which could release POSIX locks.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      try { db.exec('BEGIN EXCLUSIVE; COMMIT;'); process.exitCode = 2; }
      catch (error) { process.exitCode = (error.errcode & 255) === 5 || (error.errcode & 255) === 6 ? 0 : 3; }
      finally { db.close(); }
    `, file], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null);
    first.retire(); await first.waitForExit(); assert.equal(first.exitConfirmed, true);
    const next = new AsyncUpdateLockOwner(file, silent);
    await next.acquire(); next.assertHeld(); next.retire(); await next.waitForExit();
    assert.equal(statSync(file).ino, inode, 'lock path is never unlinked or replaced');
  } finally {
    first.retire(); await first.waitForExit(); rmSync(dir, { recursive: true, force: true });
  }
});
