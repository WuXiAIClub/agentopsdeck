import { createHash } from 'node:crypto';
import { validBoardUuid, validWorkspaceFileCard, WORKSPACE_FILE_CARD_MAX_BYTES,
  type WorkspaceFileCard } from '@agentopsdeck/shared';
import { CONTENT_PROPOSAL_BYTE_LIMIT, ContentProposalConflict,
  type ContentBinding, type ContentResource } from './content-proposal-store.js';
import type { HubStore } from './hub-store.js';

/** Journal accounting counts already JSON-escaped payload BLOBs, not raw
 * content. An overview repeats no payload: one head and <=32 binding rows.
 * The envelope/native (unmigrated) branch fits the additional bounded space. */
export const CONTENT_OVERVIEW_RESPONSE_BYTES = CONTENT_PROPOSAL_BYTE_LIMIT + 128 * 1024;
export type ContentSnapshotRef = Pick<ContentResource, 'epoch'|'revision'|'hash'> & { bytes: number };
export type ContentOverviewBinding = Omit<ContentBinding,'initial'> & { initial?: ContentSnapshotRef };
export type ContentOverviewManifest = {
  head: ContentSnapshotRef|null;
  native: (WorkspaceFileCard & {revision:number})|null;
  bindings: ContentOverviewBinding[];
  responseBytes: number;
  /** Partial native read, never a replacement document or file export. */
  nativeView?: 'hot';
};
export type ContentOverviewCommand = {action:'overview';nativeView?:'hot'} | {action:'overview-snapshot'; snapshot:ContentSnapshotRef;
  source:'head'} | {action:'overview-snapshot'; snapshot:ContentSnapshotRef; source:'binding'; id:string; generation:string};
export type ContentOverviewResult = {action:'overview';manifest:ContentOverviewManifest}
  | {action:'overview-snapshot';snapshot:ContentResource};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const number=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const identity=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\u0000-\u001f\u007f]/.test(v);
