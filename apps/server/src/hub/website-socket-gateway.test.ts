import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { WebsiteGateway } from './website-gateway.js';
import { attachWebsiteSocketUpgrade, type WebsiteSocketPeer } from './website-socket-gateway.js';

async function fixture(t: TestContext, connect: (signal: AbortSignal) => Promise<WebsiteSocketPeer>, authorize: () => void | Promise<void> = () => {}) {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const gateway = new WebsiteGateway({ originTemplate: `http://{access}.localhost:${port}`, parentOrigin: 'http://hub.localhost', port });
  const upgrade = attachWebsiteSocketUpgrade(server, gateway);
  const visit = await gateway.open({ key: 'lease', owner: 'owner', signal: new AbortController().signal,
    expiresAt: Date.now() + 5000, authorize, read: async () => { throw Error('No HTTP read expected'); },
    connect: (_path, _protocols, signal) => connect(signal) });
  const clients: WebSocket[] = [];
  t.after(async () => { clients.forEach(client => client.terminate()); await Promise.all([upgrade.close(), gateway.close()]); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { gateway, upgrade, connect: () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/hmr`, { headers: { host: new URL(visit.url).host, origin: 'null' } });
    ws.on('error', () => {}); clients.push(ws); return ws;
  } };
}

test('faulty empty long-read closes after one request instead of spinning', { timeout: 3000 }, async t => {
  let reads = 0, closes = 0;
  const f = await fixture(t, async () => ({ protocol: '', read: async () => { reads++; return { frames: [] }; }, send: async () => {}, close: async () => { closes++; } }));
  const ws = f.connect(); await once(ws, 'close');
  assert.equal(reads, 1); assert.equal(closes, 1);
});

test('shutdown destroys pending native handshake even when Connector ignores abort', { timeout: 3000 }, async t => {
  let signal: AbortSignal | undefined, release!: (peer: WebsiteSocketPeer) => void, admitted!: () => void, closes = 0;
  const admission = new Promise<void>(resolve => { admitted = resolve; });
  const f = await fixture(t, pending => { signal = pending; admitted(); return new Promise(resolve => { release = resolve; }); });
  const ws = f.connect(), closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
  await admission; const draining = f.upgrade.close(); await closed;
  assert.equal(signal?.aborted, true);
  release({ protocol: '', read: async () => { throw Error('Must not read'); }, send: async () => {}, close: async () => { closes++; } });
  await draining; assert.equal(closes, 1);
});

test('gateway shutdown aborts a long read and closes the exact upstream peer once', { timeout: 3000 }, async t => {
  let reading!: () => void, closes = 0, aborted = false;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const f = await fixture(t, async () => ({ protocol: '', send: async () => {}, close: async () => { closes++; },
    read: signal => new Promise((_resolve, reject) => { reading(); signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }); }) }));
  const ws = f.connect(); const closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
  await started; const draining = f.gateway.close(); await closed; await draining;
  assert.equal(aborted, true); assert.equal(closes, 1);
});

test('revoke timer is single flight and listener close waits original async authority', { timeout: 5000 }, async t => {
  let reading!: () => void, entered!: () => void, release!: () => void, blocking = false, checks = 0;
  const started = new Promise<void>(resolve => { reading = resolve; }), checked = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async () => ({ protocol: '', send: async () => {}, close: async () => {},
    read: signal => new Promise((_resolve, reject) => { reading(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) }),
    async () => { if (blocking) { checks++; entered(); await gate; } });
  const ws = f.connect(), closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
  await started; blocking = true; await checked;
  await new Promise(resolve => setTimeout(resolve, 550)); assert.equal(checks, 1);
  let drained = false; const closing = f.upgrade.close().then(() => { drained = true; }); await closed;
  assert.equal(drained, false); release(); await closing;
});

test('listener closes browser immediately but retains ignored-abort input until original ACK', { timeout: 5000 }, async t => {
  let entered!: () => void, release!: () => void, closes = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async () => ({ protocol: '', send: async () => { entered(); await gate; }, close: async () => { closes++; },
    read: signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }));
  const ws = f.connect(); await once(ws, 'open'); ws.send('private input'); await started;
  const closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
  let drained = false; const closing = f.upgrade.close().then(() => { drained = true; }); await closed;
  assert.equal(drained, false); release(); await closing; assert.equal(closes, 1);
});
