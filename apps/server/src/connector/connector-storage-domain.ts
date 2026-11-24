import type { ConnectorUserStore } from './connector-user-store.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Evidence = { authorization: string; expectedNode: string; protocol: string; originPresent: boolean };
type Failure = { status: 403 | 503; error: 'Storage maintenance unavailable' };
type Reply<T> = Failure | { status: 200; value: T };
export type ConnectorStorageCommands = {
  authorizedStorageRecovery: { input: Evidence; output: Reply<ReturnType<ConnectorUserStore['storageRecovery']>> };
  authorizedStorageStats: { input: Evidence; output: Reply<Awaited<ReturnType<ConnectorUserStore['storageStats']>>> };
  authorizedStorageCheckpoint: { input: Evidence; output: Reply<Awaited<ReturnType<ConnectorUserStore['checkpointStorage']>>> };
};
export type ConnectorStorageKind = keyof ConnectorStorageCommands;
// Append-only diagnostic protocol. No caller-supplied SQL, path or callback.
export const connectorStorageSteps: Readonly<Record<ConnectorStorageKind, number>> = Object.freeze({
  authorizedStorageRecovery: 35, authorizedStorageStats: 36, authorizedStorageCheckpoint: 37,
});
export const isConnectorStorageKind = (kind: string): kind is ConnectorStorageKind => Object.hasOwn(connectorStorageSteps, kind);
const record = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const header = (v: unknown) => typeof v === 'string' && Buffer.byteLength(v) <= 4096 && !/[\0\r\n]/.test(v);
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const duration = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const recovery = (v: unknown) => record(v, ['state', 'attempts']) && integer(v.attempts)
  && ['ready', 'owner-rollback-required', 'parent-rollback-required', 'close-required', 'closed'].includes(v.state as string);
const timings = (v: unknown) => record(v, ['sqlSteps', 'sqlMs', 'sqlMaxMs', 'jsonCalls', 'jsonMs', 'jsonBytes'])
  && integer(v.sqlSteps) && integer(v.jsonCalls) && integer(v.jsonBytes) && duration(v.sqlMs) && duration(v.sqlMaxMs) && duration(v.jsonMs);
export function validConnectorStorageInput(_kind: ConnectorStorageKind, v: unknown): boolean {
  return record(v, ['authorization', 'expectedNode', 'protocol', 'originPresent'])
    && header(v.authorization) && header(v.expectedNode) && header(v.protocol) && typeof v.originPresent === 'boolean';
}
export function validConnectorStorageOutput(kind: ConnectorStorageKind, v: unknown): boolean {
  if (record(v, ['status', 'error'])) return (v.status === 403 || v.status === 503) && v.error === 'Storage maintenance unavailable';
  if (!record(v, ['status', 'value']) || v.status !== 200) return false;
  const value = v.value;
  if (kind === 'authorizedStorageRecovery') return recovery(value);
  if (kind === 'authorizedStorageStats') return record(value, ['databaseBytes', 'walBytes', 'availableBytes', 'lowSpace', 'walPressure', 'connection', 'reads'])
    && integer(value.databaseBytes) && integer(value.walBytes) && integer(value.availableBytes)
    && typeof value.lowSpace === 'boolean' && typeof value.walPressure === 'boolean' && recovery(value.connection)
    && record(value.reads, ['claude', 'copilot']) && timings(value.reads.claude) && timings(value.reads.copilot);
  // SQLite reports -1 frame counts when the existing DB is not in WAL mode.
  return record(value, ['deferred']) && value.deferred === true
    || record(value, ['deferred', 'busy', 'logFrames', 'checkpointedFrames']) && value.deferred === false
      && integer(value.busy) && Number.isSafeInteger(value.logFrames) && Number(value.logFrames) >= -1
      && Number.isSafeInteger(value.checkpointedFrames) && Number(value.checkpointedFrames) >= -1;
}
export type ConnectorStorageDependencies = {
  owner: Pick<ConnectorUserStore, 'nodeId' | 'storageRecovery' | 'storageStats' | 'checkpointStorage'>;
  tokens: ConnectorTokenStore;
  diagnostics?: PerformanceDiagnostics;
  warningMs?: number;
};
class MaintenanceAuthorityChanged extends Error {}

/** Original operator policy, resolved inside the sole DB/token owner. Async
 * sampling/admission never freezes credential authority. PASSIVE checkpoint
 * remains on the original connection: no replacement handle or replay. */
export async function executeConnectorStorage<K extends ConnectorStorageKind>(kind: K,
  input: ConnectorStorageCommands[K]['input'], deps: ConnectorStorageDependencies): Promise<ConnectorStorageCommands[K]['output']> {
  const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'connector-storage-maintenance');
  trace.add('step', connectorStorageSteps[kind]);
  let failed = true, executed = false;
  const warning = setTimeout(() => trace.reportPending({ pending: 1, unknown: Number(executed) }), deps.warningMs ?? 30_000);
  warning.unref();
  try {
    const principal = () => {
      const actor = deps.tokens.authenticateAuthorization(input.authorization);
      if (!actor) return undefined;
      if (actor.scopes.includes('connector:update')) return actor;
      if (!input.originPresent && input.protocol === '1' && input.expectedNode === deps.owner.nodeId
        && actor.scopes.includes('connector:lifecycle')) return actor;
      return undefined;
    };
    const original = principal();
    if (!original) throw new MaintenanceAuthorityChanged();
    const check = () => {
      if (principal()?.tokenId !== original.tokenId) throw new MaintenanceAuthorityChanged();
      if (kind !== 'authorizedStorageRecovery' && ['closed', 'close-required'].includes(deps.owner.storageRecovery().state))
        throw new Error('Original storage owner is unavailable');
    };
    check();
    executed = true;
    const value = kind === 'authorizedStorageRecovery' ? deps.owner.storageRecovery()
      : kind === 'authorizedStorageStats' ? await deps.owner.storageStats() : await deps.owner.checkpointStorage(check);
    check();
    const reply = { status: 200 as const, value };
    if (!validConnectorStorageOutput(kind, reply)) throw new Error('Invalid original storage observation');
    failed = false; trace.add('settled', 1);
    return reply as ConnectorStorageCommands[K]['output'];
  } catch (error) {
    // Do not reflect arbitrary rejection text or coerce a hostile status.
    let denied = false;
    try { denied = error instanceof MaintenanceAuthorityChanged; } catch { trace.add('classificationUnknown', 1); }
    trace.add(denied && !executed ? 'deferred' : 'unknown', 1);
    return { status: denied ? 403 : 503, error: 'Storage maintenance unavailable' };
  } finally { clearTimeout(warning); trace.finish(failed); }
}
