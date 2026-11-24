import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadonlyWorkerStop } from './readonly-worker-stop.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('persistent stop refusals retry only the same worker once per cooldown and exit clears the timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0, observations = 0;
  const stop = createReadonlyWorkerStop({ terminate: () => {
    attempts++; return Promise.reject(Error('private-stop-error'));
  } }, () => { observations++; stop.request(); });
  stop.request(); await turn();
  for (let expected = 2; expected <= 4; expected++) {
    stop.request(); t.mock.timers.tick(999); await turn();
    assert.equal(attempts, expected - 1);
    t.mock.timers.tick(1); await turn();
    assert.equal(attempts, expected); assert.equal(observations, expected);
  }
  stop.confirmExit(); t.mock.timers.tick(10000); stop.request(); await turn();
  assert.equal(attempts, 4); assert.equal(observations, 4);
});

test('a throwing refusal observer cannot leave cleanup permanently latched', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const stop = createReadonlyWorkerStop({ terminate: () => {
    if (++attempts === 1) throw Error('private-stop-error');
    return Promise.resolve(1);
  } }, () => { throw Error('private-sink-error'); });
  assert.doesNotThrow(() => stop.request());
  t.mock.timers.tick(1000); await turn(); assert.equal(attempts, 2);
  t.mock.timers.tick(10000); await turn(); assert.equal(attempts, 2);
  stop.confirmExit();
});

test('exit reentry during refusal observation cannot schedule another stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const stop = createReadonlyWorkerStop({ terminate: () => {
    attempts++; throw Error('private-stop-error');
  } }, () => { stop.confirmExit(); stop.request(); });
  stop.request(); t.mock.timers.tick(10000); await turn(); assert.equal(attempts, 1);
});

test('a late stop rejection after actual exit does not restart cleanup or report unknown disposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reject!: (error: Error) => void, attempts = 0, observations = 0;
  const original = new Promise<number>((_, no) => { reject = no; });
  const stop = createReadonlyWorkerStop({ terminate: () => { attempts++; return original; } }, () => { observations++; });
  stop.request(); stop.confirmExit(); reject(Error('private-stop-error')); await turn();
  t.mock.timers.tick(10000); stop.request(); await turn();
  assert.equal(attempts, 1); assert.equal(observations, 0);
});

test('pending and fulfilled termination requests are not replayed as substitutes for physical exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve!: (code: number) => void, attempts = 0;
  const original = new Promise<number>(yes => { resolve = yes; });
  const stop = createReadonlyWorkerStop({ terminate: () => { attempts++; return original; } }, () => assert.fail('No refusal'));
  stop.request(); t.mock.timers.tick(10000); stop.request(); await turn(); assert.equal(attempts, 1);
  resolve(1); await turn(); t.mock.timers.tick(10000); stop.request();
  assert.equal(attempts, 1); stop.confirmExit();
});

test('clean physical exit never dispatches an unnecessary termination request', () => {
  const stop = createReadonlyWorkerStop({ terminate: () => assert.fail('Exited worker must not be stopped') }, () => assert.fail('No refusal'));
  stop.confirmExit(); stop.request(); stop.confirmExit();
});