/** Only one explicit read projection; no query-selected authority or mutation. */
export function contentOverviewView(url:string):'full'|'hot'|'invalid' {
  const query=[...new URL(url).searchParams];
  return !query.length?'full':query.length===1&&query[0]![0]==='view'&&query[0]![1]==='hot'?'hot':'invalid';
}
export function contentSnapshotRef(value:ContentResource):ContentSnapshotRef {
  return {epoch:value.epoch,revision:value.revision,hash:value.hash,bytes:Buffer.byteLength(JSON.stringify(value))};
}
export function validContentSnapshotRef(v:unknown):v is ContentSnapshotRef {
  return object(v)&&keys(v,['epoch','revision','hash','bytes'])&&validBoardUuid(v.epoch)&&number(v.revision)
    &&digest(v.hash)&&number(v.bytes)&&Number(v.bytes)>0&&Number(v.bytes)<=6*WORKSPACE_FILE_CARD_MAX_BYTES+1024;
}
export function matchesContentSnapshot(ref:ContentSnapshotRef,value:ContentResource) {
  return value.epoch===ref.epoch&&value.revision===ref.revision&&value.hash===ref.hash
    &&typeof value.content==='string'&&Buffer.byteLength(value.content)<=WORKSPACE_FILE_CARD_MAX_BYTES
    &&createHash('sha256').update(value.content).digest('hex')===ref.hash
    &&Buffer.byteLength(JSON.stringify(value))===ref.bytes;
}
export function validContentOverviewCommand(v:Record<string,unknown>) {
  if(v.action==='overview')return keys(v,['action','resourceId'])
    ||v.nativeView==='hot'&&keys(v,['action','resourceId','nativeView']);
  return v.action==='overview-snapshot'&&validContentSnapshotRef(v.snapshot)
    &&(v.source==='head'&&keys(v,['action','resourceId','source','snapshot'])
      ||v.source==='binding'&&keys(v,['action','resourceId','source','snapshot','id','generation'])&&validBoardUuid(v.id)&&validBoardUuid(v.generation));
}
export function validContentOverviewBinding(v:unknown):v is ContentOverviewBinding {
  if(!object(v)||Object.keys(v).some(k=>!['id','generation','authorityEpoch','revoked','acknowledgedRevision','acknowledgedHash','target','initial'].includes(k)))return false;
  if(!validBoardUuid(v.id)||!validBoardUuid(v.generation)||!identity(v.authorityEpoch)||typeof v.revoked!=='boolean'
    ||!Number.isSafeInteger(v.acknowledgedRevision)||Number(v.acknowledgedRevision)<-1
    ||!(v.acknowledgedHash===''&&v.acknowledgedRevision===-1||digest(v.acknowledgedHash)&&Number(v.acknowledgedRevision)>=0))return false;
  if(v.initial!==undefined&&!validContentSnapshotRef(v.initial))return false;
  if(v.target!==undefined&&(!object(v.target)||!keys(v.target,['sessionId','connectionId','sessionKey','authority'])
    ||![v.target.sessionId,v.target.connectionId,v.target.sessionKey].every(identity)||!number(v.target.authority)))return false;
  return true;
}
export function validContentOverviewManifest(v:unknown):v is ContentOverviewManifest {
  return object(v)&&(keys(v,['head','native','bindings','responseBytes'])
      ||v.nativeView==='hot'&&keys(v,['head','native','bindings','responseBytes','nativeView']))&&(v.head===null||validContentSnapshotRef(v.head))
    &&(v.native===null||v.head===null&&object(v.native)&&keys(v.native,['kind','content','revision'])
      &&validWorkspaceFileCard({kind:v.native.kind,content:v.native.content})&&number(v.native.revision))
    &&(v.nativeView!=='hot'||v.native===null||v.native.kind!=='notebook'||object(v.native.content)&&!Object.hasOwn(v.native.content,'archive'))
    &&Array.isArray(v.bindings)&&v.bindings.length<=32&&v.bindings.every(validContentOverviewBinding)
    &&new Set(v.bindings.map(b=>b.id)).size===v.bindings.length
    &&number(v.responseBytes)&&Number(v.responseBytes)>0&&Number(v.responseBytes)<=CONTENT_OVERVIEW_RESPONSE_BYTES
    &&v.responseBytes===contentOverviewResponseBytes(v as ContentOverviewManifest);
}
export function contentOverviewResponseBytes(v:Pick<ContentOverviewManifest,'head'|'native'|'bindings'|'nativeView'>) {
  return Buffer.byteLength(JSON.stringify({enabled:false,head:null,native:v.native,bindings:[],...(v.nativeView?{nativeView:v.nativeView}:{})}))
    +(v.head?v.head.bytes-4:0)+v.bindings.reduce((n,b,i)=>n+(i?1:0)
      +(b.initial?Buffer.byteLength(JSON.stringify({...b,initial:null}))-4+b.initial.bytes:Buffer.byteLength(JSON.stringify(b))),0);
}
/** Runs entirely within the original owner's same-read-view boundary. No
 * connection, caller owner, permission boolean, arbitrary SQL or network RPC. */
export function executeContentOverview(owner:HubStore,user:string,resource:string,command:ContentOverviewCommand,check:()=>void):ContentOverviewResult {
  return owner.readContentView(store=>{
    check();
    if(command.action==='overview') {
      const head=store.resource(user,resource)??null,native=head?null:owner.cardFileProjection.get(user,resource,command.nativeView)??null;
      // Count the exact original wire payload while retaining only metadata.
      // Iterator finishes before releasing the view; no transaction spans RPC.
      const view=command.nativeView?{nativeView:command.nativeView}:{};
      const manifest:ContentOverviewManifest={head:head?contentSnapshotRef(head):null,native,bindings:[],responseBytes:0,...view};
      let bytes=Buffer.byteLength(JSON.stringify({enabled:false,head,native,bindings:[],...view}));
      for(const binding of store.overviewBindings(user,resource)) {
        if(manifest.bindings.length>=32)throw new ContentProposalConflict('binding-capacity');
        bytes+=Buffer.byteLength(JSON.stringify(binding))+(manifest.bindings.length?1:0);
        const {initial,...metadata}=binding;
        manifest.bindings.push({...metadata,...(initial?{initial:contentSnapshotRef(initial)}:{})});
      }
      manifest.responseBytes=bytes;
      if(!validContentOverviewManifest(manifest))throw new ContentProposalConflict('overview-capacity');
      check();return {action:'overview',manifest};
    }
    const ref=command.snapshot;
    const snapshot=command.source==='head'?store.exactSnapshot(user,resource,ref)
      :store.originalBindingSnapshot(user,resource,command.id,command.generation);
    if(!snapshot||!matchesContentSnapshot(ref,snapshot))throw new ContentProposalConflict('overview-snapshot');
    check();return {action:'overview-snapshot',snapshot};
  });
}
