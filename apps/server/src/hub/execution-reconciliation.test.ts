import assert from 'node:assert/strict';
import test from 'node:test';
import { HubExecutionSync } from './execution-sync.js';
import type { HubExecutionLeases, ExecutionLease } from './execution-leases.js';
import type { ConnectorClient } from './connector-client.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
function fixture(transport: (id: number) => Promise<void>, diagnostics = new PerformanceDiagnostics(() => {})) {
  const rows = Array.from({ length: 6 }, (_, id) => ({ id, version: 1, grantKey: String(id), state: 'revoking',
    nodeId: 'node', issuerId: 'issuer', proof: { ownerUserId: 'owner', connectionId: `domain-${id}`,
      nodeVersion: 1, userId: 'user', resource: { runtime: 'codex', sessionKey: 'synthetic' } },
  } as unknown as ExecutionLease));
  let reads = 0;
  const store = { revocations: () => { reads++; return rows.slice(); }, get: (id: number) => rows[id],
    acknowledgeRevoke: (id: number) => { rows[id]!.state = 'revoked'; return true; },
  } as unknown as HubExecutionLeases;
  const sync = new HubExecutionSync(store, 'hub', () => ({ expectedNodeId: 'node',
    json: async (_: string, options: { body: string }) => {
      const id = Number(JSON.parse(options.body).grantKey); await transport(id);
      return { nodeId: 'node', hubId: 'hub', issuerTokenId: 'issuer', revokedThroughVersion: 1 };
    },
  } as unknown as ConnectorClient), 32, () => 1000, diagnostics);
  return { sync, rows, reads: () => reads };
}

test('held revocation does not strand later healthy nodes; same original flight retains authority', async () => {
  const gate = held(), seen: number[] = []; let active = 0, peak = 0, ended = false;
  const f = fixture(async id => { seen.push(id); active++; peak = Math.max(peak, active);
    try { if (!id) await gate.promise; } finally { active--; } });
  const page = f.sync.reconcileRevocations(), observed = page.then(() => { ended = true; });
  try {
    await flush(); assert.deepEqual(seen, [0, 1, 2, 3, 4, 5]); assert.ok(peak <= 4);
    assert.equal(ended, false); assert.equal(f.rows[0]!.state, 'revoking'); assert.equal(f.reads(), 1);
    const original = f.sync.synchronize(0); assert.equal(f.sync.synchronize(0), original);
    await flush(); assert.equal(seen.filter(id => !id).length, 1);
    gate.release(); await observed; await original;
    assert.deepEqual(await page, { examined: 6, acknowledged: 6, nextCursor: 5 });
  } finally { gate.release(); await page; await f.sync.close(); }
});

test('four held revocations stay bounded and close cannot acknowledge unreturned originals', async () => {
  const gate = held(), seen: number[] = []; const f = fixture(async id => { seen.push(id); await gate.promise; });
  const page = f.sync.reconcileRevocations(); let ended = false;
  try {
    await flush(); assert.deepEqual(seen, [0, 1, 2, 3]);
    const closing = f.sync.close().then(() => { ended = true; }); await flush(); assert.equal(ended, false);
    assert.ok(f.rows.every(row => row.state === 'revoking'));
    gate.release(); await closing;
    assert.deepEqual(await page, { examined: 6, acknowledged: 0, nextCursor: 5 });
    assert.deepEqual(seen, [0, 1, 2, 3]); assert.ok(f.rows.every(row => row.state === 'revoking'));
  } finally { gate.release(); await page; await f.sync.close(); }
});

test('failed revocation is logged before another original returns; no private error or fake ACK', async () => {
  const gate = held(), logs: string[] = [];
  const f = fixture(async id => { if (!id) await gate.promise; if (id === 1) throw Error('private-token SQL path'); },
    new PerformanceDiagnostics(line => logs.push(line), () => 100));
  const page = f.sync.reconcileRevocations();
  try {
    await flush(); const pending = logs.map(line => JSON.parse(line)).filter(row => row.phase === 'pending');
    assert.equal(pending.length, 1); assert.equal(pending[0].operation, 'hub-revocation-reconcile');
    assert.equal(pending[0].deferred, 1); assert.equal(f.rows[1]!.state, 'revoking');
    assert.ok(!logs.join('').includes('private-token')); gate.release();
    assert.deepEqual(await page, { examined: 6, acknowledged: 5, nextCursor: 5 });
    const final = JSON.parse(logs.at(-1)!); assert.equal(final.category, 'failed');
    assert.equal(final.sequence, pending[0].sequence); assert.equal(final.settled, 5);
  } finally { gate.release(); await page; await f.sync.close(); }
});

test('broken observation sink cannot change rolling work, errors or durable ACK', async () => {
  const f = fixture(async id => { if (!id) throw Error('unknown'); }, new PerformanceDiagnostics(() => { throw Error('sink'); }));
  try {
    assert.deepEqual(await f.sync.reconcileRevocations(), { examined: 6, acknowledged: 5, nextCursor: 5 });
    assert.equal(f.rows[0]!.state, 'revoking');
  } finally { await f.sync.close(); }
});

test('close before reserved page tasks invoke performs no transport', async () => {
  let calls = 0; const f = fixture(async () => { calls++; });
  const page = f.sync.reconcileRevocations(); await f.sync.close();
  assert.deepEqual(await page, { examined: 6, acknowledged: 0, nextCursor: 5 }); assert.equal(calls, 0);
});
