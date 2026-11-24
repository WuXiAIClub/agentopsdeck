import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { Hono } from 'hono';
import type { AgentSummary } from '@agentopsdeck/shared';
import { registerConnectorAgentRoutes } from './agents-http.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(agents: () => AgentSummary[] | PromiseLike<AgentSummary[]>, requestWaitMs = 1000,
  diagnostics = new PerformanceDiagnostics(() => {})) {
  let allowed = true, checks = 0, finalChecks = 0, broken = false;
  const app = new Hono();
  const routes = registerConnectorAgentRoutes(app, { agents, requestWaitMs, diagnostics, tokens: {
    requireScope: () => { checks++; return allowed ? { tokenId: 'PRIVATE-token', label: 'PRIVATE-label', scopes: ['agents:read'] } : undefined; },
    hasScope: (id, scope) => { finalChecks++; if (broken) throw Error('PRIVATE-auth-error'); return id === 'PRIVATE-token' && scope === 'agents:read' && allowed; },
  } });
  return { app, routes, diagnostics, revoke: () => { allowed = false; }, breakAuthority: () => { broken = true; },
    checks: () => ({ checks, finalChecks }) };
}
const url = 'http://connector.invalid/api/connector/v1/agents';

test('async discovery is awaited, coalesced and rechecked before unchanged JSON DTO', async () => {
  const read = held<AgentSummary[]>(); let calls = 0;
  const f = fixture(() => { calls++; return read.promise; });
  const a = f.app.request(url), b = f.app.request(url); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(f.checks().finalChecks, 0);
  read.resolve([{ id: 'PRIVATE-agent' }]);
  for (const response of await Promise.all([a, b])) {
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { agents: [{ id: 'PRIVATE-agent' }] });
  }
  assert.equal(f.checks().finalChecks, 2); assert.doesNotMatch(JSON.stringify(f.diagnostics.snapshot()), /PRIVATE/);
  await f.routes.close();
});

for (const broken of [false, true]) test(`post-await ${broken ? 'failed' : 'revoked'} authority never returns agent data`, async () => {
  const read = held<AgentSummary[]>(); const f = fixture(() => read.promise);
  const request = f.app.request(url); await new Promise(resolve => setImmediate(resolve));
  if (broken) f.breakAuthority(); else f.revoke();
  read.resolve([{ id: 'PRIVATE-agent' }]); const response = await request;
  assert.equal(response.status, broken ? 503 : 403);
  assert.doesNotMatch(await response.text(), /PRIVATE/); await f.routes.close();
});

for (const lateFailure of [false, true]) test(`deadline retains original discovery through late ${lateFailure ? 'failure' : 'success'}`, async () => {
  const read = held<AgentSummary[]>(); let calls = 0;
  const f = fixture(() => { calls++; return calls === 1 ? read.promise : [{ id: 'next' }]; }, 5);
  for (let i = 0; i < 2; i++) {
    const request = new Request(url), response = await f.app.request(request);
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'agent_read_timeout' });
    assert.equal(calls, 1); assert.equal(getEventListeners(request.signal, 'abort').length, 0);
  }
  assert.equal(f.diagnostics.snapshot().events.filter(event => event.step === 2 && event.phase === 'finished').length, 0);
  if (lateFailure) read.reject(Error('PRIVATE-provider-error')); else read.resolve([{ id: 'late' }]);
  await new Promise(resolve => setImmediate(resolve));
  const next = await f.app.request(url); assert.equal(next.status, 200); assert.deepEqual(await next.json(), { agents: [{ id: 'next' }] });
  assert.equal(calls, 2); assert.doesNotMatch(JSON.stringify(f.diagnostics.snapshot()), /PRIVATE/); await f.routes.close();
});

test('disconnect ends only one wait and leaves a joined request attached to the original', async () => {
  const read = held<AgentSummary[]>(); let calls = 0; const f = fixture(() => { calls++; return read.promise; });
  const controller = new AbortController(), request = new Request(url, { signal: controller.signal });
  const a = f.app.request(request), b = f.app.request(url); await new Promise(resolve => setImmediate(resolve));
  controller.abort(); assert.equal((await a).status, 408); assert.equal(calls, 1);
  assert.equal(getEventListeners(request.signal, 'abort').length, 0);
  read.resolve([{ id: 'original' }]); assert.equal((await b).status, 200); assert.equal(calls, 1); await f.routes.close();
});

test('pre-cancelled and unauthorized requests do not start discovery', async () => {
  let calls = 0; const f = fixture(() => { calls++; return []; });
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.app.request(new Request(url, { signal: controller.signal }))).status, 408);
  assert.equal(f.checks().checks, 0); f.revoke(); assert.equal((await f.app.request(url)).status, 403); assert.equal(calls, 0);
  await f.routes.close();
});

test('close freezes admission and waits for physical discovery, even after HTTP timeout', async () => {
  const read = held<AgentSummary[]>(); let calls = 0, closed = false;
  const f = fixture(() => { calls++; return read.promise; }, 5);
  assert.equal((await f.app.request(url)).status, 503);
  const close = f.routes.close(); assert.equal(f.routes.close(), close); void close.then(() => { closed = true; });
  assert.equal((await f.app.request(url)).status, 503); await Promise.resolve(); assert.equal(closed, false); assert.equal(calls, 1);
  read.resolve([]); await close; assert.equal(closed, true);
});

test('close during an admitted HTTP wait does not expose a late list', async () => {
  const read = held<AgentSummary[]>(), f = fixture(() => read.promise);
  const response = f.app.request(url); await new Promise(resolve => setImmediate(resolve));
  const close = f.routes.close(); read.resolve([{ id: 'PRIVATE-agent' }]);
  assert.equal((await response).status, 503); await close;
});

test('sync discovery remains compatible; unexpected failures are redacted and do not poison the next read', async () => {
  let broken = true; const f = fixture(() => { if (broken) throw Error('PRIVATE-discovery-error'); return [{ id: 'sync' }]; });
  const failed = await f.app.request(url); assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /PRIVATE/);
  broken = false; assert.deepEqual(await (await f.app.request(url)).json(), { agents: [{ id: 'sync' }] }); await f.routes.close();
});

test('diagnostic reentry joins the published list and diagnostic failures cannot authorize or replace work', async () => {
  let f!: ReturnType<typeof fixture>, reentered = false, joined!: Promise<Response>, calls = 0;
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('PRIVATE-sink'); }, () => {
    if (!reentered) { reentered = true; joined = Promise.resolve(f.app.request(url)); } return 0;
  });
  f = fixture(async () => { calls++; return [{ id: 'original' }]; }, 1000, diagnostics);
  assert.equal((await f.app.request(url)).status, 200); assert.equal((await joined).status, 200); assert.equal(calls, 1); await f.routes.close();
});

test('trusted wait settings are validated before registering routes', () => {
  for (const wait of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) assert.throws(() => fixture(() => [], wait), /invalid_agent_request_wait/);
});
