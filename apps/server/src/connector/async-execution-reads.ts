import type { AsyncConnectorOwner } from './async-connector-owner.js';

/** One original owner's fixed read port. Results are observations, not cached
 * permission or native idle proof. Runtime callers must await and recheck their
 * local connection/lifecycle before publishing or making any native request. */
export class AsyncConnectorExecutionReads {
  readonly codex;
  readonly openclaw;
  constructor(private readonly owner: AsyncConnectorOwner) {
    this.codex = {
      get: async (sessionKey: string) => (await owner.command('codexExecutionRead', { sessionKey })) ?? undefined,
      sessionPage: (after: string, limit: number) => owner.command('executionSessionPage', { runtime: 'codex', after, limit }),
      recoveryPage: (after: string, limit: number, connectionId?: string) => owner.command('turnRecoveryPage', { runtime: 'codex', after, limit, connectionId: connectionId ?? null, mirror: false }),
      hasPending: (sessionKey: string) => owner.command('turnQueuePending', { runtime: 'codex', sessionKey }),
    };
    this.openclaw = {
      get: async (sessionKey: string) => (await owner.command('openClawExecutionRead', { sessionKey })) ?? undefined,
      sessionPage: (after: string, limit: number) => owner.command('executionSessionPage', { runtime: 'openclaw', after, limit }),
      recoveryPage: (after: string, limit: number, connectionId?: string, mirror = false) => owner.command('turnRecoveryPage', { runtime: 'openclaw', after, limit, connectionId: connectionId ?? null, mirror }),
      hasPending: (sessionKey: string) => owner.command('turnQueuePending', { runtime: 'openclaw', sessionKey }),
    };
  }
  invalidateConnectionPage(after: string, limit: number, previousConnectionId: string | undefined, nextConnectionId: string | undefined) {
    return this.owner.command('codexConnectionRecoveryPage', { after, limit, previousConnectionId: previousConnectionId ?? null, nextConnectionId: nextConnectionId ?? null });
  }
}
