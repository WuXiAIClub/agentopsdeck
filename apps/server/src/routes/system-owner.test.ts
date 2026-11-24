import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { Hono } from 'hono';
import type { GatewayHealth } from '@agentopsdeck/shared';
import { loadConfig } from '../config.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerSystemRoutes } from './system.js';

type Dependencies = Parameters<typeof registerSystemRoutes>[1];
test('degraded agent fallback receives only a fixed diagnostic reason', async () => {
  let reason: string | undefined;
  const owner = fixture('redacted', async () => { throw new Error('PRIVATE-upstream-detail'); }, false,
    new PerformanceDiagnostics(() => {}), 1000, {
      normalizeError: error => String(error),
      fallbackAgents: error => { reason = error; return []; },
    });
  const response = await owner.app.request('/api/agents');
  assert.equal(response.status, 200);
  assert.equal(reason, 'gateway_unavailable');
  assert.doesNotMatch(await response.text(), /PRIVATE/);
});
test('gateway restart failure never copies injected provider diagnostics', async () => {
  const owner = fixture('redacted-restart', undefined, false,
    new PerformanceDiagnostics(() => {}), 1000, {
      normalizeError: error => String(error),
      restartEffect: async () => { throw new Error('PRIVATE-upstream-detail'); },
    });
  const response = await owner.app.request('/api/gateway/restart', { method: 'POST' });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'gateway_restart_failed' });
});
function fixture(name: string, request?: () => Promise<unknown>, enabled = false,
  diagnostics = new PerformanceDiagnostics(() => {}), requestWaitMs?: number, overrides: Partial<Dependencies> = {}) {
  const app = new Hono(), updates: GatewayHealth[] = [];
  const deps = {
    config: { localOpenClawCli: true, defaultAgentId: name }, admin: { status: () => ({ configured: false }) },
    gateway: { status: () => ({ connected: true, configured: true, url: name }),
      request: request ?? (async () => [{ id: name }]) },
    codex: { enabled }, store: { updateGateway: (value: GatewayHealth) => updates.push(value) },
    refreshSessions: async () => {}, fallbackAgents: () => [{ id: name }], normalizeError: () => 'unavailable',
    diagnostics, ...(requestWaitMs === undefined ? {} : { requestWaitMs }), ...overrides,
  } as unknown as Dependencies;
  registerSystemRoutes(app, deps);
  return { app, updates, diagnostics };
}
async function agents(app: Hono): Promise<{ id: string }[]> {
  return (await (await app.request('/api/agents')).json()).agents;
}

for (const localOnly of [false, true]) test(`async ${localOnly ? 'local-only' : 'degraded gateway'} fallback retains one original read after deadline`, async () => {
  let release!: (value: { id: string }[]) => void, calls = 0, gatewayCalls = 0;
  const original = new Promise<{ id: string }[]>(resolve => { release = resolve; });
  const f = fixture('async-fallback', async () => { gatewayCalls++; throw Error('PRIVATE-provider'); }, true,
    new PerformanceDiagnostics(() => {}), 5, {
      ...(localOnly ? { config: { localOpenClawCli: false } as Dependencies['config'] } : {}),
      fallbackAgents: () => { calls++; return calls === 1 ? original : Promise.resolve([{ id: 'fresh' }]); },
    });
  try {
    for (let i = 0; i < 2; i++) { assert.equal((await f.app.request('/api/agents')).status, 503); assert.equal(calls, 1); }
    assert.equal(gatewayCalls, localOnly ? 0 : 1);
    release([{ id: 'late' }]); await new Promise(resolve => setImmediate(resolve));
    const response = await f.app.request('/api/agents'), value = await response.json();
    assert.equal(response.status, 200);
    assert.equal(value.agents[0].id, localOnly ? 'fresh' : 'late');
    assert.equal(value.degraded, localOnly ? undefined : true); assert.equal(calls, localOnly ? 2 : 1);
    assert.doesNotMatch(JSON.stringify(f.diagnostics.snapshot()), /PRIVATE|late|fresh/);
  } finally { release([]); }
});

test('a failed async fallback is redacted and never cached as a successful empty list', async () => {
  let broken = true, calls = 0;
  const f = fixture('fallback-failed', undefined, false, new PerformanceDiagnostics(() => {}), 1000, {
    config: { localOpenClawCli: false } as Dependencies['config'],
    fallbackAgents: async () => { calls++; if (broken) throw Error('PRIVATE-fallback'); return [{ id: 'recovered' }]; },
  });
  const failed = await f.app.request('/api/agents'); assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /PRIVATE/);
  broken = false; assert.deepEqual(await agents(f.app), [{ id: 'recovered' }]); assert.equal(calls, 2);
});

