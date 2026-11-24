import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaintenanceHostClose } from './maintenance-host-close.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const held = () => {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const silent = () => new PerformanceDiagnostics(() => {});

test('host close retains exact attempt and fences admission before returning', async () => {
  const effect = held(), listener = held(), calls: string[] = [];
  const close = createMaintenanceHostClose({
    stopAdmissions() { calls.push('stop'); },
    closeListener() { calls.push('listener'); return listener.promise; },
    drainWorker() { calls.push('effect'); return effect.promise; },
    async closeJournal() { calls.push('journal'); },
  }, silent());
  const original = close();
  assert.equal(close(), original);
  assert.deepEqual(calls, ['stop', 'listener', 'effect']);
  listener.resolve(); await turn();
  assert.ok(!calls.includes('journal'));
  effect.resolve(); await original;
  assert.deepEqual(calls, ['stop', 'listener', 'effect', 'journal']);
  await close();
  assert.equal(calls.length, 4);
});

for (const synchronous of [true, false]) test(`listener ${synchronous ? 'throw' : 'rejection'} does not omit original effect drain`, async () => {
  const effect = held(), calls: string[] = [], diagnostics = silent();
  let listenerAttempts = 0;
  const close = createMaintenanceHostClose({
    stopAdmissions() { calls.push('stop'); },
    closeListener() {
      calls.push('listener');
      if (++listenerAttempts === 1) {
        if (synchronous) throw Error('private-listener');
        return Promise.reject(Error('private-listener'));
      }
      return Promise.resolve();
    },
    drainWorker() { calls.push('effect'); return effect.promise; },
    async closeJournal() { calls.push('journal'); },
  }, diagnostics);
  const original = close(), rejection = assert.rejects(original);
  assert.equal(close(), original);
  await turn();
  assert.deepEqual(calls, ['stop', 'listener', 'effect']);
  assert.equal(close.snapshot().state, 'draining');
  assert.ok(diagnostics.snapshot().events.some(row => row.operation === 'maintenance-host-close' && row.step === 1 && row.unknown === 1));
  effect.resolve(); await rejection;
  assert.equal(close.snapshot().state, 'cleanup-required');
  assert.ok(!calls.includes('journal'));
  await close();
  assert.deepEqual(calls, ['stop', 'listener', 'effect', 'listener', 'journal']);
  assert.ok(diagnostics.snapshot().events.some(row => row.unknown === 1));
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-listener/);
});

test('pending listener retains the original promise after effect drains and cannot close journal', async () => {
  const listener = held(); let journal = 0, attempts = 0;
  const close = createMaintenanceHostClose({ stopAdmissions() {},
    closeListener() { attempts++; return listener.promise; }, drainWorker: async () => {},
    closeJournal: async () => { journal++; },
  }, silent());
  const original = close(); await turn();
  assert.equal(close(), original); assert.equal(journal, 0); assert.equal(attempts, 1);
  assert.equal(close.snapshot().state, 'cleaning');
  listener.resolve(); await original; assert.equal(journal, 1);
});

test('effect drain failure never retries effects or closes dependent journal', async () => {
  let effects = 0, listeners = 0, journals = 0;
  const close = createMaintenanceHostClose({ stopAdmissions() {},
    closeListener: async () => { listeners++; },
    drainWorker: async () => { effects++; throw Error('private-effect'); },
    closeJournal: async () => { journals++; },
  }, silent());
  await assert.rejects(close()); await assert.rejects(close());
  assert.equal(close.snapshot().state, 'drain-failed');
  assert.equal(effects, 1); assert.equal(listeners, 1); assert.equal(journals, 0);
});

test('journal cleanup refusal retries only exact retained journal after acknowledged drains', async () => {
  let stops = 0, listeners = 0, effects = 0, journals = 0;
  const close = createMaintenanceHostClose({ stopAdmissions() { stops++; },
    closeListener: async () => { listeners++; }, drainWorker: async () => { effects++; },
    closeJournal: async () => { if (++journals === 1) throw Error('private-journal'); },
  }, silent());
  await assert.rejects(close()); await close();
  assert.deepEqual([stops, listeners, effects, journals], [1, 1, 1, 2]);
});

test('synchronous listener reentry receives already-published original close attempt', async () => {
  let reentered: Promise<void> | undefined;
  const close = createMaintenanceHostClose({ stopAdmissions() {},
    closeListener: async () => { reentered = close(); }, drainWorker: async () => {},
    closeJournal: async () => {},
  }, silent());
  const original = close(); assert.equal(reentered, original); await original;
});

test('caller configuration edits cannot substitute retained cleanup owners', async () => {
  let original = 0, replacement = 0;
  const options = { stopAdmissions() {}, closeListener: async () => {}, drainWorker: async () => {},
    closeJournal: async () => { original++; },
  };
  const close = createMaintenanceHostClose(options, silent());
  options.closeJournal = async () => { replacement++; };
  await close(); assert.equal(original, 1); assert.equal(replacement, 0);
});

test('failed diagnostic output cannot prevent same-owner listener cleanup retry', async () => {
  let listeners = 0, effects = 0, journals = 0;
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('private-log-sink'); });
  const close = createMaintenanceHostClose({ stopAdmissions() {},
    closeListener: async () => { if (++listeners === 1) throw Error('private-listener'); },
    drainWorker: async () => { effects++; }, closeJournal: async () => { journals++; },
  }, diagnostics);
  await assert.rejects(close());
  assert.equal(close.snapshot().state, 'cleanup-required');
  await close(); assert.deepEqual([listeners, effects, journals], [2, 1, 1]);
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-/);
});
