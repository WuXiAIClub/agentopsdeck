import { BOARD_MAX_BODY_BYTES, validBoardContent, validBoardId, validBoardUuid } from '@agentopsdeck/shared';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import type { TaskSessionIntent, TaskSessionReceipt } from './task-session-workflow.js';
import type { HubBoardBindingCredential } from './member-board-binding-domain.js';
import { parseBoardAgentEndpoint } from './workspace-board-bindings.js';
import { decodeHubSessionId } from './session-id.js';
import { validBoardToolCredential } from '../tools/workspace-board-cli.js';

export type TaskSessionPreview = { requestId:string; connectionId:string; runtime:string; title:string; model:string;
  taskIds:string[]; fields:('status'|'detail')[]; expiresAt:number };
export type TaskSessionRemote = { ready:boolean; runtime:string; sessionId:string; binding:null | {
  id:string; runtime:string; sessionId:string; state:string; expiresAt:number } };
type Base = { boardId:string; id:string };
export type HubTaskSessionCommand = { action:'prepare'; boardId:string; input:TaskSessionPreview; endpoint:string }
  | (Base & ({ [A in 'read'|'selection'|'claim'|'cancelPrepared'|'cancel']:{action:A} }['read'|'selection'|'claim'|'cancelPrepared'|'cancel']
    | { action:'bindingClaim'; endpoint:string }
    | { action:'creation'; outcome:{ requestId:string; state:'created'; sessionId:string } | { requestId:string; state:'rejected'|'unknown' } }
    | { action:'binding'; remote:TaskSessionRemote }));
export type HubTaskSessionResult = null | { error:403|404|409|429 }
  | { [A in 'prepare'|'read'|'selection'|'cancelPrepared'|'cancel'|'creation'|'binding']: { action:A; receipt:TaskSessionReceipt|null } }['prepare'|'read'|'selection'|'cancelPrepared'|'cancel'|'creation'|'binding']
  | { action:'claim'; claimed:boolean; receipt:TaskSessionReceipt }
  | { action:'bindingClaim'; claimed:boolean; receipt:TaskSessionReceipt; credential:HubBoardBindingCredential|null };
// A frozen selection can contain the original board's fully escaped content.
// Do not strand a legitimate large receipt at the worker delivery boundary.
export const HUB_TASK_SESSION_BYTES = BOARD_MAX_BODY_BYTES + 16_384;
const object = (v:unknown):v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v:Record<string,unknown>,names:string[]) => Object.keys(v).length === names.length && names.every(n=>Object.hasOwn(v,n));
const text = (v:unknown,max=512):v is string => typeof v === 'string' && v.length>0 && v.length<=max && v===v.trim() && !/[\x00-\x1f\x7f]/.test(v);
const integer = (v:unknown):v is number => Number.isSafeInteger(v) && Number(v)>=0;
const runtime = (v:unknown):v is string => ['codex','claude-code','ghcp'].includes(String(v));
function endpoint(v:unknown):v is string { try { return typeof v==='string' && v.length<=8192 && parseBoardAgentEndpoint(v)===v; } catch { return false; } }
function grant(v:Record<string,unknown>) { return Array.isArray(v.fields) && v.fields.length>0 && v.fields.length<=2
  && new Set(v.fields).size===v.fields.length && v.fields.every(f=>f==='status'||f==='detail') && integer(v.expiresAt); }
