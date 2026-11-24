import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { CommandReceipts } from '../commands/receipts.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { NativeTokenUsageStore } from '../connector/native-token-usage.js';
import { NativeTokenSnapshotStore } from '../connector/native-token-snapshots.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';
import { recoverableConnection, retireConnectionForAsyncWork } from './connection-recovery.js';

for (const fault of ['rejected', 'uninvoked', 'duplicate', 'forged-result', 'swallowed-write', 'lost-release'] as const) {
  test(`receipt async API synchronous fallback fences ${fault} and retains original SQL identity`, async t => {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    const failure = Error('synthetic admission rejected'), writeFailure = Error('synthetic request retired');
    let late!: () => unknown, checks = 0, writes = 0;
    const check = () => { if (++checks > 1 && fault === 'swallowed-write') throw writeFailure; };
    const admission = <T>(_bytes: number, write: () => T extends PromiseLike<unknown> ? never : T): T => {
      late = write;
      if (fault === 'rejected') throw failure;
      if (fault === 'uninvoked') return undefined as T;
      if (fault === 'swallowed-write') { assert.throws(write, error => error === writeFailure); return undefined as T; }
      const original = write();
      if (fault === 'lost-release') throw failure;
      if (fault === 'duplicate') assert.throws(write, /already attempted/);
      return fault === 'forged-result' ? { fresh: true, receipt: { id: 'fabricated' } } as T : original;
    };
    const receipts = new CommandReceipts(db, undefined, undefined, undefined, admission, new PerformanceDiagnostics(() => {}));
    const pending = receipts.claimAsync('scope', 'original', {}, false, undefined,
      () => { writes++; return true; }, undefined, false, check);
    if (fault === 'rejected' || fault === 'lost-release') await assert.rejects(pending, error => error === failure);
    else if (fault === 'uninvoked' || fault === 'swallowed-write') await assert.rejects(pending, /not committed/);
    else {
      const result = await pending;
      assert.equal(result.fresh, true);
      assert.deepEqual(result.receipt, receipts.get('scope', 'original'));
      assert.notEqual(result.receipt.id, 'fabricated');
    }
    const original = receipts.get('scope', 'original');
    assert.throws(late, /admission ended/);
    assert.deepEqual(receipts.get('scope', 'original'), original);
    assert.equal(writes, ['duplicate', 'forged-result', 'lost-release'].includes(fault) ? 1 : 0);
    if (original) {
      assert.equal(original.state, 'outcome_unknown');
      assert.equal((await receipts.claimAsync('scope', 'original', {})).fresh, false);
      assert.equal(writes, 1, 'lost release must not replay admission');
    }
  });
}

