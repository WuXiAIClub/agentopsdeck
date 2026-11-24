import type { Dispatch } from '../connector/transport.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { ConnectorClient } from './connector-client.js';
import type { ExecutionLease } from './execution-leases.js';
import { EXECUTION_ISSUER_PATHS, executionIssuerBinding, validHubExecutionIssuerReply, type ExecutionIssuerPath } from './member-execution-issuer-domain.js';

/** Background lease transport only; no browser token, generic proxy or sync fallback. */
export class AsyncHubExecutionIssuers {
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    private readonly local?: { connectionId: string; dispatch: Dispatch }) {}

  isLocalLease(lease: ExecutionLease): boolean {
    return !!this.local && this.local.connectionId === lease.proof.connectionId;
  }

  async clientFor(lease: ExecutionLease): Promise<ConnectorClient> {
    const binding = executionIssuerBinding(lease);
    const { id, nodeId, issuerId } = lease, { connectionId, nodeVersion } = lease.proof;
    const command = { action: 'open' as const, id, binding };
    const result = await this.owner.command('executionIssuer', command);
    if (!validHubExecutionIssuerReply(command, result) || result.action !== 'open'
      || result.snapshot.nodeId !== nodeId || result.snapshot.issuerId !== issuerId
      || result.snapshot.connectionId !== connectionId || result.snapshot.version !== nodeVersion) {
      throw new Error('Execution issuer reply mismatch');
    }
    const s = result.snapshot;
    if (s.kind === 'local' && (!this.local || this.local.connectionId !== s.connectionId)) throw new Error('Local issuer transport unavailable');
    // Keep the persisted origin in the fingerprint. Only the wire origin is
    // normalized, exactly like the original local Connector resolver. Local
    // dispatch is mandatory above; this is never an external fetch fallback.
    return new ConnectorClient(s.kind === 'local' ? 'http://connector.example.invalid' : s.origin,
      s.token, s.kind === 'local' ? this.local!.dispatch : undefined, 10_000, 8192, {
      nodeId: s.nodeId,
      request: async (path, method) => {
        if (method !== 'POST' || !EXECUTION_ISSUER_PATHS.includes(path as ExecutionIssuerPath)) throw new Error('Issuer client is restricted to lease synchronization');
        const check = { action: 'check' as const, id, binding,
          fingerprint: result.fingerprint, path: path as ExecutionIssuerPath, method: 'POST' as const };
        const reply = await this.owner.command('executionIssuer', check);
        if (!validHubExecutionIssuerReply(check, reply)) throw new Error('Execution issuer reply mismatch');
      },
    });
  }
}
