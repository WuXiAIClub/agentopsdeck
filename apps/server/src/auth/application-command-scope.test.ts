import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationCommandScopes, ApplicationCommandScopeError,
  type ApplicationCommandIntent, type ApplicationCommandScope } from './application-command-scope.js';
import { requiredSynchronousEffectAuthority } from './synchronous-effect-authority.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const intent = (): ApplicationCommandIntent => ({ action: 'message', runtime: 'codex',
  resource: 'original-session', commandKey: 'original-command', payloadDigest: 'a'.repeat(64) });
const request = (signal?: AbortSignal) => new Request('http://original/api/sessions/send', {
  headers: { cookie: 'agentopsdeck_session=original', 'x-agentopsdeck-key': 'original-key', authorization: 'Bearer original-bearer' }, ...(signal ? { signal } : {}),
});
function held<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const code = (value: string) => (error: unknown) => error instanceof ApplicationCommandScopeError && error.code === value;
const fixture = (overrides: Partial<Parameters<typeof createApplicationCommandScopes>[0]> = {}) =>
  createApplicationCommandScopes({ authorize: () => true, assertAvailable: () => {}, ...overrides });

test('binds immutable original intent/credentials, rechecks each stage and expires escaped callbacks', async () => {
  const original = request(), input = intent(), seen: Request[] = [], cookies: (string | null)[] = [];
  let captured!: ApplicationCommandScope;
  const h = fixture({ authorize: r => { seen.push(r); cookies.push(r.headers.get('cookie')); r.headers.set('cookie', 'callee-mutation'); return true; } });
  const result = h.run(original, input, async scope => {
    captured = scope;
    original.headers.set('x-agentopsdeck-key', 'caller-mutation');
    (input as { commandKey: string }).commandKey = 'caller-mutation';
    assert.equal(scope.intent.commandKey, 'original-command');
    assert.equal(Object.isFrozen(scope.intent), true);
    assert.equal(Object.isFrozen(scope), true);
    await scope.authorize('prepare'); await scope.authorize('effect');
    scope.local(); return 'original-ack';
  });
  assert.equal(await result, 'original-ack');
  assert.equal(seen.length, 3);
  assert.deepEqual(cookies, Array(3).fill('agentopsdeck_session=original'));
  assert.ok(seen.every(r => r.headers.get('x-agentopsdeck-key') === 'original-key'));
  assert.ok(seen.every(r => r.headers.get('authorization') === 'Bearer original-bearer'));
  assert.throws(captured.local, code('expired'));
  await assert.rejects(captured.authorize('effect'), code('expired'));
  assert.equal(seen.length, 3); assert.equal(h.pending, 0); await h.close();
});

for (const proof of [false, undefined, 1, 'true', {}, { authorized: true }]) {
  test(`admission never treats ${JSON.stringify(proof)} as current authority`, async () => {
    let executed = false;
    const h = fixture({ authorize: () => proof as boolean });
    await assert.rejects(h.run(request(), intent(), async () => { executed = true; }), code(proof === false ? 'unauthorized' : 'unavailable'));
    assert.equal(executed, false); assert.equal(h.pending, 0); await h.close();
  });
}

for (const mode of ['deny', 'throw', 'reject'] as const) test(`${mode} poisons a scope even if the authority later recovers`, async () => {
  let reads = 0, escaped!: ApplicationCommandScope;
  const h = fixture({ authorize: () => {
    if (++reads !== 2) return true;
    if (mode === 'deny') return false;
    if (mode === 'throw') throw Error('private persistence detail');
    return Promise.reject(Error('private persistence detail'));
  } });
  assert.equal(await h.run(request(), intent(), async scope => {
    escaped = scope;
    await assert.rejects(scope.authorize('effect'), code(mode === 'deny' ? 'unauthorized' : 'unavailable'));
    assert.throws(scope.local, code(mode === 'deny' ? 'unauthorized' : 'unavailable'));
    await assert.rejects(scope.authorize('effect'));
    return 'settled-original-receipt';
  }), 'settled-original-receipt');
  await assert.rejects(escaped.authorize('effect')); assert.equal(reads, 2); await h.close();
});

