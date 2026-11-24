import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { registerHubBrowser } from './hub-workspace-browser.js';
import { registerHubRoutes } from './hub.js';
import { HubStore } from '../hub/hub-store.js';
import { WeixinService } from '../hub/weixin-service.js';
import { HubEventBrokers } from '../hub/event-broker.js';
import { loadConfig } from '../config.js';

test('browser route retains all original close acknowledgements in a stable composite drain', async () => {
  let finish!: () => void, finishAccess!: () => void, accessCalls = 0;
  const flight = new Promise<void>(resolve => { finish = resolve; });
  const access = new Promise<void>(resolve => { finishAccess = resolve; });
  const route = registerHubBrowser(new Hono(), { principal: () => undefined,
    audit: { append() {} }, service: { close: () => flight }, access: { close: () => { accessCalls++; return access; } }
  } as unknown as Parameters<typeof registerHubBrowser>[1]);
  const original = route.close(); let settled = false;
  const observed = original.then(() => { settled = true; });
  try {
    assert.equal(route.close(), original);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(accessCalls, 0);
    finish(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(accessCalls, 1); assert.equal(settled, false);
    assert.equal(route.close(), original);
    finishAccess(); await observed; assert.equal(settled, true); assert.equal(accessCalls, 1);
  } finally { finish(); finishAccess(); await observed; }
});

test('Hub signals later original independent owners despite synchronous close failure', async t => {
  const original = WeixinService.prototype.close, failure = Error('synthetic close');
  let brokerStops = 0;
  t.mock.method(WeixinService.prototype, 'close', function(this: WeixinService) { original.call(this); throw failure; });
  const originalBrokers = HubEventBrokers.prototype.close;
  t.mock.method(HubEventBrokers.prototype, 'close', function(this: HubEventBrokers) { brokerStops++; return originalBrokers.call(this); });
  const store = new HubStore(':memory:', 'synthetic');
  const route = registerHubRoutes(new Hono(), { config: loadConfig({}), hubStore: store,
    connectorClient: () => { throw Error('not dispatched'); }, normalizeError: () => 'synthetic' });
  assert.ok(route);
  try {
    const original = route.close(); await assert.rejects(original, error => error === failure);
    assert.equal(route.close(), original); assert.equal(brokerStops, 1);
  } finally { await store.close(); }
});

for (const firstFails of [false, true]) test(`Hub closes injected async request owners once, without omitting pending peers; failure=${firstFails}`, async () => {
  let finish!: () => void, signals = 0;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const failure = Error('PRIVATE original drain failure');
  const store = new HubStore(':memory:', 'synthetic');
  const route = registerHubRoutes(new Hono(), { config: loadConfig({}), hubStore: store,
    connectorClient: () => { throw Error('No transport'); }, normalizeError: () => 'synthetic',
    asyncSharedDirectory: { sessions: async () => { throw Error('No request'); }, close: () => {
      signals++; if (firstFails) throw failure; return Promise.resolve();
    } },
    asyncOwnerControl: { open: async () => { throw Error('No request'); }, close: () => { signals++; return pending; } },
  });
  assert.ok(route);
  let settled = false; const original = route.close();
  const result = original.then(() => { settled = true; assert.equal(firstFails, false); }, error => {
    settled = true; assert.equal(firstFails, true); assert.equal(error, failure);
  });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(signals, 2); assert.equal(settled, false); assert.equal(route.close(), original);
  } finally { finish(); await result; await store.close(); }
  assert.equal(signals, 2); assert.equal(settled, true);
});
