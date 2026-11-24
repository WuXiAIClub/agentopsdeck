import {isDeepStrictEqual} from 'node:util';
import {WORKSPACE_FILE_CARD_MAX_BYTES,validBoardUuid} from '@agentopsdeck/shared';
import {ContentProposalConflict,type ContentBinding,type ContentReceipt} from './content-proposal-store.js';
import {validContentProposal,validContentReceipt,type ContentSyncCommand,type ContentSyncResult} from './member-content-sync-domain.js';
import type {ContentReplicaTransport,ContentReplicaView} from './workspace-content-coordinator.js';
import {observeContentReplica} from '../diagnostics/content-replica.js';
import type {PerformanceDiagnostics} from '../diagnostics/performance.js';

/** Shared proof validation for sync and read/reconciliation. No cached
 * remote identity is allowed to select a different binding or generation. */
export function validateContentReplicaView(binding:ContentBinding,resource:string,view:ContentReplicaView) {
    const {id,generation}=binding;
    if(view.resource!==resource||view.generation!==generation||view.sessionKey!==binding.target?.sessionKey
      ||!isDeepStrictEqual(view.initial,binding.initial)||!(view.actualHash===null||typeof view.actualHash==='string'&&/^[a-f0-9]{64}$/.test(view.actualHash))
      ||!Array.isArray(view.proposals)||view.proposals.length>128)throw new ContentProposalConflict('replica-proof');
    const ids=new Set<string>();
    for(const local of view.proposals){
      if(!local||!validContentProposal(local.proposal)||local.proposal.bindingId!==id||local.proposal.generation!==generation
        ||ids.has(local.proposal.mutationId)||!['prepared','unknown','committed','conflict'].includes(local.state)
        ||typeof local.baseContent!=='string'||Buffer.byteLength(local.baseContent)>WORKSPACE_FILE_CARD_MAX_BYTES
        ||local.resolvedBy!==undefined&&!validBoardUuid(local.resolvedBy)
        ||(local.state==='committed'||local.state==='conflict')&&(!validContentReceipt(local.receipt)
          ||local.receipt.mutationId!==local.proposal.mutationId||local.receipt.state!==local.state))throw new ContentProposalConflict('proposal-proof');
      ids.add(local.proposal.mutationId);
    }
    return view;
}

/** Effect-only coordinator. It never sees SQL, owners or cached principals.
 * Unknown claims/project effects are resolved by original receipts only. */
export async function synchronizeContentReplica(input:{id:string;resource:string;
  current:()=>Promise<ContentBinding>;inspect:()=>Promise<ContentBinding>;
  call:<T>(effect:(transport:ContentReplicaTransport)=>Promise<T>)=>Promise<T>;
  command:(command:ContentSyncCommand)=>Promise<ContentSyncResult>;check:()=>void;diagnostics?:PerformanceDiagnostics}) {
  const {id,resource,command,call,current,check}=input,binding=await input.inspect(),generation=binding.generation;
  const phase=<T>(step:number,run:()=>Promise<T>)=>observeContentReplica('hub-content-replica-effect',step,run,input.diagnostics);
  const validate=(view:ContentReplicaView)=>validateContentReplicaView(binding,resource,view);
  check();await phase(1,()=>call(t=>{check();return t.observe(id);}));let view=validate(await phase(2,()=>call(t=>t.view(id))));
  for(const local of view.proposals.filter(p=>p.state==='prepared'||p.state==='unknown').slice(0,4)){
    const proposal=local.proposal;let receipt:ContentReceipt|null=null;
    if(local.state==='prepared'){
      check();const claim=await phase(3,()=>call(t=>{check();return t.claim(id,proposal.mutationId);}));
      if(typeof claim?.claimed!=='boolean'||!claim.local||!isDeepStrictEqual(claim.local.proposal,proposal))throw new ContentProposalConflict('claim-proof');
      if(claim.claimed){
        if(claim.local.state!=='unknown')throw new ContentProposalConflict('claim-proof');
        check();const result=await phase(4,()=>command({action:'sync-submit',id,generation,proposal}));
        if(result.action!=='sync-submit')throw new ContentProposalConflict('proposal-receipt');receipt=result.receipt;
      }
    }
    if(!receipt){
      const result=await phase(5,()=>command({action:'sync-original',id,generation,proposal}));
      if(result.action!=='sync-original')throw new ContentProposalConflict('proposal-receipt');receipt=result.receipt;
    }
    if(receipt)await phase(6,()=>call(t=>t.settle(id,proposal.mutationId,receipt!)));
  }
  view=validate(await phase(2,()=>call(t=>t.view(id))));
  for(const local of view.proposals){
    if(local.state==='committed'&&local.receipt?.hash===view.actualHash&&local.receipt.revision>=(await current()).acknowledgedRevision){
      // Do not turn an untrusted remote receipt into an owner acknowledgement.
      const original=await phase(5,()=>command({action:'sync-original',id,generation,proposal:local.proposal}));
      if(original.action!=='sync-original'||!isDeepStrictEqual(original.receipt,local.receipt))throw new ContentProposalConflict('proposal-receipt');
      await phase(7,()=>command({action:'sync-proposal-ack',id,generation,mutationId:local.proposal.mutationId,hash:view.actualHash!}));
    }
  }
  const pending=view.proposals.some(p=>p.state==='prepared'||p.state==='unknown'||p.state==='conflict'&&!p.resolvedBy),excluded:string[]=[];
  for(let n=0;n<4;n++){
    const next=await phase(8,()=>command({action:'sync-projection-next',id,generation,excluded:[...excluded]}));
    if(next.action!=='sync-projection-next')throw new ContentProposalConflict('projection-proof');
    const job=next.job;if(!job)break;excluded.push(job.id);
    let result:{id:string;state:string;hash:string|null};
    if(job.state==='unknown')result=await phase(11,()=>call(t=>t.projectionReceipt(id,job)));
    else {
      if(pending||!view.actualHash)return current();
      check();const claimed=await phase(9,()=>command({action:'sync-projection-claim',id,generation,jobId:job.id,actualHash:view.actualHash!,pending}));
      if(claimed.action!=='sync-projection-claim')throw new ContentProposalConflict('projection-proof');
      if(!claimed.claimed)continue;
      check();result=await phase(10,()=>call(t=>{check();return t.project(id,claimed.job);}));
    }
    if(result.id!==job.id)throw new ContentProposalConflict('projection-receipt');
    if(result.state!=='saved'||result.hash!==job.hash)break;
    await phase(12,()=>command({action:'sync-projection-ack',id,generation,jobId:job.id,hash:result.hash!}));
    view=validate(await phase(2,()=>call(t=>t.view(id))));
  }
  return current();
}
