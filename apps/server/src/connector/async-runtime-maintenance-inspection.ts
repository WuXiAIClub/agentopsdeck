import { createTaskDrain } from '../lifecycle/task-drain.js';
import type { ConnectorUpdateService } from './update-service.js';
import type { RuntimeMaintenancePersistence } from './runtime-maintenance-persistence.js';
import type { CurrentNativeMaintenanceObservation } from './maintenance-inspection.js';

type Native = { activeRuns: number; backgroundTerminals: number; inFlightWrites: number; assertCurrent(): void };
type Sdk = { nativeWorkers: number; admissionInFlight: number; startupWorkers: number; assertCurrent(): void };

/** The original runtime's read-only native/SDK/durable/status sequence, with
 * worker permission awaits separated from synchronous effect-owner checks.
 * This does NOT authorize history hydration or certify unsupported runtimes. */
export function createAsyncRuntimeMaintenanceInspection(deps: {
  nodeId: string;
  updateService: Pick<ConnectorUpdateService, 'maintenanceStatus'>;
  persistence: Pick<RuntimeMaintenancePersistence, 'command'>;
  codex: { inspectMaintenanceAsync(authorize: () => Promise<void>, local: () => void, deadline: number): Promise<Native> };
  sdk: readonly { inspectMaintenance(): Promise<Sdk> }[];
  requests: { isStopping(): boolean; isPaused(): boolean; activeWrites(): number };
  unsupportedNative(): boolean;
  probes(): number;
}) {
  const tasks = createTaskDrain();
  let closed = false;
  const inspect = (authorize: () => Promise<void>, assertLocal: () => void, historyRecovery = false): Promise<CurrentNativeMaintenanceObservation> =>
    tasks.run(async () => {
      const observedAt = Date.now(), deadline = observedAt + 4000;
      const available = () => {
        assertLocal();
        if (closed || deps.requests.isStopping() || deps.unsupportedNative() || Date.now() >= deadline)
          throw Error('Native maintenance observation unavailable');
      };
      available();
      const before = await deps.updateService.maintenanceStatus(authorize);
      const state = before.state, fenceId = before.fenceId;
      const local = () => {
        available();
        if (!['released', 'paused'].includes(state) || (state === 'paused') !== deps.requests.isPaused())
          throw Error('Maintenance state changed');
      };
      local();
      const native = await deps.codex.inspectMaintenanceAsync(authorize, local, deadline);
      local(); await authorize(); local();
      // A rejected SDK observation must not release the drain while another
      // configured runtime still owns a physical inspection. Start each in a
      // promise as well, so a synchronous throw cannot strand earlier siblings.
      const observations = await Promise.allSettled(deps.sdk.map(runtime =>
        Promise.resolve().then(() => { local(); return runtime.inspectMaintenance(); })));
      const failure = observations.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      const sdk = observations.map(result => {
        if (result.status !== 'fulfilled') throw Error('SDK maintenance observation unavailable');
        return result.value;
      });
      local(); await authorize(); local();
      // Only synchronous local ownership enters the persistence guard. The
      // worker owns its fixed command; current authority is awaited outside it.
      const persisted = await deps.persistence.command('runtimeMaintenanceObserve', { historyRecovery }, local);
      local(); await authorize(); local();
      const after = await deps.updateService.maintenanceStatus(authorize);
      local();
      if (persisted.nodeId !== deps.nodeId || state !== after.state || fenceId !== after.fenceId)
        throw Error('Maintenance fence changed');
      const current = () => { local(); native.assertCurrent(); sdk.forEach(facts => facts.assertCurrent()); };
      await authorize(); current();
      return { ...persisted, observedAt, nativeVerified: true, assertCurrent: current,
        activeRuns: native.activeRuns + sdk.reduce((sum, facts) => sum + facts.nativeWorkers, 0),
        backgroundTerminals: native.backgroundTerminals,
        inFlightWrites: deps.requests.activeWrites() + native.inFlightWrites + deps.probes()
          + sdk.reduce((sum, facts) => sum + facts.admissionInFlight + facts.startupWorkers, 0),
        ...(state === 'paused' && fenceId ? { fenceId } : {}) };
    });
  return { inspect, close() { closed = true; return tasks.close(); } };
}
