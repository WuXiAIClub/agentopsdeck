import { createHash } from 'node:crypto';
import { WORKSPACE_FILE_CARD_MAX_BYTES, validBoardUuid, validWorkspaceFileCardResource } from '@agentopsdeck/shared';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { ContentProposalConflict, type ContentResource, type ContentMigrationReceipt, type ContentMigrationTermination,
  type ContentReceipt, type ContentWriteTermination } from './content-proposal-store.js';
import { normalizeSharedContent, sharedContentResourceId } from './workspace-content-coordinator.js';
import { executeContentOverview, validContentOverviewCommand, validContentOverviewManifest, matchesContentSnapshot,
  type ContentOverviewCommand, type ContentOverviewResult } from './content-overview-domain.js';
import { executeContentBinding, validContentBindingCommand, validContentBindingResult, matchesContentBindingReply,
  type ContentBindingCommand, type ContentBindingResult } from './member-content-replica-domain.js';
import {executeContentSync,validContentSyncCommand,validContentSyncResult,matchesContentSyncReply,
  type ContentSyncCommand,type ContentSyncResult} from './member-content-sync-domain.js';
import {executeContentBatch,validContentBatchCommand,validContentBatchResult,matchesContentBatchReply,
  type ContentBatchCommand,type ContentBatchResult} from './member-content-batch-domain.js';

export const HUB_CONTENT_DOCUMENT_BYTES=2*WORKSPACE_FILE_CARD_MAX_BYTES+65536;
export const HUB_CONTENT_DOCUMENT_RESULT_BYTES=16*1024*1024;
export type HubContentDocumentCommand={resourceId:string}&(
  |{action:'check'}
  |{action:'migrate';revision:number;requestId:string}
  |{action:'migration-read';requestId:string}
  |{action:'migration-recover';requestId:string}
  |{action:'write';mutationId:string;modeEpoch:string;baseRevision:number;baseHash:string;content:string}
  |{action:'write-read';epoch:string;mutationId:string}
  |{action:'write-recover';epoch:string;mutationId:string}|ContentOverviewCommand|ContentBindingCommand|ContentSyncCommand|ContentBatchCommand);