export function validTaskSessionPreview(v:unknown):v is TaskSessionPreview {
  return object(v) && fields(v,['requestId','connectionId','runtime','title','model','taskIds','fields','expiresAt'])
    && validBoardUuid(v.requestId) && text(v.connectionId) && runtime(v.runtime) && text(v.title,120) && text(v.model,256)
    && Array.isArray(v.taskIds) && v.taskIds.length>0 && v.taskIds.length<=32 && v.taskIds.every(validBoardUuid)
    && new Set(v.taskIds).size===v.taskIds.length && grant(v);
}
export function validTaskSessionRemote(v:unknown):v is TaskSessionRemote {
  // Connector responses can carry compatible extension fields; none cross RPC.
  return object(v) && typeof v.ready==='boolean' && runtime(v.runtime) && validBoardUuid(v.sessionId)
    && (v.binding===null || object(v.binding) && validBoardUuid(v.binding.id) && v.binding.runtime===v.runtime
      && v.binding.sessionId===v.sessionId && text(v.binding.state,64) && integer(v.binding.expiresAt));
}
export function validTaskSessionReceipt(v:unknown):v is TaskSessionReceipt {
  if(!object(v)||!fields(v,['intent','fingerprint','creationRequestId','bindingRequestId','state','sessionId','bindingId'])||!object(v.intent))return false;
  const i=v.intent, names=['owner','requestId','nodeId','connectionId','runtime','authorityEpoch','boardId','boardRevision','title','tasks','fields','expiresAt'];
  if(i.model!==undefined)names.push('model');
  return fields(i,names) && [i.owner,i.nodeId,i.connectionId,i.runtime].every(x=>text(x)) && validBoardUuid(i.requestId)
    && validBoardId(i.boardId) && integer(i.authorityEpoch) && integer(i.boardRevision) && grant(i)
    && (i.model===undefined||text(i.model,256)) && validBoardContent({title:i.title,tasks:i.tasks})
    && Array.isArray(i.tasks) && i.tasks.length>0 && i.tasks.length<=32
    && typeof v.fingerprint==='string' && /^[a-f0-9]{64}$/.test(v.fingerprint)
    && validBoardUuid(v.creationRequestId) && validBoardUuid(v.bindingRequestId) && v.creationRequestId!==v.bindingRequestId
    && ['prepared','creation_unknown','creation_rejected','created','binding_unknown','binding_rejected','bound','cancelled'].includes(String(v.state))
    && (v.sessionId===null||text(v.sessionId,2048)) && (v.bindingId===null||validBoardUuid(v.bindingId));
}
export function validHubTaskSessionCommand(v:unknown):v is HubTaskSessionCommand {
  if(!object(v)||!validBoardId(v.boardId))return false;
  if(v.action==='prepare')return fields(v,['action','boardId','input','endpoint'])&&validTaskSessionPreview(v.input)&&endpoint(v.endpoint);
  if(!validBoardUuid(v.id))return false;
  switch(v.action){
    case 'read':case 'selection':case 'claim':case 'cancelPrepared':case 'cancel':return fields(v,['action','boardId','id']);
    case 'bindingClaim':return fields(v,['action','boardId','id','endpoint'])&&endpoint(v.endpoint);
    case 'binding':return fields(v,['action','boardId','id','remote'])&&validTaskSessionRemote(v.remote)
      && fields(v.remote,['ready','runtime','sessionId','binding']) && (v.remote.binding===null||fields(v.remote.binding,['id','runtime','sessionId','state','expiresAt']));
    case 'creation':return fields(v,['action','boardId','id','outcome'])&&object(v.outcome)&&validBoardUuid(v.outcome.requestId)
      && (v.outcome.state==='created'?fields(v.outcome,['requestId','state','sessionId'])&&text(v.outcome.sessionId,2048)
        :fields(v.outcome,['requestId','state'])&&['unknown','rejected'].includes(String(v.outcome.state)));
    default:return false;
  }
}
export function validHubTaskSessionResult(v:unknown):v is HubTaskSessionResult {
  if(v===null)return true;if(!object(v))return false;
  if('error'in v)return fields(v,['error'])&&typeof v.error==='number'&&[403,404,409,429].includes(v.error);
  if(v.action==='claim'||v.action==='bindingClaim'){
    if(!fields(v,v.action==='claim'?['action','claimed','receipt']:['action','claimed','receipt','credential'])
      ||typeof v.claimed!=='boolean'||!validTaskSessionReceipt(v.receipt))return false;
    if(v.action==='claim')return !v.claimed||v.receipt.state==='creation_unknown';
    return (!v.claimed&&v.credential===null||v.claimed&&v.receipt.state==='binding_unknown'&&validBoardToolCredential(v.credential)
      && v.credential.expiresAt===v.receipt.intent.expiresAt);
  }
  return ['prepare','read','selection','cancelPrepared','cancel','creation','binding'].includes(String(v.action))
    &&fields(v,['action','receipt'])&&(v.receipt===null||validTaskSessionReceipt(v.receipt));
}

/** Proof verifier participates in workflow's own COMMIT, never an outer
 * savepoint. Only this fixed domain supplies participants, not worker callers. */
