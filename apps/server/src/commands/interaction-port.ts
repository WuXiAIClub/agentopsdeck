import type { InteractionCapabilities, InteractionScope } from '@agentopsdeck/shared';
import type { InteractionClosure } from './agent-interaction.js';
import type { InteractionRuntime, NativeInteractionHandle } from './interaction-runtime.js';
import { readInteractionFrame, type InteractionParentFrame } from './interaction-wire.js';

/** Constructed only by the owning runtime, never from worker/HTTP claims. */
export type NativeInteractionRuntime = Pick<InteractionRuntime, 'open' | 'closeRequest' | 'nativeRunEnded'>;
export type WorkerInteractionContext = {
  runtime: NativeInteractionRuntime;
  scope: InteractionScope;
  capabilities: InteractionCapabilities;
  continuation: NativeInteractionHandle['continuation'];
  permitted: NativeInteractionHandle['permitted'];
};
type Pending = { publicId?: string; acknowledged?: boolean; resolve?: (outcome: 'confirmed' | 'unknown') => void };

/** One private worker epoch. Sending IPC is not acknowledgement. A receipt
 * requires the exact original worker's ACK; exit/stop never replays answers. */
export class WorkerInteractionPort {
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Set<string>();
  private closed = false;
  /** Call only from the original child process exit event, never IPC close. */
  exited() {
    this.close();
    this.context.runtime.nativeRunEnded(this.context.scope);
  }
  constructor(private readonly identity: { executionId: string; epoch: string },
    private readonly context: WorkerInteractionContext,
    private readonly send: (frame: InteractionParentFrame) => void,
    private readonly active: () => boolean) {}

  receive(value: unknown): boolean {
    const frame = readInteractionFrame(value, 'worker');
    if (!frame || frame.executionId !== this.identity.executionId || frame.epoch !== this.identity.epoch) return false;
    if (this.closed || !this.active()) return true;
    if (frame.kind === 'interaction-request') {
      if (this.seen.has(frame.requestId)) return true;
      // Bound both concurrent work and lifetime replay IDs without eviction.
      if (this.pending.size >= 32 || this.seen.size >= 2048) return false;
      this.seen.add(frame.requestId);
      const entry: Pending = {};
      this.pending.set(frame.requestId, entry);
      const alive = () => !this.closed && this.active() && this.pending.get(frame.requestId) === entry;
      void this.context.runtime.open(frame.question, this.context.capabilities, {
        scope: this.context.scope, active: alive,
        continuation: this.context.continuation, permitted: this.context.permitted,
        deliver: answer => new Promise(resolve => {
          if (!alive() || entry.resolve) { resolve('unknown'); return; }
          entry.resolve = resolve;
          try { this.send({ ...this.identity, requestId: frame.requestId, kind: 'interaction-answer', answer }); }
          catch { this.cancel(frame.requestId, entry, 'disconnected'); }
        }),
        cancel: () => {
          this.pending.delete(frame.requestId); entry.resolve?.('unknown');
          try { this.send({ ...this.identity, requestId: frame.requestId, kind: 'interaction-cancel' }); } catch { /* closed IPC */ }
        },
      }).then(view => {
        entry.publicId = view.request.requestId;
        if (!alive() && !entry.acknowledged) this.context.runtime.closeRequest(this.context.scope, entry.publicId, 'disconnected');
      }, () => {
        this.pending.delete(frame.requestId);
        try { this.send({ ...this.identity, requestId: frame.requestId, kind: 'interaction-cancel' }); } catch { /* closed IPC */ }
      });
      return true;
    }
    const entry = this.pending.get(frame.requestId);
    if (!entry) return true; // late ACK cannot resurrect an expired request
    if (frame.kind === 'interaction-cancelled') this.cancel(frame.requestId, entry, 'stopped');
    else if (entry.resolve) {
      entry.acknowledged = true;
      this.pending.delete(frame.requestId);
      entry.resolve('confirmed');
    } else return false; // unsolicited ACK
    return true;
  }

  close(reason: InteractionClosure = 'disconnected') {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) this.cancel(id, entry, reason);
  }
  private cancel(id: string, entry: Pending, reason: InteractionClosure) {
    this.pending.delete(id);
    entry.resolve?.('unknown');
    if (entry.publicId) this.context.runtime.closeRequest(this.context.scope, entry.publicId, reason);
  }
}
