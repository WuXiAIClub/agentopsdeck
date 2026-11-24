import {createHash} from 'node:crypto';
import {WORKSPACE_FILE_CARD_MAX_BYTES,validBoardUuid} from '@agentopsdeck/shared';
import type {HubStore} from './hub-store.js';
import {ContentProposalConflict,type ContentBinding,type ContentProposal,type ContentProjection,type ContentReceipt,type ContentResource,
  type ContentResolutionInput,type ContentResolutionIntent} from './content-proposal-store.js';
import {currentContentBinding,validContentBinding} from './member-content-replica-domain.js';
import {normalizeSharedContent} from './workspace-content-coordinator.js';

type Scope={id:string;generation:string};
export type ContentSyncCommand=Scope&(
  |{action:'sync-submit';proposal:ContentProposal}
  |{action:'sync-original';proposal:ContentProposal}
  |{action:'sync-conflict-proof';proposal:ContentProposal}
  |{action:'sync-resolution-claim';intent:ContentResolutionInput}
  |{action:'sync-resolution-ack';intent:ContentResolutionInput}
  |{action:'sync-proposal-ack';mutationId:string;hash:string}
  |{action:'sync-projection-next';excluded:string[]}
  |{action:'sync-projection-claim';jobId:string;actualHash:string;pending:boolean}
  |{action:'sync-projection-ack';jobId:string;hash:string});
