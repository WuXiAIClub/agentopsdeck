import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ConnectorClient } from './connector-client.js';
import { HubEventBroker, HubEventBrokers } from './event-broker.js';
import { HubStore } from './hub-store.js';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Condition did not converge'); await delay(5); }
}

function fixture() {
  const store = new HubStore(join(mkdtempSync(join(tmpdir(), 'agentopsdeck-broker-')), 'hub.sqlite'), 'synthetic');
  store.upsertConnection({ id: 'node', label: 'Node', connectorUrl: 'http://node', capabilities: ['events'], credentialToken: 'one' });
  const requests: Request[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let cancelled = 0;
  let reject = false;
  const client = (id: string) => new ConnectorClient('http://node', store.getCredentialToken(id)!, async (request) => {
    requests.push(request);
    if (reject) return new Response(null, { status: 403 });
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { streams.push(controller); controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: \n\n')); },
      cancel() { cancelled++; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const broker = new HubEventBroker(store, client, 'default', 10, 10);
  const emit = (id: string, at = streams.length - 1) => streams[at]!.enqueue(new TextEncoder().encode(`id: ${id}\nevent: message.created\ndata: ${JSON.stringify({ type: 'message.created', sessionKey: 'same', payload: { text: id } })}\n\n`));
  return { store, broker, client, emit, requests, streams, cancelled: () => cancelled, deny: () => { reject = true; },
    close: async () => { await broker.drain(); await store.close(); } };
}

test('scoped interests open only requested nodes and coexist with owner-wide subscriptions', async () => {
  const f = fixture();
  const resolved: string[] = [];
  const broker = new HubEventBroker(f.store, id => { resolved.push(id); return f.client(id); }, 'default', 10, 10);
  try {
    f.store.upsertConnection({ id: 'other', label: 'Other', connectorUrl: 'http://other', capabilities: ['events'], credentialToken: 'two' });
    const a = broker.acquire('node'), b = broker.acquire('node');
    await until(() => f.requests.length === 1);
    await delay(30);
    assert.equal(resolved.includes('other'), false, 'scoped interest never resolves another node credential');
    const owner = broker.acquire();
    await until(() => f.requests.length === 2);
    a(); a();
    assert.equal(f.cancelled(), 0);
    owner();
    await until(() => f.cancelled() === 1);
    assert.deepEqual([...broker.visibleDomains().keys()], ['node']);
    b();
    await until(() => f.cancelled() === 2);
    assert.equal(broker.visibleDomains().size, 0);
    assert.equal((broker as any).nodeSubscribers.size, 0);
    assert.equal((broker as any).timer, undefined);
  } finally { await broker.drain(); await f.close(); }
});

test('broker registry shares within owner, isolates owners and bounds total subscriptions', async () => {
  const f = fixture();
  const other = f.store.createUser('Other owner');
  f.store.upsertConnection({ id: 'node', ownerUserId: other.id, label: 'Other', connectorUrl: 'http://other', capabilities: ['events'], credentialToken: 'other' });
  const resolved: string[] = [];
  const registry = new HubEventBrokers(f.store, (id, _maintenance, owner) => {
    resolved.push(owner!);
    return f.client(id);
  });
  const handles: ReturnType<HubEventBrokers['acquire']>[] = [];
  try {
    handles.push(registry.acquire('default', 'node'), registry.acquire('default'), registry.acquire(other.id, 'node'));
    assert.equal(handles[0]!.events, handles[1]!.events);
    assert.notEqual(handles[0]!.events, handles[2]!.events);
    await until(() => f.requests.length === 2);
    assert.ok(resolved.includes('default') && resolved.includes(other.id));
    while (handles.length < 256) handles.push(registry.acquire('default', 'node'));
    assert.throws(() => registry.acquire(other.id), /capacity/);
    assert.equal(f.requests.length, 2, 'subscriber count does not multiply upstreams');
    handles.pop()!.release();
    handles.push(registry.acquire(other.id, 'node'));
    for (const handle of handles) { handle.release(); handle.release(); }
    await until(() => f.cancelled() === 2);
    // cancel() invocation is not the original reader/pump settlement ACK.
    await Promise.all(handles.map(handle => handle.events.drain()));
    assert.equal((registry as any).brokers.size, 0);
    const reopened = registry.acquire('default', 'node');
    await until(() => f.requests.length === 3);
    registry.close();
    assert.equal(reopened.events.isClosed, true);
    await until(() => f.cancelled() === 3);
    reopened.release();
    assert.throws(() => registry.acquire('default'), /closed/);
  } finally { registry.close(); for (const handle of handles) handle.release(); await registry.drain(); await f.close(); }
});

test('failed broker acquisition rolls back interests and leaves no registry entries', async () => {
  const f = fixture();
  const registry = new HubEventBrokers(f.store, f.client);
  const list = f.store.connectionDirectoryVersion.bind(f.store);
  try {
    f.store.connectionDirectoryVersion = () => { throw new Error('synthetic storage failure'); };
    for (let i = 0; i < 300; i++) assert.throws(() => registry.acquire('default', 'node'), /storage failure/);
    assert.equal((registry as any).brokers.size, 0);
    assert.equal((registry as any).subscribers, 0);
    assert.throws(() => f.broker.acquire(), /storage failure/);
    assert.equal((f.broker as any).subscribers, 0);
    assert.equal((f.broker as any).allNodes, 0);
    assert.equal(f.broker.closedSignal.aborted, true);
    f.store.connectionDirectoryVersion = list;
    const handles = Array.from({ length: 256 }, () => registry.acquire('default', 'node'));
    for (const handle of handles) handle.release();
    assert.equal((registry as any).subscribers, 0);
  } finally { await registry.drain(); await f.close(); }
});

test('periodic storage failure closes upstreams and wakes subscribers without escaping a timer', async () => {
  const f = fixture();
  try {
    const release = f.broker.acquire();
    await until(() => f.requests.length === 1);
    const controller = new AbortController();
    const waiting = f.broker.wait(f.broker.revision, controller.signal);
    f.store.listConnectionsAsync = async () => { throw new Error('synthetic timer failure'); };
    await until(() => f.broker.isClosed);
    await waiting;
    await until(() => f.cancelled() === 1);
    release(); release();
    assert.equal((f.broker as any).subscribers, 0);
    assert.equal((f.broker as any).listeners.size, 0);
    assert.equal((f.broker as any).timer, undefined);
  } finally { await f.close(); }
});

test('release during storage failure still returns all registry capacity', async () => {
  const f = fixture();
  const registry = new HubEventBrokers(f.store, f.client);
  try {
    const owner = registry.acquire('default');
    const scoped = registry.acquire('default', 'node');
    await until(() => f.requests.length === 1);
    f.store.listConnectionsAsync = async () => { throw new Error('synthetic release failure'); };
    owner.release(); owner.release();
    await until(() => scoped.events.isClosed);
    scoped.release(); scoped.release();
    assert.equal((registry as any).subscribers, 0);
    assert.equal((registry as any).brokers.size, 0);
    await until(() => f.cancelled() === 1);
  } finally { await registry.drain(); await f.close(); }
});

test('broker attaches pinned SessionRef to durable replay without changing legacy event keys', async () => {
  const f = fixture();
  try {
    const nodeId = 'node_00000000-0000-4000-8000-000000000001';
    f.store.pinConnectionNode('node', 'default', f.store.connectionAuthority('node')!, nodeId);
    const release = f.broker.acquire();
    await until(() => f.requests.length === 1);
    f.emit('ref-event');
    await until(() => f.store.upstreamCursor('node', f.client('node').eventDomain) === 'ref-event');
    const event = f.store.deliveryPage(undefined, f.broker.visibleDomains()).events.find((item) => item.type === 'message.created')!;
    assert.deepEqual(event.sessionRef, { nodeId, runtimeId: 'openclaw', nativeSessionKey: 'same' });
    assert.equal(event.remoteSessionKey, 'same');
    assert.equal(event.hubSessionId, 'node:c2FtZQ');
    release();
  } finally { await f.close(); }
});

test('three native interaction notifications keep scoped identities and carry no question or answer data', async () => {
  const f = fixture();
  try {
    const nodeId = 'node_00000000-0000-4000-8000-000000000002';
    f.store.pinConnectionNode('node', 'default', f.store.connectionAuthority('node')!, nodeId);
    const release = f.broker.acquire();
    await until(() => f.requests.length === 1);
    const agents = ['codex', 'claude-code', 'ghcp'];
    for (const agent of agents) {
      const key = `${agent}:same-native-session`;
      f.streams[0]!.enqueue(new TextEncoder().encode(`id: interaction-${agent}\nevent: interaction.updated\ndata: ${JSON.stringify({ type: 'interaction.updated', sessionKey: key, payload: {} })}\n\n`));
    }
    await until(() => f.store.upstreamCursor('node', f.client('node').eventDomain) === 'interaction-ghcp');
    const events = f.store.deliveryPage(undefined, f.broker.visibleDomains()).events.filter(e => e.type === 'interaction.updated');
    assert.equal(events.length, 3);
    for (const [index, event] of events.entries()) {
      const agent = agents[index]!, key = `${agent}:same-native-session`;
      assert.deepEqual(event.sessionRef, { nodeId, runtimeId: agent, nativeSessionKey: 'same-native-session' });
      assert.equal(event.sessionKey, `node:${Buffer.from(key).toString('base64url')}`);
      assert.equal(event.remoteSessionKey, key);
      assert.deepEqual(event.payload, {}, 'sensitive interaction bodies must be read via owner-authorized API');
    }
    release();
    await until(() => f.cancelled() === 1);
  } finally { await f.close(); }
});

test('broker shares one upstream across 40 browsers and cancels only when the last leaves', async () => {
  const f = fixture();
  try {
    const releases = Array.from({ length: 40 }, () => f.broker.acquire());
    await until(() => f.requests.length === 1);
    f.emit('first');
    await until(() => f.store.upstreamCursor('node', f.client('node').eventDomain) === 'first');
    assert.equal(f.store.deliveryPage(undefined, f.broker.visibleDomains()).events.filter((event) => event.type === 'message.created').length, 1);
    for (const release of releases.slice(0, -1)) release();
    assert.equal(f.cancelled(), 0);
    releases.at(-1)!();
    await until(() => f.cancelled() === 1);
    const release = f.broker.acquire();
    await until(() => f.requests.length === 2);
    assert.equal(f.requests[1]!.headers.get('last-event-id'), 'first');
    release();
  } finally { await f.close(); }
});

test('credential rotation hides old cached payload immediately, cancels old stream and starts without its cursor', async () => {
  const f = fixture();
  try {
    f.broker.acquire(); await until(() => f.streams.length === 1);
    f.emit('private-old'); await until(() => f.store.upstreamCursor('node', f.client('node').eventDomain) === 'private-old');
    f.store.upsertConnection({ id: 'node', label: 'Node', connectorUrl: 'http://node', credentialToken: 'two' });
    assert.equal(f.store.deliveryPage(undefined, f.broker.visibleDomains()).events.length, 0);
    await until(() => f.streams.length === 2);
    assert.equal(f.cancelled(), 1);
    assert.equal(f.requests[1]!.headers.get('last-event-id'), null);
    assert.equal(f.requests[1]!.headers.get('authorization'), 'Bearer two');
    f.emit('new'); await until(() => f.store.upstreamCursor('node', f.client('node').eventDomain) === 'new');
    const messages = f.store.deliveryPage(undefined, f.broker.visibleDomains()).events.filter((event) => event.type === 'message.created');
    assert.deepEqual(messages.map((event) => event.remoteEventId), ['new']);
  } finally { await f.close(); }
});

test('revoked upstream denies cached events and a disabled node stops reconnecting', async () => {
  const f = fixture();
  try {
    f.broker.acquire(); await until(() => f.streams.length === 1);
    f.emit('private'); await until(() => f.store.upstreamCursor('node', f.client('node').eventDomain) === 'private');
    f.deny(); f.streams[0]!.close();
    await until(() => f.broker.deniedConnections().length === 1);
    assert.equal(f.broker.visibleDomains().size, 0);
    assert.equal(f.store.deliveryPage(undefined, f.broker.visibleDomains()).events.length, 0);
    f.store.upsertConnection({ id: 'node', label: 'Node', connectorUrl: 'http://node', status: 'disabled' });
    await delay(30);
    assert.equal(f.broker.visibleDomains().size, 0);
  } finally { await f.close(); }
});

test('a failing node does not restart the healthy node or borrow its cursor', async () => {
  const f = fixture();
  let badAttempts = 0;
  let broker: HubEventBroker | undefined;
  try {
    f.store.upsertConnection({ id: 'bad', label: 'Bad', connectorUrl: 'http://bad', capabilities: ['events'], credentialToken: 'bad-secret' });
    broker = new HubEventBroker(f.store, (id) => id === 'node' ? f.client(id) : new ConnectorClient('http://bad', 'bad-secret', async () => { badAttempts++; throw new Error('offline'); }), 'default', 10, 10);
    broker.acquire(); await until(() => f.streams.length === 1 && badAttempts >= 2);
    f.emit('healthy'); await until(() => f.store.upstreamCursor('node', f.client('node').eventDomain) === 'healthy');
    assert.equal(f.requests.length, 1);
    assert.equal(f.store.upstreamCursor('bad', 'any'), undefined);
    assert.equal(f.cancelled(), 0);
  } finally { await broker?.drain(); await f.close(); }
});

test('subscriber cancellation releases its wait listener and broker shutdown aborts its stream', async () => {
  const f = fixture();
  try {
    f.broker.acquire(); await until(() => f.streams.length === 1);
    const controller = new AbortController();
    const waiting = f.broker.wait(f.broker.revision, controller.signal);
    controller.abort(); await waiting;
    assert.equal((f.broker as any).listeners.size, 0);
    f.broker.close(); await until(() => f.cancelled() === 1);
    assert.equal((f.broker as any).upstreams.size, 0);
  } finally { await f.close(); }
});

test('Hub journal survives restart, separates user/node/domain, deduplicates and atomically advances node cursor', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-journal-')), 'hub.sqlite');
  let store = new HubStore(file, 'synthetic');
  const event = { envConnectionId: 'node', type: 'message.created', ts: 1, payload: { text: 'private' } };
  store.appendDelivery(event, 'domain', 'same');
  assert.equal(store.appendDelivery(event, 'domain', 'same'), false);
  const cursor = store.latestDeliveryCursor();
  store.appendDelivery({ ...event, envConnectionId: 'other' }, 'domain', 'same');
  store.appendDelivery(event, 'domain', 'same', 'other-user');
  (store as any).db.close(); store = new HubStore(file, 'synthetic');
  try {
    assert.equal(store.upstreamCursor('node', 'domain'), 'same');
    assert.equal(store.upstreamCursor('node', 'changed'), undefined);
    assert.equal(store.deliveryPage(undefined, new Map([['node', 'domain']])).events.length, 1);
    assert.equal(store.deliveryPage(cursor, new Map([['other', 'domain']])).events.length, 1);
    assert.equal(store.deliveryPage(cursor, new Map([['node', 'domain']]), 'other-user').reset, true);
    assert.equal(store.deliveryPage(undefined, new Map([['node', 'changed']])).events.length, 0);
    (store as any).db.exec("CREATE TRIGGER reject_cursor BEFORE UPDATE ON remote_event_cursors BEGIN SELECT RAISE(ABORT, 'synthetic crash'); END");
    const before = store.latestDeliveryCursor();
    assert.throws(() => store.appendDelivery(event, 'domain', 'failed'), /synthetic crash/);
    assert.equal(store.latestDeliveryCursor(), before);
    assert.equal(store.upstreamCursor('node', 'domain'), 'same');
  } finally { (store as any).db.close(); }
});

test('journal count and byte retention reset expired cursors without dropping the durable upstream checkpoint', async () => {
  const f = fixture();
  try {
    const event = { envConnectionId: 'node', type: 'message.created', ts: 1, payload: {} };
    f.store.appendDelivery(event, 'domain', '0');
    const first = f.store.latestDeliveryCursor();
    for (let i = 1; i <= 2050; i++) f.store.appendDelivery(event, 'domain', String(i));
    assert.equal(f.store.deliveryPage(first, new Map()).reset, true);
    assert.equal((f.store as any).db.prepare('SELECT COUNT(*) AS n FROM hub_events').get().n, 2048);
    for (let i = 0; i < 40; i++) f.store.appendDelivery({ ...event, payload: 'x'.repeat(240 * 1024) }, 'domain', `large-${i}`);
    const bytes = (f.store as any).db.prepare('SELECT SUM(length(CAST(payload_json AS BLOB))) AS n FROM hub_events').get().n;
    assert.ok(bytes <= 8 * 1024 * 1024);
    assert.equal(f.store.upstreamCursor('node', 'domain'), 'large-39');
    assert.throws(() => f.store.appendDelivery({ ...event, payload: 'x'.repeat(256 * 1024) }, 'domain', 'oversized'), /size limit/);
    assert.equal(f.store.upstreamCursor('node', 'domain'), 'large-39');
  } finally { await f.close(); }
});
