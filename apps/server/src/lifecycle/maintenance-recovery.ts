import type { connectionRecoverySnapshot } from '../storage/connection-recovery.js';

export type MaintenanceConnectionObservation = ReturnType<typeof connectionRecoverySnapshot>;
export type MaintenanceRecoveryObservation = {
  scope: 'maintenance-journal';
  transport: { scope: 'process'; pending: number; accepted: number; unavailable: boolean; closing: boolean; ownerExitConfirmed: boolean };
  connection: MaintenanceConnectionObservation | { state: 'unavailable' | 'unobserved' };
};
const states = ['ready', 'owner-rollback-required', 'parent-rollback-required', 'close-required', 'closed'];
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validMaintenanceConnectionObservation(value: unknown): value is MaintenanceConnectionObservation {
  return record(value) && Object.keys(value).length === 2 && typeof value.state === 'string'
    && states.includes(value.state) && count(value.attempts);
}
/** Fixed read-only shape; arbitrary owner/config/SQL data never reaches HTTP. */
export function validMaintenanceRecoveryObservation(value: unknown): value is MaintenanceRecoveryObservation {
  if (!record(value) || Object.keys(value).length !== 3 || value.scope !== 'maintenance-journal') return false;
  const transport = value.transport, connection = value.connection;
  return record(transport) && Object.keys(transport).length === 6 && transport.scope === 'process'
    && count(transport.pending) && count(transport.accepted) && typeof transport.unavailable === 'boolean'
    && typeof transport.closing === 'boolean' && typeof transport.ownerExitConfirmed === 'boolean'
    && (validMaintenanceConnectionObservation(connection) || (record(connection) && Object.keys(connection).length === 1
      && typeof connection.state === 'string' && ['unavailable', 'unobserved'].includes(connection.state)));
}
