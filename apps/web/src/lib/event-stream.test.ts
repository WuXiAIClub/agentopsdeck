import assert from 'node:assert/strict';
import test from 'node:test';
import { clearEventStreamDiagnostics, createReconnectingEventStream, readEventStreamDiagnostics, type StreamConnection } from './event-stream.js';

class FakeSource {
  readyState = 0;
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (event: MessageEvent<string>) => void;
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  constructor(readonly url: string) {}
  addEventListener(name: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(name, listener); }
  close() { this.readyState = 2; }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(type: string, id = '') { this.listeners.get(type)?.({ type, data: '{}', lastEventId: id } as MessageEvent<string>); }
}
function fixture() {
  const sources: FakeSource[] = [];
  const connections: StreamConnection[] = [];
  let opens = 0, messages = 0;
  const stream = createReconnectingEventStream({
    url: () => '/api/hub/v1/events/stream', eventTypes: ['message.created', 'stream.reset'],
    createSource: url => { const source = new FakeSource(url); sources.push(source); return source as unknown as EventSource; },
    onConnection: state => connections.push(state), onOpen: () => { opens++; }, onMessage: () => { messages++; },
    now: () => Date.now(),
  });
  stream.start();
  const source = (index: number) => { const value = sources[index]; assert.ok(value); return value; };
  return { stream, sources, source, connections, opens: () => opens, messages: () => messages };
}

test('recreates terminal CLOSED sources, restores cursor, and requests catch-up', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  f.source(0).open(); f.source(0).emit('message.created', 'hub_123');
  f.source(0).close(); f.source(0).onerror?.();
  assert.equal(f.connections.at(-1), 'reconnecting');
  t.mock.timers.tick(1000);
  assert.equal(f.sources.length, 2);
  assert.match(f.source(1).url, /lastEventId=hub_123/);
  f.source(1).open();
  assert.equal(f.connections.at(-1), 'connected');
  assert.equal(f.opens(), 2);
  f.source(0).onerror?.(); f.source(0).emit('message.created');
  assert.equal(f.connections.at(-1), 'connected');
  assert.equal(f.messages(), 1);
  f.stream.stop();
});

test('navigation reuses healthy connection and recovers a silently closed source', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); f.source(0).open();
  for (let n = 0; n < 10; n++) f.stream.ensureConnected();
  assert.equal(f.sources.length, 1);
  f.source(0).close(); f.stream.ensureConnected();
  t.mock.timers.tick(1000);
  assert.equal(f.sources.length, 2);
  f.source(1).open(); f.stream.stop();
  assert.equal(f.connections.at(-1), 'connecting');
  f.source(1).onerror?.(); t.mock.timers.tick(60_000);
  assert.equal(f.sources.length, 2);
});

test('expired empty-journal reset clears legacy cursor before the next reconnect', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); f.source(0).open();
  f.source(0).emit('message.created', 'hub_legacy');
  f.source(0).emit('stream.reset', '');
  f.source(0).onerror?.(); t.mock.timers.tick(1000);
  assert.equal(f.source(1).url, '/api/hub/v1/events/stream');
  f.stream.stop();
});

test('persistent outage shows disconnected after grace but keeps retrying', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); f.source(0).onerror?.();
  t.mock.timers.tick(1000); f.source(1).onerror?.();
  t.mock.timers.tick(2000); f.source(2).onerror?.();
  t.mock.timers.tick(4000); f.source(3).onerror?.();
  assert.equal(f.connections.at(-1), 'reconnecting');
  t.mock.timers.tick(3000);
  assert.equal(f.connections.at(-1), 'disconnected');
  t.mock.timers.tick(5000); f.source(4).open();
  assert.equal(f.connections.at(-1), 'connected');
  f.stream.stop();
});

