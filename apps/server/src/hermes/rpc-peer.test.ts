import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { HermesRemoteError, HermesRpcPeer, HermesTransportError, type HermesRpcOptions } from './rpc-peer.js';

function fixture(t: TestContext, options: Partial<HermesRpcOptions> = {}) {
  const output = new PassThrough();
  const sent: Record<string, unknown>[] = [];
  const input = new Writable({ write(chunk, _encoding, done) { sent.push(JSON.parse(chunk.toString())); done(); } });
  const notifications: unknown[] = [];
  const closed: string[] = [];
  const peer = new HermesRpcPeer(output, input, { timeoutMs: 500,
    onNotification: (method, params) => notifications.push({ method, params }), onClose: reason => closed.push(reason), ...options });
  t.after(() => peer.close());
  const emit = (frame: unknown) => output.write(JSON.stringify(frame) + '\n');
  const ack = (index: number, result: unknown) => emit({ jsonrpc: '2.0', id: sent[index]!.id, result });
  return { peer, output, input, sent, notifications, closed, emit, ack };
}

const unknown = (reason?: string) => (e: unknown) => e instanceof HermesTransportError
  && e.delivery === 'unknown' && (reason === undefined || e.reason === reason);
const notSent = (reason: string) => (e: unknown) => e instanceof HermesTransportError && e.delivery === 'not_sent' && e.reason === reason;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('Hermes RPC correlates out-of-order responses and delivers terminal-before-ACK notifications', async t => {
  const f = fixture(t);
  const first = f.peer.request('prompt.submit', { session_id: 'live', text: 'hi' });
  const second = f.peer.request('ping');
  f.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', session_id: 'live', payload: { status: 'complete' } } });
  f.ack(1, { pong: true }); f.ack(0, { status: 'streaming' });
  assert.deepEqual(await second, { pong: true }); assert.deepEqual(await first, { status: 'streaming' });
  assert.equal(f.notifications.length, 1); assert.equal(f.sent.length, 2);
  f.ack(0, { status: 'duplicate' }); await tick(); assert.equal(f.sent.length, 2);
});

test('Hermes RPC remote errors preserve code but not native secret text or data', async t => {
  const f = fixture(t); const result = f.peer.request('prompt.submit');
  f.emit({ jsonrpc: '2.0', id: f.sent[0]!.id, error: { code: 5071, message: 'SECRET', data: { key: 'SECRET' } } });
  await assert.rejects(result, (e: unknown) => e instanceof HermesRemoteError && e.code === 5071 && !JSON.stringify(e).includes('SECRET') && !e.message.includes('SECRET'));
});

test('Hermes RPC uncorrelated parse errors fail all pending work without assuming rejection', async t => {
  const f = fixture(t);
  const first = assert.rejects(f.peer.request('prompt.submit'), unknown('uncorrelated_native_error'));
  const second = assert.rejects(f.peer.request('ping'), unknown('uncorrelated_native_error'));
  f.emit({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'SECRET' } });
  await Promise.all([first, second]); assert.equal(f.closed.length, 1);
});

test('Hermes RPC async notification callbacks fail closed without an unhandled rejection', async t => {
  const f = fixture(t, { async onNotification() { throw new Error('SECRET'); } });
  const pending = assert.rejects(f.peer.request('ping'), unknown('async_notification_handler'));
  f.emit({ jsonrpc: '2.0', method: 'event', params: {} });
  await pending; await tick(); assert.equal(f.closed.length, 1);
});

test('Hermes RPC server requests are denied, never treated as approval or notification', async t => {
  const f = fixture(t);
  f.emit({ jsonrpc: '2.0', id: 'server-approval', method: 'approval.request', params: { command: 'SECRET' } });
  await tick();
  assert.deepEqual(f.sent, [{ jsonrpc: '2.0', id: 'server-approval', error: { code: -32601, message: 'Server requests are not supported by this client' } }]);
  assert.equal(f.notifications.length, 0);
});

