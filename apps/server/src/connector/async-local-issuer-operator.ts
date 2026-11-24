import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorAuthorityInput, validConnectorAuthorityOutput } from './connector-authority-domain.js';
import {
  connectorGrantSteps,
  validConnectorGrantInput,
  validConnectorGrantOutput,
  type ConnectorGrantCommands,
} from './connector-grant-domain.js';
import { localIssuerPlan } from './local-issuer-plan.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Private composition capability, not an HTTP identity or authorization port.
 * The original Hub workflow must approve prepare/check/install. A lost command
 * ACK fences this holder permanently: a second issuance is NOT recovery. */
export class AsyncLocalIssuerOperator {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly hubs = new Set<string>();
  private closed = false;
  private failed = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>,
    private readonly available: () => boolean,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}

  private check() {
    if (this.closed || this.failed || this.available() !== true) throw new ConnectorOwnerUnavailable();
  }
  private run<T>(step: number, effect: () => Promise<T>): Promise<T> {
    try { this.check(); if (this.pending.size >= 32) throw new ConnectorOwnerUnavailable(); }
    catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    // Publish ownership before any injected diagnostic/owner can reenter close.
    const task = Promise.resolve().then(async () => {
      const trace = guardedTrace(this.diagnostics, 'connector-sqlite-command'); trace.add('step', step);
      let dispatched = false;
      try {
        this.check(); dispatched = true;
        const value = await effect(); trace.add('settled', 1); trace.finish(); return value;
      } catch {
        if (dispatched) this.failed = true;
        trace.add(dispatched ? 'unknown' : 'deferred', 1); trace.finish(true);
        throw new ConnectorOwnerUnavailable();
      }
    });
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }
  create(hubId: string, createSessions = false) {
    const plan = localIssuerPlan(hubId, createSessions);
    if (typeof createSessions !== 'boolean' || !validConnectorAuthorityInput('tokenCreate', plan) || this.hubs.has(hubId)) {
      return Promise.reject(new ConnectorOwnerUnavailable());
    }
    this.hubs.add(hubId);
    const task = this.run(23, async () => {
      const result = await this.owner.command('tokenCreate', plan);
      if (!validConnectorAuthorityOutput('tokenCreate', result)
        || result.record.label !== plan.label || result.record.delegationHubId !== plan.delegationHubId
        || result.record.revokedAt !== undefined || result.record.identityAmbiguous !== undefined
        || !/^tok_[A-Za-z0-9_-]{10}$/.test(result.record.id)
        || result.record.scopes.length !== plan.scopes.length
        || result.record.scopes.some((scope, index) => scope !== plan.scopes[index])) throw new ConnectorOwnerUnavailable();
      return { token: result.token, record: { id: result.record.id } };
    });
    void task.then(() => this.hubs.delete(hubId), () => this.hubs.delete(hubId));
    return task;
  }
  revoke(id: string) {
    const input = { tokenId: id };
    if (!validConnectorAuthorityInput('tokenRevoke', input)) return Promise.reject(new ConnectorOwnerUnavailable());
    return this.run(24, async () => {
      const result = await this.owner.command('tokenRevoke', input);
      if (!validConnectorAuthorityOutput('tokenRevoke', result)) throw new ConnectorOwnerUnavailable();
      return result;
    });
  }
  revokeRetiredGrant(input: ConnectorGrantCommands['localRetiredGrantRevoke']['input']) {
    if (!validConnectorGrantInput('localRetiredGrantRevoke', input)) return Promise.reject(new ConnectorOwnerUnavailable());
    return this.run(connectorGrantSteps.localRetiredGrantRevoke, async () => {
      const result = await this.owner.command('localRetiredGrantRevoke', input);
      if (!validConnectorGrantOutput('localRetiredGrantRevoke', result)) throw new ConnectorOwnerUnavailable();
      return result;
    });
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= Promise.resolve().then(async () => {
      await Promise.allSettled([...this.pending]);
      if (this.failed) throw new ConnectorOwnerUnavailable();
    });
  }
}