test('heartbeats keep idle streams alive without refreshing messages; silent stalls reconnect', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); f.source(0).open();
  for (let n = 0; n < 8; n++) { t.mock.timers.tick(10_000); f.source(0).emit('heartbeat'); }
  assert.equal(f.sources.length, 1);
  assert.equal(f.messages(), 0); assert.equal(f.opens(), 1);
  for (let n = 0; n < 4; n++) t.mock.timers.tick(15_000);
  t.mock.timers.tick(1000);
  assert.equal(f.sources.length, 2);
  f.stream.stop();
});

test('a transient URL supplier failure schedules recovery without manual navigation', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let calls = 0; const sources: FakeSource[] = [];
  const stream = createReconnectingEventStream({
    url: () => { if (++calls === 1) throw Error('private-marker'); return '/events'; }, eventTypes: [],
    createSource: url => { const source = new FakeSource(url); sources.push(source); return source as unknown as EventSource; },
    onConnection() {}, onMessage() {}, onOpen() {},
  });
  t.after(() => stream.stop());
  assert.doesNotThrow(() => stream.start());
  t.mock.timers.tick(1000); assert.equal(sources.length, 1); sources[0]!.open();
});

test('repeated immediate opens and heartbeats do not defeat reconnect backoff', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); t.after(() => f.stream.stop());
  for (const [index, wait] of [1000, 2000, 4000, 8000, 15000].entries()) {
    f.source(index).open(); f.source(index).emit('heartbeat'); f.source(index).onerror?.();
    t.mock.timers.tick(wait - 1); assert.equal(f.sources.length, index + 1);
    t.mock.timers.tick(1); assert.equal(f.sources.length, index + 2);
  }
});

test('connection callback can stop the stream without stale onOpen or message effects', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let source: FakeSource | undefined, opens = 0, messages = 0;
  const stream = createReconnectingEventStream({
    url: () => '/events', eventTypes: ['message.created'],
    createSource: url => { source = new FakeSource(url); return source as unknown as EventSource; },
    onConnection(state) { if (state === 'connected') stream.stop(); },
    onMessage() { messages++; }, onOpen() { opens++; },
  });
  stream.start(); source!.emit('message.created', 'private-cursor');
  assert.equal(opens, 0); assert.equal(messages, 0);
  t.mock.timers.tick(60_000); assert.equal(source!.readyState, 2);
});

test('stopping from the URL supplier cannot create a detached source', t => {
  let creates = 0;
  const stream = createReconnectingEventStream({
    url: () => { stream.stop(); return '/events'; }, eventTypes: [],
    createSource: url => { creates++; return new FakeSource(url) as unknown as EventSource; },
    onConnection() {}, onMessage() {}, onOpen() {},
  });
  t.after(() => stream.stop());
  stream.start(); assert.equal(creates, 0);
});

test('stopping from the failure callback cannot leave orphan retry timers', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const connections: StreamConnection[] = []; let source: FakeSource | undefined;
  const stream = createReconnectingEventStream({
    url: () => '/events', eventTypes: [],
    createSource: url => { source = new FakeSource(url); return source as unknown as EventSource; },
    onConnection(state) { connections.push(state); if (state === 'reconnecting') stream.stop(); },
    onMessage() {}, onOpen() {},
  });
  stream.start(); source!.onerror?.(); t.mock.timers.tick(60_000);
  assert.equal(connections.at(-1), 'connecting');
});

test('healthy traffic resets backoff only after a sustained connected interval', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); t.after(() => f.stream.stop());
  f.source(0).open(); f.source(0).onerror?.(); t.mock.timers.tick(1000);
  f.source(1).open(); f.source(1).onerror?.(); t.mock.timers.tick(2000);
  f.source(2).open(); t.mock.timers.tick(10_000); f.source(2).emit('heartbeat'); f.source(2).onerror?.();
  t.mock.timers.tick(999); assert.equal(f.sources.length, 3);
  t.mock.timers.tick(1); assert.equal(f.sources.length, 4);
});

