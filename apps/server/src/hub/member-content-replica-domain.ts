import { isDeepStrictEqual } from 'node:util';
import { validBoardUuid } from '@agentopsdeck/shared';
import type { HubStore } from './hub-store.js';
import { decodeHubSessionId } from './session-id.js';
import { ContentProposalConflict, type ContentBinding, type ContentBindingTarget, type ContentResource } from './content-proposal-store.js';
import { contentSnapshotRef, matchesContentSnapshot, validContentOverviewBinding } from './content-overview-domain.js';

/** Fixed binding transactions. Credentials, owner selection and network effects
 * are deliberately absent. The surrounding document domain owns fresh identity. */
export type ContentBindingCommand =
  | {action:'binding-target';sessionId:string}
  | {action:'binding-prepare';id:string;target:ContentBindingTarget;epoch:string;revision:number}
  | {action:'binding-current';id:string;generation?:string}
  | {action:'binding-lookup';id:string}
  | {action:'binding-ack';id:string;generation:string;proof:Pick<ContentResource,'epoch'|'revision'|'hash'>}
  | {action:'binding-revoke';id:string}
  | {action:'binding-cleanup';id:string;generation:string};
export type ContentBindingResult =
  | {action:'binding-target';target:ContentBindingTarget}
  | {action:'binding-prepare';binding:ContentBinding;created:boolean}
  | {action:'binding-current'|'binding-ack'|'binding-revoke';binding:ContentBinding}
  | {action:'binding-lookup';binding:ContentBinding|null}
  | {action:'binding-cleanup';id:string;generation:string;target:ContentBindingTarget|null};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const identity=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\u0000-\u001f\u007f]/.test(v);
