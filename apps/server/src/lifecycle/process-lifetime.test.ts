import assert from 'node:assert/strict';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ProcessLifetime } from './process-lifetime.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test('all exact owners fence synchronously, single-flight signals wait for every ACK, and failure code escalates', async () => {
  const calls: number[] = [], exits: number[] = []; let release!: () => void;
  const p = new ProcessLifetime({ onClosed: code => exits.push(code), keepAlive: false });
  p.own(() => { calls.push(1); });
  p.own(() => { calls.push(2); return new Promise<void>(resolve => { release = resolve; }); });
  p.own(() => { calls.push(3); });
  const flight = p.shutdown(); assert.deepEqual(calls, [3, 2, 1]);
  assert.equal(p.shutdown(1), flight); await tick(); assert.deepEqual(exits, []);
  assert.equal(p.snapshot().active, true); release(); assert.equal(await flight, true);
  assert.deepEqual(exits, [1]); assert.equal(await p.shutdown(), true); assert.deepEqual(calls, [3, 2, 1]);
});

for (const rejection of [false, true]) test(`unknown ${rejection ? 'rejected' : 'thrown'} drain is consumed but never replayed`, async () => {
  let calls = 0, exits = 0;
  const p = new ProcessLifetime({ onClosed: () => { exits++; }, keepAlive: false });
  p.own(() => { calls++; if (rejection) return Promise.reject(undefined); throw undefined; });
  assert.equal(await p.shutdown(), false); assert.equal(await p.shutdown(), false);
  assert.equal(calls, 1); assert.equal(exits, 0); assert.equal(p.snapshot().pending, 1);
});

test('only explicit original-owner cleanup evidence permits automatic retry; successful peers are not replayed', async () => {
  let calls = 0, peers = 0, done!: () => void;
  const ended = new Promise<void>(resolve => { done = resolve; });
  const logs: Record<string, unknown>[] = [];
  const p = new ProcessLifetime({ onClosed: () => done(), retryMs: 5,
    diagnostics: new PerformanceDiagnostics(line => logs.push(JSON.parse(line))) });
  p.own(() => { peers++; });
  p.own(() => { calls++; if (calls === 1) throw Error('private SQL/path'); }, () => true);
  assert.equal(await p.shutdown(), false); await ended;
  assert.equal(calls, 2); assert.equal(peers, 1); assert.equal(p.snapshot().closed, true);
  assert.equal(p.snapshot().exitCode, 1);
  assert.ok(logs.some(log => log.operation === 'process-shutdown-owner' && log.unknown === 1));
  assert.ok(logs.some(log => log.operation === 'process-shutdown-owner' && log.recovered === 1));
  assert.equal(JSON.stringify(logs).includes('private SQL/path'), false);
});

test('held owner emits correlated pending observations without retry or exit', async () => {
  let calls = 0, exits = 0, release!: () => void;
  const logs: Record<string, unknown>[] = [];
  const p = new ProcessLifetime({ onClosed: () => { exits++; }, keepAlive: false, warningMs: 5, retryMs: 5,
    diagnostics: new PerformanceDiagnostics(line => logs.push(JSON.parse(line))) });
  p.own(() => { calls++; return new Promise<void>(resolve => { release = resolve; }); }, () => true);
  const flight = p.shutdown(); await new Promise<void>(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 1); assert.equal(exits, 0); assert.equal(p.shutdown(), flight);
  const warnings = logs.filter(log => log.operation === 'process-shutdown' && log.phase === 'pending');
  assert.ok(warnings.length > 0); assert.equal(new Set(warnings.map(log => log.sequence)).size, 1);
  release(); assert.equal(await flight, true); assert.equal(exits, 1);
});

test('a failed retry-evidence callback and diagnostic sink cannot authorize cleanup replay', async () => {
  let calls = 0;
  const p = new ProcessLifetime({ onClosed: () => assert.fail(), onFailure: () => { throw undefined; }, keepAlive: false,
    diagnostics: new PerformanceDiagnostics(() => { throw undefined; }) });
  p.own(() => { calls++; throw undefined; }, () => { throw undefined; });
  assert.equal(await p.shutdown(), false); assert.equal(await p.shutdown(), false); assert.equal(calls, 1);
});

test('a failed process-completion callback is not replayed', async () => {
  let calls = 0;
  const p = new ProcessLifetime({ onClosed: () => { calls++; throw undefined; }, keepAlive: false });
  assert.equal(await p.shutdown(), false); assert.equal(await p.shutdown(), false); assert.equal(calls, 1);
});

test('reentrant failure observation and owner close still share one shutdown attempt', async () => {
  let calls = 0, failures = 0, reentrant: Promise<boolean> | undefined;
  const p = new ProcessLifetime({ onClosed: () => {}, keepAlive: false,
    onFailure: () => { failures++; reentrant = p.shutdown(1); } });
  p.own(() => { calls++; reentrant = p.shutdown(1); });
  const close = p.shutdown(1); assert.equal(reentrant, close); assert.equal(await close, true);
  assert.equal(calls, 1); assert.equal(failures, 1); assert.equal(p.snapshot().attempts, 1);
});