test('disconnect while local fallback is pending leaves the joined waiter and original fallback intact', async () => {
  let release!: (value: { id: string }[]) => void, calls = 0;
  const original = new Promise<{ id: string }[]>(resolve => { release = resolve; });
  const f = fixture('local-disconnect', undefined, false, new PerformanceDiagnostics(() => {}), 1000, {
    config: { localOpenClawCli: false } as Dependencies['config'], fallbackAgents: () => { calls++; return original; },
  });
  const controller = new AbortController(), request = new Request('http://system.invalid/api/agents', { signal: controller.signal });
  const first = f.app.request(request), second = f.app.request('/api/agents');
  try {
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    assert.equal((await first).status, 408); assert.equal(calls, 1); assert.equal(getEventListeners(request.signal, 'abort').length, 0);
    release([{ id: 'same-original' }]); assert.deepEqual((await (await second).json()).agents, [{ id: 'same-original' }]); assert.equal(calls, 1);
  } finally { release([]); await Promise.all([first, second]); }
});

for (const late of ['success', 'failure'] as const) test(`read deadline retains one original request and accepts late ${late}`, { timeout: 3000 }, async () => {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void, calls = 0;
  const original = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  const f = fixture('deadline', () => { calls++; return original; }, false, new PerformanceDiagnostics(() => {}), 5);
  const signal = new AbortController().signal;
  try {
    for (let i = 0; i < 2; i++) {
      const request = new Request('http://system.invalid/api/agents', { signal });
      const response = await f.app.request(request);
      assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'system_read_timeout' }); assert.equal(calls, 1);
      assert.equal(getEventListeners(request.signal, 'abort').length, 0);
    }
    const before = f.diagnostics.snapshot().events;
    assert.equal(before.filter(e => e.operation === 'system-read-wait' && e.timedOut === 1 && e.pending === 1).length, 2);
    assert.equal(before.filter(e => e.operation === 'system-operation' && e.phase === 'finished').length, 0);
    assert.equal(f.diagnostics.snapshot().totals.finished, 2);
    if (late === 'success') resolve([{ id: 'late-result' }]); else reject(Error('PRIVATE provider failure'));
    await new Promise(yes => setImmediate(yes));
    const response = await f.app.request('/api/agents'), value = await response.json();
    assert.equal(response.status, 200); assert.equal(value.agents[0].id, late === 'success' ? 'late-result' : 'deadline');
    assert.equal(value.degraded, late === 'failure' ? true : undefined); assert.equal(calls, 1);
    assert.equal(f.diagnostics.snapshot().totals.finished, 3);
    assert.doesNotMatch(JSON.stringify(f.diagnostics.snapshot()), /PRIVATE|late-result|deadline/);
  } finally { resolve([]); }
});

