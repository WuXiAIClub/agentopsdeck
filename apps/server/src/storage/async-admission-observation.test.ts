import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { CommandReceipts } from '../commands/receipts.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { NativeTokenUsageStore } from '../connector/native-token-usage.js';
import { NativeTokenSnapshotStore } from '../connector/native-token-snapshots.js';
import { UsageManifests, usageSelection } from '../hub/usage-manifests.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';

const operations = {
  receipt: 'command-receipt-admission', queue: 'turn-queue-admission',
  snapshot: 'native-token-snapshot-admission', manifest: 'usage-manifest-admission',
} as const;
type Kind = keyof typeof operations;
type Admission = <T>(bytes: number, write: () => Promise<T>) => Promise<T>;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function original(t: TestContext, kind: Kind, admission: Admission, diagnostics: PerformanceDiagnostics) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  if (kind === 'receipt') {
    const store = new CommandReceipts(db, undefined, undefined, undefined, undefined, diagnostics, admission);
    return { db, inspect: () => store.get('synthetic-scope', 'original'), pending: store.claimAsync('synthetic-scope', 'original', {}) };
  }
  if (kind === 'queue') {
    const store = new TurnQueue(db, undefined, undefined, undefined, undefined, undefined, admission, diagnostics);
    return { db, inspect: () => store.head('codex', 'codex:synthetic'),
      pending: store.enqueueAsync('codex', { id: 'original', sessionKey: 'codex:synthetic', createdAt: 1000, payload: {} }) };
  }
  if (kind === 'snapshot') {
    t.mock.method(performanceDiagnostics, 'start', diagnostics.start.bind(diagnostics));
    const ledger = new NativeTokenUsageStore(db, () => 1000), store = new NativeTokenSnapshotStore(db, () => 1000, undefined, admission);
    const selection = { runtime: 'codex' as const, key: 'codex:synthetic', requestId: randomUUID(), from: 0, to: 60000, bucketMs: 60000 };
    return { db, inspect: () => store.read(selection.runtime, selection.key, selection.requestId),
      pending: store.createAsync(selection, () => ledger.export(selection.runtime, selection.key, selection.from, selection.to, selection.bucketMs)) };
  }
  const store = new UsageManifests(db, () => true, () => 1000, undefined, diagnostics, admission);
  const selection = usageSelection({ requestId: randomUUID(), from: 0, to: 60000, bucketMs: 60000, tags: [], tagMode: 'all' });
  return { db, inspect: () => store.read('synthetic-owner', selection.requestId),
    pending: store.prepareAsync('synthetic-owner', selection, 'directory', []) };
}

for (const kind of Object.keys(operations) as Kind[]) {
  for (const waitAfter of [false, true]) {
    test(`${kind} pending ${waitAfter ? 'release ACK' : 'admission'} observation cannot settle or replay original SQL`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const held = gate(), logs: Record<string, unknown>[] = []; let writes = 0, settled = false;
      const admission: Admission = async (_bytes, write) => {
        if (!waitAfter) await held.promise;
        writes++; const result = await write();
        if (waitAfter) await held.promise;
        return result;
      };
      const f = original(t, kind, admission, new PerformanceDiagnostics(line => logs.push(JSON.parse(line)), () => 100));
      const pending = f.pending.then(value => { settled = true; return value; });
      try {
        await flush(); t.mock.timers.tick(30000); await flush();
        assert.equal(settled, false); assert.equal(writes, Number(waitAfter));
        assert.equal(f.db.isTransaction, false); assert.equal(!!f.inspect(), waitAfter);
        const observations = logs.filter(row => row.operation === operations[kind] && row.phase === 'pending');
        assert.equal(observations.length, 1);
        const observation = observations[0]!;
        assert.equal(observation.step, waitAfter ? 3 : 1); assert.equal(observation.unknown, Number(waitAfter));
        assert.equal(observation.category, 'failed');
        const state = f.inspect(); t.mock.timers.tick(60000); await flush();
        assert.equal(settled, false); assert.equal(writes, Number(waitAfter)); assert.deepEqual(f.inspect(), state);
        assert.equal(logs.filter(row => row.operation === operations[kind] && row.phase === 'pending').length, 1);
        held.release(); await pending;
        assert.equal(writes, 1); assert.ok(f.inspect());
        const final = logs.find(row => row.operation === operations[kind] && row.phase === 'finished');
        assert.equal(final?.sequence, observation.sequence); assert.equal(final?.instance, observation.instance);
        const count = logs.length; t.mock.timers.tick(60000); assert.equal(logs.length, count);
        assert.equal(JSON.stringify(logs).includes('synthetic'), false);
      } finally { held.release(); await pending; }
    });
  }
  test(`${kind} throwing pending observation sink never changes write or admission result`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const held = gate(); let writes = 0;
    const admission: Admission = async (_bytes, write) => { await held.promise; writes++; return write(); };
    const f = original(t, kind, admission, new PerformanceDiagnostics(() => { throw Error('synthetic observation sink'); }, () => 100));
    try {
      await flush(); t.mock.timers.tick(30000); assert.equal(writes, 0); assert.equal(f.db.isTransaction, false);
      held.release(); await f.pending; assert.equal(writes, 1); assert.ok(f.inspect());
    } finally { held.release(); await f.pending; }
  });
}