export function executeHubTaskSession(owner:HubStore,actor:HubPrincipal,fresh:()=>HubPrincipal|undefined,command:HubTaskSessionCommand):HubTaskSessionResult {
  const user=actor.userId, workflows=owner.taskSessions;
  const proof=()=>{const now=fresh();if(!now||now.userId!==user||now.admin!==actor.admin)throw Error('workflow-forbidden');};
  const original=()=>{
    proof();if(command.action==='prepare')throw Error('workflow-input');
    const r=workflows.read(user,command.id);if(r&&r.intent.boardId!==command.boardId)throw Error('workflow-unavailable');return r;
  };
  const required=()=>{const r=original();if(!r)throw Error('workflow-unavailable');return r;};
  const selection=(r:{intent:TaskSessionIntent})=>{
    const i=r.intent,b=owner.boards.get(user,i.boardId);
    if(!owner.boardBindings.enabled||owner.boards.fileManaged(user,i.boardId)||b.revision!==i.boardRevision||i.expiresAt<=Date.now()
      ||i.tasks.some(task=>JSON.stringify(b.tasks.find(t=>t.id===task.id))!==JSON.stringify(task)))throw Error('workflow-selection');
  };
  try{
    proof();
    if(command.action==='prepare'){
      const b=command.input;
      if(b.expiresAt<=Date.now()||b.expiresAt>Date.now()+86400000)throw Error('workflow-input');
      const connection=owner.getConnection(b.connectionId,user),epoch=owner.connectionAuthority(b.connectionId,user);
      if(!connection?.nodeId||connection.status==='disabled'||epoch===undefined)throw Error('workflow-unavailable');
      const board=owner.boards.get(user,command.boardId),tasks=board.tasks.filter(t=>b.taskIds.includes(t.id));
      if(tasks.length!==b.taskIds.length)throw Error('workflow-selection');
      const intent:TaskSessionIntent={owner:user,requestId:b.requestId,nodeId:connection.nodeId,connectionId:b.connectionId,runtime:b.runtime,authorityEpoch:epoch,
        boardId:command.boardId,boardRevision:board.revision,title:b.title,model:b.model,tasks,fields:b.fields,expiresAt:b.expiresAt};
      const receipt=workflows.prepare(intent,()=>{proof();selection({intent});});
      return {action:'prepare',receipt};
    }
    if(command.action==='cancel')return {action:'cancel',receipt:workflows.cancel(user,command.id,()=>{original();})};
    if(command.action==='cancelPrepared')return {action:'cancelPrepared',receipt:workflows.cancelPrepared(user,command.id,()=>{required();})};
    if(command.action==='read'||command.action==='selection'){
      const receipt=workflows.read(user,command.id,()=>{const r=required();if(command.action==='selection')selection(r);});
      return {action:command.action,receipt:receipt!};
    }
    if(command.action==='claim')return {action:'claim',...workflows.claim(user,command.id,'create',()=>{selection(required());})};
    if(command.action==='bindingClaim'){
      let credential:HubBoardBindingCredential|null=null;
      const result=workflows.claim(user,command.id,'bind',()=>{selection(required());},r=>{
        if(!r.sessionId)throw Error('workflow-receipt');
        const i=r.intent,local=owner.boardBindings.prepare(user,i.boardId,{requestId:r.bindingRequestId,sessionId:r.sessionId,
          grant:{taskIds:i.tasks.map(t=>t.id),fields:i.fields,expiresAt:i.expiresAt}},i.connectionId,i.authorityEpoch,command.endpoint);
        if(!local||local.state!=='prepared')throw Error('workflow-selection');
        credential=owner.boardBindings.credential(user,i.boardId,r.bindingRequestId)??null;
        if(!credential)throw Error('workflow-selection');
        owner.boardBindings.outcome(user,i.boardId,r.bindingRequestId,'uncertain',true);
      });
      return {action:'bindingClaim',...result,credential};
    }
    const r=required(),i=r.intent;
    if(command.action==='creation'){
      const o=command.outcome,s=o.state==='created'?decodeHubSessionId(o.sessionId):undefined;
      if(o.state==='created'&&(!s||s.connectionId!==i.connectionId||!s.remoteSessionKey.startsWith(i.runtime+':')))throw Error('workflow-receipt');
      return {action:'creation',receipt:workflows.recordCreation(user,command.id,o,()=>{required();})};
    }
    const remote=command.remote,local=owner.boardBindings.get(user,i.boardId,r.bindingRequestId);
    const session=decodeHubSessionId(r.sessionId??'');
    if(remote.runtime!==i.runtime||session?.remoteSessionKey!==`${remote.runtime}:${remote.sessionId}`||!local||remote.binding?.id!==r.bindingRequestId||remote.binding.state!=='installed'
      ||remote.binding.expiresAt!==i.expiresAt||['revoked','expired','unavailable'].includes(local.state))return {action:'binding',receipt:r};
    return {action:'binding',receipt:workflows.recordBinding(user,command.id,{requestId:r.bindingRequestId,state:'bound',bindingId:r.bindingRequestId,sessionId:r.sessionId!},()=>{
      required();owner.boardBindings.outcome(user,i.boardId,r.bindingRequestId,'installed',true);
    })};
  }catch(error){
    // Fixed failures only; owner/SQL faults escape to the owner fence.
    if(error instanceof Error){
      if(error.message==='workflow-forbidden')return {error:403};
      if(error.message==='workflow-unavailable')return {error:404};
      if(error.message==='workflow-capacity')return {error:429};
      if(['workflow-input','workflow-model','workflow-scope','workflow-cancelled','workflow-request-reused','workflow-selection','workflow-receipt','workflow-not-dispatched','workflow-already-dispatched'].includes(error.message))return {error:409};
    }
    throw error;
  }
}