for (const invalid of [
  { ...intent(), actor: 'administrator' }, { ...intent(), authorized: true },
  { ...intent(), action: 'arbitrary-sql' }, { ...intent(), runtime: 'unknown' },
  { ...intent(), resource: '' }, { ...intent(), resource: 'x'.repeat(4097) },
  { ...intent(), commandKey: 'x'.repeat(201) }, { ...intent(), commandKey: 'key\n' },
  { ...intent(), payloadDigest: 'not-a-digest' }, Object.assign(Object.create({ inherited: true }), intent()),
  new Proxy(intent(), { get() { throw Error('Proxy must not execute'); } }),
  Object.defineProperty(intent(), 'resource', { get() { throw Error('Getter must not execute'); } }),
]) test('rejects invalid or executable intent data before authority or work', async () => {
  let called = false;
  const h = fixture({ authorize: () => { called = true; return true; } });
  await assert.rejects(h.run(request(), invalid as ApplicationCommandIntent, async () => { called = true; }), code('invalid'));
  assert.equal(called, false); assert.equal(h.pending, 0); await h.close();
});

for (const boundary of ['admission', 'effect'] as const) for (const freeze of ['close', 'abort'] as const) {
  test(`${freeze} while ${boundary} awaits current Auth never permits a later effect`, async () => {
    const gate = held<boolean>(), entered = held(), controller = new AbortController();
    let reads = 0, effects = 0;
    const h = fixture({ authorize: () => {
      if (++reads === (boundary === 'admission' ? 1 : 2)) { entered.resolve(); return gate.promise; }
      return true;
    } });
    const pending = h.run(request(controller.signal), intent(), async scope => {
      await scope.authorize('effect'); effects++; return 'ack';
    });
    const rejected = assert.rejects(pending, code(freeze === 'close' ? 'unavailable' : 'cancelled'));
    await entered.promise;
    let drained = false;
    const closing = freeze === 'close' ? h.close() : undefined;
    if (closing) void closing.then(() => { drained = true; });
    else controller.abort();
    try { assert.equal(h.pending, 1); assert.equal(drained, false); }
    finally { gate.resolve(true); await rejected; await closing; }
    assert.equal(effects, 0); assert.equal(h.pending, 0); await h.close();
  });
}

test('close retains physical effect and original settlement despite abort, denial and mutated public Promise', async () => {
  const gate = held<string>(), entered = held(), controller = new AbortController();
  let captured!: ApplicationCommandScope, current = true;
  const h = fixture({ authorize: () => current });
  const pending = h.run(request(controller.signal), intent(), async scope => {
    captured = scope; await scope.authorize('effect'); entered.resolve(); return gate.promise;
  });
  await entered.promise;
  const originalThen = Promise.prototype.then.bind(pending);
  Object.defineProperty(pending, 'then', { value: () => Promise.resolve('forged-ack') });
  controller.abort(); current = false;
  const closing = h.close(); assert.equal(h.close(), closing);
  let closed = false; void closing.then(() => { closed = true; });
  try {
    assert.throws(captured.local); await assert.rejects(captured.authorize('effect'));
    await assert.rejects(h.run(request(), intent(), async () => 'never'), code('unavailable'));
    assert.equal(h.pending, 1); assert.equal(closed, false);
  } finally { gate.resolve('original-physical-ack'); }
  assert.equal(await originalThen(value => value), 'original-physical-ack'); await closing;
  assert.equal(h.pending, 0);
});

test('outstanding unawaited Auth observation retains owner but not a completed scope', async () => {
  const gate = held<boolean>(); let reads = 0, captured!: ApplicationCommandScope, late!: Promise<void>;
  const h = fixture({ authorize: () => ++reads === 1 ? true : gate.promise });
  assert.equal(await h.run(request(), intent(), async scope => {
    captured = scope; late = scope.authorize('effect'); void late.catch(() => {}); return 'original-ack';
  }), 'original-ack');
  const closing = h.close();
  try { assert.equal(h.pending, 1); assert.throws(captured.local, code('expired')); }
  finally { gate.resolve(true); }
  await assert.rejects(late, code('expired')); await closing; assert.equal(h.pending, 0);
});

