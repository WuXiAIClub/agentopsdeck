import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { WORKSPACE_FILE_CARD_MAX_BYTES, parseWorkspaceFileCardResource, validBoardUuid, type WorkspaceFileCard } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ContentProjection, ContentReceipt, ContentResource } from '../hub/content-proposal-store.js';
import { readJsonBody } from '../utils/http-body.js';
import { cardFileCodec } from './workspace-file-card-format.js';
import { FileBoardError, type ConnectorWorkspaceFiles } from './workspace-board-files.js';
import { ContentReplicaConflict, type WorkspaceContentReplica, type WorkspaceContentEffects, type ContentReplicaFilePort } from './workspace-content-replica.js';
import type { WorkspaceFileActor } from './connector-workspace-file-domain.js';
import type { WorkspaceFileHttpAuthority } from './workspace-board-files-http.js';
import {observeContentReplica} from '../diagnostics/content-replica.js';
import type {PerformanceDiagnostics} from '../diagnostics/performance.js';

/** Dedicated pull protocol. Owner comes exclusively from the authenticated
 * Connector token; body cannot select another owner, path, URL or session file.
 * No automatic polling, command dispatch or write retry is performed here. */
export function registerConnectorContentReplicas(app:Hono,deps:{tokens:ConnectorTokenStore;
  replicas:WorkspaceContentReplica<WorkspaceFileCard>;files:ConnectorWorkspaceFiles<WorkspaceFileCard>;
  available:()=>boolean;session:(key:string)=>Promise<{exists:boolean;ready:boolean}>;diagnostics?:PerformanceDiagnostics}) {
  return registerContentReplicaRoutes<string>(app,{...deps,authority:{authenticate:request=>{
    if(!deps.tokens.authenticate(request))return null;
    const principal=deps.tokens.requireScope(request,'boards:files');if(!principal)throw new HTTPException(403);
    return {id:principal.tokenId,actor:principal.tokenId};
  }}});
}
type ContentHttpDeps<Actor>={
  authority:Pick<WorkspaceFileHttpAuthority<Actor>,'authenticate'>;
  replicas:WorkspaceContentEffects<WorkspaceFileCard,Actor>;files:Pick<ContentReplicaFilePort<WorkspaceFileCard,Actor>,'get'>;
  available:()=>boolean;session:(key:string)=>Promise<{exists:boolean;ready:boolean}>;diagnostics?:PerformanceDiagnostics;
};
export function registerAsyncConnectorContentReplicas(app:Hono,deps:ContentHttpDeps<WorkspaceFileActor>){
  return registerContentReplicaRoutes(app,deps);
}
function registerContentReplicaRoutes<Actor>(app:Hono,deps:ContentHttpDeps<Actor>){
  const base='/api/connector/v1/workspace/content-replicas';
  const actor=async(c:Context)=>{
    const principal=await deps.authority.authenticate(c.req.raw);if(!principal)throw new HTTPException(401);
    if(c.req.url.includes('?'))throw new HTTPException(400);
    return {id:principal.id,actor:structuredClone(principal.actor)};
  };
  const safe=(step:number,work:(c:Context,owner:Actor,check:()=>Promise<void>)=>Promise<Response>|Response)=>async(c:Context)=>{
    c.header('Cache-Control','no-store');
    try{
      return await observeContentReplica('connector-content-replica-http',step,async()=>{
        const owner=await actor(c),check=async()=>{if((await actor(c)).id!==owner.id)throw new HTTPException(403);};
        const result=await work(c,owner.actor,check);await check();return result;
      },deps.diagnostics);
    }catch(error){
      const status=error instanceof HTTPException?error.status:error instanceof FileBoardError?error.status:
        error instanceof ContentReplicaConflict?409:503;
      return c.json({error:'content_replica_unavailable_inspect_original'},status);
    }
  };
  const id=(c:Context)=>{const value=c.req.param('id');if(!validBoardUuid(value))throw new HTTPException(400);return value;};
  const ready=async(key:string,check:()=>Promise<void>)=>{
    if(!deps.available())throw new HTTPException(503);
    const session=await deps.session(key);await check();
    if(!deps.available()||!session.ready)throw new HTTPException(503);
    if(!session.exists)throw new HTTPException(404);
  };
  const binding=async(c:Context,owner:Actor,check:()=>Promise<void>)=>{
    const bindingId=id(c),record=await deps.files.get(owner,bindingId);await check();
    await ready(record.sessionKey,check);return bindingId;
  };
  app.get(base,safe(1,c=>c.json({protocol:1,maxBindings:32,available:deps.available()})));
  app.put(`${base}/:id`,safe(2,async(c,owner,check)=>{
    const bindingId=id(c),body=await readJsonBody(c.req.raw,WORKSPACE_FILE_CARD_MAX_BYTES+8192) as {
      id:string;resource:string;generation:string;sessionKey:string;base:ContentResource};await check();
    if(!body||Object.keys(body).sort().join(',')!=='base,generation,id,resource,sessionKey'||body.id!==bindingId
      ||!validBoardUuid(body.generation)||typeof body.sessionKey!=='string'||!body.base)throw new HTTPException(400);
    const ref=parseWorkspaceFileCardResource(body.resource);if(!ref||ref.kind==='statuscard')throw new HTTPException(400);
    let value:unknown;try{value=JSON.parse(body.base.content);}catch{throw new HTTPException(400);}
    if(!cardFileCodec(ref.kind).valid(value))throw new HTTPException(400);
    await ready(body.sessionKey,check);
    return c.json(await deps.replicas.install(owner,body));
  }));
  app.get(`${base}/:id`,safe(3,async(c,owner)=>c.json(await deps.replicas.view(owner,id(c)))));
  app.delete(`${base}/:id`,safe(4,async(c,owner)=>{await deps.replicas.revoke(owner,id(c));return c.json({id:id(c),revoked:true});}));
  app.post(`${base}/:id/observe`,safe(5,async(c,owner,check)=>{
    const bindingId=await binding(c,owner,check);return c.json({proposal:await deps.replicas.observe(owner,bindingId)??null});
  }));
  app.post(`${base}/:id/resolve`,safe(6,async(c,owner,check)=>{
    const input=await readJsonBody(c.req.raw,WORKSPACE_FILE_CARD_MAX_BYTES+8192) as Parameters<WorkspaceContentReplica<WorkspaceFileCard>['resolve']>[2];await check();
    if(!input||Object.keys(input).sort().join(',')!=='base,conflictId,expectedHash,mutationId'
      ||!validBoardUuid(input.conflictId)||!validBoardUuid(input.mutationId)||!(/^[a-f0-9]{64}$/).test(input.expectedHash))throw new HTTPException(400);
    const bindingId=await binding(c,owner,check);
    return c.json(await deps.replicas.resolve(owner,bindingId,input));
  }));
  app.post(`${base}/:id/proposals/:mutation/claim`,safe(7,async(c,owner,check)=>{
    const bindingId=await binding(c,owner,check),mutation=c.req.param('mutation');if(!validBoardUuid(mutation))throw new HTTPException(400);
    return c.json(await deps.replicas.claimPublish(owner,bindingId,mutation));
  }));
  app.post(`${base}/:id/proposals/:mutation/receipt`,safe(8,async(c,owner,check)=>{
    const bindingId=id(c),mutation=c.req.param('mutation'),receipt=await readJsonBody(c.req.raw,2048) as ContentReceipt;await check();
    if(!validBoardUuid(mutation)||!receipt||Object.keys(receipt).sort().join(',')!=='fingerprint,hash,mutationId,revision,state'
      ||receipt.mutationId!==mutation||!['committed','conflict'].includes(receipt.state)||!Number.isSafeInteger(receipt.revision)
      ||receipt.revision<0||!(/^[a-f0-9]{64}$/).test(receipt.hash)||!(/^[a-f0-9]{64}$/).test(receipt.fingerprint))throw new HTTPException(400);
    return c.json(await deps.replicas.settle(owner,bindingId,mutation,receipt));
  }));
  // A POST query carries a potentially large immutable projection proof; it
  // remains read-only even when the original Connector intent never arrived.
  for(const operation of ['project','projection-receipt'] as const)app.post(`${base}/:id/${operation}`,safe(operation==='project'?9:10,async(c,owner,check)=>{
    const bindingId=id(c),job=await readJsonBody(c.req.raw,WORKSPACE_FILE_CARD_MAX_BYTES+8192) as ContentProjection;await check();
    if(!job||job.bindingId!==bindingId||!validBoardUuid(job.id)||!validBoardUuid(job.generation))throw new HTTPException(400);
    if(operation==='project')await binding(c,owner,check);
    return c.json(await (operation==='project'?deps.replicas.project(owner,bindingId,job):deps.replicas.projectionReceipt(owner,bindingId,job)));
  }));
}
