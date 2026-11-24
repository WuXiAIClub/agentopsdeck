import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import type { AgentSummary } from '@agentopsdeck/shared';
import type { ConnectorPrincipal } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerConnectorAgentRoutes, CONNECTOR_AGENT_PENDING_LIMIT, type ConnectorAgentAuthority } from './agents-http.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';

const url = 'http://connector.invalid/api/connector/v1/agents';
const principal: ConnectorPrincipal = { tokenId: 'PRIVATE-token', label: 'PRIVATE-label', scopes: ['agents:read'] };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(tokens: ConnectorAgentAuthority, options: {
  agents?: () => AgentSummary[] | PromiseLike<AgentSummary[]>;
  diagnostics?: PerformanceDiagnostics; waitMs?: number;
} = {}) {
  const app = new Hono(); let scans = 0;
  const diagnostics = options.diagnostics ?? new PerformanceDiagnostics(() => {});
  const routes = registerConnectorAgentRoutes(app, { tokens, diagnostics, requestWaitMs: options.waitMs ?? 1000,
    agents: () => { scans++; return options.agents?.() ?? [{ id: 'PRIVATE-agent' }]; } });
  return { app, routes, diagnostics, scans: () => scans };
}

test('both asynchronous authority phases are awaited and the wire DTO remains unchanged', async () => {
  const initial = held<ConnectorPrincipal | undefined>(), final = held<boolean>(), entered = held<void>();
  const lines: string[] = [];
  const f = fixture({ requireScope: () => initial.promise, hasScope: (id, scope) => {
    assert.equal(id, principal.tokenId); assert.equal(scope, 'agents:read'); entered.resolve(); return final.promise;
  } }, { diagnostics: new PerformanceDiagnostics(line => { lines.push(line); }) });
  let finished = false;
  const response = Promise.resolve(f.app.request(url)); void response.then(() => { finished = true; });
  await tick(); assert.equal(f.scans(), 0); assert.equal(finished, false);
  initial.resolve(principal); await entered.promise;
  assert.equal(f.scans(), 1); assert.equal(finished, false);
  final.resolve(true); const result = await response;
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await result.json(), { agents: [{ id: 'PRIVATE-agent' }] });
  const events = lines.map(line => JSON.parse(line));
  for (const step of [4, 5]) assert.ok(events.some(event => event.step === step && event.settled === 1 && event.phase === 'finished'));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/); await f.routes.close();
});

