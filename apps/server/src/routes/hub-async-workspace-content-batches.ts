import {isDeepStrictEqual} from 'node:util';
import type {Context,Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import type {ContentfulStatusCode} from 'hono/utils/http-status';
import {sessionRuntimeId,validBoardUuid,validWorkspaceFileCardResource} from '@agentopsdeck/shared';
import type {AsyncHubContentDocuments} from '../hub/async-content-documents.js';
import type {AsyncConnectorClientResolver} from '../hub/async-connector-client.js';
import {HubRequestWork} from '../hub/async-request-work.js';
import {HubMemberRequestError} from '../hub/async-member-request.js';
import {ContentProposalConflict,type ContentBindingTarget} from '../hub/content-proposal-store.js';
import type {ContentBatchCommand,ContentBatchResult,ContentBatchCatalog} from '../hub/member-content-batch-domain.js';
import type {ContentBindingCommand,ContentBindingResult} from '../hub/member-content-replica-domain.js';
import type {ContentBatch} from '../hub/workspace-content-batches.js';
import type {DelegationSelection} from '../hub/workspace-delegation-preview.js';
import {contentBatchSelection} from '../hub/content-batch-transactions.js';
import {sharedContentResourceId,type ContentReplicaTransport} from '../hub/workspace-content-coordinator.js';
import {encodeHubSessionId} from '../hub/session-id.js';
import {contentOverviewResponses} from '../hub/content-overview-responses.js';
import {performanceDiagnostics} from '../diagnostics/performance.js';
import {observeContentReplica} from '../diagnostics/content-replica.js';
import {readJsonBody} from '../utils/http-body.js';

/** Original batch IDs and member intents survive delivery failures. The host
 * never owns SQL or a principal, and never replays a previously claimed install. */
export function registerAsyncHubContentBatches(app:Hono,deps:{access:AsyncHubContentDocuments;enabled:()=>boolean;
  clients:AsyncConnectorClientResolver;transport:(request:Request,target:ContentBindingTarget)=>Promise<ContentReplicaTransport>}) {
  const base='/api/hub/v1/workspace/shared-content/:resourceId/batches/:batchId',work=new HubRequestWork(4);
  const active=new Set<string>(),deliveries=new Set<AbortController>();
  type Scope=Awaited<ReturnType<AsyncHubContentDocuments['begin']>>;
  type Access={scope:Scope;resourceId:string;id:string;request:Request;fresh:()=>void};
  // Four native effects may run concurrently, but their large SQL reply
  // reservations must not compete with one another under the shared 32MiB
  // owner budget. Each admitted request has at most four awaiting producers;
  // the request gate bounds this lane without a second unbounded work queue.
  let sqlTail=Promise.resolve();
  const sql=<T>(run:()=>Promise<T>):Promise<T>=>{
    const result=sqlTail.then(run);sqlTail=result.then(()=>{},()=>{});return result;
  };
  const command=async(a:Access,input:ContentBatchCommand):Promise<ContentBatchResult>=>{
    const result=await sql(()=>a.scope.command({resourceId:a.resourceId,...input}));
    if(!result.action.startsWith('batch-'))throw new HTTPException(503);return result as ContentBatchResult;
  };
  const binding=async(a:Access,input:ContentBindingCommand):Promise<ContentBindingResult>=>{
    const result=await sql(()=>a.scope.command({resourceId:a.resourceId,...input}));
    if(!result.action.startsWith('binding-'))throw new HTTPException(503);return result as ContentBindingResult;
  };
  const read=async(a:Access)=>{
    const r=await command(a,{action:'batch-read',id:a.id});if(r.action!=='batch-read')throw new HTTPException(503);return r.batch;
  };
  const current=async(a:Access,id:string,generation?:string)=>{
    const r=await binding(a,{action:'binding-current',id,...(generation?{generation}:{})});
    if(r.action!=='binding-current')throw new HTTPException(503);return r.binding;
  };
  const effectCheck=async(a:Access,memberId:string)=>{
    a.fresh();await command(a,{action:'batch-effect-check',id:a.id,memberId});a.fresh();
  };
  // Server-private catalog only. Worker reconstructs all member authority and
  // selection metadata; no HTTP body can supply owner, runtime or permissions.
  const catalog=async(a:Access):Promise<ContentBatchCatalog>=>{
    a.fresh();const result=await command(a,{action:'batch-directory'});
    if(result.action!=='batch-directory')throw new HTTPException(503);
    const {connections,...fence}=result.directory,sessions:string[]=[],seen=new Set<string>();
    const check=async()=>{a.fresh();await command(a,{action:'batch-check',fence:{generation:fence.generation,preferencesRevision:fence.preferencesRevision}});a.fresh();};
    const signal=AbortSignal.any([a.request.signal,AbortSignal.timeout(5_000)]);
    const remote=async<T>(run:()=>Promise<T>):Promise<T>=>{
      try{return await run();}catch(error){await a.scope.check();throw error;}
    };
    for(const connection of connections){
      const client=await remote(()=>deps.clients(a.request,connection.id));await check();
      let after:string|undefined,sourceCursor:string|undefined;const cursors=new Set<string>();
      for(let pages=0;;pages++){
        signal.throwIfAborted();if(pages>=101)throw new ContentProposalConflict('batch-catalog-incomplete');
        const page=await remote(()=>client.sessionDirectoryOriginal({limit:100,...(after?{after}:{})},signal));await check();
        if(!page.sourceCursor||sourceCursor!==undefined&&sourceCursor!==page.sourceCursor)throw new ContentProposalConflict('batch-catalog-changed');
        sourceCursor=page.sourceCursor;
        for(const entry of page.sessions){
          const id=encodeHubSessionId(connection.id,entry.sessionKey);
          if(sessions.length>=10_000||seen.has(id)||sessionRuntimeId(entry.sessionKey)!==entry.runtime)throw new ContentProposalConflict('batch-catalog-incomplete');
          seen.add(id);sessions.push(id);
        }
        if(page.nextCursor===null)break;
        if(!page.nextCursor||cursors.has(page.nextCursor))throw new ContentProposalConflict('batch-catalog-incomplete');
        cursors.add(page.nextCursor);after=page.nextCursor;
      }
    }
    await check();return {...fence,sessions};
  };
  const inspectMember=async(a:Access,id:string)=>{
    const before=await current(a,id);if(!before.target||!before.initial)throw new HTTPException(409);
    work.check();const transport=await deps.transport(a.request,before.target);work.check();
    await current(a,id,before.generation);work.check();const view=await transport.view(id);
    await current(a,id,before.generation);
    if(view.resource!==a.resourceId||view.generation!==before.generation||view.sessionKey!==before.target.sessionKey
      ||!isDeepStrictEqual(view.initial,before.initial)||!Array.isArray(view.proposals)||view.proposals.length>128)throw new HTTPException(409);
    if(before.acknowledgedRevision<0){
      const {epoch,revision,hash}=view.initial;await binding(a,{action:'binding-ack',id,generation:before.generation,proof:{epoch,revision,hash}});
    }
    await command(a,{action:'batch-settle',id:a.id,memberId:id});
  };
  const inspect=async(a:Access,batch:ContentBatch)=>{
    for(const member of batch.members.filter(m=>m.state==='unknown')){
      try{await observeContentReplica('hub-content-batch-effect',0,()=>inspectMember(a,member.id));}catch{/* Original intent remains unknown; never install. */}
    }
    return read(a);
  };
  const install=async(a:Access,memberId:string,sessionId:string)=>{
    await effectCheck(a,memberId);
    const target=await binding(a,{action:'binding-target',sessionId});if(target.action!=='binding-target')throw new HTTPException(503);
    const transport=await deps.transport(a.request,target.target);await effectCheck(a,memberId);
    const capability=await transport.capability();await effectCheck(a,memberId);
    const now=await binding(a,{action:'binding-target',sessionId});
    if(now.action!=='binding-target'||!isDeepStrictEqual(now.target,target.target)||capability.protocol!==1||!capability.available)throw new HTTPException(409);
    const prepared=await command(a,{action:'batch-binding-prepare',id:a.id,memberId});
    if(prepared.action!=='batch-binding-prepare')throw new HTTPException(503);
    if(!prepared.result.created)return inspectMember(a,memberId);
    const b=prepared.result.binding;if(!b.target||!b.initial)throw new HTTPException(503);
    await effectCheck(a,memberId);await current(a,memberId,b.generation);a.fresh();
    // Once the effect starts, client abort/close does not discard its genuine
    // receipt. SQL authority still revalidates every ACK before settlement.
    const proof=await transport.install({id:memberId,resource:a.resourceId,generation:b.generation,sessionKey:b.target.sessionKey,base:b.initial});
    await current(a,memberId,b.generation);
    if(!isDeepStrictEqual(proof,b.initial))throw new HTTPException(409);
    const {epoch,revision,hash}=proof;
    await binding(a,{action:'binding-ack',id:memberId,generation:b.generation,proof:{epoch,revision,hash}});
    await command(a,{action:'batch-settle',id:a.id,memberId});
  };
  const cleanup=async(a:Access,memberId:string)=>{
    const target=async()=>{
      const r=await command(a,{action:'batch-cleanup-target',id:a.id,memberId});
      if(r.action!=='batch-cleanup-target')throw new HTTPException(503);return {generation:r.generation,target:r.target};
    };
    const before=await target();if(!before.target)return;
    work.check();const transport=await deps.transport(a.request,before.target);work.check();
    if(!isDeepStrictEqual(before,await target()))return;
    await transport.revoke(memberId);if(!isDeepStrictEqual(before,await target()))return;
    await command(a,{action:'batch-cleanup-settle',id:a.id,memberId});
  };
  const safe=(step:number,run:(c:Context,a:Access)=>Promise<ContentBatch>)=>async(c:Context)=>{
    c.header('Cache-Control','no-store');const trace=performanceDiagnostics.start('hub-content-batch-http');
    trace.add('step',step);const warning=setTimeout(()=>trace.reportPending({pending:1}),30_000);warning.unref();let failed=true,undelivered:Response|undefined;
    let reservation:ReturnType<typeof contentOverviewResponses.reserve>|undefined;
    try{
      const response=await work.run(async()=>{
        const raw=c.req.param('resourceId')!,id=c.req.param('batchId')!;
        if(!validWorkspaceFileCardResource(raw)||!validBoardUuid(id)||c.req.url.includes('?'))throw new HTTPException(400);
        reservation=contentOverviewResponses.reserve(1024*1024);
        const request=new Request(c.req.url,{headers:new Headers(c.req.raw.headers)}),scope=await deps.access.begin(request);
        const key=JSON.stringify([scope.recoveryScope,raw,id]),mutating=['PUT','POST','DELETE'].includes(c.req.method);
        if(mutating&&active.has(key))throw new HTTPException(409);if(mutating)active.add(key);
        const a:Access={scope,resourceId:sharedContentResourceId(raw),id,request,fresh:()=>{
          work.check();if(!deps.enabled()||c.req.raw.signal.aborted)throw new HTTPException(503);
        }};
        try{
          if(c.req.raw.signal.aborted)throw new HTTPException(499 as ContentfulStatusCode);
          const batch=await run(c,a);await scope.check();work.check();
          if(c.req.raw.signal.aborted)throw new HTTPException(499 as ContentfulStatusCode);
          if(c.req.method==='HEAD')return new Response(null,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
          const delivery=new AbortController();deliveries.add(delivery);
          const abort=()=>delivery.abort(),release=()=>{deliveries.delete(delivery);c.req.raw.signal.removeEventListener('abort',abort);};
          c.req.raw.signal.addEventListener('abort',abort,{once:true});if(c.req.raw.signal.aborted)delivery.abort();
          try{return undelivered=reservation.response(JSON.stringify({batch}),delivery.signal,release);}
          catch(error){delivery.abort();release();throw error;}
        }finally{if(mutating)active.delete(key);}
      });failed=false;return response;
    }catch(error){
      await undelivered?.body?.cancel();
      const raw=error instanceof HTTPException||error instanceof HubMemberRequestError?error.status:error instanceof ContentProposalConflict?409:503;
      return c.json({error:'shared_content_unavailable_inspect_original'},(raw>=400&&raw<=599?raw:503) as ContentfulStatusCode);
    }finally{clearTimeout(warning);reservation?.release();trace.finish(failed);}
  };
  app.put(base,safe(0,async(c,a)=>{
    a.fresh();const body=await readJsonBody(c.req.raw,2*1024*1024+8192);await a.scope.check();a.fresh();
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join(',')!=='selection')throw new HTTPException(400);
    const selection=contentBatchSelection((body as {selection:DelegationSelection}).selection);
    // Repeating prepare reads its original row even when the remote directory
    // is now offline. Missing rows alone require a complete fresh catalog.
    let prior:ContentBatch|undefined;
    try{prior=await read(a);}catch(error){if(!(error instanceof HubMemberRequestError&&error.status===409))throw error;}
    if(prior){if(!isDeepStrictEqual(prior.selection,selection))throw new ContentProposalConflict('batch-reused');return prior;}
    const r=await command(a,{action:'batch-prepare',id:a.id,selection,catalog:await catalog(a)});
    if(r.action!=='batch-prepare')throw new HTTPException(503);return r.batch;
  }));
  app.get(base,safe(1,async(_c,a)=>inspect(a,await read(a))));
  app.post(base+'/confirm',safe(2,async(_c,a)=>{
    a.fresh();const prior=await read(a);if(prior.state!=='prepared')return inspect(a,prior);
    const result=await command(a,{action:'batch-confirm',id:a.id,catalog:await catalog(a)});
    if(result.action!=='batch-confirm')throw new HTTPException(503);
    if(!result.claimed)return inspect(a,result.batch);
    const remaining=[...result.batch.members];
    await Promise.all(Array.from({length:Math.min(4,remaining.length)},async()=>{
      for(let member=remaining.shift();member;member=remaining.shift()){
        try{await observeContentReplica('hub-content-batch-effect',1,()=>install(a,member.id,member.member.sessionId));}catch{/* Original all-member claim remains durable. */}
      }
    }));return read(a);
  }));
  app.delete(base,safe(3,async(_c,a)=>{
    const result=await command(a,{action:'batch-cancel',id:a.id});if(result.action!=='batch-cancel')throw new HTTPException(503);
    for(const member of result.batch.members.filter(m=>m.state==='cleanup_pending')){
      try{await observeContentReplica('hub-content-batch-effect',2,()=>cleanup(a,member.id));}catch{/* Durable tombstone precedes all best-effort cleanup. */}
    }return read(a);
  }));
  let closing:Promise<void>|undefined;
  return {close:()=>{
    if(closing)return closing;const drained=work.close();for(const delivery of deliveries)delivery.abort();deliveries.clear();
    return closing=(async()=>{await drained;await deps.access.close();})();
  }};
}