test('bounded concurrency refuses overload and a failed task cannot skip a physical sibling drain', async () => {
  const gate = held(), entered = held();
  const h = fixture({ capacity: 2 });
  const sibling = h.run(request(), intent(), async () => { entered.resolve(); await gate.promise; return 'ack'; });
  await entered.promise;
  const bad = h.run(request(), intent(), async () => { throw Error('original failure'); });
  await assert.rejects(h.run(request(), intent(), async () => {}), code('capacity'));
  await assert.rejects(bad, /original failure/);
  const closing = h.close();
  try { assert.equal(h.pending, 1); }
  finally { gate.resolve(); await sibling; await closing; }
});

test('invalid stages poison, local is not an asynchronous/native authorization shortcut', async () => {
  const h = fixture();
  await h.run(request(), intent(), async scope => {
    assert.throws(() => requiredSynchronousEffectAuthority(scope.authorize as unknown as () => void));
    scope.local();
    await assert.rejects(scope.authorize('arbitrary' as 'effect'), code('invalid'));
    await assert.rejects(scope.authorize('effect'), code('invalid'));
  });
  await h.close();
});

test('limits simultaneous checks without cancelling original physical observations', async () => {
  const gate = held<boolean>(); let reads = 0;
  const h = fixture({ authorize: () => ++reads === 1 ? true : gate.promise });
  await h.run(request(), intent(), async scope => {
    const checks = Array.from({ length: 8 }, () => scope.authorize('effect'));
    for (const check of checks) void check.catch(() => {});
    try { await assert.rejects(scope.authorize('effect'), code('capacity')); }
    finally { gate.resolve(true); }
    for (const check of checks) await assert.rejects(check, code('capacity'));
  });
  assert.equal(reads, 9); await h.close();
});

test('retains original dependency functions and never logs credentials, intent or private errors', async () => {
  const diagnostics = new PerformanceDiagnostics(), deps = {
    authorize: () => true, assertAvailable: () => {}, diagnostics,
  };
  const h = createApplicationCommandScopes(deps); deps.authorize = () => false;
  await assert.rejects(h.run(request(), intent(), async () => { throw Error('secret-original-body'); }), /secret-original-body/);
  await h.close();
  const logs = JSON.stringify(diagnostics.snapshot());
  assert.ok(logs.includes('application-command-scope'));
  for (const text of ['secret-original-body', 'original-session', 'original-command', 'original-bearer', 'original-key', 'a'.repeat(64)])
    assert.equal(logs.includes(text), false);
});

test('physical task and authorization Promise .then overrides do not forge completion', async () => {
  const check = held<boolean>(), effect = held<string>(), entered = held();
  let checks = 0;
  Object.defineProperty(check.promise, 'then', { value: () => Promise.resolve(true) });
  Object.defineProperty(effect.promise, 'then', { value: () => Promise.resolve('forged') });
  const h = fixture({ authorize: () => ++checks === 1 ? true : check.promise });
  const pending = h.run(request(), intent(), scope => {
    // Return the original physical Promise directly, not an async wrapper
    // which could itself assimilate an owner-controlled .then property.
    entered.resolve(); void scope.authorize('effect').catch(() => {}); return effect.promise;
  });
  await entered.promise;
  const closing = h.close(); let closed = false; void closing.then(() => { closed = true; });
  try { assert.equal(h.pending, 1); assert.equal(closed, false); }
  finally { check.resolve(true); effect.resolve('original'); }
  assert.equal(await pending, 'original'); await closing; assert.equal(h.pending, 0);
});

test('broken diagnostic sinks cannot skip original work or strand close', async () => {
  const diagnostics = new PerformanceDiagnostics();
  diagnostics.start = () => { throw Error('private diagnostic failure'); };
  const h = fixture({ diagnostics });
  assert.equal(await h.run(request(), intent(), async scope => { await scope.authorize('effect'); return 'ack'; }), 'ack');
  await h.close(); assert.equal(h.pending, 0);
});

