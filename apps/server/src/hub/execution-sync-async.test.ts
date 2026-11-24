import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { HubExecutionSync, type ExecutionLeasePersistence } from './execution-sync.js';
import type { ExecutionLease } from './execution-leases.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function fixture(options: { pause?: string; state?: ExecutionLease['state']; mismatch?: boolean; ack?: boolean;
  diagnostics?: PerformanceDiagnostics; maxFlights?: number } = {}) {
  const entered = gate(), original = gate(), calls: string[] = [];
  const lease = { id: 1, grantKey: 'synthetic-private-key', version: 1,
    nodeId: 'node_00000000-0000-4000-8000-000000000001', issuerId: 'synthetic-private-issuer',
    proof: { userId: 'user', resource: { runtime: 'codex', sessionKey: 'codex:synthetic-private-session' } },
    actions: ['messages:send'], expiresAt: Date.now() + 60_000, state: options.state ?? 'pending' } as ExecutionLease;
  let reads = 0, transports = 0, acknowledgments = 0;
  async function run<T>(method: string, value: T): Promise<T> {
    calls.push(method);
    if (options.pause === method) { entered.release(); await original.promise; calls.push(method + ':settled'); }
    return value;
  }
  const leases: ExecutionLeasePersistence = {
    reserve: () => run('reserve', lease),
    get: () => run(++reads === 1 ? 'get' : 'finalGet', lease),
    prepareIssue: () => run('prepareIssue', lease),
    acknowledgeIssue: async () => { const accepted = await run('acknowledgeIssue', options.ack ?? true); acknowledgments++; return accepted; },
    acknowledgeRevoke: async () => { const accepted = await run('acknowledgeRevoke', options.ack ?? true); acknowledgments++; if (accepted) lease.state = 'revoked'; return accepted; },
    revoke: () => run('revoke', undefined),
    revocations: () => run('revocations', [lease]),
  };
  const client = { expectedNodeId: lease.nodeId, json: async () => {
    transports++; calls.push('transport');
    return { nodeId: options.mismatch ? 'mismatch' : lease.nodeId, hubId: 'hub', issuerTokenId: lease.issuerId,
      revokedThroughVersion: 1, leaseMs: 60_000, grant: { id: 'synthetic-ref', actorId: 'synthetic-actor' } };
  }};
  const rows: Record<string, unknown>[] = [];
  const diagnostics = options.diagnostics ?? new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  const sync = new HubExecutionSync(leases, 'hub', () => options.pause === 'clientFor'
    ? run('clientFor', client as never) : client as never, options.maxFlights ?? 32, Date.now, diagnostics);
  return { sync, leases, lease, entered, original, calls, rows, transports: () => transports,
    acknowledgments: () => acknowledgments, acquire: () => sync.acquire(lease.proof, lease.nodeId, lease.issuerId, lease.actions) };
}

for (const pause of ['reserve','get','clientFor','prepareIssue','acknowledgeIssue','acknowledgeRevoke','finalGet','revoke','revocations'])
test(`async execution lease ${pause}: close waits original settlement without new delivery`, async () => {
  const f = fixture({ pause, state: pause === 'acknowledgeRevoke' || pause === 'revocations' ? 'revoking' : 'pending', mismatch: pause === 'revoke' });
  const pending = pause === 'reserve' ? f.acquire() : pause === 'revocations' ? f.sync.reconcileRevocations() : f.sync.synchronize(1);
  const rejected = assert.rejects(pending, pause === 'revoke' ? /mismatch/ : /closed/);
  await f.entered.promise;
  const deliveries = f.transports();
  let closed = false;
  const closing = f.sync.close().then(() => { closed = true; });
  await delay(0); assert.equal(closed, false, 'an abort is not the original SQL settlement');
  assert.equal(f.transports(), deliveries);
  assert.throws(() => f.acquire(), /closed/);
  await assert.rejects(f.sync.synchronize(2), /closed/);
  f.original.release(); await rejected; await closing;
  assert.equal(closed, true); assert.equal(f.transports(), deliveries, 'no post-close issue or revoke transport');
  assert.ok(f.calls.includes(pause + ':settled'));
});

for (const state of ['pending','revoking'] as const)
test(`async ${state} acknowledgment false is not treated as a truthy Promise`, async () => {
  const f = fixture({ state, ack: false });
  try {
    await assert.rejects(f.sync.synchronize(1), state === 'pending' ? /changed/ : /mismatch/);
    assert.equal(f.transports(), 1); assert.equal(f.acknowledgments(), 1);
    assert.equal(f.calls.includes('finalGet'), false);
  } finally { await f.sync.close(); }
});

