import { randomUUID } from 'node:crypto';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable, encodeConnectorOwnerJson } from './connector-owner-domain.js';
import { localCredentialsMatch, validLocalCredentialsInput, validLocalCredentialsOutput,
  type LocalCredentialBundle } from './local-credentials-domain.js';
import type { LocalCredentialRole, LocalCredentialSpec } from './local-credential-plan.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Startup owns this holder, not an HTTP request. Drain consumers before close;
 * on unknown create/release, fail startup and retire the SAME shared owner. */
export class AsyncLocalCredentials {
  private readonly input: { leaseId: string; specs: LocalCredentialSpec[] };
  private opening: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private bundle: LocalCredentialBundle | undefined;
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>, specs: LocalCredentialSpec[],
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    this.input = JSON.parse(encodeConnectorOwnerJson({ leaseId: randomUUID(), specs }));
    if (!validLocalCredentialsInput('localCredentialsCreate', this.input)) throw new ConnectorOwnerUnavailable();
  }
  open(): Promise<void> {
    if (this.closed) return Promise.reject(new ConnectorOwnerUnavailable());
    // Publish ownership before diagnostics or an injected owner can reenter.
    return this.opening ??= Promise.resolve().then(() => this.acquire());
  }
  private async acquire(): Promise<void> {
    const trace = guardedTrace(this.diagnostics, 'connector-sqlite-command'); trace.add('step', 140);
    try {
      const bundle = await this.owner.command('localCredentialsCreate', this.input);
      if (!validLocalCredentialsOutput('localCredentialsCreate', bundle) || !localCredentialsMatch(this.input, bundle)) throw new ConnectorOwnerUnavailable();
      this.bundle = bundle; trace.add('settled', 1); trace.finish(false);
    } catch (error) { trace.add('unknown', 1); trace.finish(true); throw error; }
  }
  token(role: LocalCredentialRole): string | undefined {
    if (this.closed || !this.bundle) throw new ConnectorOwnerUnavailable();
    return this.bundle.credentials.find(c => c.role === role)?.token;
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= Promise.resolve().then(() => this.release());
  }
  private async release(): Promise<void> {
    if (!this.opening) return;
    const trace = guardedTrace(this.diagnostics, 'connector-sqlite-command'); trace.add('step', 141);
    try {
      // Never release on a deadline, or issue a new create after a lost ACK.
      await this.opening;
      const result = await this.owner.command('localCredentialsRelease', { leaseId: this.input.leaseId });
      if (!validLocalCredentialsOutput('localCredentialsRelease', result) || result.leaseId !== this.input.leaseId || !result.released) throw new ConnectorOwnerUnavailable();
      this.bundle = undefined; trace.add('settled', 1); trace.finish(false);
    } catch (error) { this.bundle = undefined; trace.add('unknown', 1); trace.finish(true); throw error; }
  }
}
