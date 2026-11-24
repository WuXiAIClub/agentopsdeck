import { validBoardUuid, parseWorkspaceFileCardResource, type WorkspaceFileCard, WORKSPACE_FILE_CARD_MAX_BYTES } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { WorkspaceContentMetadata } from './workspace-content-metadata.js';
import { ContentReplicaConflict } from './workspace-content-metadata.js';
import { cardFileCodec } from './workspace-file-card-format.js';
import { FileBoardError } from './workspace-file-metadata.js';
import type { FileBoardPolicy } from './workspace-board-file-policy.js';
import { createWorkspaceFileAuthorizer, validConnectorWorkspaceFileInput, type WorkspaceFileActor,
  type WorkspaceFileToolPolicies } from './connector-workspace-file-domain.js';

const methods = {
  contentReplicaOwned:'owned', contentReplicaInstallation:'installation', contentReplicaPrepareInstallation:'prepareInstallation',
  contentReplicaInstalled:'installed', contentReplicaProposals:'proposals', contentReplicaClaim:'claim',
  contentReplicaSettle:'settle', contentReplicaResolution:'resolution', contentReplicaResolve:'resolve',
  contentReplicaObserve:'observe', contentReplicaProjection:'projection', contentReplicaPrepareProjection:'prepareProjection',
  contentReplicaProjected:'projected', contentReplicaRevoke:'revoke',
} as const;
export type ContentReplicaKind = keyof typeof methods;
type Journal = WorkspaceContentMetadata<WorkspaceFileCard>;
type Result<T> = {ok:true;value:T} | {ok:false;status:401|403|404|409|429|503};
export type ConnectorContentReplicaCommands = {
  [K in ContentReplicaKind]: Journal[typeof methods[K]] extends (owner:string,...args:infer A)=>infer R
    ? {input:{actor:WorkspaceFileActor;args:A};output:Result<Exclude<Awaited<R>,undefined> | (undefined extends Awaited<R> ? null : never)>} : never;
};
export const connectorContentReplicaSteps = Object.freeze({
  contentReplicaOwned:321, contentReplicaInstallation:322, contentReplicaPrepareInstallation:323,
  contentReplicaInstalled:324, contentReplicaProposals:325, contentReplicaClaim:326, contentReplicaSettle:327,
  contentReplicaResolution:328, contentReplicaResolve:329, contentReplicaObserve:330, contentReplicaProjection:331,
  contentReplicaPrepareProjection:332, contentReplicaProjected:333, contentReplicaRevoke:334,
});
export const isConnectorContentReplicaKind = (kind:string):kind is ContentReplicaKind => Object.hasOwn(methods,kind);
const record = (v:unknown,required:string[],optional:string[]=[]):v is Record<string,unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && required.every(k=>Object.hasOwn(v,k)) && Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const hash = (v:unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const identity = (v:unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v);
const revision = (v:unknown) => Number.isSafeInteger(v) && Number(v)>=0;
const text = (v:unknown) => typeof v === 'string' && Buffer.byteLength(v)<=WORKSPACE_FILE_CARD_MAX_BYTES;
const resource = (v:unknown) => record(v,['epoch','revision','hash','content']) && identity(v.epoch) && revision(v.revision) && hash(v.hash) && text(v.content);
const session = (v:unknown) => typeof v === 'string' && /^(codex|claude-code|ghcp):[^\s\u0000-\u001f]{1,512}$/.test(v);
const replica = (v:unknown) => record(v,['owner','id','resource','generation','sessionKey','base','initial','state'])
  && identity(v.owner) && validBoardUuid(v.id) && identity(v.resource) && identity(v.generation) && session(v.sessionKey)
  && resource(v.base) && resource(v.initial) && ['installing','ready','revoked'].includes(String(v.state));
const receipt = (v:unknown) => record(v,['mutationId','fingerprint','state','revision','hash']) && validBoardUuid(v.mutationId)
  && hash(v.fingerprint) && ['committed','conflict'].includes(String(v.state)) && revision(v.revision) && hash(v.hash);
const proposal = (v:unknown) => record(v,['bindingId','generation','mutationId','modeEpoch','baseRevision','baseHash','content'])
  && validBoardUuid(v.bindingId) && identity(v.generation) && validBoardUuid(v.mutationId) && identity(v.modeEpoch)
  && revision(v.baseRevision) && hash(v.baseHash) && text(v.content);
const local = (v:unknown) => record(v,['proposal','baseContent','state'],['receipt','resolvedBy']) && proposal(v.proposal)
  && text(v.baseContent) && ['prepared','unknown','committed','conflict'].includes(String(v.state))
  && (v.receipt===undefined||receipt(v.receipt)) && (v.resolvedBy===undefined||validBoardUuid(v.resolvedBy));
const resolution = (v:unknown) => record(v,['conflictId','mutationId','expectedHash','base']) && validBoardUuid(v.conflictId)
  && validBoardUuid(v.mutationId) && hash(v.expectedHash) && resource(v.base);
const snapshot = (v:unknown) => v===null || record(v,['hash','content']) && hash(v.hash) && text(v.content);
const job = (v:unknown) => record(v,['id','bindingId','generation','revision','hash','content','state','expectedHash'])
  && validBoardUuid(v.id) && validBoardUuid(v.bindingId) && identity(v.generation) && revision(v.revision)
  && hash(v.hash) && text(v.content) && v.state==='unknown' && hash(v.expectedHash);
const state = (v:unknown) => ['saved','conflict','uncertain'].includes(String(v));
class ContentAuthorityRequired extends Error {}
export function validConnectorContentReplicaInput(kind:ContentReplicaKind,v:unknown):boolean {
  if (!record(v,['actor','args']) || !validConnectorWorkspaceFileInput('workspaceFileGuard',
    {file:'card',actor:v.actor,sessionKey:'codex:validation'}) || !Array.isArray(v.args)) return false;
  const a=v.args;
  if (kind==='contentReplicaInstallation'||kind==='contentReplicaPrepareInstallation') {
    const i=a[0]; if(a.length!==1||!record(i,['id','resource','generation','sessionKey','base']))return false;
    const ref=typeof i.resource==='string'?parseWorkspaceFileCardResource(i.resource):null;
    if(!validBoardUuid(i.id)||!ref||ref.kind==='statuscard'||!validBoardUuid(i.generation)||!session(i.sessionKey)||!resource(i.base))return false;
    try{return cardFileCodec(ref.kind).valid(JSON.parse((i.base as {content:string}).content));}catch{return false;}
  }
  if(!validBoardUuid(a[0]))return false;
  switch(kind){
    case 'contentReplicaOwned':case 'contentReplicaProposals':case 'contentReplicaRevoke':return a.length===1;
    case 'contentReplicaInstalled':return a.length===2&&hash(a[1]);
    case 'contentReplicaClaim':return (a.length===2||a.length===3&&replica(a[2]))&&validBoardUuid(a[1]);
    case 'contentReplicaSettle':return a.length===3&&validBoardUuid(a[1])&&receipt(a[2]);
    case 'contentReplicaResolution':return a.length===2&&resolution(a[1]);
    case 'contentReplicaResolve':return a.length===5&&resolution(a[1])&&replica(a[2])&&local(a[3])&&snapshot(a[4]);
    case 'contentReplicaObserve':return a.length===3&&replica(a[1])&&snapshot(a[2]);
    case 'contentReplicaProjection':return a.length===2&&job(a[1]);
    case 'contentReplicaPrepareProjection':return a.length===3&&job(a[1])&&replica(a[2]);
    case 'contentReplicaProjected':return a.length===3&&job(a[1])&&state(a[2]);
  }
}
export function validConnectorContentReplicaOutput(kind:ContentReplicaKind,v:unknown):boolean {
  if(record(v,['ok','status'])&&v.ok===false)return [401,403,404,409,429,503].includes(Number(v.status));
  if(!record(v,['ok','value'])||v.ok!==true)return false;
  const x=v.value;
  switch(kind){
    case 'contentReplicaOwned':return replica(x);
    case 'contentReplicaInstallation':return record(x,['content'],['prior'])&&cardFileCodec().valid(x.content)&&(x.prior===undefined||replica(x.prior));
    case 'contentReplicaPrepareInstallation':case 'contentReplicaRevoke':return x===null;
    case 'contentReplicaInstalled':return resource(x);
    case 'contentReplicaProposals':return Array.isArray(x)&&x.length<=128&&x.every(local);
    case 'contentReplicaClaim':return record(x,['claimed','local'])&&typeof x.claimed==='boolean'&&local(x.local);
    case 'contentReplicaSettle':case 'contentReplicaResolve':return local(x);
    case 'contentReplicaObserve':return x===null||local(x);
    case 'contentReplicaResolution':return record(x,['replica','conflict'],['prior'])&&replica(x.replica)&&local(x.conflict)&&(x.prior===undefined||local(x.prior));
    case 'contentReplicaProjection':return record(x,['replica','fingerprint','existing'])&&replica(x.replica)&&hash(x.fingerprint)&&typeof x.existing==='boolean';
    case 'contentReplicaPrepareProjection':return record(x,['content'])&&cardFileCodec().valid(x.content);
    case 'contentReplicaProjected':return record(x,['id','state','hash'])&&validBoardUuid(x.id)&&state(x.state)&&(x.state==='saved'?hash(x.hash):x.hash===null);
  }
}

/** One journal on the original worker connection. No arbitrary SQL, functions,
 * file effects, identity caches or mutable actor closures cross this boundary. */
export function createConnectorContentReplicaCommands(owner:ConnectorUserStore,tokens?:ConnectorTokenStore,
  policy?:FileBoardPolicy,tools:WorkspaceFileToolPolicies={}) {
  const files=policy?owner.createWorkspaceFileMetadata(cardFileCodec(),createWorkspaceFileAuthorizer(owner,tokens,policy,tools)):undefined;
  const journal=files?owner.createWorkspaceContentMetadata(files):undefined;
  return async <K extends ContentReplicaKind>(kind:K,input:ConnectorContentReplicaCommands[K]['input']):Promise<ConnectorContentReplicaCommands[K]['output']>=>{
    try {
      if(!journal||!files||!validConnectorContentReplicaInput(kind,input))throw new FileBoardError(503);
      const {actor,args}=input;
      const authenticate=()=>{
        const principal=tokens?.authenticateAuthorization(actor.authorization);
        if(!principal)throw new ContentAuthorityRequired();
        if(principal.tokenId!==actor.tokenId||!principal.scopes.includes('boards:files'))throw new FileBoardError(403);
        return principal.tokenId;
      };
      const id=authenticate();
      const run=()=>{
        authenticate(); // AFTER physical admission, before original synchronous transactions.
        switch(kind){
          case 'contentReplicaOwned':return journal.owned(id,...args as Parameters<Journal['owned']> extends [string,...infer A]?A:never);
          case 'contentReplicaInstallation':{
            const plan=journal.installation(id,...args as Parameters<Journal['installation']> extends [string,...infer A]?A:never);
            return {...(plan.prior?{prior:plan.prior}:{}),content:plan.content};
          }
          case 'contentReplicaPrepareInstallation':return journal.prepareInstallation(id,...args as Parameters<Journal['prepareInstallation']> extends [string,...infer A]?A:never);
          case 'contentReplicaInstalled':return journal.installed(id,...args as Parameters<Journal['installed']> extends [string,...infer A]?A:never);
          case 'contentReplicaProposals':return journal.proposals(id,...args as Parameters<Journal['proposals']> extends [string,...infer A]?A:never);
          case 'contentReplicaClaim':return journal.claim(id,...args as Parameters<Journal['claim']> extends [string,...infer A]?A:never);
          case 'contentReplicaSettle':return journal.settle(id,...args as Parameters<Journal['settle']> extends [string,...infer A]?A:never);
          case 'contentReplicaResolution':{
            const plan=journal.resolution(id,...args as Parameters<Journal['resolution']> extends [string,...infer A]?A:never);
            return {replica:plan.replica,conflict:plan.conflict,...(plan.prior?{prior:plan.prior}:{})};
          }
          case 'contentReplicaResolve':return journal.resolve(id,...args as Parameters<Journal['resolve']> extends [string,...infer A]?A:never);
          case 'contentReplicaObserve':return journal.observe(id,...args as Parameters<Journal['observe']> extends [string,...infer A]?A:never);
          case 'contentReplicaProjection':return journal.projection(id,...args as Parameters<Journal['projection']> extends [string,...infer A]?A:never);
          case 'contentReplicaPrepareProjection':return journal.prepareProjection(id,...args as Parameters<Journal['prepareProjection']> extends [string,...infer A]?A:never);
          case 'contentReplicaProjected':{
            const [binding,projection,claimed]=args as Parameters<Journal['projected']> extends [string,...infer A]?A:never;
            const plan=journal.projection(id,binding,projection);
            let actual:'saved'|'conflict'|'uncertain'='uncertain';
            if(plan.existing){
              // Inspect the ORIGINAL immutable file intent, including fingerprint.
              // A different write reusing this mutation ID cannot prove success.
              const proof=files.writeIntent(id,binding,{mutationId:projection.id,expectedHash:projection.expectedHash!,content:JSON.parse(projection.content)});
              if(proof.existing)actual=proof.receipt.state;
            }
            if(actual!==claimed)throw new ContentReplicaConflict('projection-receipt');
            return journal.projected(id,binding,projection,actual);
          }
          case 'contentReplicaRevoke':return journal.revoke(id,...args as Parameters<Journal['revoke']> extends [string,...infer A]?A:never);
        }
      };
      let bytes=0;
      if(kind==='contentReplicaPrepareInstallation'||kind==='contentReplicaResolve'||kind==='contentReplicaObserve')bytes=16*1024*1024+65536;
      if(kind==='contentReplicaResolve')bytes=32*1024*1024+65536;
      if(kind==='contentReplicaPrepareProjection')bytes=65536;
      if(kind==='contentReplicaClaim'){
        const a=args as [string,string];
        if(journal.proposals(id,a[0]).find(p=>p.proposal.mutationId===a[1])?.state==='prepared')bytes=8*1024*1024+65536;
      }
      // run() may have an awaitable type because the compatibility journal also
      // supports admission. This instance deliberately has NO admission callback:
      // use a non-Promise container to keep the volume callback synchronous.
      const result=bytes?await owner.admitContentReplica(bytes,()=>({value:run()})):{value:run()};
      const value=await result.value;
      return {ok:true,value:value??null} as ConnectorContentReplicaCommands[K]['output'];
    }catch(error){
      const status=error instanceof ContentAuthorityRequired?401:error instanceof FileBoardError?error.status:error instanceof ContentReplicaConflict?409:503;
      return {ok:false,status} as ConnectorContentReplicaCommands[K]['output'];
    }
  };
}
