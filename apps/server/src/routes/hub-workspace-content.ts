import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { WORKSPACE_FILE_CARD_MAX_BYTES, validBoardUuid, validWorkspaceFileCardResource } from '@agentopsdeck/shared';
import type { HubPrincipal } from '../hub/identity.js';
import type { WorkspaceContentCoordinator } from '../hub/workspace-content-coordinator.js';
import { ContentProposalConflict } from '../hub/content-proposal-store.js';
import { readJsonBody } from '../utils/http-body.js';
import type { WorkspaceContentBatches } from '../hub/workspace-content-batches.js';
import type { DelegationSelection } from '../hub/workspace-delegation-preview.js';
import { contentOverviewView } from '../hub/content-overview-domain.js';

/** Owner-only control plane; card/session content never selects its authority.
 * Installing a file does not send a message or start an agent. Unknown mutations
 * have separate original-receipt reads; none of these reads redispatch work. */
export function registerHubWorkspaceContent(app:Hono,deps:{
  coordinator:WorkspaceContentCoordinator;principal:(c:Context)=>HubPrincipal;
  native:(owner:string,resource:string)=>unknown;enabled:()=>boolean;
  batches?:WorkspaceContentBatches;
  asyncDocuments?:boolean;
  asyncOverview?:boolean;
  asyncBindings?:boolean;
  asyncBatches?:boolean;
}) {
  const base='/api/hub/v1/workspace/shared-content/:resourceId',coordinator=deps.coordinator;
  const safe=(work:(c:Context,owner:string,resource:string,check:()=>void)=>Promise<Response>|Response,overview=false)=>async(c:Context)=>{
    c.header('Cache-Control','no-store');
    try {
      const owner=deps.principal(c).userId,raw=c.req.param('resourceId');
      if(!validWorkspaceFileCardResource(raw)||(overview?contentOverviewView(c.req.url)==='invalid':c.req.url.includes('?')))throw new HTTPException(400);
      const resource=coordinator.resourceId(raw),check=()=>{if(deps.principal(c).userId!==owner)throw new HTTPException(401);};
      const result=await work(c,owner,resource,check);check();return result;
    }catch(error){
      const status=error instanceof HTTPException?error.status:error instanceof ContentProposalConflict?409:503;
      return c.json({error:'shared_content_unavailable_inspect_original'},status);
    }
  };
  const fresh=()=>{if(!deps.enabled())throw new HTTPException(503);};
  const bindingId=(c:Context)=>{const id=c.req.param('bindingId');if(!validBoardUuid(id))throw new HTTPException(400);return id;};
  const body=async(c:Context,check:()=>void,keys:string[])=>{
    const value=await readJsonBody(c.req.raw,WORKSPACE_FILE_CARD_MAX_BYTES+8192) as Record<string,unknown>;check();
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw new HTTPException(400);
    return value;
  };
  if(!deps.asyncOverview)app.get(base,safe((c,owner,resource)=>{
    const head=coordinator.store.resource(owner,resource)??null,view=contentOverviewView(c.req.url);
    let native=head?null:deps.native(owner,resource)??null;
    // Compatibility root: projection affects only this read. Never reuse the
    // hot-only value for a file import or native writer.
    if(view==='hot'&&native&&typeof native==='object'&&'kind'in native&&native.kind==='notebook'&&'content'in native){
      const document=native as {content:{archive?:unknown}};
      const {archive:_,...hot}=document.content;native={...document,content:hot};
    }
    return c.json({enabled:deps.enabled(),head,native,bindings:coordinator.store.listBindings(owner,resource),...(view==='hot'?{nativeView:'hot'}:{})});
  },true));
  if(!deps.asyncDocuments){
  app.post(`${base}/migrate`,safe(async(c,owner,resource,check)=>{
    const b=await body(c,check,['revision','requestId']);fresh();
    if(!Number.isSafeInteger(b.revision)||Number(b.revision)<0||!validBoardUuid(b.requestId))throw new HTTPException(400);
    return c.json({receipt:await coordinator.migrateAsync(owner,resource,Number(b.revision),b.requestId,()=>{check();fresh();})});
  }));
  app.get(`${base}/migrations/:requestId`,safe((c,owner,resource)=>{
    const id=c.req.param('requestId');if(!validBoardUuid(id))throw new HTTPException(400);
    const receipt=coordinator.store.migration(owner,id);
    const termination=coordinator.store.migrationTermination(owner,id);
    if(receipt&&receipt.resource!==resource||termination&&termination.resource!==resource)throw new HTTPException(404);
    return c.json({receipt:receipt??null,termination:termination??null});
  }));
  app.post(`${base}/migrations/:requestId/recover`,safe(async(c,owner,resource,check)=>{
    await body(c,check,[]);fresh();
    const id=c.req.param('requestId');if(!validBoardUuid(id))throw new HTTPException(400);
    return c.json(await coordinator.store.recoverMigrationAsync(owner,resource,id,()=>{check();fresh();}));
  }));
  app.put(`${base}/document`,safe(async(c,owner,resource,check)=>{
    const b=await body(c,check,['mutationId','modeEpoch','baseRevision','baseHash','content']);fresh();
    if(!validBoardUuid(b.mutationId)||!validBoardUuid(b.modeEpoch)||typeof b.content!=='string'
      ||typeof b.baseHash!=='string'||!Number.isSafeInteger(b.baseRevision))throw new HTTPException(400);
    return c.json({receipt:await coordinator.store.writeAsync(owner,resource,{mutationId:b.mutationId,modeEpoch:b.modeEpoch,
      baseRevision:Number(b.baseRevision),baseHash:b.baseHash,content:b.content},()=>{check();fresh();})});
  }));
  app.get(`${base}/writes/:epoch/:mutationId`,safe((c,owner,resource)=>{
    const epoch=c.req.param('epoch'),id=c.req.param('mutationId');if(!validBoardUuid(epoch)||!validBoardUuid(id))throw new HTTPException(400);
    return c.json({receipt:coordinator.store.ownerReceipt(owner,resource,epoch,id)??null,
      termination:coordinator.store.writeTermination(owner,resource,epoch,id)??null});
  }));
  app.post(`${base}/writes/:epoch/:mutationId/recover`,safe(async(c,owner,resource,check)=>{
    await body(c,check,[]);fresh();
    const epoch=c.req.param('epoch'),id=c.req.param('mutationId');if(!validBoardUuid(epoch)||!validBoardUuid(id))throw new HTTPException(400);
    return c.json(await coordinator.store.recoverWriteAsync(owner,resource,epoch,id,()=>{check();fresh();}));
  }));
  }
  if(!deps.asyncBindings){
  app.put(`${base}/bindings/:bindingId`,safe(async(c,owner,resource,check)=>{
    const b=await body(c,check,['sessionId','epoch','revision']);fresh();
    if(typeof b.sessionId!=='string'||b.sessionId.length>2048||!validBoardUuid(b.epoch)||!Number.isSafeInteger(b.revision))throw new HTTPException(400);
    return c.json({binding:await coordinator.bind(owner,resource,{id:bindingId(c),sessionId:b.sessionId,epoch:b.epoch,revision:Number(b.revision)},()=>{check();fresh();})});
  }));
  app.get(`${base}/bindings/:bindingId`,safe(async(c,owner,resource)=>c.json({binding:await coordinator.inspect(owner,resource,bindingId(c))})));
  app.delete(`${base}/bindings/:bindingId`,safe(async(c,owner,resource)=>c.json(await coordinator.revoke(owner,resource,bindingId(c)))));
  app.post(`${base}/bindings/:bindingId/sync`,safe(async(c,owner,resource,check)=>{
    fresh();return c.json({binding:await coordinator.synchronize(owner,resource,bindingId(c),()=>{check();fresh();})});
  }));
  app.get(`${base}/bindings/:bindingId/conflicts`,safe(async(c,owner,resource)=>c.json({conflicts:await coordinator.conflicts(owner,resource,bindingId(c))})));
  app.get(`${base}/bindings/:bindingId/proposals/:mutationId`,safe(async(c,owner,resource)=>{
    const id=c.req.param('mutationId');if(!validBoardUuid(id))throw new HTTPException(400);
    return c.json({proposal:await coordinator.originalProposal(owner,resource,bindingId(c),id)??null});
  }));
  app.post(`${base}/bindings/:bindingId/resolve`,safe(async(c,owner,resource,check)=>{
    const b=await body(c,check,['conflictId','mutationId','expectedHash']);fresh();
    if(!validBoardUuid(b.conflictId)||!validBoardUuid(b.mutationId)||typeof b.expectedHash!=='string')throw new HTTPException(400);
    return c.json({proposal:await coordinator.resolveConflict(owner,resource,bindingId(c),{
      conflictId:b.conflictId,mutationId:b.mutationId,expectedHash:b.expectedHash})});
  }));
  }
  const batches=deps.batches;
  if(batches&&!deps.asyncBatches){
    const id=(c:Context)=>{const value=c.req.param('batchId');if(!validBoardUuid(value))throw new HTTPException(400);return value;};
    app.put(`${base}/batches/:batchId`,safe(async(c,owner,resource,check)=>{
      const input=await body(c,check,['selection']);fresh();
      return c.json({batch:await batches.prepare(owner,resource,id(c),input.selection as DelegationSelection,()=>{check();fresh();})});
    }));
    app.get(`${base}/batches/:batchId`,safe(async(c,owner,resource,check)=>c.json({batch:await batches.inspect(owner,resource,id(c),check)})));
    app.post(`${base}/batches/:batchId/confirm`,safe(async(c,owner,resource,check)=>{
      fresh();return c.json({batch:await batches.confirm(owner,resource,id(c),()=>{check();fresh();})});
    }));
    app.delete(`${base}/batches/:batchId`,safe(async(c,owner,resource,check)=>c.json({batch:await batches.cancel(owner,resource,id(c),check)})));
  }
}
