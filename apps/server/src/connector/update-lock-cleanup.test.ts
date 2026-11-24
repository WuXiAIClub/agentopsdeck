import assert from 'node:assert/strict';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { closeUpdateLockOwners, UpdateLockCleanup, UpdateLockRecovery } from './update-lock-cleanup.js';

for (const fault of [false, true]) test(`lock cleanup ${fault ? 'uncertainty retains exclusion' : 'success releases after all closes'}`, () => {
  const events: string[] = [], logs: string[] = [];
  const owners = [
    { close() { events.push('first'); } },
    { close() { events.push('second'); if (fault) throw Error('private-file-SQL'); } },
  ];
  assert.equal(closeUpdateLockOwners(owners, () => { events.push('release'); }, new PerformanceDiagnostics(line => logs.push(line))), !fault);
  assert.deepEqual(events, fault ? ['second', 'first'] : ['second', 'first', 'release']);
  assert.equal(owners.length, 2, 'never mutate caller owner inventory');
  assert.doesNotMatch(logs.join('\n'), /private-file|SQL/);
  assert.equal(JSON.parse(logs[0]!).category, fault ? 'failed' : 'routine');
  if (fault) assert.equal(JSON.parse(logs[0]!).unknown, 1);
});

test('throwing diagnostics cannot skip other owner closes or release uncertain locks', () => {
  let closed = 0, released = false;
  assert.equal(closeUpdateLockOwners([{ close() { closed++; } }, { close() { throw Error('private'); } }],
    () => { released = true; }, new PerformanceDiagnostics(() => { throw Error('sink'); })), false);
  assert.equal(closed, 1); assert.equal(released, false);
});

test('lost close acknowledgement can recover only from exact closed owner evidence', () => {
  let released = 0;
  const logs: string[] = [];
  assert.equal(closeUpdateLockOwners([{ isOpen: false, close() { throw Error('lost ack'); } }], () => { released++; },
    new PerformanceDiagnostics(line => logs.push(line))), true);
  assert.equal(released, 1);
  assert.equal(JSON.parse(logs[0]!).recovered, 1);
  assert.equal(JSON.parse(logs[0]!).unknown, 1);
});

test('unavailable closure evidence retains the owner group', () => {
  let released = false;
  assert.equal(closeUpdateLockOwners([{ get isOpen(): boolean { throw Error('unavailable'); }, close() { throw Error('close'); } }],
    () => { released = true; }), false);
  assert.equal(released, false);
});

test('recovery retries only unresolved exact owners after cooldown, never releases on elapsed time alone', () => {
  let now = 0, first = 0, second = 0, released = 0, allowClose = false;
  const cleanup = new UpdateLockCleanup([
    { close() { first++; } },
    { close() { second++; if (!allowClose) throw Error('temporary close failure'); } },
  ], () => { released++; });
  assert.equal(cleanup.run(), false);
  const recovery = new UpdateLockRecovery(() => now);
  recovery.retain(['a', 'b'], cleanup);
  assert.equal(recovery.recover('a'), false);
  now = 1000;
  assert.equal(recovery.recover('b'), false);
  assert.equal(first, 1, 'already confirmed closed owner is never closed again');
  assert.equal(second, 2);
  assert.equal(released, 0);
  allowClose = true;
  assert.equal(recovery.recover('a'), false, 'aliases share the same cooldown');
  now = 2000;
  assert.equal(recovery.recover('a'), true);
  assert.equal(released, 1);
  assert.equal(first, 1);
  assert.equal(second, 3);
  assert.equal(recovery.recover('b'), true, 'whole proven-closed group removed');
  assert.equal(second, 3);
});

test('known async owner close is never invoked or acknowledged', () => {
  let closes = 0, released = 0, peer = 0;
  const cleanup = new UpdateLockCleanup([{ close() { peer++; } }, { async close() { closes++; } }],
    () => { released++; }, new PerformanceDiagnostics(() => {}));
  assert.equal(cleanup.run(), false); assert.equal(cleanup.run(), false);
  assert.equal(closes, 0); assert.equal(released, 0); assert.equal(peer, 1);
});

for (const lateFailure of [false, true]) test(`native close ${lateFailure ? 'rejection' : 'fulfilment'} cannot authorize unlock or replay`, async () => {
  let closes = 0, released = 0, resolve!: () => void, reject!: (error: unknown) => void;
  const original = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const cleanup = new UpdateLockCleanup([{ isOpen: false, close() { closes++; return original; } }],
    () => { released++; }, new PerformanceDiagnostics(() => {}));
  assert.equal(cleanup.run(), false); assert.equal(cleanup.run(), false);
  if (lateFailure) reject(Error('private-close-error')); else resolve();
  // No external catch: the cleanup must observe its native rejected result.
  await new Promise<void>(yes => setImmediate(yes));
  assert.equal(cleanup.run(), false); assert.equal(closes, 1); assert.equal(released, 0);
});

