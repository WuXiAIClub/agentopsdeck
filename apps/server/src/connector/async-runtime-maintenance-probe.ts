import type { DeckStore } from '../projection/deck-store.js';
import type { CodexMaintenanceRecoveryAuthority } from '../codex/app-server.js';
import type { MaintenanceBusinessObservation } from './maintenance-readiness.js';
import type { CurrentNativeMaintenanceObservation } from './maintenance-inspection.js';
import type { RuntimeMaintenancePersistence } from './runtime-maintenance-persistence.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
import { checkMaintenanceLocal } from './maintenance-local-guard.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Codex = {
  readonly enabled: boolean; owns(key: string): boolean;
  refreshMaintenanceSessionsAsync(authority: CodexMaintenanceRecoveryAuthority): Promise<void>;
  recoverMaintenanceHistoryAsync(key: string, authority: CodexMaintenanceRecoveryAuthority): Promise<void>;
  refreshMaintenanceSessionAsync(key: string, authority: CodexMaintenanceRecoveryAuthority): Promise<void>;
  isSessionListReady(): boolean; isSessionHistoryReady(key: string): boolean;
};
type Sdk = { id: 'claude-code' | 'ghcp'; refreshSession(key: string, options: { fresh: true }): Promise<void>;
  isSessionHistoryReady(key: string): boolean };

/** Complete original 55s probe, NOT a replacement maintenance lock or a new
 * public capability. Readiness HTTP must call this INSIDE the original
 * withMaintenanceProbe and AsyncUpdatePersistence readiness context. */
