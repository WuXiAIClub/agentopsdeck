import assert from 'node:assert/strict';
import test from 'node:test';
import { validMaintenanceConnectionObservation, validMaintenanceRecoveryObservation } from './maintenance-recovery.js';

const transport = { scope: 'process', pending: 0, accepted: 0, unavailable: false, closing: false, ownerExitConfirmed: false };
test('maintenance recovery accepts only fixed numeric owner observations', () => {
  for (const state of ['ready', 'owner-rollback-required', 'parent-rollback-required', 'close-required', 'closed']) {
    assert.equal(validMaintenanceConnectionObservation({ state, attempts: 0 }), true);
    assert.equal(validMaintenanceRecoveryObservation({ scope: 'maintenance-journal', transport, connection: { state, attempts: 0 } }), true);
  }
  for (const state of ['unavailable', 'unobserved']) {
    assert.equal(validMaintenanceRecoveryObservation({ scope: 'maintenance-journal', transport, connection: { state } }), true);
  }
  for (const connection of [{ state: 'ready' }, { state: 'idle', attempts: 0 }, { state: 'ready', attempts: -1 },
    { state: 'ready', attempts: NaN }, { state: 'ready', attempts: 0, sql: 'private' },
    { state: 'unavailable', attempts: 0 }, { state: { toString() { throw Error('coercion'); } } }]) {
    assert.equal(validMaintenanceRecoveryObservation({ scope: 'maintenance-journal', transport, connection }), false);
  }
  for (const value of [{ ...transport, pending: -1 }, { ...transport, accepted: 0.5 }, { ...transport, unavailable: 1 },
    { ...transport, path: 'private' }, { ...transport, scope: 'database' }]) {
    assert.equal(validMaintenanceRecoveryObservation({ scope: 'maintenance-journal', transport: value, connection: { state: 'unobserved' } }), false);
  }
});