test('silent recovery uses monotonic elapsed time despite wall-clock rollback', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let elapsed = 0, wallTime = 100_000; const sources: FakeSource[] = [];
  t.mock.method(Date, 'now', () => wallTime);
  const stream = createReconnectingEventStream({
    url: () => '/events', eventTypes: [], now: () => elapsed,
    createSource: url => { const source = new FakeSource(url); sources.push(source); return source as unknown as EventSource; },
    onConnection() {}, onMessage() {}, onOpen() {},
  });
  t.after(() => stream.stop()); stream.start(); sources[0]!.open();
  wallTime = 0;
  for (let n = 0; n < 3; n++) { elapsed += 15_000; t.mock.timers.tick(15_000); }
  assert.equal(sources[0]!.readyState, 2); t.mock.timers.tick(1000); assert.equal(sources.length, 2);
});

test('a source close exception cannot prevent fenced retry or admit stale packets', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); t.after(() => f.stream.stop()); f.source(0).open();
  f.source(0).close = () => { throw Error('private-close-marker'); };
  f.source(0).onerror?.(); f.source(0).emit('message.created');
  assert.equal(f.messages(), 0); t.mock.timers.tick(1000); assert.equal(f.sources.length, 2);
});

test('a source returned after its factory stops the stream is immediately disposed', () => {
  let source: FakeSource | undefined;
  const stream = createReconnectingEventStream({
    url: () => '/events', eventTypes: [],
    createSource: url => { stream.stop(); source = new FakeSource(url); return source as unknown as EventSource; },
    onConnection() {}, onMessage() {}, onOpen() {},
  });
  stream.start(); assert.equal(source!.readyState, 2);
});

test('stop/start from a URL callback unwinds before binding the new source', async () => {
  let calls = 0; const sources: FakeSource[] = [];
  const stream = createReconnectingEventStream({
    url: () => { if (++calls === 1) { stream.stop(); stream.start(); } return '/events'; }, eventTypes: [],
    createSource: url => { const source = new FakeSource(url); sources.push(source); return source as unknown as EventSource; },
    onConnection() {}, onMessage() {}, onOpen() {},
  });
  try { stream.start(); await Promise.resolve(); assert.equal(calls, 2); assert.equal(sources.length, 1); }
  finally { stream.stop(); }
});

test('recovery diagnostics are bounded, copied and contain no URL/cursor/exception text', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); clearEventStreamDiagnostics();
  t.after(clearEventStreamDiagnostics);
  const f = fixture(); t.after(() => f.stream.stop());
  for (let index = 0; index < 80; index++) {
    f.source(index).open(); f.source(index).emit('message.created', 'private-cursor'); f.source(index).onerror?.();
    t.mock.timers.tick(15_000);
  }
  const rows = readEventStreamDiagnostics(); assert.equal(rows.length, 128);
  assert.ok(rows.every(row => Number.isFinite(row.sequence) && row.attempts <= 5 && row.retryMs <= 15_000));
  assert.doesNotMatch(JSON.stringify(rows), /private-|lastEventId|\/api\//);
  rows[0]!.attempts = 100; assert.ok(readEventStreamDiagnostics()[0]!.attempts <= 5);
  clearEventStreamDiagnostics(); assert.deepEqual(readEventStreamDiagnostics(), []);
});

test('wake bypasses pending retry backoff and immediately replaces half-open stale streams after backgrounding', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); t.after(() => f.stream.stop());
  f.source(0).open(); f.source(0).onerror?.();
  assert.equal(f.sources.length, 1);
  f.stream.wake();
  assert.equal(f.sources.length, 2, 'wake cancels pending backoff timer and reconnects immediately');
  f.source(1).open();
  t.mock.timers.tick(5_000);
  f.stream.wake();
  assert.equal(f.sources.length, 2, 'fresh stream (<15s since heartbeat) is reused on wake');
  t.mock.timers.tick(10_000);
  f.stream.wake();
  assert.equal(f.sources.length, 3, 'half-open stream silent for >=15s reconnects immediately on wake');
});
