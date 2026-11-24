import { randomUUID } from 'node:crypto';
import type { InteractionScope } from '@agentopsdeck/shared';
import type { InteractionClosure } from '../commands/agent-interaction.js';
import { InteractionConflict } from '../commands/agent-interaction.js';
import { continuationFingerprint } from '../commands/interaction-continuation.js';
import { interactionView, type NativeInteractionHandle, type InteractionView } from '../commands/interaction-runtime.js';
import type { NativeInteractionRuntime } from '../commands/interaction-port.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { ConnectorSdkInteractionCommands, SdkInteractionResult } from './connector-sdk-interaction-domain.js';
import type { SdkInteractionBinding } from './connector-sdk-dispatch-domain.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';

type Bound = ConnectorSdkInteractionCommands['sdkInteractionRetire']['input'];
type Entry = { bindingId: string; handle: NativeInteractionHandle; timer: ReturnType<typeof setTimeout> };
type Binding = { request: Omit<Bound, 'nativeEnded'>; original: SdkInteractionBinding; closing: boolean; pending: Set<Promise<unknown>>; failed: boolean };
type Answer = ConnectorSdkInteractionCommands['sdkInteractionAnswer']['input'];
const same = (a: InteractionScope, b: InteractionScope) => a.ownerId === b.ownerId && a.nodeId === b.nodeId
  && a.sessionKey === b.sessionKey && a.runId === b.runId;

/** No SQL/store/credentials are cached locally. Only original native handles
 * live here. Worker receipts never reconstruct or replay a continuation. */