export type HubContentDocumentResult=null|{error:404|409}|({resourceId:string}&(
  |{action:'check';ok:true}
  |{action:'migrate'|'migration-read'|'migration-recover';receipt:ContentMigrationReceipt|null;termination:ContentMigrationTermination|null}
  |{action:'write'|'write-read'|'write-recover';receipt:ContentReceipt|null;termination:ContentWriteTermination|null}|ContentOverviewResult|ContentBindingResult|ContentSyncResult|ContentBatchResult));
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const revision=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function validHubContentDocumentCommand(v:unknown):v is HubContentDocumentCommand {
  if(!object(v)||!validWorkspaceFileCardResource(v.resourceId))return false;
  const exact=(...extra:string[])=>keys(v,['action','resourceId',...extra]);
  if(typeof v.action==='string'&&v.action.startsWith('batch-'))return validContentBatchCommand(v);
  if(typeof v.action==='string'&&v.action.startsWith('binding-'))return validContentBindingCommand(v);
  if(typeof v.action==='string'&&v.action.startsWith('sync-'))return validContentSyncCommand(v);
  if(v.action==='overview'||v.action==='overview-snapshot')return validContentOverviewCommand(v);
  if(v.action==='check')return exact();
  if(v.action==='migrate')return exact('revision','requestId')&&revision(v.revision)&&validBoardUuid(v.requestId);
  if(v.action==='migration-read'||v.action==='migration-recover')return exact('requestId')&&validBoardUuid(v.requestId);
  if(v.action==='write-read'||v.action==='write-recover')return exact('epoch','mutationId')&&validBoardUuid(v.epoch)&&validBoardUuid(v.mutationId);
  return v.action==='write'&&exact('mutationId','modeEpoch','baseRevision','baseHash','content')
    &&validBoardUuid(v.mutationId)&&validBoardUuid(v.modeEpoch)&&revision(v.baseRevision)&&hash(v.baseHash)
    &&typeof v.content==='string'&&Buffer.byteLength(v.content)<=WORKSPACE_FILE_CARD_MAX_BYTES;
}
function resource(v:unknown):v is ContentResource {
  return object(v)&&keys(v,['epoch','revision','hash','content'])&&validBoardUuid(v.epoch)&&revision(v.revision)&&hash(v.hash)
    &&typeof v.content==='string'&&Buffer.byteLength(v.content)<=WORKSPACE_FILE_CARD_MAX_BYTES
    &&createHash('sha256').update(v.content).digest('hex')===v.hash;
}
function receipt(v:unknown):v is ContentReceipt {
  return object(v)&&keys(v,['mutationId','fingerprint','state','revision','hash'])&&validBoardUuid(v.mutationId)
    &&hash(v.fingerprint)&&(v.state==='committed'||v.state==='conflict')&&revision(v.revision)&&hash(v.hash);
}
export function validHubContentDocumentResult(v:unknown):v is HubContentDocumentResult {
  if(v===null)return true;
  if(!object(v))return false;
  if('error'in v)return keys(v,['error'])&&(v.error===404||v.error===409);
  if(!validWorkspaceFileCardResource(v.resourceId)||sharedContentResourceId(v.resourceId)!==v.resourceId)return false;
  if(typeof v.action==='string'&&v.action.startsWith('batch-'))return validContentBatchResult(v);
  if(typeof v.action==='string'&&v.action.startsWith('binding-'))return validContentBindingResult(v);
  if(typeof v.action==='string'&&v.action.startsWith('sync-'))return validContentSyncResult(v);
  if(v.action==='check')return keys(v,['action','resourceId','ok'])&&v.ok===true;
  if(v.action==='overview')return keys(v,['action','resourceId','manifest'])&&validContentOverviewManifest(v.manifest);
  if(v.action==='overview-snapshot')return keys(v,['action','resourceId','snapshot'])&&resource(v.snapshot);
  if(!keys(v,['action','resourceId','receipt','termination'])||(v.receipt!==null&&v.termination!==null))return false;
  if(['migrate','migration-read','migration-recover'].includes(String(v.action))) {
    if(v.action==='migrate'&&v.receipt===null)return false;
    return (v.receipt===null||object(v.receipt)&&keys(v.receipt,['mutationId','resource','nativeRevision','result'])
      &&validBoardUuid(v.receipt.mutationId)&&v.receipt.resource===v.resourceId&&revision(v.receipt.nativeRevision)&&resource(v.receipt.result))
      &&(v.termination===null||object(v.termination)&&keys(v.termination,['mutationId','resource','state'])
        &&validBoardUuid(v.termination.mutationId)&&v.termination.resource===v.resourceId&&v.termination.state==='not-executed');
  }
  if(!['write','write-read','write-recover'].includes(String(v.action))||v.action==='write'&&v.receipt===null)return false;
  return (v.receipt===null||receipt(v.receipt))&&(v.termination===null||object(v.termination)
    &&keys(v.termination,['mutationId','resource','epoch','state'])&&validBoardUuid(v.termination.mutationId)
    &&v.termination.resource===v.resourceId&&validBoardUuid(v.termination.epoch)&&v.termination.state==='not-executed');
}
export function validHubContentDocumentReply(command:HubContentDocumentCommand,v:unknown):v is HubContentDocumentResult {
  if(!validHubContentDocumentResult(v))return false;
  if(v===null||'error'in v)return true;
  if(v.action!==command.action||v.resourceId!==sharedContentResourceId(command.resourceId))return false;
  if(v.action.startsWith('batch-'))return matchesContentBatchReply(command as ContentBatchCommand,v as ContentBatchResult);
  if('id'in v&&'generation'in v&&v.action.startsWith('sync-'))return matchesContentSyncReply(command as ContentSyncCommand,v as ContentSyncResult,v.resourceId);
  if(v.action.startsWith('binding-'))return matchesContentBindingReply(command as ContentBindingCommand,v as ContentBindingResult);
  if(v.action==='check')return true;
  if(v.action==='overview')return command.action==='overview'&&v.manifest.nativeView===command.nativeView;
  if(v.action==='overview-snapshot')return command.action==='overview-snapshot'&&matchesContentSnapshot(command.snapshot,v.snapshot);
  if(!('receipt'in v)||!('termination'in v))return false;
  const id='requestId'in command?command.requestId:'mutationId'in command?command.mutationId:undefined;
  if(v.receipt&&v.receipt.mutationId!==id||v.termination&&v.termination.mutationId!==id)return false;
  if(v.termination&&'epoch'in v.termination&&(!('epoch'in command)||command.epoch!==v.termination.epoch))return false;
  if(command.action==='migrate'&&v.receipt&&'nativeRevision'in v.receipt&&v.receipt.nativeRevision!==command.revision)return false;
  if(command.action==='write'&&v.receipt&&'fingerprint'in v.receipt){
    try {
      const content=normalizeSharedContent(command.content,v.resourceId);
      if(v.receipt.fingerprint!==createHash('sha256').update(JSON.stringify([command.modeEpoch,command.baseRevision,command.baseHash,content])).digest('hex'))return false;
    }catch{return false;}
  }
  return true;
}
class Denied extends Error {}
function batchCommand(command:HubContentDocumentCommand):command is {resourceId:string}&ContentBatchCommand {
  return command.action.startsWith('batch-');
}
/** Never wrap in an outer savepoint. The original store rechecks fresh inside
 * its root transaction, AFTER physical volume admission may have waited. */