test('disconnect ends only its wait while another request receives the original result', { timeout: 3000 }, async () => {
  let resolve!: (value: unknown) => void, entered!: () => void, calls = 0;
  const original = new Promise<unknown>(yes => { resolve = yes; });
  const started = new Promise<void>(yes => { entered = yes; });
  const f = fixture('disconnect', () => { calls++; entered(); return original; });
  const controller = new AbortController();
  const first = f.app.request(new Request('http://system.invalid/api/agents', { signal: controller.signal }));
  const second = f.app.request('/api/agents');
  try {
    await started; controller.abort();
    const cancelled = await first;
    assert.equal(cancelled.status, 408); assert.deepEqual(await cancelled.json(), { error: 'request_cancelled' });
    assert.equal(cancelled.headers.get('cache-control'), 'no-store'); assert.equal(calls, 1);
    assert.equal(f.diagnostics.snapshot().events.filter(e => e.operation === 'system-operation' && e.phase === 'finished').length, 0);
    resolve([{ id: 'original' }]);
    assert.equal((await (await second).json()).agents[0].id, 'original'); assert.equal(calls, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { resolve([]); await Promise.all([first, second]); }
});

test('already disconnected reads never dispatch or publish cache', async () => {
  let calls = 0; const f = fixture('cancelled', async () => { calls++; return []; });
  const controller = new AbortController(); controller.abort();
  for (const path of ['/api/agents', '/api/gateway/status']) {
    const response = await f.app.request(new Request('http://system.invalid' + path, { signal: controller.signal }));
    assert.equal(response.status, 408); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(calls, 0); assert.equal(f.updates.length, 0);
});

test('read wait rejects invalid trusted timeout settings before route registration', () => {
  for (const ms of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) assert.throws(() => fixture('invalid', undefined, false, undefined, ms), /invalid_system_request_wait/);
});

test('agent cache belongs to each registered application', async () => {
  const a = fixture('agent-a'), b = fixture('agent-b');
  assert.equal((await agents(a.app))[0]!.id, 'agent-a');
  assert.equal((await agents(b.app))[0]!.id, 'agent-b');
});

test('gateway cache and publication belong to each registered application', async () => {
  const a = fixture('gateway-a'), b = fixture('gateway-b');
  assert.equal((await (await a.app.request('/api/gateway/status')).json()).defaultAgentId, 'gateway-a');
  assert.equal((await (await b.app.request('/api/gateway/status')).json()).defaultAgentId, 'gateway-b');
  assert.equal(a.updates.length, 1); assert.equal(b.updates.length, 1);
  assert.equal(a.updates[0]!.defaultAgentId, 'gateway-a');
  assert.equal(b.updates[0]!.defaultAgentId, 'gateway-b');
  assert.equal(a.updates[0]!.gatewayWs?.url, undefined);
  assert.equal(b.updates[0]!.gatewayWs?.url, undefined);
});

test('replacement app progresses without settling or cancelling old original agent request', { timeout: 3000 }, async () => {
  let release!: (value: unknown) => void, entered!: () => void, calls = 0;
  const pending = new Promise<unknown>(resolve => { release = resolve; });
  const secondEntered = new Promise<void>(resolve => { entered = resolve; });
  const a = fixture('pending-a', () => pending), b = fixture('pending-b', async () => {
    calls++; entered(); return [{ id: 'pending-b' }];
  });
  const first = a.app.request('/api/agents'), second = b.app.request('/api/agents');
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([secondEntered, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error('replacement gated by old owner')), 1000);
    })]);
    assert.equal((await (await second).json()).agents[0].id, 'pending-b'); assert.equal(calls, 1);
  } finally {
    clearTimeout(timer); release([{ id: 'pending-a' }]); await Promise.all([first, second]);
  }
  assert.equal((await agents(b.app))[0]!.id, 'pending-b');
});

test('requests in same app still coalesce and retain exactly one original call', async () => {
  let release!: (value: unknown) => void, calls = 0;
  const pending = new Promise<unknown>(resolve => { release = resolve; });
  const a = fixture('shared', () => { calls++; return pending; });
  const first = a.app.request('/api/agents'), second = a.app.request('/api/agents');
  release([{ id: 'shared' }]); await Promise.all([first, second]); assert.equal(calls, 1);
  assert.equal((await agents(a.app))[0]!.id, 'shared'); assert.equal(calls, 1);
  assert.equal(a.diagnostics.snapshot().totals.finished, 3);
});

test('degraded fallback and local codex flags cannot leak across owners', async () => {
  const a = fixture('degraded', async () => { throw Error('private failure'); }, true), b = fixture('healthy');
  const result = await (await a.app.request('/api/agents')).json();
  assert.equal(result.degraded, true); assert.deepEqual(result.agents.map((a: { id: string }) => a.id), ['degraded', 'codex']);
  const other = await (await b.app.request('/api/agents')).json();
  assert.equal(other.degraded, undefined); assert.deepEqual(other.agents.map((a: { id: string }) => a.id), ['healthy']);
  const event = a.diagnostics.snapshot().events[0]!;
  assert.equal(event.operation, 'system-operation'); assert.equal(event.step, 1);
  assert.equal(event.category, 'failed'); assert.equal(event.deferred, 1);
  assert.doesNotMatch(JSON.stringify(a.diagnostics.snapshot()), /private failure|degraded|healthy/);
});

test('synchronous provider failure follows original degraded fallback, not an unobserved HTTP exception', async () => {
  const a = fixture('sync-fallback', () => { throw Error('PRIVATE'); });
  const response = await a.app.request('/api/agents'); assert.equal(response.status, 200);
  assert.equal((await response.json()).degraded, true);
  assert.equal(a.diagnostics.snapshot().totals.failed, 1);
  assert.doesNotMatch(JSON.stringify(a.diagnostics.snapshot()), /PRIVATE|sync-fallback/);
});

