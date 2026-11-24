import type { ChangeSignal } from '../utils/change-signal.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { workerConnectorFileAuthority, type ConnectorFileAuthority } from './file-authority.js';

/** Wake hints only. Consumers always re-read current authority in the owner. */
export type ConnectorMachineAuthority = ConnectorFileAuthority & {
  changes: Pick<ChangeSignal, 'revision' | 'wait'>;
};
export function workerConnectorMachineAuthority(owner: Pick<AsyncConnectorOwner, 'command' | 'authorityChanges'>): ConnectorMachineAuthority {
  return { ...workerConnectorFileAuthority(owner), changes: owner.authorityChanges };
}

/** Settle every original effect/cleanup even when a sibling rejects. */
export async function settleMachineWork(work: readonly PromiseLike<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(work);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

/** Invalidate every sibling immediately, including after a synchronous throw. */
export function closeMachineServices(closers: readonly (() => unknown)[]): Promise<void> {
  return settleMachineWork(closers.map(close => {
    try { return Promise.resolve(close()); } catch (error) { return Promise.reject(error); }
  }));
}

/** Keep cleanup owned without extending the caller's cancellation deadline.
 * Close this only after HTTP admission is shut and original handlers drained. */
export function createMachineEffectDrain() {
  const pending = new Set<Promise<unknown>>();
  return {
    retain(work: Promise<unknown>) {
      pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
    },
    async close() { while (pending.size) await Promise.allSettled([...pending]); },
  };
}
