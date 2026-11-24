import assert from 'node:assert/strict';
import test from 'node:test';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createConnectorSessionDiscovery, type ConnectorSessionDiscoveryOptions } from './session-discovery.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function fixture() {
  const deck = new DeckStore(), key = 'agent:main:dashboard:original';
  const counts = { directories: 0, gateway: 0, local: 0, disk: 0, replace: 0, usage: 0 };
  const state = { connection: 'original', payload: { sessions: [{ key }] } as unknown, local: [] as any[] };
  const hooks: { disk?: () => Promise<void>; gateway?: () => Promise<void>; directories?: () => void } = {};
  const logs: string[] = [];
  const usage: Awaited<ReturnType<NonNullable<ConnectorSessionDiscoveryOptions['readDiskUsage']>>> = new Map();
  const options: ConnectorSessionDiscoveryOptions = {
    gateway: { connectionId: () => state.connection, requestWithConnection: async <T>(method: string, input: unknown) => {
      assert.equal(method, 'sessions.list');
      assert.deepEqual(input, { includeGlobal: true, includeUnknown: true, includeDerivedTitles: true, limit: 100 });
      const connectionId = state.connection; counts.gateway++; await hooks.gateway?.();
      return { connectionId, payload: state.payload as T };
    } },
    projection: { replaceSessions: rows => { counts.replace++; deck.replaceSessions(rows); },
      applySessionUsage: rows => { counts.usage++; deck.applySessionUsage(rows); } },
    local: false, configured: true,
    readLocal: async () => { counts.local++; return state.local; },
    refreshDirectories: () => { counts.directories++; hooks.directories?.(); },
    readDiskUsage: async () => { counts.disk++; await hooks.disk?.(); return usage; },
    diagnostics: new PerformanceDiagnostics(line => logs.push(line)),
  };
  return { deck, key, counts, state, hooks, logs, usage, options };
}

test('unconfigured discovery is inert, refreshes original SDK directories only and never queries Gateway', async () => {
  const f = fixture(); f.options.configured = false;
  const discovery = createConnectorSessionDiscovery(f.options);
  assert.equal(discovery.current, false); assert.equal(f.counts.directories, 0);
  await discovery.refresh(); assert.equal(discovery.current, true);
  assert.deepEqual(f.counts, { directories: 1, gateway: 0, local: 0, disk: 0, replace: 0, usage: 0 });
  await discovery.close(); await assert.rejects(discovery.refresh(), /closing/);
});

test('original local directory wins; empty or failed local read falls back to the original Gateway', async () => {
  const f = fixture(); f.options.local = true; f.state.local = [{ key: f.key }];
  const discovery = createConnectorSessionDiscovery(f.options);
  await discovery.refresh(); assert.equal(f.counts.gateway, 0); assert.ok(f.deck.getSession(f.key));
  f.state.local = []; await discovery.refresh(); assert.equal(f.counts.gateway, 1);
  f.options.readLocal = async () => { throw Error('private-path'); };
  await discovery.refresh(); assert.equal(f.counts.gateway, 2); assert.equal(f.counts.replace, 1);
  await discovery.close(); assert.doesNotMatch(f.logs.join('\n'), /private-path|agent:main|original/);
});

for (const format of ['array', 'sessions', 'rows'] as const) test(`original ${format} list response preserves directory and disk classification`, async () => {
  const f = fixture(), rows = [{ sessionKey: f.key }];
  f.state.payload = format === 'array' ? rows : { [format]: rows };
  f.usage.set(f.key, { status: 'idle', hasActiveRun: false });
  const discovery = createConnectorSessionDiscovery(f.options);
  await discovery.refresh(); assert.ok(f.deck.getSession(f.key)); assert.equal(f.counts.usage, 1);
  assert.equal(discovery.current, true); await discovery.close();
});

test('malformed Gateway lists never publish or mark discovery current, and original failures are not logged', async () => {
  const f = fixture(), discovery = createConnectorSessionDiscovery(f.options);
  for (const payload of [null, {}, { sessions: {} }, [null], [[]], [{ key: ' ' }], [{ key: 42 }]]) {
    f.state.payload = payload; await assert.rejects(discovery.refresh(), /Invalid Gateway session list/);
    assert.equal(discovery.current, false); assert.equal(discovery.refreshing, false);
  }
  assert.equal(f.counts.replace, 0); assert.equal(f.counts.disk, 0);
  f.hooks.gateway = async () => { throw Error('Bearer original-secret'); };
  await assert.rejects(discovery.refresh(), /original-secret/);
  assert.doesNotMatch(f.logs.join('\n'), /Bearer|original-secret/);
  await discovery.close();
});

