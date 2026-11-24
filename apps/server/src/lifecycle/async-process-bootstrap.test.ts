import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapAsyncProcess, type AsyncProcessBootstrapOptions } from './async-process-bootstrap.js';
import type { ProcessListener } from './process-bootstrap.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { StartupApplicationCleanup } from './startup-cleanup.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { HubStore } from '../hub/hub-store.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class Listener extends EventEmitter implements ProcessListener {
  listening = true;
  calls = 0;
  hold = false;
  idleError = false;
  error?: NodeJS.ErrnoException;
  callback?: (error?: Error) => void;
  close(callback: (error?: Error) => void) {
    this.calls++; this.callback = callback;
    if (!this.hold) this.ack();
    return this;
  }
  ack() { this.listening = false; this.callback?.(this.error); }
  closeIdleConnections() { if (this.idleError) throw Error('private idle pruning'); }
}
type App = { tag: string };
function fixture(overrides: Partial<AsyncProcessBootstrapOptions<object, App>> = {}, failure = 0) {
  const calls: number[] = [], exits: number[] = [], logs: Record<string, unknown>[] = [];
  const closed: string[] = [], main = new Listener(), website = new Listener();
  const stage = (value: number) => { calls.push(value); if (value === failure) throw Error('private constructor body'); };
  const bootstrap = bootstrapAsyncProcess({
    loadConfig: () => { stage(1); return {}; },
    createApplication: () => { stage(2); return { tag: 'original' }; },
    applicationOwner: () => ({ close() { closed.push('application'); } }),
    mainListener: () => { stage(3); return main; },
    websiteListener: () => { stage(4); return website; },
    websiteSockets: () => { stage(5); return { close() { closed.push('sockets'); } }; },
    failedApplicationOwner: { close() { closed.push('retained'); } },
    diagnostics: new PerformanceDiagnostics(line => logs.push(JSON.parse(line))),
    onClosed: code => exits.push(code), keepAlive: false,
    ...overrides,
  });
  return { ...bootstrap, calls, exits, logs, closed, main, website };
}

test('factories defer until signal handlers can attach and preserve original shutdown order', async () => {
  const f = fixture(); assert.deepEqual(f.calls, []);
  assert.equal(await f.ready, true); assert.deepEqual(f.calls, [1, 2, 3, 4, 5]);
  assert.equal(await f.lifetime.shutdown(), true);
  assert.deepEqual(f.closed, ['sockets', 'application', 'retained']);
  assert.equal(f.main.calls, 1); assert.equal(f.website.calls, 1); assert.deepEqual(f.exits, [0]);
  assert.ok(f.logs.some(log => log.operation === 'process-startup' && log.settled === 1));
});

test('immediate shutdown prevents even configuration and application construction', async () => {
  const f = fixture(); const close = f.lifetime.shutdown();
  assert.equal(await f.ready, false); assert.equal(await close, true);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.closed, ['retained']);
  assert.equal(f.main.calls, 0); assert.deepEqual(f.exits, [0]);
});

test('after readiness shutdown fences returned owners synchronously before yielding', async () => {
  const f = fixture(); assert.equal(await f.ready, true);
  const close = f.lifetime.shutdown();
  assert.equal(f.main.calls, 1); assert.equal(f.website.calls, 1);
  assert.deepEqual(f.closed, ['sockets', 'application', 'retained']);
  assert.equal(await close, true);
});

test('pending original factory blocks ingress and signal exit retains its late returned owner', async () => {
  const original = deferred<App>(); let creates = 0;
  const f = fixture({ createApplication: () => { creates++; return original.promise; } });
  await tick(); assert.deepEqual(f.calls, [1]);
  const close = f.lifetime.shutdown(); assert.equal(close, f.lifetime.shutdown());
  await tick(); assert.deepEqual(f.closed, []); assert.deepEqual(f.exits, []);
  assert.equal(f.lifetime.snapshot().pending, 5);
  original.resolve({ tag: 'original' });
  assert.equal(await f.ready, false); assert.equal(await close, true);
  assert.equal(creates, 1); assert.deepEqual(f.calls, [1]);
  assert.deepEqual(f.closed, ['application', 'retained']); assert.equal(f.main.calls, 0);
});

