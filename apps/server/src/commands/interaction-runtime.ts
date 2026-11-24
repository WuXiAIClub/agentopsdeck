import { randomUUID } from 'node:crypto';
import type { InteractionAnswer, InteractionCapabilities, InteractionRequest, InteractionScope } from '@agentopsdeck/shared';
import { InteractionConflict, type InteractionClosure } from './agent-interaction.js';
import { continuationFingerprint, InteractionDeliveryConflict, type InteractionContinuation } from './interaction-continuation.js';
import { InteractionStore, type StoredInteraction } from './interaction-store.js';

export type InteractionQuestion = Pick<InteractionRequest, 'kind' | 'prompt' | 'options' | 'allowFreeform'>;
/** Trusted runtime-only handle. Never reconstructed from HTTP or durable data.
 * `deliver` confirms receipt by the original native adapter, NOT tool success. */
export type NativeInteractionHandle = {
  scope: InteractionScope;
  active(): boolean;
  continuation(): Promise<InteractionContinuation>;
  permitted(answer?: InteractionAnswer): Promise<boolean>;
  deliver(answer: InteractionAnswer): Promise<'confirmed' | 'unknown'>;
  cancel(reason: InteractionClosure): void;
};
export function interactionView(fact: StoredInteraction) {
  const { state } = fact;
  return { request: structuredClone(state.request), revision: fact.revision, status: state.status,
    delivery: fact.delivery, ...(state.status === 'closed' ? { reason: state.reason } : {}) };
}
export type InteractionView = ReturnType<typeof interactionView>;
type Entry = { handle: NativeInteractionHandle; timer: ReturnType<typeof setTimeout> };
const keyOf = (scope: InteractionScope, id: string) => JSON.stringify([scope.ownerId, scope.nodeId, scope.sessionKey, scope.runId, id]);

/** One runtime owns live continuations. No answer redelivery on HTTP retries,
 * no background native polling, no synthetic chat message or goal resume. */
export class InteractionRuntime {
  private readonly live = new Map<string, Entry>();
  private closed = false;
  constructor(readonly store: InteractionStore, private readonly available: () => boolean,
    private readonly changed: (sessionKey: string) => void = () => {}, private readonly now = Date.now,
    private readonly acknowledgementMs = 10_000) {
    if (!Number.isSafeInteger(acknowledgementMs) || acknowledgementMs < 1 || acknowledgementMs > 30_000) throw new InteractionConflict('invalid');
  }

  async open(question: InteractionQuestion, capabilities: InteractionCapabilities, handle: NativeInteractionHandle,
    ttlMs = 10 * 60_000): Promise<InteractionView> {
    if (this.closed || !this.available() || !handle.active()) throw new InteractionConflict('closed');
    const continuation = await handle.continuation();
    const permission = await handle.permitted();
    if (this.closed || !this.available() || !handle.active() || !permission) throw new InteractionConflict('permission');
    // Re-read evidence after asynchronous policy work; no gap may create a
    // request against a goal version which has already changed.
    if (continuationFingerprint(await handle.continuation()) !== continuationFingerprint(continuation)
      || this.closed || !this.available() || !handle.active()) throw new InteractionDeliveryConflict('continuation');
    const now = this.now();
    const request: InteractionRequest = { ...question, ...handle.scope, version: 1, requestId: randomUUID(), createdAt: now, expiresAt: now + ttlMs };
    const fact = this.store.create(request, capabilities, handle.scope, continuation, now);
    const key = keyOf(handle.scope, request.requestId);
    const timer = setTimeout(() => { this.closeRun(handle.scope, 'expired'); }, ttlMs);
    timer.unref();
    this.live.set(key, { handle, timer });
    this.publish(handle.scope.sessionKey);
    return interactionView(fact);
  }

  list(scope: Omit<InteractionScope, 'runId'>): InteractionView[] { return this.store.list(scope).map(interactionView); }

