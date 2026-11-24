import type { AgentSummary } from '@agentopsdeck/shared';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

type SessionGroup = { agentId: string; sessions: { status?: string; hasActiveRun?: boolean }[] };
type Snapshot = { agents: AgentSummary[]; fallbackId: string | undefined };

/** Display discovery only, never execution admission or a permission cache.
 * Both HTTP surfaces share the actual directory read. A disconnected waiter
 * cannot replace it; close retains it until the original work has settled. */
export function createFallbackAgentCatalog(deps: {
  groups: () => SessionGroup[];
  registry?: () => Promise<string[]>;
  defaultAgentId?: string;
  runtimes: () => AgentSummary[];
  diagnostics?: PerformanceDiagnostics;
}) {
  let inflight: Promise<Snapshot> | undefined;
  let closing: Promise<void> | undefined;
  return {
    list(error?: string): Promise<AgentSummary[]> {
      if (closing) return Promise.reject(new Error('agent_catalog_unavailable'));
      // Publish before dispatch, including before a diagnostic clock/sink can
      // reenter. No timestamp cache of session status or runtime readiness.
      if (!inflight) inflight = Promise.resolve().then(async () => {
        const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'connector-agent-catalog');
        trace.add('step', 1);
        const warning = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000); warning.unref();
        let failed = true;
        try {
          let names: string[] = [], registryFailed = false;
          try { names = await deps.registry?.() ?? []; }
          catch { registryFailed = true; trace.add('deferred', 1); } // Keep the original session-derived fallback.
          // Read volatile state AFTER IO, not from a stale pre-await snapshot.
          const byId = new Map<string, AgentSummary>();
          for (const group of deps.groups()) {
            const running = group.sessions.some(session => session.status === 'running' || session.hasActiveRun);
            byId.set(group.agentId, { id: group.agentId, label: group.agentId, status: running ? 'running' : 'active' });
          }
          for (const name of names) if (!byId.has(name)) byId.set(name, { id: name, label: name, status: 'available' });
          let fallbackId: string | undefined;
          if (deps.defaultAgentId && !byId.has(deps.defaultAgentId)) {
            fallbackId = deps.defaultAgentId;
            byId.set(fallbackId, { id: fallbackId, label: fallbackId, status: 'unknown' });
          }
          for (const runtime of deps.runtimes()) byId.set(runtime.id, runtime);
          const agents = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
          trace.add('settled', 1); failed = registryFailed;
          return { agents, fallbackId };
        } catch { throw new Error('agent_catalog_unavailable'); }
        finally { clearTimeout(warning); trace.finish(failed); }
      }).finally(() => { inflight = undefined; });
      return inflight.then(snapshot => snapshot.agents.map(agent => ({ ...agent,
        ...(error && agent.id === snapshot.fallbackId && agent.status === 'unknown' ? { status: 'degraded' } : {}),
      })));
    },
    close(): Promise<void> {
      // Freeze admission synchronously. A failed display read is already
      // observed; closure waits for settlement, not a successful display DTO.
      return closing ??= (inflight ?? Promise.resolve()).then(() => undefined, () => undefined);
    },
  };
}