export function createAsyncRuntimeMaintenanceProbe(deps: {
  nodeId: string; revision(): string | undefined;
  requests: { isStopping(): boolean; isPaused(): boolean };
  unsupportedNative(): boolean;
  codex: Codex; sdk: readonly Sdk[];
  projection: { refresh(options: { maxAgeMs: number }): Promise<void>; assertCurrent(): void };
  deck: Pick<DeckStore, 'getSession' | 'getSessionsState' | 'getMessages' | 'append'>;
  persistence: Pick<RuntimeMaintenancePersistence, 'command'>;
  inspect(authorize: () => Promise<void>, local: () => void, historyRecovery?: boolean): Promise<CurrentNativeMaintenanceObservation>;
  resumes(local: () => void): CodexMaintenanceRecoveryAuthority['resumes'];
  diagnostics?: PerformanceDiagnostics;
}) {
  const tasks = createTaskDrain(), sdk = [...deps.sdk];
  let closed = false, probes = 0;
  const probe = (sessionKey: string, authorize: () => Promise<void>, assertLocal: () => void = () => {}):
    Promise<Omit<MaintenanceBusinessObservation, 'fenceId'>> => tasks.run(async () => {
    const revision = deps.revision(), deadline = Date.now() + 55_000;
    const target = sdk.find(runtime => sessionKey.startsWith(`${runtime.id}:`));
    if (closed || probes || deps.unsupportedNative() || !revision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)
      || (!target && (!deps.codex.enabled || !deps.codex.owns(sessionKey))))
      throw Error('Pinned runtime business probe unavailable');
    let active = true;
    const local = () => {
      checkMaintenanceLocal(assertLocal);
      if (!active || closed || Date.now() >= deadline || deps.requests.isStopping() || !deps.requests.isPaused()
        || probes !== 1 || deps.revision() !== revision || deps.unsupportedNative())
        throw Error('Business probe isolation changed');
    };
    const current = async () => { local(); await authorize(); local(); };
    probes++;
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'connector-sqlite-command');
    trace.add('step', 348);
    let failed = true;
    try {
      const resumes = deps.resumes(local);
      const authority: CodexMaintenanceRecoveryAuthority = { authorize: current, local, resumes };
      await current();
      const before = await deps.inspect(current, local, true);
      local(); before.assertCurrent();
      if (before.nodeId !== deps.nodeId || !before.fenceId || before.activeRuns || before.backgroundTerminals
        || before.pendingExecutions || before.inFlightWrites !== 1)
        throw Error('Business probe requires native quiescence');
      // Only projection hydration bypasses the paused public scheduler. No
      // queue/turn-start gate is released, and all configured fragments run.
      await deps.projection.refresh({ maxAgeMs: 0 }); await current();
      if (deps.codex.enabled) { await deps.codex.refreshMaintenanceSessionsAsync(authority); await current(); }
      if ((target && !await deps.persistence.command('runtimeMaintenanceSdkSession', { key: sessionKey, runtime: target.id }, local))
        || !deps.deck.getSession(sessionKey)) throw Error('Probe requires an existing owned session');
      const recovering = await deps.persistence.command('runtimeMaintenanceHistory', {}, local);
      await current();
      for (const key of recovering) {
        await current(); await deps.codex.recoverMaintenanceHistoryAsync(key, authority); await current();
      }
      if (target) { await current(); await target.refreshSession(sessionKey, { fresh: true }); await current(); }
      else if (!recovering.includes(sessionKey)) {
        await deps.codex.refreshMaintenanceSessionAsync(sessionKey, authority); await current();
      }
      for (const key of await deps.persistence.command('runtimeMaintenanceInteractions', {}, local)) {
        local(); deps.deck.append('interaction.updated', {}, { sessionKey: key });
      }
      const preservation = await deps.persistence.command('runtimeMaintenancePreservation', { key: sessionKey, codex: !target }, local);
      const observation = await deps.inspect(current, local);
      await current(); observation.assertCurrent(); deps.projection.assertCurrent();
      if (observation.nodeId !== deps.nodeId || observation.fenceId !== before.fenceId || observation.activeRuns
        || observation.backgroundTerminals || observation.pendingExecutions || observation.queuedMessages !== before.queuedMessages
        || observation.inFlightWrites !== 1 || (deps.codex.enabled && !deps.codex.isSessionListReady())
        || !(target ? target.isSessionHistoryReady(sessionKey) : deps.codex.isSessionHistoryReady(sessionKey)))
        throw Error('Business projection is not quiescent and current');
      const state = deps.deck.getSessionsState({ includeHidden: true, includeArchived: true });
      const session = state.groups.flatMap(group => group.sessions).find(row => row.sessionKey === sessionKey);
      const messages = deps.deck.getMessages(sessionKey), execution = preservation.execution;
      const recoveredRunId = session?.runtime?.phase === 'interrupted' && execution?.runId
        && execution.cleanupRecovered ? execution.runId : undefined;
      if (!session || session.hasActiveRun || session.runtime?.sync !== 'current'
        || !['completed', 'failed', 'interrupted'].includes(session.runtime.phase)
        || !messages.some(message => message.role === 'user')
        || (!recoveredRunId && !messages.some(message => message.role === 'assistant'))
        || messages.some(message => message.status === 'sending' && !(message.role === 'tool' && message.turnId
          && execution?.sync === 'current' && execution.runId && execution.runId === session.runtime?.turnId
          && message.turnId !== execution.runId))) throw Error('Original business history unavailable');
      failed = false; trace.add('settled', 1);
      return { nodeId: deps.nodeId, observedAt: Date.now(), revision, sessionKey, messageCount: messages.length,
        projectionVerified: true, businessReadVerified: true, ...(recoveredRunId ? { recoveredRunId } : {}),
        preservation: { queueSha256: preservation.queueSha256, ...(execution ? { execution: {
          commandId: execution.commandId, connectionId: execution.connectionId, runId: execution.runId,
          phase: execution.phase, sync: execution.sync,
          ...(execution.executionProtection ? { executionProtection: execution.executionProtection } : {}),
        } } : {}) } };
    } finally { active = false; probes--; trace.finish(failed); }
  });
  return { probe, probes: () => probes, close() { closed = true; return tasks.close(); } };
}
