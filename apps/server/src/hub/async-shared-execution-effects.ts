import { ConnectorClient } from './connector-client.js';
import { HubExecutionEffects, type ExecutionEffectLocal, type ExecutionEffectOperation } from './execution-effects.js';
import type { ExecutionLease } from './execution-leases.js';
import { executionIssuerBinding } from './member-execution-issuer-domain.js';
import type { HubExecutionCommandResult } from './member-execution-command-domain.js';
import type { HubExecutionEffect } from './member-execution-effect-domain.js';

/** One original request + one fixed operation. Never accepts a generic path RPC
 * or falls back to ordinary Connector credentials. */
export class AsyncHubSharedExecutionEffects extends HubExecutionEffects {
  constructor(private readonly run: (action: { action: 'effectOpen'; effect: HubExecutionEffect }
    | { action: 'effectCheck'; effect: HubExecutionEffect; fingerprint: string }) => Promise<HubExecutionCommandResult>,
    private readonly effect: HubExecutionEffect) { super(); }
  protected async client(lease: ExecutionLease, local?: ExecutionEffectLocal, operation?: ExecutionEffectOperation): Promise<ConnectorClient> {
    if (!operation) throw new Error('A shared command operation is required');
    const opened = await this.run({ action: 'effectOpen', effect: this.effect });
    if (!opened || 'error' in opened || opened.action !== 'effectOpen' || !lease.ref
      || executionIssuerBinding(opened.lease) !== executionIssuerBinding(lease)
      || opened.lease.ref?.id !== lease.ref.id || opened.lease.ref?.actorId !== lease.ref.actorId
      || opened.path !== operation.path || opened.method !== operation.method) throw new Error('Execution effect reply mismatch');
    const s = opened.snapshot;
    if (s.kind === 'local' && (!local || local.connectionId !== s.connectionId)) throw new Error('Local issuer transport unavailable');
    return new ConnectorClient(s.origin, s.token, s.kind === 'local' ? local!.dispatch : undefined, 10_000, 128 * 1024, {
      nodeId: s.nodeId, authorize: operation.authorize,
      request: async (path, method) => {
        if (path !== opened.path || method !== opened.method) throw new Error('Issuer client is restricted to one command operation');
        const check = await this.run({ action: 'effectCheck', effect: this.effect, fingerprint: opened.fingerprint });
        if (!check || 'error' in check || check.action !== 'effectCheck' || check.path !== path || check.method !== method
          || check.binding !== opened.binding || check.fingerprint !== opened.fingerprint
          || executionIssuerBinding(check.lease) !== executionIssuerBinding(lease)
          || check.lease.ref?.id !== lease.ref!.id || check.lease.ref?.actorId !== lease.ref!.actorId) throw new Error('Execution effect reply mismatch');
      },
    });
  }
}