for (const phase of ['initial', 'final'] as const) {
  for (const refusal of phase === 'initial' ? ['denied', 'rejected'] as const : ['denied', 'rejected', 'malformed'] as const) test(`async ${phase} authority ${refusal} cannot disclose agents`, async () => {
    let finals = 0;
    const denied = async () => {
      if (refusal === 'rejected') throw Error('PRIVATE-auth-error');
      return refusal === 'denied' ? false : 'true';
    };
    const f = fixture({ requireScope: async () => {
      if (phase === 'initial') {
        if (refusal === 'rejected') throw Error('PRIVATE-auth-error');
        return undefined;
      }
      return principal;
    }, hasScope: async () => { finals++; return phase === 'final' ? await denied() as boolean : true; } });
    const response = await f.app.request(url);
    assert.equal(response.status, refusal === 'rejected' ? 503 : 403);
    assert.equal(f.scans(), phase === 'initial' ? 0 : 1);
    assert.equal(finals, phase === 'initial' ? 0 : 1);
    assert.doesNotMatch(await response.text(), /PRIVATE/); await f.routes.close();
  });
  for (const reason of ['deadline', 'abort', 'close'] as const) {
    for (const lateFailure of [false, true]) test(`${phase} authority ${reason} retains original through late ${lateFailure ? 'rejection' : 'success'}`, async () => {
      const initial = held<ConnectorPrincipal | undefined>(), final = held<boolean>(), entered = held<void>();
      let initials = 0, finals = 0;
      const f = fixture({ requireScope: () => {
        initials++; if (phase === 'initial') { entered.resolve(); return initial.promise; } return principal;
      }, hasScope: () => { finals++; entered.resolve(); return final.promise; } }, { waitMs: reason === 'deadline' ? 20 : 1000 });
      const controller = new AbortController(), request = new Request(url, { signal: controller.signal });
      const response = f.app.request(request); await entered.promise;
      if (reason === 'abort') controller.abort();
      let closed = false;
      if (reason !== 'close') {
        const result = await response; assert.equal(result.status, reason === 'abort' ? 408 : 503);
        assert.deepEqual(await result.clone().json(), { error: reason === 'abort' ? 'request_cancelled' : 'agent_read_timeout' });
        assert.equal(getEventListeners(request.signal, 'abort').length, 0);
      }
      const close = f.routes.close(); assert.equal(close, f.routes.close());
      void close.then(() => { closed = true; }); await tick(); assert.equal(closed, false);
      assert.equal((await f.app.request(url)).status, 503); assert.equal(initials, 1);
      if (phase === 'initial') {
        if (lateFailure) initial.reject(Error('PRIVATE-late-auth')); else initial.resolve(principal);
      } else if (lateFailure) final.reject(Error('PRIVATE-late-auth')); else final.resolve(true);
      await close; assert.equal(closed, true);
      const result = await response; assert.equal(result.status, reason === 'abort' ? 408 : 503);
      assert.doesNotMatch(await result.text(), /PRIVATE/);
      assert.equal(f.scans(), phase === 'initial' ? 0 : 1); assert.equal(finals, phase === 'initial' ? 0 : 1);
      assert.equal(getEventListeners(request.signal, 'abort').length, 0);
      assert.doesNotMatch(JSON.stringify(f.diagnostics.snapshot()), /PRIVATE/);
    });
  }
}

for (const phase of ['initial', 'final'] as const) test(`${phase} authority timeout cannot replenish the bounded original-operation budget`, async () => {
  const initial = held<ConnectorPrincipal | undefined>(), final = held<boolean>();
  let initials = 0, finals = 0, release = false;
  const f = fixture({ requireScope: () => { initials++; return phase === 'initial' && !release ? initial.promise : principal; },
    hasScope: () => { finals++; return phase === 'final' && !release ? final.promise : true; } }, { waitMs: 100 });
  const requests = Array.from({ length: CONNECTOR_AGENT_PENDING_LIMIT }, () => f.app.request(url));
  for (const response of await Promise.all(requests)) assert.equal(response.status, 503);
  assert.equal(initials, CONNECTOR_AGENT_PENDING_LIMIT);
  if (phase === 'final') assert.equal(finals, CONNECTOR_AGENT_PENDING_LIMIT);
  const saturated = await f.app.request(url); assert.equal(saturated.status, 503);
  assert.deepEqual(await saturated.json(), { error: 'agent_catalog_unavailable' });
  assert.equal(initials, CONNECTOR_AGENT_PENDING_LIMIT);
  assert.ok(f.diagnostics.snapshot().events.some(event => event.step === 6 && event.pending === CONNECTOR_AGENT_PENDING_LIMIT));
  release = true; initial.resolve(principal); final.resolve(true); await tick();
  assert.equal((await f.app.request(url)).status, 200); assert.equal(initials, CONNECTOR_AGENT_PENDING_LIMIT + 1);
  await f.routes.close();
});

test('one request deadline includes both authority phases, rather than restarting at each await', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const initial = held<ConnectorPrincipal | undefined>(), final = held<boolean>(), entered = held<void>();
  const f = fixture({ requireScope: () => initial.promise, hasScope: () => { entered.resolve(); return final.promise; } }, { waitMs: 100 });
  const response = f.app.request(url); await tick(); t.mock.timers.tick(60);
  initial.resolve(principal); await entered.promise;
  t.mock.timers.tick(40); assert.equal((await response).status, 503);
  final.resolve(true); await f.routes.close();
});

