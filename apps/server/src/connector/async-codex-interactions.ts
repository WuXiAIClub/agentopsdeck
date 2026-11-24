import { randomUUID } from 'node:crypto';
import type { InteractionScope } from '@agentopsdeck/shared';
import { InteractionConflict, type InteractionClosure } from '../commands/agent-interaction.js';
import { continuationFingerprint } from '../commands/interaction-continuation.js';
import { interactionView, type InteractionView, type NativeInteractionHandle } from '../commands/interaction-runtime.js';
import type { NativeInteractionRuntime } from '../commands/interaction-port.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { validConnectorCodexInteractionOutput, type CodexInteractionBinding, type ConnectorCodexInteractionCommands } from './connector-codex-interaction-domain.js';
import type { SdkInteractionResult } from './connector-sdk-interaction-domain.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { requiredSynchronousEffectAuthority } from '../auth/synchronous-effect-authority.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';

type Input = ConnectorCodexInteractionCommands['codexInteractionBind']['input'];
type Answer = Omit<ConnectorCodexInteractionCommands['codexInteractionAnswer']['input'], 'binding'>;
type Binding = { original: CodexInteractionBinding; closing: boolean; pending: Set<Promise<unknown>>; failed: boolean; stop?: () => void };
type Entry = { binding: Binding; handle: NativeInteractionHandle; fingerprint: string; scope: InteractionScope; timer: ReturnType<typeof setTimeout> };
const same = (a: Omit<InteractionScope, 'runId'>, b: Omit<InteractionScope, 'runId'>) => a.ownerId === b.ownerId && a.nodeId === b.nodeId && a.sessionKey === b.sessionKey;

/** Owns original native handles, never SQL or cached permission. Goal evidence
 * comes from those handles; HTTP answers cannot supply or restore a handle. */
