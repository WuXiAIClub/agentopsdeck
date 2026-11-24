import {isDeepStrictEqual} from 'node:util';
import {sessionRuntimeId,validBoardUuid,validSessionTags} from '@agentopsdeck/shared';
import type {HubStore} from './hub-store.js';
import {ContentProposalConflict,type ContentBindingTarget} from './content-proposal-store.js';
import {contentBatchSelection,contentBatchSnapshot} from './content-batch-transactions.js';
import type {ContentBatch} from './workspace-content-batches.js';
import type {DelegationMember,DelegationSelection} from './workspace-delegation-preview.js';
import {decodeHubSessionId} from './session-id.js';
import {executeContentBinding,validContentBinding as validBinding,validContentBindingTarget,type ContentBindingResult} from './member-content-replica-domain.js';

type Fence={generation:number;preferencesRevision:number};
export type ContentBatchCatalog=Fence&{epoch:string;revision:number;sessions:string[]};
export type ContentBatchDirectory=Fence&{epoch:string;revision:number;connections:{id:string;nodeId:string;epoch:number}[]};
export type ContentBatchCommand=
  |{action:'batch-directory'}|{action:'batch-check';fence:Fence}
  |{action:'batch-prepare';id:string;selection:DelegationSelection;catalog:ContentBatchCatalog}
  |{action:'batch-confirm';id:string;catalog:ContentBatchCatalog}
  |{action:'batch-read'|'batch-cancel';id:string}
  |{action:'batch-settle'|'batch-cleanup-target'|'batch-cleanup-settle'|'batch-effect-check'|'batch-binding-prepare';id:string;memberId:string};
export type ContentBatchResult=
  |{action:'batch-directory';directory:ContentBatchDirectory}
  |{action:'batch-check';ok:true}
  |{action:'batch-prepare'|'batch-read'|'batch-cancel';batch:ContentBatch}
  |{action:'batch-confirm';batch:ContentBatch;claimed:boolean}
  |{action:'batch-settle'|'batch-cleanup-settle';batch:ContentBatch;memberId:string}
  |{action:'batch-effect-check';id:string;memberId:string;ok:true}
  |{action:'batch-cleanup-target';id:string;memberId:string;generation:string;target:ContentBindingTarget|null}
  |{action:'batch-binding-prepare';id:string;memberId:string;result:Extract<ContentBindingResult,{action:'binding-prepare'}>};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=2048&&v===v.trim()&&!/[\x00-\x1f\x7f]/.test(v);
