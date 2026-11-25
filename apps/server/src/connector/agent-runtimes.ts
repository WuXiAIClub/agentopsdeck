import type { AdmissionPause } from '../lifecycle/request-drain.js';
import type { HistoryRefreshOptions } from '../refresh/history.js';

// Internal lifecycle boundary, NOT a grant/runtime expansion. SDK runtimes
// are explicitly configured and owner-only; discovery never grants execution.
export type ConnectorAgentId = 'codex' | 'hermes' | 'claude-code' | 'ghcp' | 'antigravity';
const agentIds = new Set<string>(['codex', 'hermes', 'claude-code', 'ghcp', 'antigravity']);

export interface ConnectorAgentLifecycle {
  id: ConnectorAgentId;
  refreshSession(key: string, options: HistoryRefreshOptions): Promise<void>;
  isSessionHistoryReady(key: string): boolean;
  pauseQueueWorker(): AdmissionPause;
  close(): Promise<void>;
}

export function connectorAgentId(key: string): ConnectorAgentId | undefined {
  const separator = key.indexOf(':');
  if (separator < 1) return;
  const prefix = key.slice(0, separator);
  return agentIds.has(prefix) ? prefix as ConnectorAgentId : undefined;
}

/** Registry of Connector-owned processes. OpenClaw retains its existing path;
 * disabled/reserved Agent keys must never fall through to that path. No native
 * discovery, session import, automatic restart, or authorization lives here. */
export class ConnectorAgentRuntimes {
  private readonly agents = new Map<ConnectorAgentId, ConnectorAgentLifecycle>();
  private closing: Promise<void> | undefined;
  constructor(agents: readonly ConnectorAgentLifecycle[]) {
    for (const agent of agents) {
      if (!agentIds.has(agent.id) || this.agents.has(agent.id)) throw new Error('Duplicate or unsupported Connector runtime');
      this.agents.set(agent.id, agent);
    }
  }
  forSession(key: string): ConnectorAgentLifecycle | undefined {
    const id = connectorAgentId(key);
    if (!id) return;
    if (this.closing) throw new Error('Connector runtime is closing');
    const agent = this.agents.get(id);
    if (!agent) throw new Error('Requested Agent runtime is disabled');
    return agent;
  }
  historyReady(key: string): boolean | undefined {
    const id = connectorAgentId(key);
    if (!id) return;
    return !this.closing && (this.agents.get(id)?.isSessionHistoryReady(key) ?? false);
  }
  pauseQueueWorkers(): AdmissionPause {
    if (this.closing) throw new Error('Connector runtime is closing');
    // A synchronous pause failure deliberately leaves already paused runtimes
    // paused: maintenance must fail closed, never partially reopen execution.
    const pauses: AdmissionPause[] = [];
    let pauseFailed = false;
    for (const agent of this.agents.values()) {
      try {
        const pause = agent.pauseQueueWorker();
        pauses.push(pause);
        // A later synchronous failure must not leave an earlier rejected drain
        // unhandled. The returned aggregate still reports a failed drain.
        void pause.drained.catch(() => {});
      } catch { pauseFailed = true; }
    }
    if (pauseFailed) throw new Error('Connector runtime pause failed; execution fence must remain closed');
    let drained = false;
    let resumed = false;
    return {
      drained: Promise.all(pauses.map(pause => pause.drained)).then(() => { drained = true; }, () => {
        throw new Error('Connector runtime drain failed; execution fence must remain closed');
      }),
      resume: () => {
        if (this.closing || !drained || resumed) return false;
        resumed = true;
        for (const pause of pauses) {
          let reopened = false;
          try { reopened = pause.resume(); } catch { /* Native exceptions fail closed too. */ }
          if (!reopened) {
            // The outer execution fence remains closed during this operation.
            // Re-pause every runtime if one refuses its resume lease.
            let failed = false;
            for (const agent of this.agents.values()) {
              try {
                const recovery = agent.pauseQueueWorker();
                // No maintenance success can be reported on this failed lease.
                // Handle rejected drains without leaking raw native diagnostics.
                void recovery.drained.catch(() => {});
              } catch { failed = true; }
            }
            if (failed) throw new Error('Connector runtime pause failed; execution fence must remain closed');
            return false;
          }
        }
        return true;
      },
    };
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      const results = await Promise.allSettled([...this.agents.values()].map(agent => Promise.resolve().then(() => agent.close())));
      if (results.some(result => result.status === 'rejected')) {
        // Native error text can include prompts/credentials; never return it.
        throw new Error('One or more Connector runtimes failed to close');
      }
    })();
  }
}
