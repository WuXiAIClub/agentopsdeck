import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeHubEventJson, HUB_EVENT_RPC_BYTES, HUB_EVENT_RPC_NODES } from './member-event-domain.js';
import { encodeHubMemberJson } from './async-member-owner.js';

test('event JSON retains legacy omission, sparse arrays, nonfinite numbers and shared objects', () => {
  const shared = { empty: '', payload: undefined, number: Infinity };
  const array = [undefined, shared]; array.length = 4;
  const value = { payload: array, optional: undefined, same: shared, ['__proto__']: null };
  assert.equal(encodeHubEventJson(value), JSON.stringify(value));
});

for (const size of [8192, 8193, 32768, 65536]) test(`event array ${size} preserves original JSON without widening member settings`, () => {
  const value = { payload: new Array(size).fill(0) };
  assert.equal(encodeHubEventJson(value), JSON.stringify(value));
  if (size > 8192) assert.throws(() => encodeHubMemberJson(value, HUB_EVENT_RPC_BYTES, HUB_EVENT_RPC_NODES));
});

for (const depth of [32, 33, 1000, 10000]) test(`iterative event encoding accepts JSON depth ${depth} without recursive stack failure`, () => {
  let value: unknown = 0;
  for (let index = 0; index < depth; index++) value = { payload: value };
  const expected = '{"payload":'.repeat(depth) + '0' + '}'.repeat(depth);
  assert.equal(encodeHubEventJson(value), expected);
  assert.doesNotThrow(() => JSON.parse(expected));
  if (depth > 32) assert.throws(() => encodeHubMemberJson(value, HUB_EVENT_RPC_BYTES, HUB_EVENT_RPC_NODES));
});

for (const shape of ['getter','proxy','revoked-proxy','toJSON','symbol','prototype','array-getter','array-extra'] as const)
  test(`event encoder refuses nested ${shape} without running caller code`, () => {
    let invoked = 0;
    const revoked = Proxy.revocable({}, { ownKeys() { invoked++; return []; } }); revoked.revoke();
    const arrayGetter = [0]; Object.defineProperty(arrayGetter, '0', { get() { invoked++; return 0; } });
    const arrayExtra = Object.assign([0], { toJSON() { invoked++; return []; } });
    const value = shape === 'getter' ? { get payload() { invoked++; return {}; } }
      : shape === 'proxy' ? new Proxy({}, { ownKeys() { invoked++; return []; } })
      : shape === 'revoked-proxy' ? revoked.proxy
      : shape === 'toJSON' ? { toJSON() { invoked++; return {}; } }
      : shape === 'symbol' ? { [Symbol('private')]: true }
      : shape === 'prototype' ? Object.create({})
      : shape === 'array-getter' ? arrayGetter : arrayExtra;
    assert.throws(() => encodeHubEventJson({ payload: value })); assert.equal(invoked, 0);
  });

test('event encoder bounds exact UTF8/escape output rather than truncating', () => {
  assert.equal(encodeHubEventJson('a'.repeat(HUB_EVENT_RPC_BYTES - 2)).length, HUB_EVENT_RPC_BYTES);
  for (const value of ['a'.repeat(HUB_EVENT_RPC_BYTES - 1), '\u0000'.repeat(HUB_EVENT_RPC_BYTES / 6), '界'.repeat(HUB_EVENT_RPC_BYTES / 3)])
    assert.throws(() => encodeHubEventJson(value));
});

test('event encoder refuses cycles, callback values and node exhaustion without dispatch', () => {
  const cyclic: any = {}; cyclic.self = cyclic;
  for (const value of [cyclic, { payload: () => 1 }, { payload: 1n }, new Array(HUB_EVENT_RPC_NODES).fill(null)])
    assert.throws(() => encodeHubEventJson(value));
});
