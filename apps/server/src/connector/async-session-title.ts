import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorTitleOutput, type ConnectorTitleCommands, type ConnectorTitleKind, type TitleResult } from './connector-title-domain.js';
import type { DeckStore } from '../projection/deck-store.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Single original Deck file executor; physical work outlives HTTP waiters. */
export class AsyncSessionTitle {
  private readonly pending = new Set<Promise<void>>();
  private frozen = false;
  private closing?: Promise<void>;
  constructor(private readonly deps: { owner: Pick<AsyncConnectorOwner, 'command'>; deck: Pick<DeckStore, 'getSession' | 'renameSessionOwned'>;
    local(): void; writable(): boolean; diagnostics?: PerformanceDiagnostics }) {}
  private track<T>(run: () => Promise<T>): Promise<T> {
    if (this.frozen || this.pending.size >= 16) return Promise.reject(new ConnectorOwnerUnavailable());
    const work = Promise.resolve().then(run), release = () => { this.pending.delete(drain); };
    const drain = Promise.prototype.then.call(work, release, release) as Promise<void>; this.pending.add(drain); return work;
  }
  private async command<K extends ConnectorTitleKind>(kind: K, input: ConnectorTitleCommands[K]['input']) {
    const result = await this.deps.owner.command(kind, input);
    if (!validConnectorTitleOutput(kind, result)) throw new ConnectorOwnerUnavailable();
    return result;
  }
  receipt(input: ConnectorTitleCommands['titleReceipt']['input']) {
    const original = structuredClone(input); return this.track(() => this.command('titleReceipt', original));
  }
  change(input: ConnectorTitleCommands['titleClaim']['input'], authority?: ApplicationCommandScope): Promise<TitleResult | { error: 403 | 409 | 503 }> {
    const original = structuredClone(input);
    return this.track(async () => {
      const trace = guardedTrace(this.deps.diagnostics ?? performanceDiagnostics, 'connector-session-settings'); let failed = true;
      try {
        trace.add('step', 1); await authority?.authorize('prepare'); authority?.local();
        const claimed = await this.command('titleClaim', { ...original, ...(!this.deps.writable() ? { rejectFresh: 'runtime_unavailable' as const } : {}) });
        if ('error' in claimed || !claimed.intent) return claimed;
        const intent = claimed.intent;
        const local = () => { authority?.local(); if (this.frozen || !this.deps.writable()) throw new ConnectorOwnerUnavailable(); this.deps.local(); };
        try {
          if (!this.deps.deck.getSession(original.key)) await this.command('titleAbandon', { intent, reason: 'session_missing' });
          else {
            await authority?.authorize('effect'); local();
            if (!await this.command('titleBegin', { intent, authorization: original.authorization })) throw new ConnectorOwnerUnavailable();
            local(); trace.add('step', 2);
            await this.deps.deck.renameSessionOwned(original.key, intent.title, async session => {
              // ACK is a durable fact, not a newly authorized effect.
              const accepted = await this.command('titleAccept', { intent, title: session.title! });
              if (accepted === false || accepted.receipt?.state !== 'accepted') throw new ConnectorOwnerUnavailable();
              trace.add('settled', 1); await authority?.authorize('prepare'); local();
            });
          }
        } catch { await this.command('titleAbandon', { intent }).catch(() => false); }
        const result = await this.command('titleReceipt', { authorization: original.authorization, key: original.key, commandKey: original.commandKey });
        failed = 'error' in result || result.receipt?.state !== 'accepted'; return result;
      } finally { trace.finish(failed); }
    });
  }
  close(): Promise<void> { this.frozen = true; return this.closing ??= Promise.all([...this.pending]).then(() => {}); }
}