export async function executeHubContentDocument(owner:HubStore,actor:HubPrincipal,fresh:()=>HubPrincipal|undefined,
  command:HubContentDocumentCommand):Promise<HubContentDocumentResult> {
  if(!validHubContentDocumentCommand(command))throw Error('hub_content_document_unavailable');
  const user=actor.userId,resourceId=sharedContentResourceId(command.resourceId),store=owner.createContentDocumentStore();
  const check=()=>{if(fresh()?.userId!==user)throw new Denied();};
  try {
    check();
    if(batchCommand(command))return {resourceId,...await executeContentBatch(owner,user,resourceId,command,check)};
    if(command.action==='sync-submit'||command.action==='sync-original'||command.action==='sync-conflict-proof'||command.action==='sync-proposal-ack'
      ||command.action==='sync-resolution-claim'||command.action==='sync-resolution-ack'
      ||command.action==='sync-projection-next'||command.action==='sync-projection-claim'||command.action==='sync-projection-ack')
      return {resourceId,...await executeContentSync(owner,user,resourceId,command,check)};
    if(command.action==='check')return {action:'check',resourceId,ok:true};
    if(command.action==='binding-target'||command.action==='binding-prepare'||command.action==='binding-current'
      ||command.action==='binding-ack'||command.action==='binding-revoke'||command.action==='binding-cleanup'||command.action==='binding-lookup')
      return {resourceId,...await executeContentBinding(owner,user,resourceId,command,check)};
    if(command.action==='overview'||command.action==='overview-snapshot')return {resourceId,...executeContentOverview(owner,user,resourceId,command,check)};
    if(command.action==='migrate')return {action:command.action,resourceId,termination:null,
      receipt:await store.migrateNativeRequestAsync(user,resourceId,command.revision,command.requestId,owner.cardFileProjection,check)};
    if(command.action==='migration-read') {
      const receipt=store.migration(user,command.requestId)??null,termination=store.migrationTermination(user,command.requestId)??null;
      if(receipt&&receipt.resource!==resourceId||termination&&termination.resource!==resourceId)return {error:404};
      return {action:command.action,resourceId,receipt,termination};
    }
    if(command.action==='migration-recover')return {action:command.action,resourceId,...await store.recoverMigrationAsync(user,resourceId,command.requestId,check)};
    if(command.action==='write')return {action:command.action,resourceId,termination:null,receipt:await store.writeAsync(user,resourceId,{
      mutationId:command.mutationId,modeEpoch:command.modeEpoch,baseRevision:command.baseRevision,baseHash:command.baseHash,content:command.content},check)};
    if(command.action==='write-read')return {action:command.action,resourceId,
      receipt:store.ownerReceipt(user,resourceId,command.epoch,command.mutationId)??null,
      termination:store.writeTermination(user,resourceId,command.epoch,command.mutationId)??null};
    return {action:command.action,resourceId,...await store.recoverWriteAsync(user,resourceId,command.epoch,command.mutationId,check)};
  } catch(error) {
    if(error instanceof Denied)return null;
    if(error instanceof ContentProposalConflict)return {error:409};
    throw error;
  }
}