test('Hermes RPC timeout is unknown and never retries; a late ACK cannot settle another request', async t => {
  const f = fixture(t, { timeoutMs: 20 });
  await assert.rejects(f.peer.request('prompt.submit'), unknown('timeout'));
  assert.equal(f.sent.length, 1);
  const ping = f.peer.request('ping'); f.ack(0, { status: 'streaming' }); f.ack(1, { pong: true });
  assert.deepEqual(await ping, { pong: true }); assert.equal(f.sent.length, 2);
});

test('Hermes RPC EOF, malformed output and consumer failure reject pending work as unknown', async t => {
  for (const mode of ['eof', 'partial', 'malformed', 'handler']) {
    const f = fixture(t, mode === 'handler' ? { onNotification() { throw new Error('SECRET'); } } : {});
    const rejected = assert.rejects(f.peer.request('prompt.submit'), unknown());
    if (mode === 'eof') f.output.end();
    if (mode === 'partial') f.output.end('{');
    if (mode === 'malformed') f.output.write('SECRET\n');
    if (mode === 'handler') f.emit({ jsonrpc: '2.0', method: 'event', params: {} });
    await rejected;
    assert.equal(f.closed.length, 1); assert.ok(!f.closed[0]!.includes('SECRET'));
    await assert.rejects(f.peer.request('ping'), notSent('closed'));
    assert.equal(f.sent.length, 1);
  }
});

test('Hermes RPC admission limits reject before write; close settles existing work once', async t => {
  const f = fixture(t, { maxInFlight: 1, maxFrameBytes: 256 });
  const pending = assert.rejects(f.peer.request('ping'), unknown('closed'));
  await assert.rejects(f.peer.request('ping'), notSent('inflight_limit'));
  f.peer.close(); f.peer.close(); await pending;
  assert.equal(f.sent.length, 1); assert.equal(f.closed.length, 1);
  const g = fixture(t, { maxFrameBytes: 128 });
  await assert.rejects(g.peer.request('x', 'x'.repeat(256)), notSent('frame_limit'));
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  await assert.rejects(g.peer.request('x', cycle), notSent('invalid_params'));
  assert.equal(g.sent.length, 0);
});

test('Hermes RPC write error is ambiguous even when local write fails', async t => {
  const output = new PassThrough();
  const input = new Writable({ write(_chunk, _encoding, done) { done(new Error('SECRET')); } });
  const peer = new HermesRpcPeer(output, input, { onNotification() {} }); t.after(() => peer.close());
  await assert.rejects(peer.request('prompt.submit'), unknown('stdin_error'));
});

test('Hermes RPC bounds buffered writes without interpreting write(false) as rejection', async t => {
  const output = new PassThrough();
  let release: (() => void) | undefined;
  const input = new Writable({ highWaterMark: 1, write(_chunk, _encoding, done) { release = done; } });
  const peer = new HermesRpcPeer(output, input, { maxFrameBytes: 256, onNotification() {} }); t.after(() => peer.close());
  const first = assert.rejects(peer.request('prompt.submit', { text: 'x'.repeat(80) }), unknown('closed'));
  await assert.rejects(peer.request('prompt.submit', { text: 'x'.repeat(80) }), notSent('backpressure'));
  peer.close(); release?.(); await first;
});

test('Hermes RPC works across real child pipes without launching Hermes or a model', { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createInterface } from 'node:readline';
    console.log(JSON.stringify({jsonrpc:'2.0',method:'event',params:{type:'gateway.ready',payload:{change_events:true,replay_epoch:'fixture'}}}));
    for await (const line of createInterface({input:process.stdin})) {
      const request=JSON.parse(line);
      console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{pong:true}}));
    }
  `], { cwd: process.cwd(), env: {}, stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  let ready = false;
  const peer = new HermesRpcPeer(child.stdout!, child.stdin!, { onNotification: (_method, params) => {
    ready = (params as { type: string }).type === 'gateway.ready';
  } });
  t.after(async () => { peer.close(); if (child.exitCode === null) child.kill(); await exited; });
  assert.deepEqual(await peer.request('ping'), { pong: true }); assert.equal(ready, true);
});