test('a pending async factory becomes ready before any listener or socket factory', async () => {
  const original = deferred<App>();
  const f = fixture({ createApplication: () => original.promise });
  await tick(); assert.deepEqual(f.calls, [1]);
  original.resolve({ tag: 'original' }); assert.equal(await f.ready, true);
  assert.deepEqual(f.calls, [1, 3, 4, 5]); assert.equal(await f.lifetime.shutdown(), true);
});

for (const failure of [1, 2, 3, 4, 5]) test(`async startup stage ${failure} failure retains resources without replay`, async () => {
  const f = fixture({}, failure);
  assert.equal(await f.ready, false); assert.equal(await f.lifetime.shutdown(1), true);
  assert.deepEqual(f.calls, Array.from({ length: failure }, (_, index) => index + 1));
  assert.equal(f.closed.includes('application'), failure >= 3);
  assert.equal(f.main.calls, Number(failure >= 4)); assert.equal(f.website.calls, Number(failure >= 5));
  assert.ok(f.logs.some(log => log.operation === 'process-startup' && log.step === failure && log.unknown === 1));
  assert.doesNotMatch(JSON.stringify(f.logs), /private constructor body/); assert.deepEqual(f.exits, [1]);
});

test('late async rejection retains partial original cleanup and consumes thrown undefined', async () => {
  const original = deferred<App>(); const registry = new StartupApplicationCleanup(new PerformanceDiagnostics(() => {}));
  let drains = 0, cleanups = 0;
  const f = fixture({ createApplication: async () => {
    try { return await original.promise; } catch (error) {
      registry.abandon([() => { drains++; }], [() => { cleanups++; }]); throw error;
    }
  }, failedApplicationOwner: { close: () => registry.closeRetainedOwners(),
    canRetry: () => registry.snapshot().retryable > 0 } });
  await tick(); const close = f.lifetime.shutdown(); await tick();
  assert.equal(cleanups, 0); assert.deepEqual(f.exits, []);
  original.reject(undefined);
  assert.equal(await f.ready, false); assert.equal(await close, true);
  assert.equal(drains, 1); assert.equal(cleanups, 1); assert.deepEqual(f.exits, [1]);
});

for (const during of ['applicationOwner', 'mainListener', 'websiteListener', 'websiteSockets'] as const) {
  test(`reentrant shutdown in ${during} never abandons a returned resource`, async () => {
    let f: ReturnType<typeof fixture>;
    const override = during === 'applicationOwner'
      ? { applicationOwner: () => { void f.lifetime.shutdown(); return { close() { f.closed.push('application'); } }; } }
      : during === 'mainListener'
        ? { mainListener: () => { void f.lifetime.shutdown(); return f.main; } }
        : during === 'websiteListener'
          ? { websiteListener: () => { void f.lifetime.shutdown(); return f.website; } }
          : { websiteSockets: () => { void f.lifetime.shutdown(); return { close() { f.closed.push('sockets'); } }; } };
    f = fixture(override);
    assert.equal(await f.ready, false); assert.equal(await f.lifetime.shutdown(), true);
    assert.equal(f.main.calls, Number(during !== 'applicationOwner'));
    assert.equal(f.website.calls, Number(during === 'websiteListener' || during === 'websiteSockets'));
    assert.equal(f.closed.includes('application'), true);
    assert.equal(f.closed.includes('sockets'), during === 'websiteSockets');
  });
}

test('listener registration hook failure still retains the returned listener close owner', async () => {
  const listener = new Listener(); listener.on = () => { throw Error('private registration'); };
  const f = fixture({ mainListener: () => listener });
  assert.equal(await f.ready, false); assert.equal(await f.lifetime.shutdown(1), true);
  assert.equal(listener.calls, 1); assert.deepEqual(f.exits, [1]);
});

test('listener error while its close is pending stays consumed until exact close ACK', async () => {
  const f = fixture(); assert.equal(await f.ready, true); f.main.hold = true;
  f.main.emit('error', Error('private error 1')); f.main.emit('error', Error('private error 2'));
  const close = f.lifetime.shutdown(); await tick();
  assert.equal(f.main.calls, 1); assert.equal(f.main.listenerCount('error'), 1); assert.deepEqual(f.exits, []);
  f.main.ack(); assert.equal(await close, true); assert.equal(f.main.listenerCount('error'), 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /private error/); assert.deepEqual(f.exits, [1]);
});