test('cancelled admission and oversized original evidence never start authorization', async () => {
  let called = false;
  const h = fixture({ authorize: () => { called = true; return true; } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.run(request(controller.signal), intent(), async () => {}), code('cancelled'));
  const oversized = new Request('http://fixture', { headers: { cookie: 'x'.repeat(65_537) } });
  await assert.rejects(h.run(oversized, intent(), async () => {}), code('invalid'));
  assert.equal(called, false); await h.close();
});

for (const callback of [() => { throw Error('original synchronous failure'); }, async () => { throw Error('original asynchronous failure'); }]) {
  test('original task failure drains without replacing original error', async () => {
    const h = fixture();
    await assert.rejects(h.run(request(), intent(), callback), /original .* failure/);
    assert.equal(h.pending, 0); await h.close();
  });
}

test('reentrant close in availability check freezes before admitting or starting a task', async () => {
  let h!: ReturnType<typeof fixture>, calls = 0;
  h = fixture({ assertAvailable: () => { h.close(); }, authorize: () => { calls++; return true; } });
  await assert.rejects(h.run(request(), intent(), async () => { calls++; }), code('unavailable'));
  assert.equal(calls, 0); assert.equal(h.pending, 0); await h.close();
});

for (const at of ['authority', 'task'] as const) test(`unobservable original ${at} is unknown, never a certified drain`, async () => {
  const physical = held<boolean>(), entered = held(); let reads = 0, touched = false;
  Object.defineProperty(physical.promise, 'constructor', { configurable: true, get() { throw Error('private species failure'); } });
  const h = fixture({ authorize: () => at === 'authority' && ++reads === 1 ? physical.promise : true });
  await assert.rejects(h.run(request(), intent(), () => { touched = true; entered.resolve(); return physical.promise; }), code('unavailable'));
  assert.equal(touched, at === 'task');
  const closing = h.close(); let closed = false; void closing.then(() => { closed = true; });
  // Restore only the test object. A repaired observation mechanism is NOT an
  // original completion ACK and the owner must not guess that work drained.
  Object.defineProperty(physical.promise, 'constructor', { value: Promise }); physical.resolve(true);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.pending, 1); assert.equal(closed, false); assert.equal(h.close(), closing);
});

for (const capacity of [0, -1, 1.5, Number.NaN, 1025]) test('rejects invalid admission bounds before any work', () => {
  assert.throws(() => fixture({ capacity }), code('invalid'));
});

test('async local availability cannot be accidentally installed or authorize work', async () => {
  let called = false;
  assert.throws(() => fixture({ assertAvailable: async () => { called = true; } }), code('invalid'));
  assert.equal(called, false);
  const h = fixture({ assertAvailable: () => Promise.reject(Error('private late failure')) });
  await assert.rejects(h.run(request(), intent(), async () => { called = true; }), code('unavailable'));
  assert.equal(called, false); await h.close();
});

for (const runtime of ['codex', 'openclaw', 'claude-code', 'ghcp', 'hermes'] as const) {
  test(`${runtime} retains the existing 200-character idempotency key`, async () => {
    const h = fixture();
    assert.equal(await h.run(request(), { ...intent(), runtime, commandKey: 'k'.repeat(200) }, async scope => scope.intent.commandKey), 'k'.repeat(200));
    await h.close();
  });
}

test('retains existing 4096-byte resource identifiers without relaxing the byte budget', async () => {
  const h = fixture();
  for (const resource of ['codex:' + 'x'.repeat(4090), 'codex:' + '界'.repeat(1363) + 'x']) {
    assert.equal(Buffer.byteLength(resource), 4096);
    assert.equal(await h.run(request(), { ...intent(), resource }, async scope => scope.intent.resource), resource);
  }
  for (const resource of ['x'.repeat(4097), '界'.repeat(1366)]) {
    await assert.rejects(h.run(request(), { ...intent(), resource }, async () => {}), code('invalid'));
  }
  await h.close();
});