for (const kind of ['receipt', 'queue', 'snapshot'] as const) {
  for (const fault of ['rejected', 'uninvoked', 'duplicate', 'forged-result', 'swallowed-write'] as const) {
    test(`${kind} admission fences ${fault} adapter callbacks and trusts only original SQL`, async t => {
      const db = new DatabaseSync(':memory:'); t.after(() => db.close());
      const logs: Record<string, unknown>[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
      t.mock.method(performanceDiagnostics, 'start', diagnostics.start.bind(diagnostics));
      const failure = Error('synthetic admission rejected'), writeFailure = Error('synthetic request retired');
      let late!: () => Promise<unknown>, inspect!: () => unknown, checks = 0;
      const check = () => { checks++; if (fault === 'swallowed-write' && checks > 1) throw writeFailure; };
      const admission = async <T>(_bytes: number, write: () => Promise<T>): Promise<T> => {
        late = write;
        if (fault === 'rejected') throw failure;
        if (fault === 'uninvoked') return undefined as T;
        if (fault === 'swallowed-write') { await assert.rejects(write(), error => error === writeFailure); return undefined as T; }
        await write();
        if (fault === 'duplicate') return write();
        return { forged: true } as T;
      };
      let pending: Promise<unknown>;
      if (kind === 'receipt') {
        const receipts = new CommandReceipts(db, undefined, undefined, undefined, undefined, diagnostics, admission);
        inspect = () => receipts.get('scope', 'original');
        pending = receipts.claimAsync('scope', 'original', {}, false, undefined, undefined, undefined, false, check);
      } else if (kind === 'queue') {
        const queue = new TurnQueue(db, undefined, undefined, undefined, undefined, undefined, admission, diagnostics);
        inspect = () => queue.head('codex', 'codex:synthetic');
        pending = queue.enqueueAsync('codex', { id: 'original', sessionKey: 'codex:synthetic', createdAt: 1000, payload: {} }, undefined, check);
      } else {
        const ledger = new NativeTokenUsageStore(db, () => 1000), snapshots = new NativeTokenSnapshotStore(db, () => 1000, undefined, admission);
        const selection = { runtime: 'codex' as const, key: 'codex:synthetic', requestId: randomUUID(), from: 0, to: 60000, bucketMs: 60000 };
        inspect = () => snapshots.read(selection.runtime, selection.key, selection.requestId);
        pending = snapshots.createAsync(selection, () => ledger.export(selection.runtime, selection.key, selection.from, selection.to, selection.bucketMs), check);
      }
      if (fault === 'forged-result') {
        const result = await pending;
        if (kind === 'receipt') assert.deepEqual((result as { receipt: unknown }).receipt, inspect());
        if (kind === 'snapshot') assert.deepEqual(result, inspect());
      } else if (fault === 'rejected') await assert.rejects(pending, error => error === failure);
      else await assert.rejects(pending);
      const state = inspect(), observations = JSON.stringify(logs), checked = checks;
      if (fault === 'duplicate' || fault === 'forged-result') assert.ok(state, 'original write remains authoritative');
      else assert.equal(state == null, true, 'no original write was admitted');
      await assert.rejects(late(), /admission ended/);
      assert.deepEqual(inspect(), state); assert.equal(checks, checked);
      assert.equal(JSON.stringify(logs), observations, 'late callback cannot mutate an already-finished trace');
      assert.equal(db.isTransaction, false);
    });
  }
}

for (const kind of ['receipt', 'queue', 'snapshot'] as const) {
  for (const lifetime of ['closed', 'retired'] as const) {
    test(`${kind} committed admission cannot acknowledge a ${lifetime} original connection`, async t => {
      const raw = new DatabaseSync(':memory:'); t.after(() => { if (raw.isOpen) raw.close(); });
      const logs: Record<string, unknown>[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
      t.mock.method(performanceDiagnostics, 'start', diagnostics.start.bind(diagnostics));
      const db = lifetime === 'retired' ? recoverableConnection(raw, diagnostics) : raw;
      let inspect!: () => unknown, committed: unknown, writes = 0;
      const admission = async <T>(_bytes: number, write: () => Promise<T>) => {
        const result = await write(); writes++; committed = inspect();
        if (lifetime === 'closed') db.close(); else retireConnectionForAsyncWork(db);
        return result;
      };
      let pending: Promise<unknown>;
      if (kind === 'receipt') {
        const receipts = new CommandReceipts(db, undefined, undefined, undefined, undefined, diagnostics, admission);
        inspect = () => receipts.get('scope', 'original'); pending = receipts.claimAsync('scope', 'original', {});
      } else if (kind === 'queue') {
        const queue = new TurnQueue(db, undefined, undefined, undefined, undefined, undefined, admission, diagnostics);
        inspect = () => queue.head('codex', 'codex:synthetic');
        pending = queue.enqueueAsync('codex', { id: 'original', sessionKey: 'codex:synthetic', createdAt: 1000, payload: {} });
      } else {
        const ledger = new NativeTokenUsageStore(db, () => 1000), snapshots = new NativeTokenSnapshotStore(db, () => 1000, undefined, admission);
        const selection = { runtime: 'codex' as const, key: 'codex:synthetic', requestId: randomUUID(), from: 0, to: 60000, bucketMs: 60000 };
        inspect = () => snapshots.read(selection.runtime, selection.key, selection.requestId);
        pending = snapshots.createAsync(selection, () => ledger.export(selection.runtime, selection.key, selection.from, selection.to, selection.bucketMs));
      }
      await assert.rejects(pending);
      assert.equal(writes, 1); assert.ok(committed, 'original durable state was present before owner retirement');
      const operation = { receipt: 'command-receipt-admission', queue: 'turn-queue-admission', snapshot: 'native-token-snapshot-admission' }[kind];
      assert.equal(logs.find(row => row.operation === operation && row.category === 'failed')?.unknown, 1);
    });
  }
}

for (const status of [200, 409]) {
  test(`receipt settled with ${status} during release cannot grant stale dispatch permission`, async t => {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    let receipts!: CommandReceipts, originalId = '', writes = 0, bindings = 0;
    const admission = async <T>(_bytes: number, write: () => Promise<T>) => {
      const result = await write(); writes++;
      originalId = receipts.get('scope', 'original')!.id;
      receipts.settle('scope', 'original', { status, body: { ok: true } });
      return result;
    };
    receipts = new CommandReceipts(db, undefined, undefined, undefined, undefined,
      new PerformanceDiagnostics(() => {}), admission);
    const result = await receipts.claimAsync('scope', 'original', {}, false, undefined,
      undefined, () => { bindings++; return { metadata: { synthetic: true } }; });
    assert.equal(result.fresh, false, 'original-only settlement revokes the stale dispatch permission');
    assert.equal(result.receipt.id, originalId);
    assert.equal(result.receipt.state, status === 200 ? 'accepted' : 'rejected');
    assert.deepEqual(result.receipt, receipts.get('scope', 'original'));
    assert.equal(writes, 1); assert.equal(bindings, 1);
    assert.equal((await receipts.claimAsync('scope', 'original', {})).fresh, false);
    assert.equal(writes, 1); assert.equal(bindings, 1);
  });
}
