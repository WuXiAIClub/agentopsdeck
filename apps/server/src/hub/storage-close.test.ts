import assert from 'node:assert/strict';
import test from 'node:test';
import { HubStore } from './hub-store.js';
import { connectionRecoverySnapshot } from '../storage/connection-recovery.js';

for (const lane of ['executionCommands', 'maintenanceCommands', 'lifecycleCommands', 'executionIssuers'] as const) {
  test(`Hub storage close waits for the original ${lane} continuation`, async () => {
    const store = new HubStore(':memory:', 'synthetic-vault'), db = (store as any).db;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const owner = store[lane] as any;
    const flights: Set<Promise<unknown>> | Map<string, Promise<unknown>> = owner.flights ?? owner.configuring;
    let reads = 0;
    const original = gate.then(() => {
      assert.equal(Number(db.prepare('SELECT 1 AS n').get().n), 1);
      reads++;
    });
    const work = original.finally(() => { flights.delete(work as never); if (flights instanceof Map) flights.delete('original'); });
    // Isolated accepted-owner fixture: no provider request or live state.
    if (flights instanceof Map) flights.set('original', work); else flights.add(work);
    void work.catch(() => {});
    try {
      const closing = store.close();
      assert.equal(connectionRecoverySnapshot(db).state, 'ready', 'pending work is not closed-owner proof');
      assert.deepEqual(store.storageRecovery().ownerClose, { state: 'draining', active: true, pending: 1, attempts: 1 });
      assert.equal(store.close(), closing, 'one close attempt while work is pending');
      release();
      await closing;
      assert.equal(reads, 1, 'original continuation ran exactly once before close');
      assert.equal(connectionRecoverySnapshot(db).state, 'closed');
      assert.equal(store.storageRecovery().ownerClose?.state, 'closed');
      await store.close();
    } finally {
      release();
      await work.catch(() => {});
      await store.close();
    }
  });
}

test('idle Hub storage close retains synchronous confirmed cleanup for existing owners', () => {
  const store = new HubStore(':memory:', 'synthetic-vault'), db = (store as any).db;
  assert.equal(store.close(), undefined);
  assert.equal(connectionRecoverySnapshot(db).state, 'closed');
  assert.equal(store.close(), undefined);
});
