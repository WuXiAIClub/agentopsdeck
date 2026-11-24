import { isDeepStrictEqual } from 'node:util';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTPException } from 'hono/http-exception';
import { validBoardUuid, validWorkspaceFileCardResource } from '@agentopsdeck/shared';
import type { AsyncHubContentDocuments } from '../hub/async-content-documents.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import {ContentProposalConflict,type ContentBindingTarget} from '../hub/content-proposal-store.js';
import type { ContentBindingCommand, ContentBindingResult } from '../hub/member-content-replica-domain.js';
import type {ContentSyncCommand,ContentSyncResult} from '../hub/member-content-sync-domain.js';
import {synchronizeContentReplica} from '../hub/async-content-synchronize.js';
import type { ContentReplicaTransport } from '../hub/workspace-content-coordinator.js';
import { sharedContentResourceId } from '../hub/workspace-content-coordinator.js';
import { readJsonBody } from '../utils/http-body.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { contentOverviewResponses } from '../hub/content-overview-responses.js';
import {contentConflictProof,readContentReplica,resolveContentConflict,type ContentReconcileAccess} from '../hub/async-content-reconcile.js';

/** Binding intents/settlements live with the original SQL owner. This host owns
 * each original Connector effect through client abort and route shutdown. */
export function registerAsyncHubContentBindings(app:Hono,deps:{access:AsyncHubContentDocuments;enabled:()=>boolean;
  transport:(request:Request,target:ContentBindingTarget)=>Promise<ContentReplicaTransport>}) {
  const base='/api/hub/v1/workspace/shared-content/:resourceId/bindings/:bindingId',work=new HubRequestWork(4),active=new Set<string>();
  const deliveries=new Set<AbortController>();
  class EncodedReplicaResponse {constructor(readonly parts:Uint8Array[]) {}}
  type Scope=Awaited<ReturnType<AsyncHubContentDocuments['begin']>>;
  type Reservation=ReturnType<typeof contentOverviewResponses.reserve>;
  const safe=(step:number,run:(c:Context,scope:Scope,resourceId:string,id:string,request:Request,reservation:Reservation)=>Promise<unknown>)=>async(c:Context)=>{
    c.header('Cache-Control','no-store');
    const trace=performanceDiagnostics.start('hub-content-replica-http');trace.add('step',step);const warning=setTimeout(()=>trace.reportPending({pending:1}),30_000);warning.unref();let failed=true;
    let reservation:ReturnType<typeof contentOverviewResponses.reserve>|undefined;
    let undelivered:Response|undefined;
    try {
      const value=await work.run(async()=>{
        const raw=c.req.param('resourceId')!,id=c.req.param('bindingId')!;
        if(!validWorkspaceFileCardResource(raw)||!validBoardUuid(id)||c.req.url.includes('?'))throw new HTTPException(400);
        const resourceId=sharedContentResourceId(raw);
        // One complete binding fits the fixed 16MiB owner reply budget. Reserve
        // before any effect and retain until the delivered body is consumed.
        reservation=step===3?contentOverviewResponses.reserveControl()
          :step===5?contentOverviewResponses.reserveParts():contentOverviewResponses.reserve(16*1024*1024);
        // Browser abort ends delivery, not an admitted original effect/ACK.
        const request=new Request(c.req.url,{headers:new Headers(c.req.raw.headers)}),scope=await deps.access.begin(request);
        const key=JSON.stringify([scope.recoveryScope,resourceId,id]);
        const mutating=['PUT','POST','DELETE'].includes(c.req.method);
        if(mutating&&active.has(key))throw new HTTPException(409);
        if(mutating)active.add(key);
        try {
          if(c.req.raw.signal.aborted)throw new HTTPException(499 as ContentfulStatusCode);
          const result=await run(c,scope,resourceId,id,request,reservation);
          await scope.check();if(c.req.raw.signal.aborted)throw new HTTPException(499 as ContentfulStatusCode);
          // Settlement may have drained through close. Do not create a new
          // delivery after close has already cancelled its delivery set.
          work.check();
          if(c.req.method==='HEAD')return new Response(null,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
          const delivery=new AbortController();deliveries.add(delivery);
          const abort=()=>delivery.abort(),cleanup=()=>{deliveries.delete(delivery);c.req.raw.signal.removeEventListener('abort',abort);};
          c.req.raw.signal.addEventListener('abort',abort,{once:true});
          if(c.req.raw.signal.aborted)delivery.abort();
          try{return undelivered=result instanceof EncodedReplicaResponse
            ?reservation.responseParts(result.parts,delivery.signal,cleanup)
            :reservation.response(JSON.stringify(result),delivery.signal,cleanup);}catch(error){delivery.abort();cleanup();throw error;}
        } finally {if(mutating)active.delete(key);}
      });
      failed=false;return value;
    } catch(error) {
      // close can also win between response construction and work.run's final
      // delivery check. That response never reaches a consumer: release it.
      await undelivered?.body?.cancel();
      const raw=error instanceof HTTPException||error instanceof HubMemberRequestError?error.status:error instanceof ContentProposalConflict?409:503;
      const status:ContentfulStatusCode=raw>=400&&raw<=599?raw as ContentfulStatusCode:503;
      return c.json({error:'shared_content_unavailable_inspect_original'},status);
    } finally {clearTimeout(warning);reservation?.release();trace.finish(failed);}
  };
  const command=async(scope:Scope,resourceId:string,input:ContentBindingCommand):Promise<ContentBindingResult>=>{
    const result=await scope.command({resourceId,...input});
    if(!result.action.startsWith('binding-'))throw new HTTPException(503);
    return result as ContentBindingResult;
  };
  const current=async(scope:Scope,resourceId:string,id:string,generation?:string)=>{
    const result=await command(scope,resourceId,{action:'binding-current',id,...(generation?{generation}:{})});
    if(result.action!=='binding-current')throw new HTTPException(503);return result.binding;
  };
  const inspect=async(scope:Scope,resourceId:string,id:string,request:Request)=>{
    const before=await current(scope,resourceId,id);
    if(!before.target||!before.initial)throw new HTTPException(409);
    work.check();
    const transport=await deps.transport(request,before.target);
    work.check();await current(scope,resourceId,id,before.generation);work.check();
    const view=await transport.view(id);
    await current(scope,resourceId,id,before.generation);
    if(view.resource!==resourceId||view.generation!==before.generation||view.sessionKey!==before.target.sessionKey
      ||!isDeepStrictEqual(view.initial,before.initial)||!Array.isArray(view.proposals)||view.proposals.length>128)throw new HTTPException(409);
    if(before.acknowledgedRevision<0) {
      const {epoch,revision,hash}=view.initial;
      await command(scope,resourceId,{action:'binding-ack',id,generation:before.generation,proof:{epoch,revision,hash}});
    }
    return current(scope,resourceId,id,before.generation);
  };
  const reconcile=async(c:Context,scope:Scope,resource:string,id:string,request:Request):Promise<ContentReconcileAccess>=>{
    const binding=await current(scope,resource,id),generation=binding.generation;
    return {id,resource,binding,check:()=>{work.check();if(!deps.enabled()||c.req.raw.signal.aborted)throw new HTTPException(503);},
      command:async input=>{
        const result=await scope.command({resourceId:resource,...input});
        if(!('id'in result)||!result.action.startsWith('sync-'))throw new HTTPException(503);return result as ContentSyncResult;
      },call:async effect=>{
        const before=await current(scope,resource,id,generation);if(!before.target)throw new HTTPException(409);
        const transport=await deps.transport(request,before.target),now=await current(scope,resource,id,generation);
        if(!isDeepStrictEqual(now.target,before.target))throw new HTTPException(409);
        try{const result=await effect(transport);await current(scope,resource,id,generation);return result;}
        catch(error){await scope.check();throw error;}
      }};
  };
  app.get(base+'/conflicts',safe(5,async(c,scope,resource,id,request,reservation)=>{
    const access=await reconcile(c,scope,resource,id,request),view=await readContentReplica(access);
    const parts:Uint8Array[]=[reservation.encode('{"conflicts":[')];
    const snapshots=new Map<string,Uint8Array>();let first=true;
    for(const local of view.proposals.filter(p=>p.state==='conflict'&&!p.resolvedBy)){
      // Proof is checked for EVERY original mutation, even if bodies deduplicate.
      const remote=await contentConflictProof(access,local),key=JSON.stringify([remote.epoch,remote.revision,remote.hash]);
      let encoded=snapshots.get(key);if(!encoded){encoded=reservation.encode(JSON.stringify(remote));snapshots.set(key,encoded);}
      parts.push(reservation.encode((first?'':',')+'{"local":'+JSON.stringify(local)+',"remote":'),encoded,
        reservation.encode(',"actualHash":'+JSON.stringify(view.actualHash)+'}'));first=false;
    }
    parts.push(reservation.encode(']}'));return new EncodedReplicaResponse(parts);
  }));
  app.get(base+'/proposals/:mutationId',safe(6,async(c,scope,resource,id,request)=>{
    const mutationId=c.req.param('mutationId');if(!validBoardUuid(mutationId))throw new HTTPException(400);
    const access=await reconcile(c,scope,resource,id,request),view=await readContentReplica(access);
    return {proposal:view.proposals.find(p=>p.proposal.mutationId===mutationId)??null};
  }));
  app.post(base+'/resolve',safe(7,async(c,scope,resource,id,request)=>{
    const b=await readJsonBody(c.req.raw,8192);await scope.check();
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='conflictId,expectedHash,mutationId')throw new HTTPException(400);
    const input=b as Record<string,unknown>;
    if(!validBoardUuid(input.conflictId)||!validBoardUuid(input.mutationId)||typeof input.expectedHash!=='string'
      ||!/^[a-f0-9]{64}$/.test(input.expectedHash))throw new HTTPException(400);
    const access=await reconcile(c,scope,resource,id,request);access.check();const view=await readContentReplica(access);
    return {proposal:await resolveContentConflict(access,view,{conflictId:input.conflictId,mutationId:input.mutationId,expectedHash:input.expectedHash})};
  }));
  app.get(base,safe(2,async(_c,scope,resourceId,id,request)=>({binding:await inspect(scope,resourceId,id,request)})));
  app.post(base+'/sync',safe(4,async(c,scope,resourceId,id,request)=>{
    const binding=await current(scope,resourceId,id),generation=binding.generation;
    const checked=()=>current(scope,resourceId,id,generation);
    const check=()=>{work.check();if(!deps.enabled()||c.req.raw.signal.aborted)throw new HTTPException(503);};
    check();
    const sync=async(input:ContentSyncCommand):Promise<ContentSyncResult>=>{
      const result=await scope.command({resourceId,...input});
      if(!('id'in result)||!result.action.startsWith('sync-'))throw new HTTPException(503);
      return result as ContentSyncResult;
    };
    return {binding:await synchronizeContentReplica({id,resource:resourceId,current:checked,
      inspect:()=>inspect(scope,resourceId,id,request),command:sync,check,
      call:async effect=>{
        const before=await checked();if(!before.target)throw new HTTPException(409);
        const transport=await deps.transport(request,before.target);
        const now=await checked();if(!isDeepStrictEqual(now.target,before.target))throw new HTTPException(409);
        try {const result=await effect(transport);await checked();return result;}
        catch(error){await scope.check();throw error;}
      }} )};
  }));
  app.put(base,safe(1,async(c,scope,resourceId,id,request)=>{
    const input=await readJsonBody(c.req.raw,8192);await scope.check();work.check();
    if(!input||typeof input!=='object'||Array.isArray(input))throw new HTTPException(400);
    const b=input as Record<string,unknown>;
    if(Object.keys(b).sort().join(',')!=='epoch,revision,sessionId'||typeof b.sessionId!=='string'||b.sessionId.length>2048
      ||!validBoardUuid(b.epoch)||!Number.isSafeInteger(b.revision)||Number(b.revision)<0)throw new HTTPException(400);
    if(!deps.enabled()||c.req.raw.signal.aborted)throw new HTTPException(503);
    const old=await command(scope,resourceId,{action:'binding-lookup',id});
    if(old.action!=='binding-lookup')throw new HTTPException(503);
    if(old.binding){
      if(old.binding.target?.sessionId!==b.sessionId||old.binding.initial?.epoch!==b.epoch||old.binding.initial.revision!==b.revision)throw new HTTPException(409);
      return {binding:await inspect(scope,resourceId,id,request)};
    }
    const target=await command(scope,resourceId,{action:'binding-target',sessionId:b.sessionId});
    if(target.action!=='binding-target')throw new HTTPException(503);
    const transport=await deps.transport(request,target.target);work.check();
    if(!deps.enabled()||c.req.raw.signal.aborted)throw new HTTPException(503);
    const capability=await transport.capability();
    const now=await command(scope,resourceId,{action:'binding-target',sessionId:b.sessionId});
    if(now.action!=='binding-target'||!isDeepStrictEqual(now.target,target.target)||capability.protocol!==1||capability.available!==true)throw new HTTPException(409);
    work.check();if(!deps.enabled()||c.req.raw.signal.aborted)throw new HTTPException(503);
    const prepared=await command(scope,resourceId,{action:'binding-prepare',id,target:target.target,epoch:b.epoch,revision:Number(b.revision)});
    if(prepared.action!=='binding-prepare')throw new HTTPException(503);
    if(!prepared.created)return {binding:await inspect(scope,resourceId,id,request)};
    const binding=prepared.binding;
    if(!binding.target||!binding.initial)throw new HTTPException(503);
    try {
      work.check();if(!deps.enabled()||c.req.raw.signal.aborted)throw new HTTPException(503);
      await current(scope,resourceId,id,binding.generation);work.check();
      const proof=await transport.install({id,resource:resourceId,generation:binding.generation,sessionKey:binding.target.sessionKey,base:binding.initial});
      await current(scope,resourceId,id,binding.generation);
      if(!isDeepStrictEqual(proof,binding.initial))throw new HTTPException(409);
      const {epoch,revision,hash}=proof;
      await command(scope,resourceId,{action:'binding-ack',id,generation:binding.generation,proof:{epoch,revision,hash}});
    } catch {
      // An unknown effect occupies its original intent forever. Neither a
      // transport error nor missing remote file permits another installation.
      await current(scope,resourceId,id,binding.generation);
    }
    return {binding:await current(scope,resourceId,id,binding.generation)};
  }));
  app.delete(base,safe(3,async(_c,scope,resourceId,id,request)=>{
    const revoked=await command(scope,resourceId,{action:'binding-revoke',id});
    if(revoked.action!=='binding-revoke')throw new HTTPException(503);
    const cleanup=async()=>{
      const result=await command(scope,resourceId,{action:'binding-cleanup',id,generation:revoked.binding.generation});
      if(result.action!=='binding-cleanup')throw new HTTPException(503);return result.target;
    };
    let target:ContentBindingTarget|null,transport:ContentReplicaTransport;
    try {target=await cleanup();if(!target)return {revoked:true,cleanup:'unavailable'};
      work.check();transport=await deps.transport(request,target);work.check();
      if(!isDeepStrictEqual(await cleanup(),target))return {revoked:true,cleanup:'unavailable'};
    } catch {return {revoked:true,cleanup:'unavailable'};}
    await transport.revoke(id);
    return {revoked:true,cleanup:isDeepStrictEqual(await cleanup(),target)?'confirmed':'unavailable'};
  }));
  let closing:Promise<void>|undefined;
  return {close:()=>{
    if(closing)return closing;
    const drained=work.close();for(const delivery of deliveries)delivery.abort();deliveries.clear();
    return closing=(async()=>{await drained;await deps.access.close();})();
  }};
}
