import assert from 'node:assert/strict';
import test from 'node:test';
import { HubExecutionUsage } from './execution-usage.js';
import type { HubExecutionLeases, ExecutionLease } from './execution-leases.js';
import type { ConnectorClient } from './connector-client.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function held() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function flush() { for (let index = 0; index < 100; index++) await Promise.resolve(); }
function fixture(sameIssuer: boolean, probe: (id: number) => Promise<void>, renew: (id: number) => Promise<void>,
  diagnostics = new PerformanceDiagnostics(() => {})) {
  const items = Array.from({ length: 6 }, (_, id) => ({ id, state: 'active', expiresAt: 21_000,
    nodeId: 'node', issuerId: 'issuer', ref: { id: String(id) }, actions: ['messages:send'],
    proof: { ownerUserId: 'owner', connectionId: sameIssuer ? 'domain' : `domain-${id}`, nodeVersion: 1 },
  } as unknown as ExecutionLease));
  let reads = 0;
  const leases = { usageDueAsync: async () => { reads++; return items.map(lease => ({ lease, version: 1 })); },
    get: (id: number) => items[id], authorized: () => true,
    revoke: () => assert.fail('synthetic current lease must not be revoked'),
    usageQuiet: () => assert.fail('synthetic used lease must not be assumed quiet'),
  } as unknown as HubExecutionLeases;
  const usage = new HubExecutionUsage(leases, 'hub', {
    synchronize: async id => { await renew(id); return items[id]!; },
  }, lease => ({ expectedNodeId: 'node', json: async (_: string, options: { body: string }) => {
    await probe(lease.id);
    return { nodeId: 'node', hubId: 'hub', issuerTokenId: 'issuer',
      usage: (JSON.parse(options.body).ids as string[]).map(id => ({ id, needed: true })) };
  } } as unknown as ConnectorClient), () => 1000, diagnostics);
  return { usage, items, reads: () => reads };
}

test('one held usage issuer does not suppress healthy later probes or confirmed renewals in the same page', async () => {
  const retained = held(), probes: number[] = [], renewals: number[] = [];
  let active = 0, maximum = 0, ended = false;
  const f = fixture(false, async id => {
    probes.push(id); active++; maximum = Math.max(maximum, active);
    try { if (id === 0) await retained.promise; } finally { active--; }
  }, async id => { renewals.push(id); active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; });
  const original = f.usage.reconcile(), completion = original.then(() => { ended = true; });
  try {
    assert.equal(f.usage.reconcile(), original); await flush();
    assert.deepEqual(probes, [0, 1, 2, 3, 4, 5]);
    assert.deepEqual([...renewals].sort(), [1, 2, 3, 4, 5]);
    assert.equal(f.reads(), 1); assert.equal(ended, false); assert.ok(maximum <= 4);
    retained.release(); await completion;
    assert.deepEqual([...renewals].sort(), [0, 1, 2, 3, 4, 5]);
  } finally { retained.release(); await original; await f.usage.close(); }
});

test('one held confirmed renewal does not strand later healthy renewals behind a four-item barrier', async () => {
  const retained = held(), renewals: number[] = [];
  let active = 0, maximum = 0;
  const f = fixture(true, async () => {}, async id => {
    renewals.push(id); active++; maximum = Math.max(maximum, active);
    try { if (id === 0) await retained.promise; } finally { active--; }
  });
  const original = f.usage.reconcile();
  try {
    await flush(); assert.deepEqual(renewals, [0, 1, 2, 3, 4, 5]);
    assert.ok(maximum <= 4); assert.equal(f.reads(), 1);
  } finally { retained.release(); await original; await f.usage.close(); }
});

test('four retained usage issuers bound work; close fences unstarted probes and waits for original settlement', async () => {
  const retained = held(), probes: number[] = [], renewals: number[] = [];
  const f = fixture(false, async id => { probes.push(id); await retained.promise; }, async id => { renewals.push(id); });
  const original = f.usage.reconcile(); let ended = false;
  try {
    await flush(); assert.deepEqual(probes, [0, 1, 2, 3]);
    const closing = f.usage.close().then(() => { ended = true; });
    await flush(); assert.equal(ended, false);
    await assert.rejects(f.usage.reconcile(), /closed/);
    retained.release(); await original; await closing;
    assert.deepEqual(probes, [0, 1, 2, 3]); assert.deepEqual(renewals, []);
  } finally { retained.release(); await original; await f.usage.close(); }
});

