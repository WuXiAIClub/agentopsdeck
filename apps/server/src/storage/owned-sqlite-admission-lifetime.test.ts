import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { checkpointOwnedWalAsync } from './owned-sqlite.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
for (const fault of ['rejected', 'uninvoked', 'duplicate', 'forged-result', 'swallowed-write', 'masked-write', 'lost-release', 'detached-sample'] as const) {
  test(`checkpoint admission fences ${fault} and only trusts the original SQL`, async t => {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    const nativePrepare = db.prepare.bind(db), held = gate(), failure = Error('original failure');
    let writes = 0, checks = 0, samples = 0, late!: () => Promise<unknown>, detached!: Promise<unknown>;
    const logs: Record<string, unknown>[] = [];
    t.mock.method(db, 'prepare', (sql: string) => { if (sql === 'PRAGMA wal_checkpoint(PASSIVE)') writes++; return nativePrepare(sql); });
    const pending = checkpointOwnedWalAsync(db, '/nonexistent-checkpoint-lifetime.db', {
      diagnostics: new PerformanceDiagnostics(line => logs.push(JSON.parse(line))),
      check: () => { checks++; },
      sample: async () => {
        samples++;
        if (samples === 2 && (fault === 'swallowed-write' || fault === 'masked-write')) throw failure;
        if (samples === 2 && fault === 'detached-sample') await held.promise;
        return 0;
      },
      admission: async <T>(_root: string, _bytes: number, write: () => Promise<T>): Promise<T> => {
        late = write;
        if (fault === 'rejected') throw failure;
        if (fault === 'uninvoked') return undefined as T;
        if (fault === 'detached-sample') {
          detached = write().catch(error => error);
          await flush();
          return { deferred: false, busy: 999, logFrames: 999, checkpointedFrames: 999 } as T;
        }
        if (fault === 'swallowed-write' || fault === 'masked-write') {
          try { return await write(); } catch {
            if (fault === 'masked-write') throw Error('adapter failure must not replace writer failure');
            return { deferred: true } as T;
          }
        }
        const original = await write();
        if (fault === 'duplicate') return write();
        if (fault === 'lost-release') throw failure;
        if (fault === 'forged-result') return { deferred: false, busy: 999, logFrames: 999, checkpointedFrames: 999 } as T;
        return original;
      },
    });
    if (fault === 'forged-result') {
      const original = await pending;
      assert.equal(original.deferred, false);
      if (!original.deferred) assert.notEqual(original.busy, 999);
    } else if (['rejected', 'swallowed-write', 'masked-write', 'lost-release'].includes(fault)) await assert.rejects(pending, error => error === failure);
    else await assert.rejects(pending);
    const before = { writes, checks, samples, logs: JSON.stringify(logs) };
    assert.equal(writes, ['duplicate', 'forged-result', 'lost-release'].includes(fault) ? 1 : 0);
    await assert.rejects(late(), /admission ended/);
    assert.deepEqual({ writes, checks, samples, logs: JSON.stringify(logs) }, before);
    if (fault === 'detached-sample') {
      held.release();
      assert.match(String(await detached), /admission ended/);
      assert.deepEqual({ writes, checks, samples, logs: JSON.stringify(logs) }, before);
    }
    if (fault === 'duplicate' || fault === 'lost-release') {
      const diagnostic = logs[0]; assert.ok(diagnostic);
      assert.equal(diagnostic.unknown, 1);
    }
    assert.equal(db.isTransaction, false);
  });
}

for (const step of [1, 2, 3, 4]) for (const brokenSink of [false, true]) {
  test(`checkpoint pending phase ${step}${brokenSink ? ' with throwing sink' : ''} is observation, never SQL replay`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    const nativePrepare = db.prepare.bind(db), held = gate();
    let writes = 0, samples = 0, admitted = 0, settled = false;
    const logs: Record<string, unknown>[] = [];
    t.mock.method(db, 'prepare', (sql: string) => { if (sql === 'PRAGMA wal_checkpoint(PASSIVE)') writes++; return nativePrepare(sql); });
    const pending = checkpointOwnedWalAsync(db, '/private/nonexistent-checkpoint-observation.db', {
      diagnostics: new PerformanceDiagnostics(line => { logs.push(JSON.parse(line)); if (brokenSink) throw Error('sink'); }),
      sample: async () => {
        samples++;
        if ((step === 1 && samples === 1) || (step === 3 && samples === 2)) await held.promise;
        return 0;
      },
      admission: async (_root, _bytes, write) => {
        admitted++;
        if (step === 2) await held.promise;
        const original = await write();
        if (step === 4) await held.promise;
        return original;
      },
    }).then(value => { settled = true; return value; });
    await flush();
    t.mock.timers.tick(30_000); await flush();
    assert.equal(settled, false); assert.equal(logs.length, 1);
    const observation = logs[0]; assert.ok(observation);
    assert.equal(observation.operation, 'owned-wal-checkpoint');
    assert.equal(observation.phase, 'pending'); assert.equal(observation.step, step);
    assert.equal(observation.unknown, Number(step === 4));
    assert.equal(writes, Number(step === 4));
    assert.equal(admitted, Number(step !== 1));
    t.mock.timers.tick(30_000); await flush();
    assert.equal(logs.length, 1); assert.equal(writes, Number(step === 4));
    held.release(); assert.equal((await pending).deferred, false);
    assert.equal(writes, 1); assert.equal(logs.length, 2);
    const completion = logs[1]; assert.ok(completion);
    assert.equal(completion.phase, 'finished');
    assert.equal(completion.instance, observation.instance); assert.equal(completion.sequence, observation.sequence);
    assert.doesNotMatch(JSON.stringify(logs), /private|nonexistent|checkpoint-observation|SELECT|PRAGMA/);
    t.mock.timers.tick(30_000); await flush(); assert.equal(logs.length, 2);
  });
}
