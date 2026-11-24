import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Browser } from 'playwright-core';
import { BrowserAuthorization, BrowserWork } from './browser-authorization.js';
import { WorkspaceBrowser } from './workspace-browser.js';

const config = { endpoint: 'ws://127.0.0.1/synthetic', users: ['alice'], hosts: ['learn.microsoft.com'] };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const effects: string[] = [];
  const page = { on() {}, url: () => 'about:blank', title: async () => 'PRIVATE_TITLE', screenshot: async () => { effects.push('screenshot'); return Buffer.from('frame'); },
    keyboard: { press: async () => { effects.push('key'); } } };
  const context = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, route: async () => {}, routeWebSocket: async () => {}, on() {},
    newPage: async () => page, close: async () => { effects.push('context.close'); } };
  const service = new WorkspaceBrowser(config, async () => { effects.push('connect'); return { newContext: async () => context,
    close: async () => { effects.push('browser.close'); } } as unknown as Browser; });
  return { service, page, effects };
}

test('browser authority never treats Promise as true, coalesces checks and retains sticky denial', async () => {
  const work = new BrowserWork(), gate = deferred<boolean>(); let calls = 0;
  const proof = new BrowserAuthorization(() => { calls++; return gate.promise; }, run => work.track(run));
  const a = proof.check(), b = proof.check(); assert.equal(a, b); assert.equal(calls, 1);
  let drained = false; const closing = work.drain().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); gate.resolve(false);
  await assert.rejects(a!, /browser_revoked/); await closing;
  assert.throws(() => proof.check(), /browser_revoked/); assert.equal(calls, 1);
});

test('browser initial async denial prevents native connect and releases original reservation', async () => {
  const f = fixture(), gate = deferred<boolean>();
  const rejected = assert.rejects(f.service.start('alice', randomUUID(), () => gate.promise), /browser_disabled/);
  assert.equal(f.effects.length, 0); assert.equal(f.service.snapshot().leases, 1);
  gate.resolve(false); await rejected; await f.service.close();
  assert.equal(f.effects.length, 0); assert.equal(f.service.snapshot().leases, 0);
});

test('close during async authority retains original proof and prevents late native dispatch', async () => {
  const f = fixture(), gate = deferred<boolean>(); let drained = false;
  const rejected = assert.rejects(f.service.start('alice', randomUUID(), () => gate.promise), /browser_disabled/);
  const closing = f.service.close().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); assert.equal(f.effects.length, 0);
  gate.resolve(true); await rejected; await closing; assert.equal(f.effects.length, 0);
});

test('busy is reserved before async lease checks; one seq cannot dispatch twice', async () => {
  const f = fixture(), id = randomUUID(), gate = deferred<boolean>(); let waiting = false;
  try {
    await f.service.start('alice', id, () => waiting ? gate.promise : true); waiting = true;
    const first = f.service.act('alice', id, { kind: 'key', key: 'Enter', seq: 1 });
    await assert.rejects(f.service.act('alice', id, { kind: 'key', key: 'Enter', seq: 1 }), /browser_busy/);
    assert.equal(f.effects.includes('key'), false); gate.resolve(true); await first;
    await assert.rejects(f.service.act('alice', id, { kind: 'key', key: 'Enter', seq: 1 }), /browser_action_already_consumed/);
    assert.equal(f.effects.filter(v => v === 'key').length, 1);
  } finally { gate.resolve(true); await f.service.close(); }
});

test('current caller proof is independent of live creator proof and cannot dispatch on false', async () => {
  const f = fixture(), id = randomUUID(), gate = deferred<boolean>();
  try {
    await f.service.start('alice', id, async () => true);
    const denied = assert.rejects(f.service.act('alice', id, { kind: 'key', key: 'Enter', seq: 1 }, () => gate.promise), /browser_expired/);
    await tick(); assert.equal(f.effects.includes('key'), false); gate.resolve(false); await denied;
    assert.equal(f.effects.includes('key'), false);
  } finally { gate.resolve(false); await f.service.close(); }
});

test('async expiry checks are single flight and drain their original proof', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(), id = randomUUID(), gate = deferred<boolean>(); let waiting = false, calls = 0, drained = false;
  await f.service.start('alice', id, () => { calls++; return waiting ? gate.promise : true; });
  waiting = true; calls = 0; t.mock.timers.tick(5000); t.mock.timers.tick(5000); t.mock.timers.tick(5000);
  assert.equal(calls, 1); const closing = f.service.close().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); gate.resolve(false); await closing;
  assert.equal(f.effects.filter(v => v === 'context.close').length, 1);
});

test('mutable action input is copied before async authority can yield', async () => {
  const f = fixture(), id = randomUUID(), gate = deferred<boolean>(); let waiting = false;
  try {
    await f.service.start('alice', id, () => waiting ? gate.promise : true); waiting = true;
    const action = { kind: 'key' as const, key: 'Enter', seq: 1 }, running = f.service.act('alice', id, action);
    action.seq = 99; gate.resolve(true); assert.equal((await running).seq, 1);
  } finally { gate.resolve(true); await f.service.close(); }
});
