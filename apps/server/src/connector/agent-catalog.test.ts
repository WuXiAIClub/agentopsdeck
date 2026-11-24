import assert from 'node:assert/strict';
import test from 'node:test';
import { createFallbackAgentCatalog } from './agent-catalog.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('one original scan, fresh volatile state after IO, independent caller results and no settled cache', async () => {
  const scan = held<string[]>(); let calls = 0, running = false, ready = false;
  const diagnostics = new PerformanceDiagnostics(() => {});
  const catalog = createFallbackAgentCatalog({ registry: () => { calls++; return scan.promise; }, defaultAgentId: 'PRIVATE-main',
    groups: () => [{ agentId: 'PRIVATE-session', sessions: [{ hasActiveRun: running }] }],
    runtimes: () => [{ id: 'codex', label: 'Codex · local harness', status: ready ? 'available' : 'degraded' }], diagnostics });
  const first = catalog.list(), second = catalog.list('PRIVATE-provider-error');
  await Promise.resolve(); assert.equal(calls, 1);
  running = true; ready = true; scan.resolve(['PRIVATE-disk', 'PRIVATE-session', 'codex']);
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a.map(agent => [agent.id, agent.status]), [
    ['codex', 'available'], ['PRIVATE-disk', 'available'], ['PRIVATE-main', 'unknown'], ['PRIVATE-session', 'running'],
  ]);
  assert.equal(b.find(agent => agent.id === 'PRIVATE-main')?.status, 'degraded');
  assert.ok(a[0]); assert.ok(b[0]);
  a[0].label = 'mutated'; a.pop();
  assert.equal(b[0].label, 'Codex · local harness'); assert.equal(b.length, 4);
  running = false;
  const next = await catalog.list(); assert.equal(calls, 2);
  assert.equal(next.find(agent => agent.id === 'PRIVATE-session')?.status, 'active');
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE|mutated|Codex/);
  await catalog.close();
});

test('unavailable registry preserves session-derived rows, native readiness and original default policy', async () => {
  const diagnostics = new PerformanceDiagnostics(() => {});
  const catalog = createFallbackAgentCatalog({ registry: async () => { throw Error('PRIVATE-path'); },
    groups: () => [{ agentId: 'main', sessions: [{ status: 'running' }] }], defaultAgentId: 'main',
    runtimes: () => [{ id: 'hermes', status: 'degraded' }], diagnostics });
  assert.deepEqual(await catalog.list('provider-failed'), [{ id: 'hermes', status: 'degraded' }, { id: 'main', label: 'main', status: 'running' }]);
  assert.equal(diagnostics.snapshot().events[0]?.deferred, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE/);
  await catalog.close();
});

test('local-only catalog does not invent an OpenClaw default agent', async () => {
  const catalog = createFallbackAgentCatalog({ groups: () => [], runtimes: () => [{ id: 'codex', status: 'available' }] });
  assert.deepEqual(await catalog.list(), [{ id: 'codex', status: 'available' }]); await catalog.close();
});

test('close freezes admission but retains original scan and projection until actual settlement', async () => {
  const scan = held<string[]>(); let calls = 0, projections = 0, closed = false;
  const catalog = createFallbackAgentCatalog({ registry: () => { calls++; return scan.promise; },
    groups: () => { projections++; return []; }, runtimes: () => [] });
  const reading = catalog.list(); await Promise.resolve();
  const close = catalog.close(); assert.equal(catalog.close(), close);
  void close.then(() => { closed = true; });
  await assert.rejects(catalog.list(), /agent_catalog_unavailable/);
  await Promise.resolve(); assert.equal(closed, false); assert.equal(projections, 0); assert.equal(calls, 1);
  scan.resolve(['disk']); assert.deepEqual(await reading, [{ id: 'disk', label: 'disk', status: 'available' }]);
  await close; assert.equal(closed, true); assert.equal(projections, 1);
});

test('unexpected display failure is redacted and settles before a new scan is admitted', async () => {
  let broken = true, calls = 0;
  const diagnostics = new PerformanceDiagnostics(() => {});
  const catalog = createFallbackAgentCatalog({ registry: async () => { calls++; return []; },
    groups: () => { if (broken) throw Error('PRIVATE-database-error'); return []; }, runtimes: () => [], diagnostics });
  await assert.rejects(catalog.list(), error => error instanceof Error && error.message === 'agent_catalog_unavailable');
  broken = false; assert.deepEqual(await catalog.list(), []); assert.equal(calls, 2);
  assert.equal(diagnostics.snapshot().totals.failed, 1); assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE/);
  await catalog.close();
});

test('diagnostic reentry joins the published scan; throwing diagnostics cannot change discovery', async () => {
  let calls = 0, reentered = false, joined!: Promise<unknown>;
  let catalog!: ReturnType<typeof createFallbackAgentCatalog>;
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('PRIVATE-sink'); }, () => {
    if (!reentered) { reentered = true; joined = catalog.list(); }
    return 0;
  });
  catalog = createFallbackAgentCatalog({ registry: async () => { calls++; return ['disk']; }, groups: () => [], runtimes: () => [], diagnostics });
  assert.deepEqual(await catalog.list(), await joined); assert.equal(calls, 1); await catalog.close();
});
