import { AOD_MODEL_SET_ID, type ConnectorUpdateStatus } from '@agentopsdeck/shared';

/** Fixed wire operations, not an arbitrary URL/method/body forwarding port. */
export type ConnectionControlOperation =
  | { operation: 'capabilities' | 'modelSet' | 'updateStatus' | 'maintenanceStatus' }
  | { operation: 'reconcile'; request: { setId: typeof AOD_MODEL_SET_ID; idempotencyKey?: string; dryRun?: true } }
  | { operation: 'updateCheck'; request: { channel?: 'stable' | 'candidate' } };
export type ConnectionControlFacts = Readonly<{ state?: ConnectorUpdateStatus['state']; ok?: boolean }>;
export type ConnectionControlObservation = Readonly<{ operation: ConnectionControlOperation['operation']; status: number; facts: ConnectionControlFacts }>;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const states = new Set<unknown>(['idle','checking','available','downloading','verifying','installing','restarting','succeeded','failed','rolled_back']);
const knownState = (v: unknown): v is ConnectorUpdateStatus['state'] => states.has(v);
const fields = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
export function validConnectionControlOperation(v: unknown): v is ConnectionControlOperation {
  if (!object(v)) return false;
  if (['capabilities', 'modelSet', 'updateStatus', 'maintenanceStatus'].includes(String(v.operation))) return fields(v, ['operation']);
  if (!fields(v, ['operation', 'request']) || !object(v.request)) return false;
  const r = v.request;
  if (v.operation === 'reconcile') return fields(r, ['setId'], ['idempotencyKey', 'dryRun']) && r.setId === AOD_MODEL_SET_ID
    && (r.idempotencyKey === undefined || typeof r.idempotencyKey === 'string' && Buffer.byteLength(r.idempotencyKey) <= 4096 && !/[\x00-\x1f\x7f]/.test(r.idempotencyKey))
    && (r.dryRun === undefined || r.dryRun === true);
  return v.operation === 'updateCheck' && fields(r, [], ['channel']) && (r.channel === undefined || r.channel === 'stable' || r.channel === 'candidate');
}
export function validConnectionControlObservation(v: unknown): v is ConnectionControlObservation {
  if (!object(v) || !fields(v, ['operation', 'status', 'facts']) || !['capabilities','modelSet','updateStatus','maintenanceStatus','reconcile','updateCheck'].includes(String(v.operation))
    || !Number.isInteger(v.status) || Number(v.status) < 200 || Number(v.status) >= 500 || Number(v.status) >= 300 && Number(v.status) < 400
    || !object(v.facts) || !fields(v.facts, [], ['state', 'ok'])) return false;
  return (v.facts.state === undefined || knownState(v.facts.state))
    && (v.facts.ok === undefined || typeof v.facts.ok === 'boolean');
}
export function connectionControlWire(command: ConnectionControlOperation) {
  if (!validConnectionControlOperation(command)) throw Error('connection_control_unavailable');
  switch (command.operation) {
    case 'capabilities': return { path: '/capabilities', method: 'GET', maintenance: false } as const;
    case 'modelSet': return { path: '/gateway/model-set', method: 'GET', maintenance: true } as const;
    case 'updateStatus': return { path: '/update/status', method: 'GET', maintenance: false } as const;
    case 'maintenanceStatus': return { path: '/maintenance/status', method: 'GET', maintenance: true } as const;
    case 'reconcile': return { path: '/gateway/model-set/reconcile', method: 'POST', maintenance: true, body: JSON.stringify(command.request) } as const;
    case 'updateCheck': return { path: '/update/check', method: 'POST', maintenance: true, body: JSON.stringify(command.request) } as const;
  }
}
export function connectionControlObservation(command: ConnectionControlOperation, status: number, body: unknown): ConnectionControlObservation {
  // Never persist arbitrary upstream properties, text, error messages or credentials.
  const state = object(body) && knownState(body.state) ? body.state : undefined;
  const ok = object(body) && typeof body.ok === 'boolean' ? body.ok : undefined;
  const facts = Object.freeze({ ...(state !== undefined ? {state} : {}), ...(ok !== undefined ? {ok} : {}) });
  return Object.freeze({ operation: command.operation, status, facts });
}