  async answer(input: { scope: InteractionScope; requestId: string; responseId: string;
    expectedRevision: number; answer: unknown; authorize(): boolean }): Promise<InteractionView> {
    const prior = this.store.get(input.scope, input.requestId);
    if (!prior) throw new InteractionDeliveryConflict('missing');
    if (!input.authorize()) throw new InteractionConflict('permission');
    // Same response receipt remains readable after disconnect/stop, but is
    // never interpreted as permission to invoke the old continuation again.
    if (prior.state.status === 'answered') {
      const fact = this.store.answer({ ...input, continuation: { connectionId: '', goal: { status: 'unknown', version: '' } },
        permissionAllowed: true, now: this.now() });
      return interactionView(fact);
    }
    const key = keyOf(input.scope, input.requestId), entry = this.live.get(key);
    const usable = () => !this.closed && this.available() && input.authorize() && this.live.get(key) === entry && !!entry?.handle.active();
    if (!entry || !usable()) throw new InteractionConflict('closed');
    const continuation = await entry.handle.continuation();
    if (!await entry.handle.permitted() || !usable()) throw new InteractionConflict('permission');
    const current = await entry.handle.continuation();
    if (!usable() || continuationFingerprint(current) !== continuationFingerprint(continuation)) throw new InteractionDeliveryConflict('continuation');
    const fact = this.store.answer({ ...input, continuation: current, permissionAllowed: true, now: this.now() });
    this.publish(input.scope.sessionKey);
    if (fact.state.status !== 'answered' || fact.delivery !== 'queued') {
      this.release(key, entry, 'expired');
      return interactionView(fact);
    }
    // Answers (especially tool approvals) are checked AGAIN immediately before
    // claim. Stopping while a filesystem/goal check awaits cancels the send.
    let permitted: boolean, deliveryEvidence: InteractionContinuation;
    try {
      permitted = await entry.handle.permitted(fact.state.answer);
      deliveryEvidence = await entry.handle.continuation();
      if (continuationFingerprint(deliveryEvidence) !== continuationFingerprint(current)) throw new InteractionDeliveryConflict('continuation');
    } catch (error) {
      this.closeRun(input.scope, 'disconnected');
      throw error;
    }
    if (!permitted || !usable()) {
      this.closeRun(input.scope, 'revoked');
      throw new InteractionConflict('permission');
    }
    const claimed = this.store.claim({ scope: input.scope, requestId: input.requestId, expectedRevision: fact.revision,
      continuation: deliveryEvidence, permissionAllowed: true, now: this.now() });
    if (!claimed || claimed.state.status !== 'answered' || !claimed.claimId) return interactionView(this.store.get(input.scope, input.requestId)!);
    this.publish(input.scope.sessionKey);
    let outcome: 'confirmed' | 'unknown' = 'unknown';
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      outcome = await Promise.race([entry.handle.deliver(claimed.state.answer),
        new Promise<'unknown'>(resolve => { deadline = setTimeout(() => resolve('unknown'), this.acknowledgementMs); })]);
    } catch { /* delivery must never be repeated */ }
    finally { clearTimeout(deadline); }
    const latest = this.store.get(input.scope, input.requestId)!;
    // A concurrent stop/disconnect changed claimed -> unknown. A late ACK
    // cannot resurrect it, even if the adapter's promise resolves successfully.
    const settled = latest.delivery === 'claimed'
      ? this.store.settle(input.scope, input.requestId, claimed.claimId, outcome, this.now()) : latest;
    this.release(key, entry, settled.delivery === 'unknown' ? 'disconnected' : undefined);
    this.publish(input.scope.sessionKey);
    return interactionView(settled);
  }

  closeRun(scope: InteractionScope, reason: InteractionClosure) {
    this.store.closeRun(scope, reason, this.now());
    for (const [key, entry] of this.live) {
      if (keyOf(entry.handle.scope, '') !== keyOf(scope, '')) continue;
      if (reason === 'expired') {
        // Requests in the same run can have independent expiration deadlines.
        const id = JSON.parse(key)[4] as string;
        if ((this.store.get(scope, id)?.state.request.expiresAt ?? Infinity) > this.now()) continue;
      }
      this.release(key, entry, reason);
    }
    this.publish(scope.sessionKey);
  }

  closeRequest(scope: InteractionScope, requestId: string, reason: InteractionClosure) {
    this.store.closeRequest(scope, requestId, reason, this.now());
    const key = keyOf(scope, requestId), entry = this.live.get(key);
    if (entry) this.release(key, entry, reason);
    this.publish(scope.sessionKey);
  }

  nativeRunEnded(scope: InteractionScope) {
    this.closeRun(scope, 'stopped');
    this.store.retireRun(scope, this.now());
    this.publish(scope.sessionKey);
  }

  close(reason: 'disconnected' | 'stopped' = 'disconnected') {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.live.values()]) this.closeRun(entry.handle.scope, reason);
  }
  private release(key: string, entry: Entry, reason?: InteractionClosure) {
    if (this.live.get(key) !== entry) return;
    clearTimeout(entry.timer); this.live.delete(key);
    if (reason) { try { entry.handle.cancel(reason); } catch { /* durable closure already committed */ } }
  }
  private publish(sessionKey: string) {
    // Projection failure never rolls back durable acceptance or re-sends.
    try { this.changed(sessionKey); } catch { /* next authenticated snapshot repairs projection */ }
  }
}