for (const state of ['pending','revoking'] as const)
test(`sync reads with async ${state} ACK false cannot declare successful synchronization`, async () => {
  const f = fixture({ state, ack: false });
  f.leases.get = () => f.lease;
  f.leases.prepareIssue = () => f.lease;
  try {
    await assert.rejects(f.sync.synchronize(1), state === 'pending' ? /changed/ : /mismatch/);
    assert.equal(f.transports(), 1); assert.equal(f.acknowledgments(), 1);
  } finally { await f.sync.close(); }
});

test('async reserve pending is bounded independently and cannot escape close', async () => {
  const f = fixture({ pause: 'reserve', maxFlights: 2 });
  const first = f.acquire(), second = f.acquire();
  const rejected = [assert.rejects(first, /closed/), assert.rejects(second, /closed/)];
  await assert.rejects(f.acquire(), /capacity/);
  assert.equal(f.calls.filter(method => method === 'reserve').length, 2);
  const closing = f.sync.close(); f.original.release(); await Promise.all([...rejected, closing]);
  assert.equal(f.transports(), 0);
});

test('async revocation-page admission is bounded and retained until its original read settles', async () => {
  const f = fixture({ pause: 'revocations', maxFlights: 1 });
  const first = f.sync.reconcileRevocations(), rejected = assert.rejects(first, /closed/);
  await f.entered.promise; await assert.rejects(f.sync.reconcileRevocations(), /capacity/);
  assert.equal(f.calls.filter(method => method === 'revocations').length, 1);
  const closing = f.sync.close(); f.original.release(); await rejected; await closing;
  assert.equal(f.transports(), 0);
});

test('sync compatibility reserve still throws before returning a Promise and does not leak acquisition slots', async () => {
  const f = fixture({ maxFlights: 1 });
  f.leases.reserve = () => { throw Error('synthetic refusal'); };
  for (let index = 0; index < 3; index++) assert.throws(() => f.acquire(), /synthetic refusal/);
  await f.sync.close(); assert.equal(f.transports(), 0);
});

test('close reentry in original reserve cannot hide its pending owner', async () => {
  const f = fixture(); let closing: Promise<void> | undefined;
  f.leases.reserve = () => { closing = f.sync.close(); return f.lease; };
  await assert.rejects(f.acquire(), /closed/); await closing;
  assert.equal(f.transports(), 0);
});

test('async reservations for the same original lease retain one synchronization flight', async () => {
  const f = fixture({ pause: 'get' });
  const first = f.acquire(), second = f.acquire();
  await f.entered.promise; assert.equal(f.calls.filter(method => method === 'get').length, 1);
  f.original.release(); assert.deepEqual(await first, await second);
  assert.equal(f.transports(), 1); await f.sync.close();
});

test('async final lookup missing fails rather than returning an undefined successful lease', async () => {
  const f = fixture(); let reads = 0;
  f.leases.get = async () => ++reads === 1 ? f.lease : undefined;
  try { await assert.rejects(f.sync.synchronize(1), /not found/); assert.equal(f.transports(), 1); }
  finally { await f.sync.close(); }
});

for (const failure of ['start','clock','sink'] as const)
test(`execution synchronization diagnostics ${failure} failure cannot replace its original result`, async () => {
  const diagnostics = new PerformanceDiagnostics(() => { if (failure === 'sink') throw Error('private sink'); },
    () => { if (failure === 'clock') throw Error('private clock'); return performance.now(); });
  if (failure === 'start') diagnostics.start = () => { throw Error('private start'); };
  const f = fixture({ diagnostics });
  try {
    assert.equal((await f.sync.synchronize(1)).id, 1);
    f.lease.state = 'revoking';
    assert.equal((await f.sync.reconcileRevocations()).acknowledged, 1);
    assert.equal(f.transports(), 2); assert.equal(f.acknowledgments(), 2);
  } finally { await f.sync.close(); }
});

test('execution synchronization logs bounded numeric settlement without private binding or session text', async () => {
  const f = fixture();
  try {
    await f.sync.synchronize(1);
    const rows = f.rows.filter(row => row.operation === 'hub-execution-sync');
    assert.ok(rows.some(row => row.step === 2 && row.settled === 1));
    assert.equal(JSON.stringify(rows).includes('synthetic-private'), false);
  } finally { await f.sync.close(); }
});
