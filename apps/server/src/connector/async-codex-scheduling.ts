import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable, validConnectorOwnerOutput } from './connector-owner-domain.js';
import type { CodexSchedulingRecheck } from './connector-codex-scheduling-domain.js';
import type { TurnWorkerQueue } from '../commands/turn-worker.js';

/** Scan/read ports for the ORIGINAL TurnWorker, not a replacement scheduler.
 * No SQL, native requests, timers, queue copy or permission cache. The original
 * runtime owns pause/close and must drain its worker before the shared owner.
 * notifyAdmission is an untrusted wake hint, never admission or authorization. */
export class AsyncCodexScheduling implements TurnWorkerQueue {
  private readonly listeners = new Set<(runtime: string) => void>();
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>) {}
  async observe(sessionKey: string) {
    const value = await this.owner.command('codexSchedulingObservation', { sessionKey });
    if (!validConnectorOwnerOutput('codexSchedulingObservation', value) || value.sessionKey !== sessionKey) throw new ConnectorOwnerUnavailable();
    return value;
  }
  async recheck(input: CodexSchedulingRecheck) {
    const value = await this.owner.command('codexSchedulingRecheck', input);
    if (!validConnectorOwnerOutput('codexSchedulingRecheck', value)) throw new ConnectorOwnerUnavailable();
    return value;
  }
  async rejectHead(input: CodexSchedulingRecheck) {
    const value = await this.owner.command('codexSchedulingRejectHead', structuredClone(input));
    if (!validConnectorOwnerOutput('codexSchedulingRejectHead', value)) throw new ConnectorOwnerUnavailable();
    return value;
  }
  sessionPage(runtime: string, after: string, limit: number) {
    if (runtime !== 'codex') return Promise.reject(new ConnectorOwnerUnavailable());
    return this.owner.command('turnSessionPage', { runtime, after, limit });
  }
  recoveryPage(after: string, limit: number, connectionId?: string) {
    return this.owner.command('turnRecoveryPage', { runtime: 'codex', after, limit, connectionId: connectionId ?? null, mirror: false });
  }
  onAdmission(listener: (runtime: string) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  notifyAdmission() {
    for (const listener of this.listeners) {
      try { listener('codex'); } catch { /* Wake subscribers cannot undo durable admission. */ }
    }
  }
}
