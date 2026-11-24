import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { registerStorageDiagnostics } from "./diagnostics-http.js";
import { PerformanceDiagnostics } from "../diagnostics/performance.js";
import { DatabaseSync } from 'node:sqlite';
import { HubStore } from '../hub/hub-store.js';
import { connectionRecoverySnapshot, markConnectionCleanupFault, recoverableConnection,
  retireConnectionForAsyncWork } from "./connection-recovery.js";
const coordinator = () => ({ scope: 'process' as const, status: 'idle' as const, pending: 0, acceptedRequests: 0, pendingVolumeSamples: 0, activeWriters: 0,
  recoveryProofs: 0, ownerExitConfirmed: false, cooldownMs: 0, blockedBy: null });

test('recovery observation exposes original Hub close drain without IO, release, replay or private fields', async () => {
  const store = new HubStore(':memory:', 'synthetic-vault'), app = new Hono();
  let release!: () => void, reads = 0, writes = 0;
  const original = new Promise<void>(resolve => { release = resolve; });
  const flights: Set<Promise<void>> = (store.executionCommands as any).flights;
  const work = original.finally(() => { flights.delete(work); }); flights.add(work);
  registerStorageDiagnostics(app, '/storage', {
    // Independent fixture authority only; no bypass of production identity.
    authorize: () => () => {}, stats: async () => { reads++; throw Error('must not read'); },
    checkpoint: () => { writes++; throw Error('must not write'); }, coordinator,
    performance: () => new PerformanceDiagnostics(() => {}).snapshot(), recovery: () => store.storageRecovery(),
  });
  const closing = store.close();
  try {
    const response = await app.request('/storage/recovery'), body = await response.json();
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(body.connection.ownerClose, { state: 'draining', active: true, pending: 1, attempts: 1 });
    assert.equal(reads, 0); assert.equal(writes, 0); assert.equal(store.close(), closing);
    assert.doesNotMatch(JSON.stringify(body), /synthetic-vault|SELECT|private|token/);
    release(); await closing;
    const settled = await (await app.request('/storage/recovery')).json();
    assert.equal(settled.connection.ownerClose.state, 'closed'); assert.equal(settled.connection.state, 'closed');
    assert.equal(reads, 0); assert.equal(writes, 0);
  } finally { release(); await work; await closing; }
});

test('authorized recovery observation remains available when storage IO fails; no checkpoint or owner repair', async () => {
  const app = new Hono(), diagnostics = new PerformanceDiagnostics(() => { throw Error('sink'); });
  let reads = 0, writes = 0, snapshots = 0;
  diagnostics.start('storage-connection-recovery').finish(true);
  registerStorageDiagnostics(app, '/storage', { authorize: () => () => {},
    stats: async () => { reads++; throw Error('/private/db'); }, checkpoint: () => { writes++; return { deferred: true }; },
    coordinator: () => { snapshots++; return coordinator(); }, performance: () => diagnostics.snapshot(),
    recovery: () => ({ state: 'owner-rollback-required', attempts: 2 }) });
  assert.equal((await app.request('/storage')).status, 503);
  const response = await app.request('/storage/recovery'), body = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(body.connection.state, 'owner-rollback-required'); assert.equal(body.connection.attempts, 2);
  assert.equal(body.performance.totals.sinkFailures, 1); assert.equal(snapshots, 1);
  assert.equal(reads, 1); assert.equal(writes, 0); assert.doesNotMatch(JSON.stringify(body), /private/);
});

test('recovery route rejects unauthorized access before any snapshot and rechecks revocation between sources', async () => {
  const app = new Hono(), diagnostics = new PerformanceDiagnostics(() => {}); let allowed = false, observations = 0;
  registerStorageDiagnostics(app, '/storage', {
    authorize: () => { const check = () => { if (!allowed) throw new HTTPException(403); }; check(); return check; },
    stats: async () => { throw Error('must not read'); }, checkpoint: () => { throw Error('must not write'); },
    coordinator: () => { observations++; allowed = false; return coordinator(); },
    performance: () => { observations++; return diagnostics.snapshot(); }, recovery: () => { observations++; return { state: 'ready', attempts: 0 }; }
  });
  assert.equal((await app.request('/storage/recovery')).status, 403); assert.equal(observations, 0);
  allowed = true; const revoked = await app.request('/storage/recovery');
  assert.equal(revoked.status, 403); assert.equal(observations, 1);
  assert.equal(Object.hasOwn(await revoked.json(), 'performance'), false);
});

test('recovery route catches revocation during performance or connection observation without delivering evidence', async () => {
  for (const during of ['performance', 'connection']) {
    const app = new Hono(), diagnostics = new PerformanceDiagnostics(() => {}); let allowed = true;
    registerStorageDiagnostics(app, '/storage', {
      authorize: () => { const check = () => { if (!allowed) throw new HTTPException(403); }; check(); return check; },
      stats: async () => { throw Error('unused'); }, checkpoint: () => { throw Error('unused'); }, coordinator,
      performance: () => { if (during === 'performance') allowed = false; return diagnostics.snapshot(); },
      recovery: () => { allowed = false; return { state: 'ready', attempts: 0 }; }
    });
    const response = await app.request('/storage/recovery');
    assert.equal(response.status, 403); assert.equal(Object.hasOwn(await response.json(), 'connection'), false);
  }
});

for (const state of ['owner-rollback-required', 'parent-rollback-required', 'close-required', 'closed'] as const) {
  test(`recovery inspection cannot repair or reopen the exact original connection (${state})`, async () => {
    const raw = new DatabaseSync(':memory:');
    const db = recoverableConnection(raw, new PerformanceDiagnostics(() => {}));
    let reads = 0, writes = 0;
    try {
      if (state === 'closed') db.close();
      else if (state === 'close-required') retireConnectionForAsyncWork(db);
      else {
        db.exec('BEGIN; CREATE TABLE uncommitted(value INTEGER); INSERT INTO uncommitted VALUES(1)');
        markConnectionCleanupFault(db, state === 'parent-rollback-required');
      }
      const app = new Hono(), before = connectionRecoverySnapshot(db);
      registerStorageDiagnostics(app, '/storage', { authorize: () => () => {}, coordinator,
        stats: async () => { reads++; throw Error('must not sample'); },
        checkpoint: () => { writes++; throw Error('must not checkpoint'); },
        performance: () => new PerformanceDiagnostics(() => {}).snapshot(),
        recovery: () => connectionRecoverySnapshot(db) });
      for (let query = 0; query < 3; query++) {
        const response = await app.request('/storage/recovery');
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).connection, before);
      }
      assert.equal(reads, 0); assert.equal(writes, 0);
      assert.deepEqual(connectionRecoverySnapshot(db), before);
      if (state.endsWith('rollback-required')) {
        assert.equal(raw.isTransaction, true, 'inspection must not rollback original work');
        assert.equal(raw.prepare('SELECT value FROM uncommitted').get()!.value, 1);
      } else assert.equal(raw.isOpen, state !== 'closed', 'inspection cannot close or reopen a handle');
    } finally { db.close(); }
  });
}