test('diagnostic sink failure cannot change provider outcome or release shared work early', async () => {
  const d = new PerformanceDiagnostics(() => { throw Error('PRIVATE'); });
  let calls = 0; const a = fixture('sink', async () => { calls++; return [{ id: 'sink' }]; }, false, d);
  assert.equal((await agents(a.app))[0]!.id, 'sink');
  assert.equal((await agents(a.app))[0]!.id, 'sink'); assert.equal(calls, 1);
  assert.equal(d.snapshot().totals.sinkFailures, 2);
  assert.equal(d.snapshot().totals.finished, 2);
  assert.doesNotMatch(JSON.stringify(d.snapshot()), /PRIVATE|sink"/);
});

test('diagnostic clock reentry joins already published original agent request', async () => {
  let app!: Hono, joined: Promise<Response> | undefined, entered = false, calls = 0;
  const d = new PerformanceDiagnostics(() => {}, () => {
    if (!entered) { entered = true; joined = Promise.resolve(app.request('/api/agents')); } return 0;
  });
  const a = fixture('clock', async () => { calls++; return [{ id: 'clock' }]; }, false, d); app = a.app;
  const first = await app.request('/api/agents'); assert.equal((await first.json()).agents[0].id, 'clock');
  assert.equal((await (await joined!).json()).agents[0].id, 'clock'); assert.equal(calls, 1);
  assert.equal(d.snapshot().totals.finished, 3);
});

for (const phase of ['start', 'start-get', 'add', 'add-get', 'pending', 'pending-get', 'finish', 'finish-get'] as const) {
  const diagnostics = () => {
    const d = new PerformanceDiagnostics(() => {}), fail = () => { throw Error('observation fixture'); };
    const trace = { add() {}, reportPending() {}, finish() {} };
    const method = phase.startsWith('pending') ? 'reportPending' : phase.startsWith('add') ? 'add' : 'finish';
    if (!phase.startsWith('start')) Object.defineProperty(trace, method,
      phase.endsWith('-get') ? { get: fail } : { value: fail });
    Object.defineProperty(d, 'start', phase === 'start-get' ? { get: fail } : { value: phase === 'start' ? fail : () => trace });
    return d;
  };
  test(`system ${phase} observation cannot skip original provider or replace successful cache`, async () => {
    let calls = 0;
    const f = fixture('original', async () => { calls++; return [{ id: 'original' }]; }, false, diagnostics());
    for (let i = 0; i < 2; i++) {
      const response = await f.app.request('/api/agents'); assert.equal(response.status, 200);
      assert.equal((await response.json()).agents[0].id, 'original');
    }
    assert.equal(calls, 1);
  });
  test(`system ${phase} pending observation leaves shared original request available for late ACK`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let resolve!: (value: unknown) => void, calls = 0;
    const original = new Promise<unknown>(yes => { resolve = yes; });
    const f = fixture('fallback', () => { calls++; return original; }, false, diagnostics(), 60_000);
    const a = f.app.request('/api/agents'), b = f.app.request('/api/agents');
    await new Promise<void>(yes => setImmediate(yes));
    t.mock.timers.tick(30_000); await new Promise<void>(yes => setImmediate(yes));
    assert.equal(calls, 1); resolve([{ id: 'late original' }]);
    const results = await Promise.all([a, b]);
    for (const response of results) { assert.equal(response.status, 200); assert.equal((await response.json()).agents[0].id, 'late original'); }
    assert.equal((await agents(f.app))[0]!.id, 'late original'); assert.equal(calls, 1);
  });
}

test('/api/config/debug reports process, projection, and runtime memory diagnostics without secrets', async () => {
  const f = fixture('debug-mem', undefined, true, new PerformanceDiagnostics(() => {}), undefined, {
    config: loadConfig({ AOD_OWNER_TOKEN: 'SECRET-OWNER-TOKEN' }),
    store: {
      updateGateway: () => {},
      memoryStats: () => ({
        sessions: 23,
        residentMessageSessions: 8,
        residentMessages: 420,
        approxMessageBytes: 512_000,
        evictedMessageSessions: 15,
        evictedTranscriptsTotal: 19,
        activitySessions: 4,
        retainedEvents: 64,
      }),
    } as Dependencies['store'],
    memoryDiagnostics: () => ({ codex: { warmHistorySessions: 23, activeTurns: 1 } }),
  });
  const response = await f.app.request('/api/config/debug');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.memory?.process?.rss, 'number');
  assert.equal(body.memory?.projection?.residentMessageSessions, 8);
  assert.equal(body.memory?.projection?.evictedMessageSessions, 15);
  assert.equal(body.memory?.codex?.warmHistorySessions, 23);
  assert.doesNotMatch(JSON.stringify(body), /SECRET-OWNER-TOKEN/);
});
