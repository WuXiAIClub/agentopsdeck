import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorAutomationOutput, type ConnectorAutomationCommands, type ConnectorAutomationKind } from './connector-automation-domain.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

/** Configuration only; never creates a scheduler or sends a native message.
 * HTTP deadlines end the waiter, not the physical original DB operation. */
export class AsyncAutomationConfiguration {
  private readonly pending = new Set<Promise<unknown>>();
  private frozen = false;
  private closing?: Promise<void>;
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>, private readonly nodeId: string,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}
  private retain<T>(run: () => Promise<T>): Promise<T> {
    if (this.frozen || this.pending.size >= 32) return Promise.reject(new ConnectorOwnerUnavailable());
    // Register before user callbacks can close/re-enter; close drains the real
    // operation even if the HTTP waiter timed out or was aborted already.
    const physical = Promise.resolve().then(run);
    // Keep an unexposed settlement promise: callers own the returned waiter
    // and can replace its .then without changing physical shutdown ownership.
    const done = () => { this.pending.delete(drain); };
    const drain = Promise.prototype.then.call(physical, done, done) as Promise<void>;
    this.pending.add(drain);
    return physical;
  }
  private async call<K extends ConnectorAutomationKind>(kind: K, input: ConnectorAutomationCommands[K]['input']): Promise<ConnectorAutomationCommands[K]['output']> {
    const result = await this.owner.command(kind, structuredClone(input));
    if (!validConnectorAutomationOutput(kind, result)) throw new ConnectorOwnerUnavailable();
    return result;
  }
  authority(input: ConnectorAutomationCommands['automationAuthority']['input']) {
    const original = structuredClone(input);
    return this.retain(async () => {
      const result = await this.call('automationAuthority', original);
      if (this.frozen || result.ok && result.value.connectionId !== this.nodeId) throw new ConnectorOwnerUnavailable();
      return result;
    });
  }
  private operation<K extends Exclude<ConnectorAutomationKind, 'automationAuthority'>>(kind: K,
    input: ConnectorAutomationCommands[K]['input']): Promise<ConnectorAutomationCommands[K]['output']> {
    const original = structuredClone(input);
    return this.retain(async () => {
      const trace = guardedTrace(this.diagnostics, 'connector-sqlite-command');
      trace.add('step', kind === 'automationConfigure' ? 275 : kind === 'automationConfigurationView' ? 273 : 274);
      let failed = true;
      try {
        const before = await this.call('automationAuthority', { authorization: original.authorization });
        if (!before.ok) return before;
        if (this.frozen || before.value.connectionId !== this.nodeId) throw new ConnectorOwnerUnavailable();
        const result = await this.call(kind, original);
        if (!result.ok) return result;
        const after = await this.call('automationAuthority', { authorization: original.authorization });
        if (!after.ok) return after;
        if (this.frozen || after.value.ownerId !== before.value.ownerId || after.value.connectionId !== this.nodeId) throw new ConnectorOwnerUnavailable();
        if (kind === 'automationConfigurationView') {
          const view = (result as ConnectorAutomationCommands['automationConfigurationView']['output']);
          if (!view.ok || view.value.ownerId !== before.value.ownerId || view.value.connectionId !== this.nodeId) throw new ConnectorOwnerUnavailable();
        } else {
          const receipt = (result as ConnectorAutomationCommands['automationConfigurationOriginal']['output']);
          if (!receipt.ok || receipt.value && (receipt.value.requestId !== (original as { requestId: string }).requestId
            || receipt.value.result.rule.target.ownerId !== before.value.ownerId
            || receipt.value.result.rule.target.connectionId !== this.nodeId)) throw new ConnectorOwnerUnavailable();
        }
        failed = false; return result;
      } finally { trace.finish(failed); }
    }) as Promise<ConnectorAutomationCommands[K]['output']>;
  }
  view(input: ConnectorAutomationCommands['automationConfigurationView']['input']) { return this.operation('automationConfigurationView', input); }
  original(input: ConnectorAutomationCommands['automationConfigurationOriginal']['input']) { return this.operation('automationConfigurationOriginal', input); }
  configure(input: ConnectorAutomationCommands['automationConfigure']['input']) { return this.operation('automationConfigure', input); }
  close(): Promise<void> {
    this.frozen = true;
    return this.closing ??= Promise.allSettled([...this.pending]).then(() => {});
  }
}