test('caller cancellation during initial authority does not cancel an independently authorized shared discovery', async () => {
  const initial = held<ConnectorPrincipal | undefined>(), scan = held<AgentSummary[]>(), entered = held<void>();
  const f = fixture({ requireScope: request => request.headers.has('x-held') ? initial.promise : principal,
    hasScope: async () => true }, { agents: () => { entered.resolve(); return scan.promise; } });
  const controller = new AbortController();
  const a = f.app.request(new Request(url, { headers: { 'x-held': '1' }, signal: controller.signal }));
  const b = f.app.request(url); await entered.promise; controller.abort(); assert.equal((await a).status, 408);
  initial.resolve(principal); scan.resolve([{ id: 'original' }]);
  assert.equal((await b).status, 200); assert.equal(f.scans(), 1); await f.routes.close();
});

test('close reentered by diagnostics owns initial authority before any dependent read starts', async () => {
  let f!: ReturnType<typeof fixture>, stopped = false, reads = 0;
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('PRIVATE-sink'); }, () => {
    if (!stopped) { stopped = true; void f.routes.close(); } return 0;
  });
  f = fixture({ requireScope: () => { reads++; return principal; }, hasScope: () => true }, { diagnostics });
  assert.equal((await f.app.request(url)).status, 503); assert.equal(reads, 0); assert.equal(f.scans(), 0);
  await f.routes.close();
});

test('throwing diagnostic clocks cannot skip asynchronous final authority or strand close', async () => {
  let finals = 0;
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('PRIVATE-sink'); }, () => { throw Error('PRIVATE-clock'); });
  const f = fixture({ requireScope: async () => principal, hasScope: async () => { finals++; return false; } }, { diagnostics });
  const response = await f.app.request(url); assert.equal(response.status, 403); assert.equal(finals, 1);
  assert.doesNotMatch(await response.text(), /PRIVATE/); await f.routes.close();
});

test('isolated real SQL/token owner integrates with HTTP, rechecks revocation and retains it on reopen', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-agent-authority-中文-'));
  const config = { file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json') };
  const silence = new PerformanceDiagnostics(() => {}), scan = held<AgentSummary[]>(), entered = held<void>();
  let owner = new AsyncConnectorOwner(config, silence);
  let routes: ReturnType<typeof registerConnectorAgentRoutes> | undefined;
  t.after(async () => { scan.resolve([]); try { await routes?.close(); await owner.closeForShutdown(); }
    finally { await rm(root, { recursive: true, force: true }); } });
  await owner.open(); const issued = await owner.command('tokenCreate', { label: 'PRIVATE-label', scopes: ['agents:read'] });
  const tokens: ConnectorAgentAuthority = {
    requireScope: async (request, scope) => {
      const authorization = request.headers.get('authorization'); if (!authorization) return undefined;
      const current = await owner.command('tokenAuthenticate', { authorization });
      return current?.scopes.includes(scope) ? current : undefined;
    },
    hasScope: (tokenId, scope) => owner.command('tokenHasScope', { tokenId, scope }),
  };
  const app = new Hono(); routes = registerConnectorAgentRoutes(app, { tokens, diagnostics: silence,
    agents: () => { entered.resolve(); return scan.promise; } });
  const headers = { authorization: `Bearer ${issued.token}` };
  const response = app.request(new Request(url, { headers })); await entered.promise;
  assert.equal(await owner.command('tokenRevoke', { tokenId: issued.record.id }), true);
  scan.resolve([{ id: 'PRIVATE-agent' }]); const result = await response;
  assert.equal(result.status, 403); assert.doesNotMatch(await result.text(), /PRIVATE|aod_conn_/);
  await routes.close(); await owner.close(); owner = new AsyncConnectorOwner(config, silence); await owner.open();
  const reopened = new Hono(); let scans = 0;
  routes = registerConnectorAgentRoutes(reopened, { tokens, diagnostics: silence, agents: () => { scans++; return []; } });
  assert.equal((await reopened.request(new Request(url, { headers }))).status, 403); assert.equal(scans, 0);
  assert.equal((await owner.command('tokensList', {}))[0]!.id, issued.record.id);
  assert.doesNotMatch(JSON.stringify(silence.snapshot()), /PRIVATE|aod_conn_/);
});
