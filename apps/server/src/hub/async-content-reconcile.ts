import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ContentProposalConflict,type ContentBinding} from './content-proposal-store.js';
import type {LocalContentProposal} from '../connector/workspace-content-replica.js';
import type {ContentReplicaTransport,ContentReplicaView} from './workspace-content-coordinator.js';
import type {ContentSyncCommand,ContentSyncResult} from './member-content-sync-domain.js';
import {validateContentReplicaView} from './async-content-synchronize.js';
import {observeContentReplica} from '../diagnostics/content-replica.js';
import {HubMemberOwnerUnavailable} from './member-owner-domain.js';

export type ContentReconcileAccess={id:string;resource:string;binding:ContentBinding;
  call:<T>(effect:(transport:ContentReplicaTransport)=>Promise<T>)=>Promise<T>;
  command:(command:ContentSyncCommand)=>Promise<ContentSyncResult>;check:()=>void};
export async function readContentReplica(access:ContentReconcileAccess) {
  const view=await observeContentReplica('hub-content-replica-effect',13,()=>access.call(t=>t.view(access.id)));
  return validateContentReplicaView(access.binding,access.resource,view);
}
/** Read exactly the immutable conflict receipt and its historical snapshot.
 * This command never admits a proposal, projects a file or substitutes head. */
export async function contentConflictProof(access:ContentReconcileAccess,local:LocalContentProposal) {
  const proof=await observeContentReplica('hub-content-replica-effect',14,()=>access.command({action:'sync-conflict-proof',
    id:access.id,generation:access.binding.generation,proposal:local.proposal}));
  if(proof.action!=='sync-conflict-proof'||!isDeepStrictEqual(proof.receipt,local.receipt))throw new ContentProposalConflict('conflict-proof');
  return proof.snapshot;
}
export async function resolveContentConflict(access:ContentReconcileAccess,view:ContentReplicaView,
  input:{conflictId:string;mutationId:string;expectedHash:string}) {
  const local=view.proposals.find(p=>p.proposal.mutationId===input.conflictId);
  if(!local||local.state!=='conflict'||input.mutationId===input.conflictId)throw new ContentProposalConflict('conflict-proof');
  const base=await contentConflictProof(access,local),prior=view.proposals.find(p=>p.proposal.mutationId===input.mutationId);
  const intent={...input,epoch:base.epoch,revision:base.revision,hash:base.hash},scope={id:access.id,generation:access.binding.generation};
  const claim=async()=>{
    const result=await observeContentReplica('hub-content-replica-effect',16,()=>access.command({action:'sync-resolution-claim',...scope,intent}));
    if(result.action!=='sync-resolution-claim')throw new HubMemberOwnerUnavailable();return result;
  };
  const acknowledge=async(result:LocalContentProposal)=>{
    const settled=await observeContentReplica('hub-content-replica-effect',17,()=>access.command({action:'sync-resolution-ack',...scope,intent}));
    if(settled.action!=='sync-resolution-ack')throw new HubMemberOwnerUnavailable();return result;
  };
  const validate=(result:LocalContentProposal)=>{
    validateContentReplicaView(access.binding,access.resource,{...view,proposals:[result]});
    const proposal=result.proposal;
    if(proposal.mutationId!==input.mutationId||proposal.modeEpoch!==base.epoch||proposal.baseRevision!==base.revision
      ||proposal.baseHash!==base.hash||result.baseContent!==base.content
      ||createHash('sha256').update(proposal.content).digest('hex')!==input.expectedHash)throw new ContentProposalConflict('resolution-proof');
    return result;
  };
  if(prior){
    if(local.resolvedBy!==input.mutationId)throw new ContentProposalConflict('resolution-reused');
    const result=validate(prior);await claim();return acknowledge(result); // Lost ACK: query original, never call resolve again.
  }
  if(local.resolvedBy)throw new ContentProposalConflict('resolution-reused');
  // Persist before dispatch. Missing native proposal does not prove that an
  // admitted resolve did not execute, including after SQL owner restart.
  if(!(await claim()).claimed)throw new HubMemberOwnerUnavailable();
  access.check();
  return acknowledge(validate(await observeContentReplica('hub-content-replica-effect',15,()=>access.call(t=>{
    access.check();return t.resolve(access.id,{...input,base});
  }))));
}