test('listener unknown close retries only the original close and never reopens ingress', async () => {
  const f = fixture(); assert.equal(await f.ready, true);
  f.main.close = callback => { f.main.calls++; callback(Object.assign(Error('private inconsistent listener'),
    { code: 'ERR_SERVER_NOT_RUNNING' })); return f.main; };
  assert.equal(await f.lifetime.shutdown(), false); assert.equal(f.lifetime.snapshot().pending, 1);
  f.main.close = Listener.prototype.close.bind(f.main);
  assert.equal(await f.lifetime.shutdown(), true); assert.equal(f.main.calls, 2);
  assert.deepEqual(f.calls, [1, 2, 3, 4, 5]); assert.deepEqual(f.closed, ['sockets', 'application', 'retained']);
});

test('idle pruning failure cannot replace a pending native listener close ACK', async () => {
  const f = fixture(); assert.equal(await f.ready, true); f.main.hold = true; f.main.idleError = true;
  const close = f.lifetime.shutdown(); await tick(); assert.deepEqual(f.exits, []);
  f.main.ack(); assert.equal(await close, true); assert.equal(f.main.calls, 1);
});

test('original application close rejection is retained and is not retried without its explicit proof', async () => {
  let attempts = 0, retryable = false;
  const f = fixture({ applicationOwner: () => ({ close() { attempts++; if (attempts === 1) throw undefined; },
    canRetry: () => retryable }) });
  assert.equal(await f.ready, true); assert.equal(await f.lifetime.shutdown(), false);
  assert.equal(await f.lifetime.shutdown(), false); assert.equal(attempts, 1);
  retryable = true; assert.equal(await f.lifetime.shutdown(), true); assert.equal(attempts, 2);
  assert.deepEqual(f.calls, [1, 2, 3, 4, 5]); assert.deepEqual(f.exits, [1]);
});

test('startup pending warnings do not release/replay factory, even when diagnostic sink throws', async () => {
  const original = deferred<App>(); let creates = 0, observations = 0;
  const f = fixture({ warningMs: 2, createApplication: () => { creates++; return original.promise; },
    diagnostics: new PerformanceDiagnostics(() => { observations++; throw Error('private broken sink'); }) });
  await new Promise<void>(resolve => setTimeout(resolve, 15));
  assert.equal(creates, 1); assert.deepEqual(f.calls, [1]); assert.deepEqual(f.exits, []);
  const close = f.lifetime.shutdown(); original.resolve({ tag: 'original' });
  assert.equal(await f.ready, false); assert.equal(await close, true); assert.ok(observations > 0);
});

test('a missing website never constructs sockets; native isolated listener closes before late listen', async () => {
  const listener = createServer(); let sockets = 0, listening = 0;
  listener.on('listening', () => { listening++; });
  const f = fixture({ mainListener: () => { listener.listen(0, '127.0.0.1'); return listener; },
    websiteListener: () => undefined, websiteSockets: () => { sockets++; throw Error('unexpected sockets'); } });
  try {
    assert.equal(await f.ready, true); assert.equal(await f.lifetime.shutdown(), true);
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(listener.listening, false); assert.equal(listening, 0); assert.equal(sockets, 0);
  } finally { listener.close(); }
});

test('real worker readiness and acknowledged shutdown preserve original database for reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'async-process-owner-')), file = join(root, 'hub.sqlite');
  const silence = new PerformanceDiagnostics(() => {});
  let worker: AsyncHubMemberOwner | undefined, closes = 0;
  const bootstrap = bootstrapAsyncProcess({
    loadConfig: () => ({}), createApplication: async () => {
      worker = new AsyncHubMemberOwner({ file, encryptionSecret: 'private-fixture-vault' }, silence);
      await worker.open(); return worker;
    }, applicationOwner: owner => ({ close: async () => { closes++; await owner.close(); } }),
    mainListener: () => new Listener(), websiteListener: () => undefined,
    websiteSockets: () => { throw Error('no website'); },
    failedApplicationOwner: { close: async () => { if (!closes) await worker?.close(); } },
    onClosed() {}, diagnostics: silence, keepAlive: false,
  });
  try {
    assert.equal(await bootstrap.ready, true); assert.ok(worker);
    assert.equal(await bootstrap.lifetime.shutdown(), true);
    assert.equal(worker.snapshot().ownerExitConfirmed, true); assert.equal(closes, 1);
    const original = new HubStore(file, 'private-fixture-vault');
    try { assert.equal(original.identities.hasKeys(), false); } finally { await original.close(); }
  } finally { await bootstrap.lifetime.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