const session=(v:unknown):v is string=>text(v)&&!!decodeHubSessionId(v);
const fence=(v:unknown)=>object(v)&&integer(v.generation)&&integer(v.preferencesRevision);
function catalog(v:unknown):v is ContentBatchCatalog {
  return fence(v)&&object(v)&&keys(v,['generation','preferencesRevision','epoch','revision','sessions'])&&validBoardUuid(v.epoch)&&integer(v.revision)
    &&Array.isArray(v.sessions)&&v.sessions.length<=10_000&&v.sessions.every(session)&&new Set(v.sessions).size===v.sessions.length;
}
function selection(v:unknown):v is DelegationSelection {try{contentBatchSelection(v as DelegationSelection);return true;}catch{return false;}}
export function validContentBatchCommand(v:Record<string,unknown>) {
  const exact=(...extra:string[])=>keys(v,['action','resourceId',...extra]);
  if(v.action==='batch-directory')return exact();
  if(v.action==='batch-check')return exact('fence')&&fence(v.fence)&&keys(v.fence as Record<string,unknown>,['generation','preferencesRevision']);
  if(!validBoardUuid(v.id))return false;
  if(v.action==='batch-read'||v.action==='batch-cancel')return exact('id');
  if(v.action==='batch-prepare')return exact('id','selection','catalog')&&selection(v.selection)&&catalog(v.catalog);
  if(v.action==='batch-confirm')return exact('id','catalog')&&catalog(v.catalog);
  return ['batch-settle','batch-cleanup-target','batch-cleanup-settle','batch-effect-check','batch-binding-prepare'].includes(String(v.action))&&exact('id','memberId')&&validBoardUuid(v.memberId);
}
function member(v:unknown):v is DelegationMember {
  if(!object(v)||!keys(v,['owner','nodeId','connectionId','runtime','sessionId','authorityEpoch','groupId','tags','taskBinding'])
    ||![v.owner,v.nodeId,v.connectionId,v.runtime].every(text)||!session(v.sessionId)||!integer(v.authorityEpoch)||v.authorityEpoch===0
    ||v.groupId!==null&&!text(v.groupId)||!validSessionTags(v.tags)||!['supported','unsupported','unknown'].includes(String(v.taskBinding)))return false;
  const decoded=decodeHubSessionId(v.sessionId)!;
  return decoded.connectionId===v.connectionId&&sessionRuntimeId(decoded.remoteSessionKey)===v.runtime;
}
export function validContentBatch(v:unknown):v is ContentBatch {
  return object(v)&&keys(v,['id','resource','epoch','revision','selection','fingerprint','expiresAt','state','members'])
    &&validBoardUuid(v.id)&&text(v.resource)&&validBoardUuid(v.epoch)&&integer(v.revision)&&selection(v.selection)
    &&typeof v.fingerprint==='string'&&/^[a-f0-9]{64}$/.test(v.fingerprint)&&integer(v.expiresAt)
    &&['prepared','confirmed','cancelled'].includes(String(v.state))&&Array.isArray(v.members)&&v.members.length>0&&v.members.length<=32
    &&new Set(v.members.map(m=>object(m)?m.id:null)).size===v.members.length&&v.members.every(m=>object(m)&&keys(m,['id','member','state'])
      &&validBoardUuid(m.id)&&member(m.member)&&['prepared','unknown','installed','cancelled','cleanup_pending'].includes(String(m.state)));
}
export function validContentBatchResult(v:Record<string,unknown>) {
  const exact=(...extra:string[])=>keys(v,['action','resourceId',...extra]);
  if(v.action==='batch-check')return exact('ok')&&v.ok===true;
  if(v.action==='batch-directory'){
    const d=v.directory;return exact('directory')&&fence(d)&&object(d)&&keys(d,['generation','preferencesRevision','epoch','revision','connections'])
      &&validBoardUuid(d.epoch)&&integer(d.revision)&&Array.isArray(d.connections)&&d.connections.length<=10_000
      &&new Set(d.connections.map(c=>object(c)?c.id:null)).size===d.connections.length&&d.connections.every(c=>object(c)
        &&keys(c,['id','nodeId','epoch'])&&text(c.id)&&text(c.nodeId)&&integer(c.epoch)&&c.epoch>0);
  }
  if(v.action==='batch-effect-check')return exact('id','memberId','ok')&&validBoardUuid(v.id)&&validBoardUuid(v.memberId)&&v.ok===true;
  if(v.action==='batch-cleanup-target')return exact('id','memberId','generation','target')&&validBoardUuid(v.id)&&validBoardUuid(v.memberId)
    &&validBoardUuid(v.generation)&&(v.target===null||validContentBindingTarget(v.target));
  if(v.action==='batch-binding-prepare')return exact('id','memberId','result')&&validBoardUuid(v.id)&&validBoardUuid(v.memberId)
    &&object(v.result)&&keys(v.result,['action','binding','created'])&&v.result.action==='binding-prepare'&&typeof v.result.created==='boolean'
    &&validBinding(v.result.binding)&&v.result.binding.id===v.memberId;
  if(!validContentBatch(v.batch)||v.batch.resource!==v.resourceId)return false;
  if(v.action==='batch-confirm')return exact('batch','claimed')&&typeof v.claimed==='boolean'&&(!v.claimed||v.batch.state==='confirmed'&&v.batch.members.every(m=>m.state==='unknown'));
  if(v.action==='batch-settle'||v.action==='batch-cleanup-settle')return exact('batch','memberId')&&validBoardUuid(v.memberId)&&v.batch.members.some(m=>m.id===v.memberId);
  return ['batch-prepare','batch-read','batch-cancel'].includes(String(v.action))&&exact('batch')&&(v.action!=='batch-cancel'||v.batch.state==='cancelled');
}
export function matchesContentBatchReply(c:ContentBatchCommand,r:ContentBatchResult) {
  if(c.action!==r.action)return false;
  if('batch'in r&&(!('id'in c)||c.id!==r.batch.id))return false;
  if('memberId'in r&&(!('memberId'in c)||c.memberId!==r.memberId))return false;
  if('id'in r&&(!('id'in c)||c.id!==r.id))return false;
  if(c.action==='batch-prepare'&&'batch'in r&&!isDeepStrictEqual(contentBatchSelection(c.selection),r.batch.selection))return false;
  return true;
}