export type ContentSyncResult=Scope&(
  |{action:'sync-submit'|'sync-original';receipt:ContentReceipt|null}
  |{action:'sync-conflict-proof';receipt:ContentReceipt;snapshot:ContentResource}
  |{action:'sync-resolution-claim';intent:ContentResolutionIntent;claimed:boolean}
  |{action:'sync-resolution-ack';intent:ContentResolutionIntent}
  |{action:'sync-proposal-ack';binding:ContentBinding}
  |{action:'sync-projection-next';job:ContentProjection|null}
  |{action:'sync-projection-claim';job:ContentProjection;claimed:boolean}
  |{action:'sync-projection-ack';job:ContentProjection});
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const revision=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const body=(v:unknown):v is string=>typeof v==='string'&&Buffer.byteLength(v)<=WORKSPACE_FILE_CARD_MAX_BYTES;
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
function resolution(v:unknown,state=false):v is ContentResolutionIntent {
  return object(v)&&keys(v,['conflictId','mutationId','expectedHash','epoch','revision','hash',...(state?['state']:[])])
    &&[v.conflictId,v.mutationId,v.epoch].every(validBoardUuid)&&v.conflictId!==v.mutationId&&revision(v.revision)
    &&hash(v.expectedHash)&&hash(v.hash)&&(!state||v.state==='unknown'||v.state==='acknowledged');
}
export function validContentProposal(v:unknown):v is ContentProposal {
  return object(v)&&keys(v,['bindingId','generation','mutationId','modeEpoch','baseRevision','baseHash','content'])
    &&[v.bindingId,v.generation,v.mutationId,v.modeEpoch].every(validBoardUuid)&&revision(v.baseRevision)&&hash(v.baseHash)&&body(v.content);
}
export function validContentReceipt(v:unknown):v is ContentReceipt {
  return object(v)&&keys(v,['mutationId','fingerprint','state','revision','hash'])&&validBoardUuid(v.mutationId)
    &&hash(v.fingerprint)&&['committed','conflict'].includes(String(v.state))&&revision(v.revision)&&hash(v.hash);
}
function validProjection(v:unknown):v is ContentProjection {
  return object(v)&&keys(v,['id','bindingId','generation','revision','hash','content','state','expectedHash'])
    &&[v.id,v.bindingId,v.generation].every(validBoardUuid)&&revision(v.revision)&&hash(v.hash)&&body(v.content)&&digest(v.content)===v.hash
    &&['pending','unknown','acknowledged'].includes(String(v.state))&&(v.state==='pending'?v.expectedHash===null:
      v.state==='unknown'?hash(v.expectedHash):v.expectedHash===null||hash(v.expectedHash));
}
export function validContentSyncCommand(v:Record<string,unknown>) {
  if(!validBoardUuid(v.id)||!validBoardUuid(v.generation))return false;
  const exact=(...extra:string[])=>keys(v,['action','resourceId','id','generation',...extra]);
  if(v.action==='sync-resolution-claim'||v.action==='sync-resolution-ack')return exact('intent')&&resolution(v.intent);
  if(v.action==='sync-submit'||v.action==='sync-original'||v.action==='sync-conflict-proof')return exact('proposal')&&validContentProposal(v.proposal)
    &&v.proposal.bindingId===v.id&&v.proposal.generation===v.generation;
  if(v.action==='sync-proposal-ack')return exact('mutationId','hash')&&validBoardUuid(v.mutationId)&&hash(v.hash);
  if(v.action==='sync-projection-next')return exact('excluded')&&Array.isArray(v.excluded)&&v.excluded.length<=4
    &&v.excluded.every(validBoardUuid)&&new Set(v.excluded).size===v.excluded.length;
  if(v.action==='sync-projection-claim')return exact('jobId','actualHash','pending')&&validBoardUuid(v.jobId)&&hash(v.actualHash)&&typeof v.pending==='boolean';
  return v.action==='sync-projection-ack'&&exact('jobId','hash')&&validBoardUuid(v.jobId)&&hash(v.hash);
}
export function validContentSyncResult(v:Record<string,unknown>) {
  if(!validBoardUuid(v.id)||!validBoardUuid(v.generation))return false;
  const exact=(...extra:string[])=>keys(v,['action','resourceId','id','generation',...extra]);
  if(v.action==='sync-resolution-claim')return exact('intent','claimed')&&resolution(v.intent,true)&&typeof v.claimed==='boolean'
    &&(!v.claimed||v.intent.state==='unknown');
  if(v.action==='sync-resolution-ack')return exact('intent')&&resolution(v.intent,true)&&v.intent.state==='acknowledged';
  if(v.action==='sync-conflict-proof'){
    const s=v.snapshot;
    return exact('receipt','snapshot')&&validContentReceipt(v.receipt)&&v.receipt.state==='conflict'
      &&object(s)&&keys(s,['epoch','revision','hash','content'])&&validBoardUuid(s.epoch)&&revision(s.revision)&&hash(s.hash)
      &&body(s.content)&&digest(s.content)===s.hash&&s.revision===v.receipt.revision&&s.hash===v.receipt.hash;
  }
  if(v.action==='sync-submit'||v.action==='sync-original')return exact('receipt')
    &&(v.receipt===null?v.action==='sync-original':validContentReceipt(v.receipt));
  if(v.action==='sync-proposal-ack')return exact('binding')&&validContentBinding(v.binding)
    &&v.binding.id===v.id&&v.binding.generation===v.generation&&!v.binding.revoked;
  if(!['sync-projection-next','sync-projection-claim','sync-projection-ack'].includes(String(v.action)))return false;
  return exact('job',...(v.action==='sync-projection-claim'?['claimed']:[]))
    &&(v.job===null?v.action==='sync-projection-next':validProjection(v.job)&&v.job.bindingId===v.id&&v.job.generation===v.generation)
    &&(v.action!=='sync-projection-claim'||typeof v.claimed==='boolean');
}
export function matchesContentSyncReply(command:ContentSyncCommand,result:ContentSyncResult,resource:string) {
  if(command.action!==result.action||command.id!==result.id||command.generation!==result.generation)return false;
  if(command.action==='sync-resolution-claim'||command.action==='sync-resolution-ack')return 'intent'in result
    &&(['conflictId','mutationId','expectedHash','epoch','revision','hash'] as const).every(k=>command.intent[k]===result.intent[k]);
  if(command.action==='sync-conflict-proof'&&(!('snapshot'in result)||result.snapshot.epoch!==command.proposal.modeEpoch))return false;
  if((command.action==='sync-submit'||command.action==='sync-original'||command.action==='sync-conflict-proof')&&'receipt'in result){
    if(!result.receipt)return command.action==='sync-original';
    try{return result.receipt.mutationId===command.proposal.mutationId&&result.receipt.fingerprint===digest(JSON.stringify([
      command.proposal.modeEpoch,command.proposal.baseRevision,command.proposal.baseHash,normalizeSharedContent(command.proposal.content,resource)]));}catch{return false;}
  }
  if(command.action==='sync-proposal-ack'&&'binding'in result)return result.binding.acknowledgedHash===command.hash;
  if('job'in result){
    if(command.action==='sync-projection-next')return !result.job||!command.excluded.includes(result.job.id);
    if(!('jobId'in command)||result.job?.id!==command.jobId)return false;
    if(command.action==='sync-projection-claim'&&'claimed'in result)return !result.claimed||result.job.state==='unknown'&&result.job.expectedHash===command.actualHash;
    return command.action==='sync-projection-ack'&&result.job.state==='acknowledged'&&result.job.hash===command.hash;
  }
  return false;
}
export async function executeContentSync(owner:HubStore,user:string,resource:string,command:ContentSyncCommand,check:()=>void):Promise<ContentSyncResult> {
  const store=owner.createContentDocumentStore(),scope={id:command.id,generation:command.generation};
  const current=()=>currentContentBinding(owner,user,resource,command.id,command.generation,check);
  current();
  if(command.action==='sync-resolution-claim')return {...scope,action:command.action,
    ...await store.claimResolutionAsync(user,resource,command.id,command.generation,command.intent,()=>{current();})};
  if(command.action==='sync-resolution-ack')return {...scope,action:command.action,
    intent:store.acknowledgeResolution(user,resource,command.id,command.generation,command.intent)};
  if(command.action==='sync-conflict-proof'){
    const receipt=store.receipt(user,resource,command.id,command.generation,command.proposal.mutationId);
    const fingerprint=digest(JSON.stringify([command.proposal.modeEpoch,command.proposal.baseRevision,command.proposal.baseHash,
      normalizeSharedContent(command.proposal.content,resource)]));
    if(!receipt||receipt.state!=='conflict'||receipt.fingerprint!==fingerprint)throw new ContentProposalConflict('conflict-proof');
    const snapshot=store.exactSnapshot(user,resource,{epoch:command.proposal.modeEpoch,revision:receipt.revision,hash:receipt.hash});
    if(!snapshot)throw new ContentProposalConflict('conflict-snapshot');
    return {...scope,action:command.action,receipt,snapshot};
  }
  if(command.action==='sync-submit')return {...scope,action:command.action,receipt:await store.proposeAsync(user,resource,command.proposal,()=>{current();})};
  if(command.action==='sync-original')return {...scope,action:command.action,receipt:store.receipt(user,resource,command.id,command.generation,command.proposal.mutationId)??null};
  if(command.action==='sync-proposal-ack')return {...scope,action:command.action,
    binding:store.acknowledgeProposal(user,resource,command.id,command.generation,command.mutationId,command.hash)};
  if(command.action==='sync-projection-next')return {...scope,action:command.action,job:store.nextProjection(user,resource,command.id,command.generation,command.excluded)??null};
  const original=()=>store.originalProjection(user,resource,command.id,command.generation,command.jobId);
  original();
  if(command.action==='sync-projection-claim')return {...scope,action:command.action,...await store.claimProjectionAsync(user,resource,command.jobId,
    command.actualHash,command.pending,()=>{current();original();})};
  const job=store.acknowledgeProjection(user,resource,command.jobId,command.hash);
  if(job.bindingId!==command.id||job.generation!==command.generation)throw new ContentProposalConflict('projection-scope');
  return {...scope,action:command.action,job};
}