for (const result of [null, 0, false, { get then() { return assert.fail('must not inspect then'); } }]) {
  test(`nonvoid close acknowledgement ${typeof result} remains unknown without reading thenables`, () => {
    let closes = 0, released = 0;
    const cleanup = new UpdateLockCleanup([{ isOpen: false, close() { closes++; return result as never; } }],
      () => { released++; }, new PerformanceDiagnostics(() => {}));
    assert.equal(cleanup.run(), false); assert.equal(cleanup.run(), false);
    assert.equal(closes, 1); assert.equal(released, 0);
  });
}

test('acknowledged original close and release are idempotent', () => {
  let closes = 0, released = 0;
  const cleanup = new UpdateLockCleanup([{ close() { closes++; } }], () => { released++; });
  assert.equal(cleanup.run(), true); assert.equal(cleanup.run(), true);
  assert.equal(closes, 1); assert.equal(released, 1);
});

test('owner, release and diagnostic reentrancy cannot replay cleanup', () => {
  const observations: boolean[] = [];
  let closes = 0, releases = 0;
  const cleanup = new UpdateLockCleanup([{ close() { closes++; observations.push(cleanup.run()); } }],
    () => { releases++; observations.push(cleanup.run()); },
    new PerformanceDiagnostics(() => { observations.push(cleanup.run()); }));
  assert.equal(cleanup.run(), true); assert.equal(cleanup.run(), true);
  assert.equal(closes, 1); assert.equal(releases, 1);
  assert.deepEqual(observations, [false, false, false]);
});

for (const kind of ['throw', 'async', 'promise', 'nonvoid'] as const) {
  test(`unknown original ${kind} release cannot be acknowledged or replayed`, async () => {
    let closes = 0, releases = 0;
    const release = kind === 'async' ? async () => { releases++; } : () => {
      releases++;
      if (kind === 'throw') throw Error('private-release');
      if (kind === 'promise') return Promise.reject(Error('private-release'));
      return { get then() { return assert.fail('must not inspect release then'); } } as never;
    };
    const logs: string[] = [];
    const cleanup = new UpdateLockCleanup([{ close() { closes++; } }], release, new PerformanceDiagnostics(line => logs.push(line)));
    assert.equal(cleanup.run(), false); assert.equal(cleanup.run(), false);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closes, 1); assert.equal(releases, kind === 'async' ? 0 : 1);
    assert.equal(JSON.parse(logs[0]!).category, 'failed');
    assert.equal(JSON.parse(logs[0]!).pending, 1);
    assert.doesNotMatch(logs.join('\n'), /private-release/);
  });
}

test('cooldown cannot reinterpret a late async close as original synchronous proof', async () => {
  let now = 0, closes = 0, released = 0;
  const cleanup = new UpdateLockCleanup([{ close() { closes++; return Promise.resolve(); } }], () => { released++; });
  assert.equal(cleanup.run(), false);
  const recovery = new UpdateLockRecovery(() => now);
  recovery.retain(['a', 'b'], cleanup);
  await new Promise<void>(resolve => setImmediate(resolve));
  now = 10000;
  assert.equal(recovery.recover('a'), false); assert.equal(recovery.hasPending(), true);
  assert.equal(closes, 1); assert.equal(released, 0);
});

test('synchronous original callback receiver is preserved without reading its call accessor', () => {
  let closes = 0, released = 0;
  const owner = { close() { assert.equal(this, owner); closes++; } };
  Object.defineProperty(owner.close, 'call', { get() { assert.fail('must not inspect callback.call'); } });
  const cleanup = new UpdateLockCleanup([owner], () => { released++; });
  assert.equal(cleanup.run(), true); assert.equal(closes, 1); assert.equal(released, 1);
});

test('native close observer never reads promise-owned then/finally accessors', async () => {
  const original = Promise.reject(Error('private-native-close'));
  for (const key of ['then', 'finally']) Object.defineProperty(original, key, {
    get() { assert.fail(`must not inspect ${key}`); },
  });
  let closes = 0, released = 0;
  const cleanup = new UpdateLockCleanup([{ close() { closes++; return original; } }], () => { released++; });
  assert.equal(cleanup.run(), false);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cleanup.run(), false); assert.equal(closes, 1); assert.equal(released, 0);
});
