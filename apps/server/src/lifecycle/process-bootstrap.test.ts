import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { bootstrapProcess, type ProcessListener } from './process-bootstrap.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { StartupApplicationCleanup } from './startup-cleanup.js';

class Listener extends EventEmitter implements ProcessListener {
  listening = true;
  calls = 0;
  idleCalls = 0;
  hold = false;
  error?: NodeJS.ErrnoException;
  idleError = false;
  callback?: (error?: Error) => void;
  close(callback: (error?: Error) => void) {
    this.calls++; this.callback = callback;
    if (!this.hold) this.ack();
    return this;
  }
  ack() { this.listening = false; this.callback?.(this.error); }
  closeIdleConnections() { this.idleCalls++; if (this.idleError) throw Error('private idle pruning'); }
}
function setup(fail = 0) {
  const calls: number[] = [], exits: number[] = [], logs: Record<string, unknown>[] = [];
  const main = new Listener(), website = new Listener();
  let appClose = 0, socketsClose = 0, retainedClose = 0;
  const stage = (step: number) => { calls.push(step); if (step === fail) throw Error('private startup details'); };
  const p = bootstrapProcess({
    loadConfig: () => { stage(1); return {}; }, createApplication: () => { stage(2); return {}; },
    applicationOwner: () => ({ close: () => { appClose++; } }),
    mainListener: () => { stage(3); return main; }, websiteListener: () => { stage(4); return website; },
    websiteSockets: () => { stage(5); return { close: () => { socketsClose++; } }; },
    failedApplicationOwner: { close: () => { retainedClose++; } }, keepAlive: false,
    onClosed: code => exits.push(code), diagnostics: new PerformanceDiagnostics(line => logs.push(JSON.parse(line))),
  });
  return { p, main, website, calls, exits, logs, counts: () => ({ appClose, socketsClose, retainedClose }) };
}

for (const failure of [1, 2, 3, 4, 5]) test(`startup stage ${failure} failure drains only returned owners without factory replay`, async () => {
  const s = setup(failure); assert.equal(await s.p.shutdown(1), true);
  assert.deepEqual(s.calls, Array.from({ length: failure }, (_, i) => i + 1));
  assert.equal(s.counts().retainedClose, 1); assert.equal(s.counts().appClose, Number(failure >= 3));
  assert.equal(s.main.calls, Number(failure >= 4)); assert.equal(s.website.calls, Number(failure >= 5));
  assert.equal(s.counts().socketsClose, 0); assert.deepEqual(s.exits, [1]);
  assert.ok(s.logs.some(log => log.operation === 'process-startup' && log.step === failure && log.unknown === 1));
  assert.equal(JSON.stringify(s.logs).includes('private startup details'), false);
});

test('listener errors remain consumed while draining, even after its first error', async () => {
  const s = setup(); s.main.hold = true;
  s.main.emit('error', Error('private address 1')); s.main.emit('error', Error('private address 2'));
  assert.equal(s.main.calls, 1); assert.equal(s.website.calls, 1); assert.equal(s.counts().appClose, 1);
  const close = s.p.shutdown(); assert.deepEqual(s.exits, []); s.main.ack();
  assert.equal(await close, true); assert.deepEqual(s.exits, [1]); assert.equal(s.main.listenerCount('error'), 0);
});

test('idle-pruning failure never replaces the original listener close ACK', async () => {
  const s = setup(); s.main.idleError = true; s.main.hold = true;
  const close = s.p.shutdown(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(s.exits, []); assert.equal(s.main.calls, 1); s.main.ack(); assert.equal(await close, true);
});

test('not-running is acknowledged only for the exact stopped listener', async () => {
  const s = setup(); s.main.error = Object.assign(Error('private bind failure'), { code: 'ERR_SERVER_NOT_RUNNING' });
  assert.equal(await s.p.shutdown(1), true); assert.equal(s.main.calls, 1);
});

test('a not-running error for a listener still claiming to listen is not a cleanup ACK', async () => {
  const s = setup();
  s.main.close = callback => { s.main.calls++; callback(Object.assign(Error('private inconsistent close'), { code: 'ERR_SERVER_NOT_RUNNING' })); return s.main; };
  assert.equal(await s.p.shutdown(), false); assert.deepEqual(s.exits, []);
  assert.equal(s.p.snapshot().pending, 1); assert.equal(s.main.listenerCount('error'), 1);
  s.main.close = Listener.prototype.close.bind(s.main);
  assert.equal(await s.p.shutdown(), true); assert.equal(s.main.calls, 2);
  assert.equal(s.counts().appClose, 1); assert.equal(s.website.calls, 1); assert.deepEqual(s.exits, [1]);
});

test('closing the actual isolated listener before hostname resolution ACK prevents a late listen', async () => {
  const listener = createServer(); let listening = 0;
  listener.on('listening', () => { listening++; });
  listener.listen(0, '127.0.0.1');
  const p = bootstrapProcess({ loadConfig: () => ({}), createApplication: () => ({}),
    applicationOwner: () => ({ close() {} }), mainListener: () => listener,
    websiteListener: () => undefined, websiteSockets: () => { throw Error('no website owner'); },
    failedApplicationOwner: { close() {} }, onClosed() {}, keepAlive: false,
    diagnostics: new PerformanceDiagnostics(() => {}) });
  try {
    assert.equal(await p.shutdown(), true);
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(listener.listening, false); assert.equal(listening, 0);
  } finally { listener.close(); }
});

test('retained failed-startup cleanup retries exact cleanup but never replays its acknowledged drains', async () => {
  let clock = 0, drains = 0, closes = 0;
  const registry = new StartupApplicationCleanup(new PerformanceDiagnostics(() => {}), () => clock);
  registry.abandon([() => { drains++; }], [() => { closes++; if (closes === 1) throw undefined; }]);
  await assert.rejects(registry.closeRetainedOwners()); assert.equal(registry.snapshot().retryable, 1);
  clock = 1000; await registry.closeRetainedOwners(); assert.equal(drains, 1); assert.equal(closes, 2);
  assert.deepEqual(registry.snapshot(), { pending: 0, retryable: 0 });
});

test('failed startup drain stays unknown and cannot become retry evidence', async () => {
  let drains = 0, closes = 0;
  const registry = new StartupApplicationCleanup(new PerformanceDiagnostics(() => {}));
  registry.abandon([() => { drains++; return Promise.reject(undefined); }], [() => { closes++; }]);
  await assert.rejects(registry.closeRetainedOwners()); await assert.rejects(registry.closeRetainedOwners());
  assert.equal(registry.snapshot().pending, 1); assert.equal(registry.snapshot().retryable, 0);
  assert.equal(drains, 1); assert.equal(closes, 0);
});
