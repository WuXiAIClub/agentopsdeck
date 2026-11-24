import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import type { ExecutionAction, ExecutionGrantRef } from '../connector/execution-grants.js';
import type { HubExecutionLeases } from './execution-leases.js';
import type { NodeGrantProof } from './node-grants.js';
import { HUB_EXECUTION_LEASE_COMMAND_BYTES, validHubExecutionLeaseReply, type HubExecutionLeaseCommand } from './member-execution-lease-domain.js';
/** Fixed domain adapter. Production still uses the original synchronous owner;
 * worker candidates use the same port. Callbacks remain on their own side.
 * Aborted waiters never replay an unknown reservation or release its owner. */
export class AsyncHubExecutionLeases {
  constructor(private readonly owner: Pick<AsyncHubMemberOwner,'command'>) {}
  private async run(c: HubExecutionLeaseCommand) {
    const owned = JSON.parse(encodeHubMemberJson(c,HUB_EXECUTION_LEASE_COMMAND_BYTES)) as HubExecutionLeaseCommand;
    const value = await this.owner.command('executionLease',owned);
    if (!validHubExecutionLeaseReply(owned,value)) throw Error('hub_execution_lease_unavailable');
    return value;
  }
  async reserve(proof: NodeGrantProof,nodeId: string,issuerId: string,actions: ExecutionAction[]) {
    const value = await this.run({ action:'reserve',proof,nodeId,issuerId,actions });
    if (!('lease' in value) || !value.lease) throw Error('hub_execution_lease_unavailable');
    return value.lease;
  }
  async get(id: number) {
    const value = await this.run({ action:'get',id });
    if (!('lease' in value)) throw Error('hub_execution_lease_unavailable');
    return value.lease ?? undefined;
  }
  async prepareIssue(id: number) {
    const value = await this.run({ action:'prepareIssue',id });
    if (!('lease' in value) || !value.lease) throw Error('hub_execution_lease_unavailable');
    return value.lease;
  }
  async acknowledgeIssue(id: number,ref: ExecutionGrantRef,expiresAt: number) {
    const value = await this.run({ action:'acknowledgeIssue',id,ref,expiresAt });
    if (!('value' in value) || typeof value.value !== 'boolean') throw Error('hub_execution_lease_unavailable');
    return value.value;
  }
  async revoke(id: number) { await this.run({ action:'revoke',id }); }
  async acknowledgeRevoke(id: number,throughVersion: number) {
    const value = await this.run({ action:'acknowledgeRevoke',id,throughVersion });
    if (!('value' in value) || typeof value.value !== 'boolean') throw Error('hub_execution_lease_unavailable');
    return value.value;
  }
  async revocations(after = 0,limit = 32) {
    const value = await this.run({ action:'revocations',after,limit });
    if (!('leases' in value)) throw Error('hub_execution_lease_unavailable');
    return value.leases;
  }
  async authorized(proof: NodeGrantProof,actions: ExecutionAction[]) {
    const value = await this.run({ action:'authorized',proof,actions });
    if (!('value' in value) || typeof value.value !== 'boolean') throw Error('hub_execution_lease_unavailable');
    return value.value;
  }
  async usageQuiet(id: number,version: number) {
    const value = await this.run({ action:'usageQuiet',id,version });
    if (!('value' in value) || typeof value.value !== 'boolean') throw Error('hub_execution_lease_unavailable');
    return value.value;
  }
  async usageDueAsync(limit = 16,check: () => void = () => {}) {
    check(); // Local admission check, never serialized to the worker.
    const value = await this.run({ action:'usageDue',limit });
    check(); // Owner's durable reservation is not permission after cancellation.
    if (!('page' in value)) throw Error('hub_execution_lease_unavailable');
    return value.page;
  }
  async nextQueueActor(target: Parameters<HubExecutionLeases['nextQueueActor']>[0],afterIssuer = '') {
    const value = await this.run({ action:'nextQueueActor',target,afterIssuer });
    if (!('lease' in value)) throw Error('hub_execution_lease_unavailable');
    return value.lease ?? undefined;
  }
}
