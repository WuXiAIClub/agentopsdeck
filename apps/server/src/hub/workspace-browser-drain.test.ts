import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext } from 'playwright-core';
import { WorkspaceBrowser } from './workspace-browser.js';

const config = { endpoint: 'ws://127.0.0.1/synthetic', users: ['alice'], hosts: ['learn.microsoft.com'] };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function context(close: () => Promise<void>) {
  return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, route: async () => {}, routeWebSocket: async () => {}, on() {},
    newPage: async () => ({ on() {}, url: () => 'about:blank' }), close } as unknown as BrowserContext;
}

test('service close waits for original pending connect and disposes its late handle exactly once', async () => {
  let connect!: (value: Browser) => void, closed = false, nativeCloses = 0;
  const service = new WorkspaceBrowser(config, () => new Promise(resolve => { connect = resolve; }));
  const started = assert.rejects(service.start('alice', randomUUID(), () => true), /browser_start_failed/);
  const original = service.close(); assert.equal(service.close(), original);
  const drain = original.then(() => { closed = true; });
  try { await turn(); assert.equal(closed, false); assert.equal(service.snapshot().state, 'draining'); }
  finally { connect({ close: async () => { nativeCloses++; } } as unknown as Browser); await started; await drain; }
  assert.equal(nativeCloses, 1); assert.equal(service.snapshot().leases, 0);
  await assert.rejects(service.start('alice', randomUUID(), () => true), /browser_disabled/);
});

test('late newContext handle remains owned while stop and service close race', async () => {
  let acquire!: (value: BrowserContext) => void, closed = false, contextStops = 0, browserStops = 0;
  const browser = { newContext: () => new Promise<BrowserContext>(resolve => { acquire = resolve; }),
    close: async () => { browserStops++; } } as unknown as Browser;
  const service = new WorkspaceBrowser(config, async () => browser), id = randomUUID();
  const started = assert.rejects(service.start('alice', id, () => true), /browser_start_failed/);
  await turn(); assert.ok(acquire);
  await service.stop('alice', id);
  const drain = service.close().then(() => { closed = true; });
  try { await turn(); assert.equal(closed, false); }
  finally { acquire(context(async () => { contextStops++; })); await started; await drain; }
  assert.equal(contextStops, 1); assert.equal(browserStops, 1); assert.equal(service.snapshot().leases, 0);
});

test('concurrent stop and close retain original pending context close and still signal browser', async () => {
  let finish!: () => void, closed = false, contextStops = 0, browserStops = 0;
  const native = context(() => { contextStops++; return new Promise<void>(resolve => { finish = resolve; }); });
  const service = new WorkspaceBrowser(config, async () => ({ newContext: async () => native,
    close: async () => { browserStops++; } } as unknown as Browser));
  const id = randomUUID(); await service.start('alice', id, () => true);
  const stop = service.stop('alice', id), drain = service.close().then(() => { closed = true; });
  try { await turn(); assert.equal(closed, false); assert.equal(browserStops, 1); }
  finally { finish(); await stop; await drain; }
  assert.equal(contextStops, 1); assert.equal(service.snapshot().accepted, 0);
});

test('native close failure is retained, cannot masquerade as idle or be replayed', async () => {
  let calls = 0, browserStops = 0;
  const native = context(async () => { calls++; throw Error('private-native-close'); });
  const service = new WorkspaceBrowser(config, async () => ({ newContext: async () => native,
    close: async () => { browserStops++; } } as unknown as Browser));
  const id = randomUUID(); await service.start('alice', id, () => true);
  await assert.rejects(service.stop('alice', id), /browser_close_unconfirmed/);
  const original = service.close(); await assert.rejects(original);
  assert.equal(service.close(), original); assert.equal(calls, 1); assert.equal(browserStops, 1);
  assert.equal(service.snapshot().state, 'failed'); assert.equal(service.snapshot().leases, 1);
});

test('caller action deadline is not native settlement or permission to replay input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish!: () => void, calls = 0, drained = false;
  const page = { on() {}, url: () => 'about:blank', keyboard: { press: () => { calls++; return new Promise<void>(resolve => { finish = resolve; }); } } };
  const native = context(async () => {}); native.newPage = async () => page as unknown as Awaited<ReturnType<BrowserContext['newPage']>>;
  const service = new WorkspaceBrowser(config, async () => ({ newContext: async () => native, close: async () => {} } as unknown as Browser));
  const id = randomUUID(); await service.start('alice', id, () => true);
  const rejected = assert.rejects(service.act('alice', id, { kind: 'key', key: 'Enter', seq: 1 }), /browser_action_unconfirmed/);
  t.mock.timers.tick(15_000); await rejected;
  assert.equal(service.snapshot().accepted, 1, 'original native input remains owned after caller deadline');
  const drain = service.close().then(() => { drained = true; });
  try { await turn(); assert.equal(drained, false); await assert.rejects(service.act('alice', id, { kind: 'key', key: 'Enter', seq: 1 }), /browser_disabled/); }
  finally { finish(); await drain; }
  assert.equal(calls, 1); assert.equal(service.snapshot().accepted, 0);
});

test('hung native title work cannot create an unbounded number of replacement leases', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending: (() => void)[] = [];
  const page = { on() {}, url: () => 'about:blank', screenshot: async () => Buffer.from('fixture'),
    title: () => new Promise<string>(resolve => { pending.push(() => resolve('fixture')); }) };
  const native = context(async () => {}); native.newPage = async () => page as unknown as Awaited<ReturnType<BrowserContext['newPage']>>;
  const service = new WorkspaceBrowser(config, async () => ({ newContext: async () => native, close: async () => {} } as unknown as Browser));
  try {
    for (let index = 0; index < 16; index++) {
      const id = randomUUID(); await service.start('alice', id, () => true);
      const failed = assert.rejects(service.frame('alice', id), /browser_disconnected|browser_capacity/);
      await turn(); t.mock.timers.tick(2000); await failed;
    }
    assert.equal(pending.length, 16);
    await assert.rejects(service.start('alice', randomUUID(), () => true), /browser_capacity/);
  } finally { for (const settle of pending) settle(); await service.close(); }
});