const revision=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
export function validContentBindingTarget(v:unknown):v is ContentBindingTarget {
  if(!object(v)||!keys(v,['sessionId','connectionId','sessionKey','authority'])
    ||![v.sessionId,v.connectionId,v.sessionKey].every(identity)||!revision(v.authority))return false;
  const decoded=decodeHubSessionId(String(v.sessionId));
  return !!decoded&&decoded.connectionId===v.connectionId&&decoded.remoteSessionKey===v.sessionKey
    &&/^(codex|claude-code|ghcp):/.test(decoded.remoteSessionKey);
}
export function validContentBinding(v:unknown):v is ContentBinding {
  if(!object(v))return false;
  if(v.target!==undefined&&!validContentBindingTarget(v.target))return false;
  const {initial,...metadata}=v;
  if(initial===undefined)return validContentOverviewBinding(metadata);
  if(!object(initial)||!keys(initial,['epoch','revision','hash','content'])||typeof initial.content!=='string')return false;
  const ref=contentSnapshotRef(initial as ContentResource);
  return validContentOverviewBinding({...metadata,initial:ref})&&matchesContentSnapshot(ref,initial as ContentResource);
}
export function validContentBindingCommand(v:Record<string,unknown>) {
  const exact=(...extra:string[])=>keys(v,['action','resourceId',...extra]);
  if(v.action==='binding-target')return exact('sessionId')&&identity(v.sessionId)&&!!decodeHubSessionId(v.sessionId);
  if(!validBoardUuid(v.id))return false;
  if(v.action==='binding-prepare')return exact('id','target','epoch','revision')&&validContentBindingTarget(v.target)&&validBoardUuid(v.epoch)&&revision(v.revision);
  if(v.action==='binding-current')return exact('id',...(Object.hasOwn(v,'generation')?['generation']:[]))&&(v.generation===undefined||validBoardUuid(v.generation));
  if(v.action==='binding-revoke'||v.action==='binding-lookup')return exact('id');
  if(!validBoardUuid(v.generation))return false;
  if(v.action==='binding-cleanup')return exact('id','generation');
  return v.action==='binding-ack'&&exact('id','generation','proof')&&object(v.proof)&&keys(v.proof,['epoch','revision','hash'])
    &&validBoardUuid(v.proof.epoch)&&revision(v.proof.revision)&&typeof v.proof.hash==='string'&&/^[a-f0-9]{64}$/.test(v.proof.hash);
}
export function validContentBindingResult(v:Record<string,unknown>) {
  if(v.action==='binding-target')return keys(v,['action','resourceId','target'])&&validContentBindingTarget(v.target);
  if(v.action==='binding-cleanup')return keys(v,['action','resourceId','id','generation','target'])&&validBoardUuid(v.id)&&validBoardUuid(v.generation)
    &&(v.target===null||validContentBindingTarget(v.target));
  if(v.action==='binding-lookup')return keys(v,['action','resourceId','binding'])&&(v.binding===null||validContentBinding(v.binding));
  if(!['binding-prepare','binding-current','binding-ack','binding-revoke'].includes(String(v.action)))return false;
  return keys(v,['action','resourceId','binding',...(v.action==='binding-prepare'?['created']:[])])&&validContentBinding(v.binding)
    &&(v.action!=='binding-prepare'||typeof v.created==='boolean');
}
export function matchesContentBindingReply(command:ContentBindingCommand,result:ContentBindingResult) {
  if(command.action!==result.action)return false;
  if(result.action==='binding-target')return command.action==='binding-target'&&result.target.sessionId===command.sessionId;
  if(result.action==='binding-cleanup')return command.action==='binding-cleanup'&&command.id===result.id&&command.generation===result.generation;
  if(result.action==='binding-lookup')return command.action==='binding-lookup'&&(result.binding===null||result.binding.id===command.id&&!result.binding.revoked);
  if(!('id'in command)||command.id!==result.binding.id||'generation'in command&&command.generation!==undefined&&command.generation!==result.binding.generation)return false;
  if(command.action==='binding-prepare')return isDeepStrictEqual(command.target,result.binding.target)
    &&command.epoch===result.binding.initial?.epoch&&command.revision===result.binding.initial?.revision;
  if(command.action==='binding-revoke')return result.binding.revoked;
  if(command.action==='binding-ack')return !result.binding.revoked&&result.binding.initial?.epoch===command.proof.epoch
    &&result.binding.acknowledgedRevision===command.proof.revision&&result.binding.acknowledgedHash===command.proof.hash;
  return !result.binding.revoked;
}
function readTarget(owner:HubStore,user:string,sessionId:string):ContentBindingTarget {
  const decoded=decodeHubSessionId(sessionId);
  if(!decoded||!/^(codex|claude-code|ghcp):/.test(decoded.remoteSessionKey))throw new ContentProposalConflict('binding-target');
  const connection=owner.getConnection(decoded.connectionId,user),authority=owner.connectionAuthority(decoded.connectionId,user);
  if(!connection?.nodeId||connection.status==='disabled'||authority===undefined)throw new ContentProposalConflict('binding-authority');
  const target={sessionId,connectionId:decoded.connectionId,sessionKey:decoded.remoteSessionKey,authority};
  if(!validContentBindingTarget(target))throw new ContentProposalConflict('binding-target');
  return target;
}
/** Shared synchronous fence, including checks inside the original transaction. */
export function currentContentBinding(owner:HubStore,user:string,resource:string,id:string,generation:string|undefined,check:()=>void) {
  check();const binding=owner.createContentDocumentStore().bindingRecord(user,resource,id);
  if(!binding||binding.revoked||!binding.target||!binding.initial||generation!==undefined&&binding.generation!==generation)
    throw new ContentProposalConflict('binding-unavailable');
  if(!isDeepStrictEqual(binding.target,readTarget(owner,user,binding.target.sessionId))
    ||binding.authorityEpoch!==JSON.stringify([binding.target.connectionId,binding.target.authority]))throw new ContentProposalConflict('binding-authority');
  return binding;
}
export async function executeContentBinding(owner:HubStore,user:string,resource:string,command:ContentBindingCommand,check:()=>void):Promise<ContentBindingResult> {
  const store=owner.createContentDocumentStore();
  const target=(expected:ContentBindingTarget)=>{
    check();const current=readTarget(owner,user,expected.sessionId);
    if(!isDeepStrictEqual(expected,current))throw new ContentProposalConflict('binding-authority');
    return current;
  };
  const current=(id:string,generation?:string)=>{
    return currentContentBinding(owner,user,resource,id,generation,check);
  };
  check();
  if(command.action==='binding-target')return {action:command.action,target:readTarget(owner,user,command.sessionId)};
  if(command.action==='binding-current')return {action:command.action,binding:current(command.id,command.generation)};
  if(command.action==='binding-lookup')return {action:command.action,binding:store.bindingRecord(user,resource,command.id)?current(command.id):null};
  if(command.action==='binding-prepare') {
    target(command.target);
    const old=store.bindingRecord(user,resource,command.id);
    if(old){
      const binding=current(command.id);
      if(!isDeepStrictEqual(binding.target,command.target)||binding.initial?.epoch!==command.epoch||binding.initial.revision!==command.revision)
        throw new ContentProposalConflict('binding-reused');
      return {action:command.action,binding,created:false};
    }
    const binding=await store.bindAsync(user,resource,command.id,JSON.stringify([command.target.connectionId,command.target.authority]),{
      target:command.target,epoch:command.epoch,revision:command.revision},()=>{target(command.target);});
    return {action:command.action,binding,created:true};
  }
  if(command.action==='binding-ack') {
    current(command.id,command.generation);
    return {action:command.action,binding:store.acknowledgeInstallation(user,resource,command.id,command.generation,command.proof)};
  }
  if(command.action==='binding-revoke')return {action:command.action,binding:store.revoke(user,resource,command.id)};
  try {
    const binding=store.bindingRecord(user,resource,command.id);
    if(!binding?.revoked||binding.generation!==command.generation)throw new ContentProposalConflict('binding-unavailable');
    return {action:command.action,id:command.id,generation:command.generation,target:binding.target?target(binding.target):null};
  }
  catch(error) { check();if(error instanceof ContentProposalConflict)return {action:command.action,id:command.id,generation:command.generation,target:null};throw error; }
}
