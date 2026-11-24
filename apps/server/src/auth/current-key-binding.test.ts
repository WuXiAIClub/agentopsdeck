import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthCurrentKeyBinding, OriginalAuthCurrentKey, validCurrentKeyBinding, type CurrentKeyBinding } from './current-key-binding.js';
import { AuthPersistenceError } from './private-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const hash = 'a'.repeat(24), quiet = () => new PerformanceDiagnostics(() => {});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('binding protocol accepts only bounded sequential configuration, not caller authorization', () => {
  for (const value of [null, [], {}, { epoch: 0 }, { epoch: 1.1 }, { epoch: Infinity },
    { epoch: Number.MAX_SAFE_INTEGER + 1 }, { epoch: 1, authorized: true },
    { epoch: 1, keyIdentityHash: undefined }, { epoch: 1, keyIdentityHash: 'private-key' }]) {
    assert.equal(validCurrentKeyBinding(value), false);
  }
  assert.equal(validCurrentKeyBinding({ epoch: 1 }), true);
  const original = new OriginalAuthCurrentKey(hash);
  assert.throws(() => original.update({ epoch: 2 }), AuthPersistenceError);
  const input = { epoch: 1 };
  assert.deepEqual(original.update(input), input);
  input.epoch = 99;
  assert.equal(original.keyIdentityHash, undefined);
  assert.deepEqual(original.update({ epoch: 2, keyIdentityHash: hash }), { epoch: 2, keyIdentityHash: hash });
  assert.throws(() => original.update({ epoch: 2 }), AuthPersistenceError);
});

test('freeze synchronously, drain original work, match ACK, and never revive an old delivery epoch', async () => {
  const binding = new AuthCurrentKeyBinding(quiet()), original = gate(), ack = gate();
  const epoch = binding.capture(), sent: CurrentKeyBinding[] = [];
  const update = binding.update(hash, [original.promise], async input => { sent.push(input); await ack.promise; return input; });
  assert.equal(binding.pending, update);
  assert.throws(() => binding.capture(), AuthPersistenceError);
  assert.throws(() => binding.assertCurrent(epoch), AuthPersistenceError);
  await assert.rejects(binding.update(hash, [], async input => input), AuthPersistenceError);
  await tick(); assert.deepEqual(sent, []);
  original.release(); await tick(); assert.deepEqual(sent, [{ epoch: 1, keyIdentityHash: hash }]);
  assert.throws(() => binding.capture(), AuthPersistenceError);
  ack.release(); await update;
  assert.equal(binding.capture(), 1);
  assert.throws(() => binding.assertCurrent(epoch), AuthPersistenceError);
  await binding.update(undefined, [], async input => input);
  assert.equal(binding.capture(), 2);
  assert.throws(() => binding.assertCurrent(epoch), AuthPersistenceError);
});

test('invalid configuration does not freeze, while rejected original work still drains before update', async () => {
  const binding = new AuthCurrentKeyBinding(quiet());
  await assert.rejects(binding.update('bad', [], async input => input), AuthPersistenceError);
  assert.equal(binding.capture(), 0);
  const failed = Promise.reject(Error('private-original-error'));
  await binding.update(hash, [failed], async input => input);
  assert.equal(binding.capture(), 1);
});

for (const outcome of ['rejected', 'wrong-epoch', 'wrong-hash', 'extra-field', 'missing'] as const)
test(`unknown ${outcome} ACK permanently fences admission without resend`, async () => {
  const binding = new AuthCurrentKeyBinding(quiet()); let sends = 0;
  await assert.rejects(binding.update(hash, [], async input => {
    sends++;
    if (outcome === 'rejected') throw Error('private-transport');
    if (outcome === 'wrong-epoch') return { ...input, epoch: 2 };
    if (outcome === 'wrong-hash') return { epoch: input.epoch };
    if (outcome === 'extra-field') return { ...input, authorized: true };
    return undefined as unknown as CurrentKeyBinding;
  }), AuthPersistenceError);
  assert.throws(() => binding.capture(), AuthPersistenceError);
  await assert.rejects(binding.update(hash, [], async input => { sends++; return input; }), AuthPersistenceError);
  assert.equal(sends, 1);
});

test('warning is observation only; late original ACK, not elapsed time, reopens admission', async () => {
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => { lines.push(line); });
  const binding = new AuthCurrentKeyBinding(diagnostics, 1), ack = gate();
  const update = binding.update(hash, [], async input => { await ack.promise; return input; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.throws(() => binding.capture(), AuthPersistenceError);
  assert.ok(diagnostics.snapshot().events.some(event => event.operation === 'auth-current-key-binding' && event.phase === 'pending'));
  ack.release(); await update;
  assert.equal(binding.capture(), 1);
  const evidence = diagnostics.snapshot().events.filter(event => event.operation === 'auth-current-key-binding');
  assert.deepEqual(evidence.map(event => event.phase), ['pending', 'finished']);
  assert.ok(evidence.every(event => event.generation === 1));
  assert.doesNotMatch(JSON.stringify(lines), new RegExp(hash));
});

test('diagnostic failure and reentrant diagnostics cannot change admission or duplicate update', async () => {
  let binding!: AuthCurrentKeyBinding, sends = 0;
  const diagnostics = new PerformanceDiagnostics(() => {
    if (sends === 0) assert.throws(() => binding.capture(), AuthPersistenceError);
    throw Error('private-log-sink');
  });
  binding = new AuthCurrentKeyBinding(diagnostics);
  await binding.update(hash, [], async input => { sends++; return input; });
  assert.equal(binding.capture(), 1); assert.equal(sends, 1);
  const failing = new AuthCurrentKeyBinding(new PerformanceDiagnostics(() => {}, () => { throw Error(); }));
  await failing.update(hash, [], async input => input);
  assert.equal(failing.capture(), 1);
});