test('one shared physical scan owns concurrent callers; cache, invalidation and unchanged row revisions stay distinct', async () => {
  const f = fixture(), held = gate(); f.hooks.disk = () => held.promise;
  const discovery = createConnectorSessionDiscovery(f.options), first = discovery.refresh();
  assert.equal(discovery.refresh(), first); assert.equal(discovery.refreshing, true);
  await tick(); assert.equal(f.counts.gateway, 1); assert.equal(f.counts.replace, 0);
  held.release(); await first; assert.equal(discovery.current, true);
  await discovery.refresh({ maxAgeMs: Number.MAX_SAFE_INTEGER }); assert.equal(f.counts.gateway, 1);
  await discovery.refresh(); assert.equal(f.counts.gateway, 2); assert.equal(f.counts.replace, 1);
  discovery.invalidate(); assert.equal(discovery.current, false);
  await discovery.refresh({ maxAgeMs: Number.MAX_SAFE_INTEGER }); assert.equal(f.counts.gateway, 3);
  await discovery.close();
});

for (const stage of ['gateway', 'disk'] as const) test(`connection change during ${stage} await cannot publish stale directory`, async () => {
  const f = fixture(), held = gate(); f.hooks[stage] = () => held.promise;
  const discovery = createConnectorSessionDiscovery(f.options), pending = discovery.refresh();
  const observed = assert.rejects(pending, /connection changed/);
  await tick(); f.state.connection = 'successor'; held.release(); await observed;
  assert.equal(f.counts.replace, 0); assert.equal(discovery.current, false);
  await discovery.refresh(); assert.ok(f.deck.getSession(f.key)); await discovery.close();
});

test('explicit invalidation during a local scan cannot publish an older directory or become current', async () => {
  const f = fixture(), held = gate(); f.options.local = true; f.state.local = [{ key: f.key }];
  f.hooks.disk = () => held.promise;
  const discovery = createConnectorSessionDiscovery(f.options), pending = discovery.refresh();
  const observed = assert.rejects(pending, /connection changed/);
  await tick(); discovery.invalidate(); held.release(); await observed;
  assert.equal(f.counts.replace, 0); assert.equal(discovery.current, false); await discovery.close();
});

for (const failed of [false, true]) test(`close drains accepted original reads through ${failed ? 'failure' : 'publication'} and rejects new work`, async () => {
  const f = fixture(), held = gate(); f.hooks.disk = async () => { await held.promise; if (failed) throw Error('native-read-failed'); };
  const discovery = createConnectorSessionDiscovery(f.options), pending = discovery.refresh();
  const observed = pending.then(() => null, error => error);
  await tick(); let drained = false;
  const close = discovery.close(); assert.equal(discovery.close(), close); void close.then(() => { drained = true; });
  await assert.rejects(discovery.refresh(), /closing/); await tick(); assert.equal(drained, false);
  held.release(); const result = await observed; await close;
  assert.equal(result instanceof Error, failed); assert.equal(f.counts.replace, failed ? 0 : 1);
  assert.equal(discovery.current, false); assert.equal(drained, true);
});

test('public Promise mutation cannot replace the physical discovery close barrier', async () => {
  const f = fixture(), held = gate(); f.hooks.disk = () => held.promise;
  const discovery = createConnectorSessionDiscovery(f.options), pending = discovery.refresh();
  const original = Promise.prototype.then.call(pending, () => {});
  await tick(); pending.then = (() => Promise.resolve()) as typeof pending.then;
  let drained = false; const close = discovery.close().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); held.release(); await original; await close;
  assert.equal(f.counts.replace, 1);
});

test('original directory callback failure leaves readiness false and permits a fresh scan', async () => {
  const f = fixture(); f.hooks.directories = () => { throw Error('original-sdk-failure'); };
  const discovery = createConnectorSessionDiscovery(f.options);
  await assert.rejects(discovery.refresh(), /original-sdk-failure/);
  assert.equal(discovery.current, false); assert.equal(f.counts.gateway, 0);
  delete f.hooks.directories; await discovery.refresh(); assert.equal(discovery.current, true);
  await discovery.close();
});