export class AsyncCodexInteractions {
  private readonly bindings = new Map<string, Binding>();
  private readonly live = new Map<string, Entry>();
  private readonly preparing = new Set<Promise<unknown>>();
  private readonly preparingKeys = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private frozen = false;
  private closing?: Promise<void>;
  constructor(private readonly options: {
    owner: Pick<AsyncConnectorOwner, 'command'>;
    runtime: { readonly stopConnectionId: string | null | undefined; readonly interactionReady: boolean;
      installOwnedInteractions(binding: CodexInteractionBinding, runtime: NativeInteractionRuntime, permitted: () => Promise<boolean>): () => void };
    changed?(key: string): void;
    diagnostics?: PerformanceDiagnostics;
    acknowledgementMs?: number;
  }) {
    const ms = options.acknowledgementMs ?? 10_000;
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 30_000) throw new InteractionConflict('invalid');
  }
  private log(step: number) { const t = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'codex-dispatch'); t.add('step', step); t.finish(true); }
  private publish(key: string) { if (!this.frozen) try { this.options.changed?.(key); } catch { this.log(41); } }
  private track<T>(b: Binding, physical: Promise<T>, cleanup = false): Promise<T> {
    const drain = Promise.prototype.then.call(physical, () => { b.pending.delete(drain); }, () => {
      b.pending.delete(drain); if (cleanup) b.failed = true; this.log(42);
    }) as Promise<void>;
    b.pending.add(drain);
    return physical;
  }
  private retain<T>(run: () => Promise<T>): Promise<T> {
    if (this.frozen || this.pending.size >= 128) return Promise.reject(new ConnectorOwnerUnavailable());
    const physical = Promise.resolve().then(run);
    const done = () => { this.pending.delete(drain); };
    const drain = Promise.prototype.then.call(physical, done, done) as Promise<void>;
    this.pending.add(drain);
    return physical;
  }
  private command<K extends keyof ConnectorCodexInteractionCommands>(kind: K, input: ConnectorCodexInteractionCommands[K]['input']): Promise<ConnectorCodexInteractionCommands[K]['output']> {
    return this.options.owner.command(kind, structuredClone(input)).then(result => {
      if (!validConnectorCodexInteractionOutput(kind, result)) throw new ConnectorOwnerUnavailable();
      return result;
    });
  }
  prepare(input: Input): Promise<boolean> {
    if (this.frozen || this.preparingKeys.has(input.sessionKey) || this.preparing.size >= 128) return Promise.reject(new ConnectorOwnerUnavailable());
    const request = structuredClone(input), key = request.sessionKey;
    this.preparingKeys.add(key);
    const physical = Promise.resolve().then(async () => {
      const local = () => { if (this.frozen || this.options.runtime.stopConnectionId !== request.connectionId) throw new ConnectorOwnerUnavailable(); };
      local();
      const previous = this.bindings.get(key); if (previous) await this.release(previous);
      local();
      const reply = await this.command('codexInteractionBind', request);
      if (!reply.ok) throw new ConnectorOwnerUnavailable();
      if (reply.value.mode === 'automatic') { local(); return false; }
      const original = structuredClone(reply.value.binding);
      if (original.ref.sessionKey !== key || original.ref.commandId !== request.commandId || original.ref.connectionId !== request.connectionId) throw new ConnectorOwnerUnavailable();
      const b: Binding = { original, closing: false, pending: new Set(), failed: false };
      this.bindings.set(key, b);
      try {
        local(); if (!this.options.runtime.interactionReady) throw new ConnectorOwnerUnavailable();
        const stop = this.options.runtime.installOwnedInteractions(structuredClone(original), this.port(b), () => this.permitted(original.ref));
        if (typeof stop !== 'function') throw new ConnectorOwnerUnavailable();
        b.stop = stop; local(); return true;
      } catch (error) { await this.release(b); throw error; }
    });
    const drain = physical.then(() => { this.preparing.delete(drain); this.preparingKeys.delete(key); }, () => { this.preparing.delete(drain); this.preparingKeys.delete(key); });
    this.preparing.add(drain); return physical;
  }
  private drop(id: string, e: Entry, reason?: InteractionClosure) {
    if (this.live.get(id) !== e) return;
    this.live.delete(id); clearTimeout(e.timer);
    if (reason) try { e.handle.cancel(reason); } catch { this.log(43); }
  }
  private closeRun(b: Binding, runId: string, reason: InteractionClosure, requestId?: string, quiet = false) {
    for (const [id, e] of this.live) if (e.binding === b && e.scope.runId === runId && (!requestId || id === requestId)) this.drop(id, e, reason);
    return this.track(b, this.command('codexInteractionClose', { ...b.original.ref, runId, reason, ...(requestId ? { requestId } : {}) }).then(r => {
      if (!r.ok) throw new ConnectorOwnerUnavailable(); if (!quiet) this.publish(b.original.scope.sessionKey);
    }), true);
  }
  private port(b: Binding): NativeInteractionRuntime {
    return {
      open: (question, _capabilities, handle, ttlMs = 600_000) => {
        const scope = structuredClone(handle.scope), body = structuredClone(question);
        // Pin original callbacks before any asynchronous policy/IPC work.
        const original: NativeInteractionHandle = { scope, active: handle.active.bind(handle), continuation: handle.continuation.bind(handle),
          permitted: handle.permitted.bind(handle), deliver: handle.deliver.bind(handle), cancel: handle.cancel.bind(handle) };
        return this.track(b, Promise.resolve().then(async () => {
          const alive = () => !this.frozen && !b.closing && same(scope, b.original.scope) && original.active() === true;
          if (!alive()) throw new InteractionConflict('closed');
          const continuation = await original.continuation(), fingerprint = continuationFingerprint(continuation);
          if (continuation.connectionId !== b.original.ref.connectionId || await original.permitted() !== true || !alive()
            || continuationFingerprint(await original.continuation()) !== fingerprint || !alive()) throw new InteractionConflict('permission');
          const requestId = randomUUID();
          const reply = await this.command('codexInteractionOpen', { ...b.original.ref, runId: scope.runId, continuation, requestId, question: body, ttlMs });
          if (!reply.ok) throw new InteractionConflict(reply.error === 403 ? 'permission' : 'closed');
          if (!alive()) { await this.closeRun(b, scope.runId, 'disconnected', requestId); throw new InteractionConflict('closed'); }
          const timer = setTimeout(() => { void this.closeRun(b, scope.runId, 'expired', requestId); }, Math.max(1, reply.value.state.request.expiresAt - Date.now()));
          timer.unref(); this.live.set(requestId, { binding: b, handle: original, fingerprint, scope, timer });
          this.publish(scope.sessionKey); return interactionView(reply.value);
        }));
      },
      closeRequest: (scope, requestId, reason) => { if (same(scope, b.original.scope)) void this.closeRun(b, scope.runId, reason, requestId); },
      nativeRunEnded: scope => {
        if (!same(scope, b.original.scope)) return;
        // Completing a turn retires its questions, not the continuing Goal's binding.
        for (const [id, e] of this.live) if (e.binding === b && e.scope.runId === scope.runId) this.drop(id, e, 'stopped');
        this.track(b, this.command('codexInteractionRetire', { ...b.original.ref, runId: scope.runId, nativeEnded: true }).then(r => {
          if (!r.ok) throw new ConnectorOwnerUnavailable(); this.publish(scope.sessionKey);
        }), true);
      },
    };
  }
  permitted(ref: CodexInteractionBinding['ref']): Promise<boolean> {
    if (this.frozen) return Promise.resolve(false);
    const request = structuredClone(ref);
    return this.retain(() => this.command('codexInteractionCheck', request).then(r => r.ok && r.value === true));
  }
  observe(input: ConnectorCodexInteractionCommands['codexInteractionObserve']['input']) {
    const request = structuredClone(input);
    return this.frozen ? Promise.resolve<SdkInteractionResult<{ mode: import('@agentopsdeck/shared').InteractionMode; requests: InteractionView[] }>>({ ok: false, error: 503 })
      : this.retain(() => this.command('codexInteractionObserve', request));
  }
  mode(input: ConnectorCodexInteractionCommands['codexInteractionMode']['input'], scope?: ApplicationCommandScope) {
    if (this.frozen) return Promise.resolve({ ok: false as const, error: 503 as const });
    const request = structuredClone(input);
    return this.retain(async () => {
      if (scope) { await scope.authorize('prepare'); scope.local(); }
      const result = await this.command('codexInteractionMode', request);
      if (scope) { await scope.authorize('prepare'); scope.local(); }
      if (result.ok) this.publish(request.key); return result;
    });
  }
  answer(input: Answer, scope?: ApplicationCommandScope): Promise<SdkInteractionResult<InteractionView>> {
    if (this.frozen) return Promise.resolve({ ok: false, error: 503 });
    const request = structuredClone(input), e = this.live.get(request.requestId);
    return this.retain(() => {
      const physical = (async (): Promise<SdkInteractionResult<InteractionView>> => {
      if (scope) { await scope.authorize('prepare'); scope.local(); }
      const duplicate = await this.command('codexInteractionAnswer', request);
      if (duplicate.ok) return { ok: true, value: interactionView(duplicate.value) };
      if (duplicate.error !== 409 || !e) return duplicate;
      return this.deliver(request, e, scope);
      })();
      return e ? this.track(e.binding, physical) : physical;
    });
  }
  private async deliver(request: Answer, e: Entry, scope?: ApplicationCommandScope): Promise<SdkInteractionResult<InteractionView>> {
    const b = e.binding, bound = { ...b.original.ref, runId: e.scope.runId };
    const usable = () => !this.frozen && !b.closing && this.live.get(request.requestId) === e && e.handle.active() === true;
    const evidence = async () => { const v = await e.handle.continuation();
      if (continuationFingerprint(v) !== e.fingerprint || !usable()) throw new InteractionConflict('closed'); return v; };
    let accepted = false;
    try {
      let continuation = await evidence();
      if (await e.handle.permitted() !== true || !usable()) return { ok: false, error: 403 };
      continuation = await evidence();
      const result = await this.command('codexInteractionAnswer', { ...request, binding: { ...bound, continuation } });
      if (!result.ok) return result;
      accepted = true; if (!scope) this.publish(request.key);
      if (result.value.state.status !== 'answered' || result.value.delivery !== 'queued') return { ok: true, value: interactionView(result.value) };
      if (await e.handle.permitted(result.value.state.answer) !== true || !usable()) { await this.closeRun(b, bound.runId, 'revoked', undefined, !!scope); return { ok: false, error: 403 }; }
      continuation = await evidence();
      const claim = await this.command('codexInteractionClaim', { ...bound, continuation, authorization: request.authorization,
        requestId: request.requestId, expectedRevision: result.value.revision });
      if (!claim.ok) { await this.closeRun(b, bound.runId, 'revoked', undefined, !!scope); return claim; }
      if (!claim.value?.claimId || claim.value.state.status !== 'answered') return { ok: true, value: interactionView(result.value) };
      const claimId = claim.value.claimId, answer = claim.value.state.answer;
      continuation = await evidence();
      const check = await this.command('codexInteractionDeliverable', { ...bound, continuation, authorization: request.authorization, requestId: request.requestId, claimId });
      let outcome: 'confirmed' | 'unknown' = 'unknown', timer: ReturnType<typeof setTimeout> | undefined;
      if (check.ok && check.value === true && usable() && await e.handle.permitted(answer) === true) {
        await evidence();
        if (scope) { await scope.authorize('effect'); scope.local(); }
        if (!usable()) throw new InteractionConflict('closed');
        const physical = this.track(b, (async () => e.handle.deliver(answer))().catch(() => 'unknown' as const));
        try { outcome = await Promise.race([physical, new Promise<'unknown'>(resolve => { timer = setTimeout(() => resolve('unknown'), this.options.acknowledgementMs ?? 10_000); })]); }
        finally { clearTimeout(timer); }
      }
      const settled = await this.command('codexInteractionSettle', { ...bound, requestId: request.requestId, claimId, outcome: outcome === 'confirmed' ? 'confirmed' : 'unknown' });
      if (!settled.ok) return settled;
      this.drop(request.requestId, e, settled.value.delivery === 'unknown' ? 'disconnected' : undefined);
      if (scope) { await scope.authorize('prepare'); scope.local(); }
      this.publish(request.key); return { ok: true, value: interactionView(settled.value) };
    } catch { if (accepted) await this.closeRun(b, bound.runId, 'disconnected', undefined, !!scope); this.log(44); return { ok: false, error: 503 }; }
  }
  private async release(b: Binding) {
    b.closing = true;
    if (b.stop) requiredSynchronousEffectAuthority(b.stop);
    const runs = new Set([...this.live.values()].filter(e => e.binding === b).map(e => e.scope.runId));
    await Promise.allSettled([...runs].map(run => this.closeRun(b, run, 'disconnected')));
    while (b.pending.size) await Promise.allSettled([...b.pending]);
    if (b.failed) throw new ConnectorOwnerUnavailable();
    const r = await this.command('codexInteractionRelease', b.original.ref); if (!r.ok) throw new ConnectorOwnerUnavailable();
    if (this.bindings.get(b.original.scope.sessionKey) === b) this.bindings.delete(b.original.scope.sessionKey);
  }
  freeze(): void { this.frozen = true; }
  close(): Promise<void> {
    this.freeze();
    return this.closing ??= (async () => {
      await Promise.allSettled([...this.preparing, ...this.pending]);
      const results = await Promise.allSettled([...this.bindings.values()].map(b => this.release(b)));
      if (results.some(r => r.status === 'rejected')) throw new ConnectorOwnerUnavailable();
    })();
  }
}