export class AsyncSdkInteractionRuntime {
  private readonly bindings = new Map<string, Binding>();
  private readonly live = new Map<string, Entry>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>,
    private readonly changed: (key: string) => void = () => {},
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    private readonly acknowledgementMs = 10_000) {
    if (!Number.isSafeInteger(acknowledgementMs) || acknowledgementMs < 1 || acknowledgementMs > 30_000) throw new InteractionConflict('invalid');
  }
  private track<T>(binding: Binding, work: Promise<T>, cleanup = false): Promise<T> {
    binding.pending.add(work);
    void work.then(() => binding.pending.delete(work), () => { binding.pending.delete(work); if (cleanup) binding.failed = true; this.log(32); });
    return work;
  }
  private retain<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed || this.pending.size >= 128) return Promise.reject(new InteractionConflict('closed'));
    const physical = Promise.resolve().then(run);
    const done = () => { this.pending.delete(drain); };
    const drain = Promise.prototype.then.call(physical, done, done) as Promise<void>;
    this.pending.add(drain);
    return physical;
  }
  private log(step: number) { const trace = guardedTrace(this.diagnostics, 'sdk-owned-lifecycle'); trace.add('step', step); trace.finish(true); }
  private publish(key: string) { if (!this.closed) try { this.changed(key); } catch { this.log(33); } }
  private continuation(binding: Binding) {
    return continuationFingerprint({ connectionId: binding.request.ref.epoch,
      goal: { status: 'absent', version: `${binding.request.runtime}:no-native-goal:v1` } });
  }
  private release(id: string, entry: Entry, reason?: InteractionClosure) {
    if (this.live.get(id) !== entry) return;
    this.live.delete(id); clearTimeout(entry.timer);
    if (reason) { try { entry.handle.cancel(reason); } catch { this.log(34); } }
  }
  private closeBinding(binding: Binding, reason: InteractionClosure, requestId?: string, quiet = false) {
    for (const [id, entry] of this.live) if (entry.bindingId === binding.request.bindingId && (!requestId || id === requestId)) this.release(id, entry, reason);
    return this.track(binding, this.owner.command('sdkInteractionClose', { ...binding.request, reason, ...(requestId ? { requestId } : {}) }).then(result => {
      if (!result.ok) throw Error('Original interaction closure unavailable');
      if (!quiet) this.publish(binding.original.scope.sessionKey);
    }), true);
  }
  forSdkBinding(runtime: SdkAgentId, original: SdkInteractionBinding): NativeInteractionRuntime {
    if (this.closed) throw new InteractionConflict('closed');
    let binding = this.bindings.get(original.bindingId);
    if (!binding) {
      if (this.bindings.size >= 128) throw new InteractionConflict('closed');
      binding = { request: { runtime, bindingId: original.bindingId, ref: { ...original.ref } },
        original: structuredClone(original), closing: false, pending: new Set(), failed: false };
      this.bindings.set(original.bindingId, binding);
    }
    const b = binding;
    return {
      open: (question, _capabilities, handle, ttlMs = 600_000) => this.track(b, Promise.resolve().then(async () => {
        const alive = () => !this.closed && !b.closing && handle.active() === true;
        if (!same(handle.scope, b.original.scope) || !alive()) throw new InteractionConflict('closed');
        const evidence = await handle.continuation();
        if (continuationFingerprint(evidence) !== this.continuation(b)) throw new InteractionConflict('closed');
        if (await handle.permitted() !== true || !alive()) throw new InteractionConflict('permission');
        if (continuationFingerprint(await handle.continuation()) !== continuationFingerprint(evidence) || !alive()) throw new InteractionConflict('closed');
        const requestId = randomUUID();
        const result = await this.owner.command('sdkInteractionOpen', { ...b.request, requestId, question, ttlMs });
        if (!result.ok) throw new InteractionConflict(result.error === 403 ? 'permission' : 'closed');
        if (!alive()) { await this.closeBinding(b, 'disconnected', requestId); throw new InteractionConflict('closed'); }
        const timer = setTimeout(() => { void this.closeBinding(b, 'expired', requestId); }, Math.max(1, result.value.state.request.expiresAt - Date.now()));
        timer.unref(); this.live.set(requestId, { bindingId: original.bindingId, handle, timer });
        this.publish(original.scope.sessionKey); return interactionView(result.value);
      })),
      closeRequest: (scope, requestId, reason) => { if (same(scope, b.original.scope)) void this.closeBinding(b, reason, requestId); },
      nativeRunEnded: scope => {
        if (!same(scope, b.original.scope)) return;
        b.closing = true;
        for (const [id, entry] of this.live) if (entry.bindingId === b.request.bindingId) this.release(id, entry, 'stopped');
        this.track(b, this.owner.command('sdkInteractionRetire', { ...b.request, nativeEnded: true }).then(result => {
          if (!result.ok) throw Error('Original interaction retirement unavailable'); this.publish(scope.sessionKey);
        }), true);
      },
    };
  }
  observe(input: ConnectorSdkInteractionCommands['sdkInteractionObserve']['input']): Promise<ConnectorSdkInteractionCommands['sdkInteractionObserve']['output']> {
    const request = structuredClone(input);
    return this.closed ? Promise.resolve({ ok: false, error: 503 }) : this.retain(() => this.owner.command('sdkInteractionObserve', request));
  }
  mode(input: ConnectorSdkInteractionCommands['sdkInteractionMode']['input'], scope?: ApplicationCommandScope) {
    if (this.closed) return Promise.resolve<SdkInteractionResult<import('@agentopsdeck/shared').InteractionMode>>({ ok: false, error: 503 });
    const request = structuredClone(input);
    return this.retain(async () => {
      if (scope) { await scope.authorize('prepare'); scope.local(); }
      const result = await this.owner.command('sdkInteractionMode', request);
      if (scope) { await scope.authorize('prepare'); scope.local(); }
      if (result.ok) this.publish(request.key); return result;
    });
  }
  answer(input: Omit<Answer, 'binding'>, scope?: ApplicationCommandScope): Promise<SdkInteractionResult<InteractionView>> {
    if (this.closed) return Promise.resolve({ ok: false, error: 503 });
    const request = structuredClone(input);
    return this.retain(() => this.doAnswer(request, scope));
  }
  private async doAnswer(input: Omit<Answer, 'binding'>, scope?: ApplicationCommandScope): Promise<SdkInteractionResult<InteractionView>> {
    if (scope) { await scope.authorize('prepare'); scope.local(); }
    const request = structuredClone(input), entry = this.live.get(request.requestId), b = entry && this.bindings.get(entry.bindingId);
    // Duplicate receipts are observations, even while an original send is awaiting ACK.
    // Without a binding the worker can only return an already-answered receipt;
    // pending requests return 409 without mutation. No bounded-list lookup.
    const duplicate = await this.owner.command('sdkInteractionAnswer', request);
    if (duplicate.ok) return { ok: true, value: interactionView(duplicate.value) };
    if (duplicate.error !== 409) return duplicate;
    if (!entry || !b || this.closed || b.closing) return { ok: false, error: 409 };
    return this.track(b, this.deliver(request, entry, b, scope));
  }
  private async deliver(request: Omit<Answer, 'binding'>, entry: Entry, b: Binding, scope?: ApplicationCommandScope): Promise<SdkInteractionResult<InteractionView>> {
    const usable = () => !this.closed && !b.closing && this.live.get(request.requestId) === entry && entry.handle.active() === true;
    let accepted = false;
    try {
      const evidence = await entry.handle.continuation();
      if (continuationFingerprint(evidence) !== this.continuation(b)) return { ok: false, error: 409 };
      if (await entry.handle.permitted() !== true || !usable()) return { ok: false, error: 403 };
      if (continuationFingerprint(await entry.handle.continuation()) !== continuationFingerprint(evidence) || !usable()) return { ok: false, error: 409 };
      const result = await this.owner.command('sdkInteractionAnswer', { ...request, binding: b.request });
      if (!result.ok) return result;
      accepted = true; if (!scope) this.publish(request.key);
      if (result.value.state.status !== 'answered' || result.value.delivery !== 'queued') return { ok: true, value: interactionView(result.value) };
      if (await entry.handle.permitted(result.value.state.answer) !== true || !usable()
        || continuationFingerprint(await entry.handle.continuation()) !== continuationFingerprint(evidence) || !usable()) {
        await this.closeBinding(b, 'revoked', undefined, !!scope); return { ok: false, error: 403 };
      }
      const claimed = await this.owner.command('sdkInteractionClaim', { ...b.request, authorization: request.authorization,
        requestId: request.requestId, expectedRevision: result.value.revision });
      if (!claimed.ok) { await this.closeBinding(b, 'revoked', undefined, !!scope); return claimed; }
      if (!claimed.value || !claimed.value.claimId || claimed.value.state.status !== 'answered') return { ok: true, value: interactionView(result.value) };
      const claimId = claimed.value.claimId, answer = claimed.value.state.answer;
      const check = await this.owner.command('sdkInteractionDeliverable', { ...b.request, authorization: request.authorization, requestId: request.requestId, claimId });
      let outcome: 'confirmed' | 'unknown' = 'unknown', timer: ReturnType<typeof setTimeout> | undefined;
      if (check.ok && check.value === true && usable()
        && await entry.handle.permitted(answer) === true
        && continuationFingerprint(await entry.handle.continuation()) === this.continuation(b) && usable()) {
        // Retain the original physical Promise beyond the ACK deadline. Closing
        // may cancel its handle but cannot mistake a timed-out waiter for exit.
        if (scope) { await scope.authorize('effect'); scope.local(); }
        if (!usable()) throw new InteractionConflict('closed');
        const physical = this.track(b, (async () => entry.handle.deliver(answer))().catch(() => 'unknown' as const));
        try { outcome = await Promise.race([physical,
          new Promise<'unknown'>(resolve => { timer = setTimeout(() => resolve('unknown'), this.acknowledgementMs); })]); }
        catch { /* the claim is never replayed */ } finally { clearTimeout(timer); }
      }
      const settled = await this.owner.command('sdkInteractionSettle', { ...b.request, requestId: request.requestId, claimId,
        outcome: outcome === 'confirmed' ? 'confirmed' : 'unknown' });
      if (!settled.ok) return settled;
      this.release(request.requestId, entry, settled.value.delivery === 'unknown' ? 'disconnected' : undefined);
      if (scope) { await scope.authorize('prepare'); scope.local(); }
      this.publish(request.key); return { ok: true, value: interactionView(settled.value) };
    } catch {
      if (accepted) await this.closeBinding(b, 'disconnected', undefined, !!scope);
      this.log(35); return { ok: false, error: 503 };
    }
  }
  async releaseSdkBinding(bindingId: string): Promise<void> {
    const b = this.bindings.get(bindingId);
    if (!b) return;
    b.closing = true;
    await this.closeBinding(b, 'disconnected');
    while (b.pending.size) await Promise.allSettled([...b.pending]);
    if (b.failed) throw Error('Original interaction cleanup unavailable');
    this.bindings.delete(bindingId);
  }
  freeze() {
    if (this.closed) return;
    this.closed = true;
    for (const b of this.bindings.values()) { b.closing = true; void this.closeBinding(b, 'disconnected'); }
  }
  close(): Promise<void> {
    this.freeze();
    return this.closing ??= (async () => {
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled([...this.bindings.keys()].map(id => this.releaseSdkBinding(id)));
      if (results.some(result => result.status === 'rejected')) throw Error('Original interaction cleanup unavailable');
    })();
  }
}