test('failed usage proof never renews that lease and failed renewal is not replayed in the same page', async () => {
  const renewals: number[] = [];
  const f = fixture(false, async id => { if (id === 0) throw Error('private token SQL'); }, async id => {
    renewals.push(id); if (id === 1) throw Error('private original unknown effect');
  });
  try { await f.usage.reconcile(); assert.deepEqual([...renewals].sort(), [1, 2, 3, 4, 5]); assert.equal(f.reads(), 1); }
  finally { await f.usage.close(); }
});

test('usage and renewal failures stay observable even while another issuer retains its original slot', async () => {
  const gate = held(), logs: string[] = [], renewals: number[] = [];
  const f = fixture(false, async id => { if (!id) await gate.promise; if (id === 1) throw Error('secret SQL'); },
    async id => { renewals.push(id); if (id === 2) throw Error('private unknown'); }, new PerformanceDiagnostics(line => logs.push(line), () => 100));
  const page = f.usage.reconcile();
  try {
    await flush(); const pending = logs.map(line => JSON.parse(line)).filter(row => row.phase === 'pending');
    assert.equal(pending.length, 2); assert.equal(pending.at(-1).deferred, 2);
    assert.ok(!logs.join('').includes('secret')); assert.ok(!logs.join('').includes('private'));
    gate.release(); await page;
    const final = JSON.parse(logs.at(-1)!); assert.equal(final.operation, 'hub-usage-reconcile');
    assert.equal(final.category, 'failed'); assert.equal(final.deferred, 2); assert.equal(final.sequence, pending[0].sequence);
    assert.deepEqual([...renewals].sort(), [0, 2, 3, 4, 5]);
  } finally { gate.release(); await page; await f.usage.close(); }
});

test('unreferenced pending usage warning observes the same flight and is cleared after settlement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = held(), logs: string[] = [], renewals: number[] = [];
  const f = fixture(false, async id => { if (!id) await gate.promise; }, async id => { renewals.push(id); },
    new PerformanceDiagnostics(line => logs.push(line), () => 100));
  const page = f.usage.reconcile();
  try {
    await flush(); assert.deepEqual([...renewals].sort(), [1, 2, 3, 4, 5]); assert.equal(logs.length, 0);
    t.mock.timers.tick(30_000); await flush(); assert.equal(logs.length, 1);
    const pending = JSON.parse(logs[0]!); assert.equal(pending.phase, 'pending'); assert.equal(pending.pending, 1);
    assert.equal(f.usage.reconcile(), page); assert.equal(f.reads(), 1);
    gate.release(); await page; const final = JSON.parse(logs[1]!); assert.equal(final.sequence, pending.sequence);
    t.mock.timers.tick(60_000); assert.equal(logs.length, 2);
  } finally { gate.release(); await page; await f.usage.close(); }
});

test('throwing usage diagnostic sink changes no original transport or confirmed renewal', async () => {
  const renewals: number[] = [], f = fixture(false, async id => { if (!id) throw Error('usage'); }, async id => { renewals.push(id); },
    new PerformanceDiagnostics(() => { throw Error('sink'); }));
  try { await f.usage.reconcile(); assert.deepEqual([...renewals].sort(), [1, 2, 3, 4, 5]); }
  finally { await f.usage.close(); }
});

test('new durable expiry prevents stale confirmation from unnecessarily renewing queued work', async () => {
  const renewals: number[] = [];
  const f = fixture(true, async () => {}, async id => { renewals.push(id); if (!id) f.items[5]!.expiresAt = 61_000; });
  try { await f.usage.reconcile(); assert.deepEqual(renewals, [0, 1, 2, 3, 4]); }
  finally { await f.usage.close(); }
});