/** Rebuild all local facts here. Catalog session IDs come only from the private
 * server-owned directory effect, never from HTTP. No owner/credentials/SQL DTO. */
export async function executeContentBatch(owner:HubStore,user:string,resource:string,command:ContentBatchCommand,check:()=>void):Promise<ContentBatchResult> {
  const content=owner.createContentDocumentStore(),versions=()=>owner.contentBatchFence(user);
  const localMember=(sessionId:string):DelegationMember=>{
    const decoded=decodeHubSessionId(sessionId),connection=decoded&&owner.getConnection(decoded.connectionId,user);
    const epoch=connection&&owner.connectionAuthority(connection.id,user),prefs=owner.workspace.get(user).sessions[sessionId];
    if(!decoded||!connection?.nodeId||connection.status==='disabled'||epoch===undefined)throw new ContentProposalConflict('batch-authority');
    return {owner:user,nodeId:connection.nodeId,connectionId:connection.id,runtime:sessionRuntimeId(decoded.remoteSessionKey),sessionId,
      authorityEpoch:epoch,groupId:prefs?.groupId??null,tags:[...(prefs?.tags??[])].sort(),taskBinding:'unknown'};
  };
  const checkFence=(expected:Fence)=>{check();if(!isDeepStrictEqual(versions(),{generation:expected.generation,preferencesRevision:expected.preferencesRevision}))throw new ContentProposalConflict('preview-changed-or-expired');};
  const store=owner.createContentBatchTransactions((_owner,_resource,snapshot)=>{
    checkFence(snapshot);const head=content.resource(user,resource);
    if(!head||head.epoch!==snapshot.epoch||head.revision!==snapshot.revision||snapshot.members.some(m=>!isDeepStrictEqual(localMember(m.sessionId),m)))
      throw new ContentProposalConflict('preview-changed-or-expired');
  });
  const snapshot=(catalog:ContentBatchCatalog,selection:DelegationSelection)=>{
    checkFence(catalog);const head=content.resource(user,resource);
    if(!head||head.epoch!==catalog.epoch||head.revision!==catalog.revision)throw new ContentProposalConflict('preview-changed-or-expired');
    const members=catalog.sessions.map(localMember),key=(m:DelegationMember)=>JSON.stringify([m.owner,m.nodeId,m.connectionId,m.runtime,m.sessionId]);
    members.sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0);
    return contentBatchSnapshot(head,{...catalog,members},selection);
  };
  check();
  if(command.action==='batch-check'){checkFence(command.fence);return {action:command.action,ok:true};}
  if(command.action==='batch-directory'){
    const head=content.resource(user,resource);if(!head)throw new ContentProposalConflict('shared-content-required');
    const connections=owner.listConnections(user).filter(c=>c.status!=='disabled').map(c=>{
      const epoch=owner.connectionAuthority(c.id,user);if(!c.nodeId||epoch===undefined)throw new ContentProposalConflict('batch-authority');
      return {id:c.id,nodeId:c.nodeId,epoch};
    }).sort((a,b)=>a.id.localeCompare(b.id));
    return {action:command.action,directory:{...versions(),epoch:head.epoch,revision:head.revision,connections}};
  }
  if(command.action==='batch-prepare'){
    const selection=contentBatchSelection(command.selection),prior=store.get(user,resource,command.id);
    if(prior){if(!isDeepStrictEqual(prior.selection,selection))throw new ContentProposalConflict('batch-reused');return {action:command.action,batch:prior};}
    return {action:command.action,batch:await store.prepare(user,resource,command.id,selection,snapshot(command.catalog,selection),check)};
  }
  if(command.action==='batch-cancel')return {action:command.action,batch:store.cancel(user,resource,command.id,check)};
  const batch=store.required(user,resource,command.id);
  if(command.action==='batch-read')return {action:command.action,batch};
  if(command.action==='batch-confirm')return {action:command.action,...(batch.state!=='prepared'?{batch,claimed:false}:await store.confirm(user,resource,command.id,snapshot(command.catalog,batch.selection),check))};
  if(command.action==='batch-settle')return {action:command.action,batch:store.settle(user,resource,command.id,command.memberId,check),memberId:command.memberId};
  if(command.action==='batch-cleanup-settle')return {action:command.action,batch:store.cleanupSettled(user,resource,command.id,command.memberId,check),memberId:command.memberId};
  if(!('memberId'in command))throw new ContentProposalConflict('batch-command');
  if(command.action==='batch-cleanup-target'){
    const member=batch.members.find(m=>m.id===command.memberId),binding=content.bindingRecord(user,resource,command.memberId);
    if(batch.state!=='cancelled'||member?.state!=='cleanup_pending'||!binding?.revoked)throw new ContentProposalConflict('batch-cleanup');
    const result=await executeContentBinding(owner,user,resource,{action:'binding-cleanup',id:member.id,generation:binding.generation},check);
    if(result.action!=='binding-cleanup')throw new ContentProposalConflict('batch-cleanup');
    return {action:command.action,id:command.id,memberId:member.id,generation:binding.generation,target:result.target};
  }
  const effectCheck=()=>{
    check();const current=store.required(user,resource,command.id),member=current.members.find(m=>m.id===command.memberId);
    if(current.state!=='confirmed'||Date.now()>=current.expiresAt||!member||!['unknown','installed'].includes(member.state)
      ||!sameAuthority(localMember(member.member.sessionId),member.member))throw new ContentProposalConflict('batch-revoked');
  };
  effectCheck();
  if(command.action==='batch-effect-check')return {action:command.action,id:command.id,memberId:command.memberId,ok:true};
  const member=batch.members.find(m=>m.id===command.memberId)!;
  const target=await executeContentBinding(owner,user,resource,{action:'binding-target',sessionId:member.member.sessionId},effectCheck);
  if(target.action!=='binding-target')throw new ContentProposalConflict('batch-authority');
  const result=await executeContentBinding(owner,user,resource,{action:'binding-prepare',id:member.id,target:target.target,epoch:batch.epoch,revision:batch.revision},effectCheck);
  if(result.action!=='binding-prepare')throw new ContentProposalConflict('batch-authority');
  return {action:command.action,id:command.id,memberId:command.memberId,result};
}

// Group/tag edits after confirmation do not revoke an already selected member.
// Preserve the original authority contract; preparation/claim still compare the
// complete catalog fingerprint, including all selection metadata.
function sameAuthority(a:DelegationMember,b:DelegationMember) {
  return a.owner===b.owner&&a.nodeId===b.nodeId&&a.connectionId===b.connectionId&&a.runtime===b.runtime
    &&a.sessionId===b.sessionId&&a.authorityEpoch===b.authorityEpoch;
}
