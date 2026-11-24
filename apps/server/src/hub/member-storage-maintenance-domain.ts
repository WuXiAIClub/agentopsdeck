import type { HubStore } from './hub-store.js';

export type StorageMaintenanceAction = 'stats' | 'recovery' | 'checkpoint';
export type StorageMaintenanceCommand = { action: StorageMaintenanceAction };
export type StorageMaintenanceResult = { error: 401 | 403 } | {
  [K in StorageMaintenanceAction]: { action: K; value: Awaited<ReturnType<HubStore[
    K extends 'stats' ? 'storageStats' : K extends 'recovery' ? 'storageRecovery' : 'checkpointStorage']>> }
}[StorageMaintenanceAction];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
export function validStorageMaintenanceCommand(v: unknown): v is StorageMaintenanceCommand {
  return record(v) && fields(v, ['action']) && ['stats','recovery','checkpoint'].includes(String(v.action));
}
function recovery(v: unknown): boolean {
  if (!record(v) || !fields(v, ['state','attempts', ...(v.ownerClose === undefined ? [] : ['ownerClose'])])
    || !['ready','owner-rollback-required','parent-rollback-required','close-required','closed'].includes(String(v.state)) || !count(v.attempts)) return false;
  if (v.ownerClose === undefined) return true;
  const c = v.ownerClose;
  return record(c) && fields(c, ['state','active','pending','attempts']) && typeof c.active === 'boolean'
    && count(c.pending) && count(c.attempts) && ['open','draining','drain-failed','closing','close-required','close-outcome-unknown','closed'].includes(String(c.state));
}
export function validStorageMaintenanceResult(v: unknown): v is StorageMaintenanceResult {
  if (!record(v)) return false;
  if (fields(v, ['error'])) return v.error === 401 || v.error === 403;
  if (!fields(v, ['action','value'])) return false;
  const r = v.value;
  if (v.action === 'recovery') return recovery(r);
  if (!record(r)) return false;
  if (v.action === 'stats') return fields(r, ['databaseBytes','walBytes','availableBytes','lowSpace','walPressure','connection'])
    && count(r.databaseBytes) && count(r.walBytes) && count(r.availableBytes)
    && typeof r.lowSpace === 'boolean' && typeof r.walPressure === 'boolean' && recovery(r.connection);
  // SQLite legitimately returns -1 frame counts when no WAL is open.
  return v.action === 'checkpoint' && (r.deferred === true && fields(r, ['deferred'])
    || r.deferred === false && fields(r, ['deferred','busy','logFrames','checkpointedFrames'])
      && count(r.busy) && [r.logFrames,r.checkpointedFrames].every(n => Number.isSafeInteger(n) && (n as number) >= -1));
}
class Denied extends Error { constructor(readonly status: 401 | 403) { super('storage_maintenance_denied'); } }
/** Not a savepoint: PASSIVE cannot execute inside one. The original synchronous
 * policy guard runs after volume admission, immediately before native SQL. */
export async function executeStorageMaintenance(owner: HubStore, request: Request, expectedScope: string,
  command: StorageMaintenanceCommand): Promise<StorageMaintenanceResult> {
  const check = () => {
    const actor = owner.identities.commandPrincipal(request);
    if (!actor || owner.identities.recoveryScope(actor) !== expectedScope) throw new Denied(401);
    if (!actor.admin) throw new Denied(403);
  };
  try {
    check();
    if (command.action === 'recovery') { const value = owner.storageRecovery(); check(); return { action: 'recovery', value }; }
    if (command.action === 'stats') { const value = await owner.storageStats(); check(); return { action: 'stats', value }; }
    const value = await owner.checkpointStorage(check); check(); return { action: 'checkpoint', value };
  } catch (e) { if (e instanceof Denied) return { error: e.status }; throw e; }
}
