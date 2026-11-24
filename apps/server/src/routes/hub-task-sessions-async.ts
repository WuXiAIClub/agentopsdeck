import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validBoardId, validBoardUuid } from '@agentopsdeck/shared';
import type { AsyncHubTaskSessions } from '../hub/async-task-sessions.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import type { AsyncOwnerControlPort } from '../hub/owner-control.js';
import type { TaskSessionReceipt } from '../hub/task-session-workflow.js';
import type { CommandReceipt } from '../commands/receipts.js';
import { validTaskSessionPreview, validTaskSessionRemote, type TaskSessionRemote } from '../hub/member-task-session-domain.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import { readJsonBody } from '../utils/http-body.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

export type AsyncTaskSessionDeps = { mode:'async'; access:AsyncHubTaskSessions;
  controls:AsyncOwnerControlPort; asyncConnectorClient:AsyncConnectorClientResolver; endpoint?:string|undefined;
  hubStore?:never; principal?:never; connectorClient?:never; bindingClient?:never };

/** Explicit no-store composition. Own the original resolver and transports,
 * not merely their cancellable HTTP delivery. GET never dispatches a write. */
export function registerAsyncHubTaskSessions(app:Hono,deps:AsyncTaskSessionDeps) {
  if (!deps.access || typeof deps.access.begin!=='function' || typeof deps.access.close!=='function'
    || !deps.controls || typeof deps.controls.open!=='function' || typeof deps.controls.close!=='function'
    || typeof deps.asyncConnectorClient!=='function') throw Error('task-session-async-ports');
  const work=new HubRequestWork(), active=new Set<string>();
  type Access=Awaited<ReturnType<AsyncHubTaskSessions['begin']>>;
  const base='/api/hub/v1/workspace/boards/:boardId/task-sessions';
  const scope=async(c:Context)=>{
    const board=c.req.param('boardId')!;
    if(!validBoardId(board)||c.req.url.includes('?'))throw new HTTPException(400);
    const access=await deps.access.begin(c.req.raw);work.check();
    const check=async()=>{work.check();await access.check();work.check();};
    return {...access,board,check};
  };
  type Scope=Awaited<ReturnType<typeof scope>>;
  const original=async(c:Context)=>{
    const s=await scope(c),id=c.req.param('id')!;if(!validBoardUuid(id))throw new HTTPException(400);
    const value=await s.command({action:'read',boardId:s.board,id});await s.check();
    if(!value.receipt)throw new HTTPException(404);
    return {...s,receipt:value.receipt};
  };
  const selection=async(s:Scope,r:TaskSessionReceipt)=>{
    if(!deps.endpoint)throw new HTTPException(409);
    await s.command({action:'selection',boardId:s.board,id:r.intent.requestId});await s.check();
  };
  const creation=async(c:Context,s:Scope,r:TaskSessionReceipt)=>{
    const i=r.intent;
    const t=await deps.controls.open(c.req.raw,s.owner,{operation:'create',connectionId:i.connectionId,agentId:i.runtime});
    await s.check();await t.check();work.check();
    if(t.authority!==i.authorityEpoch||t.nodeId!==i.nodeId)throw new HTTPException(403);
    return t;
  };
  const settleCreation=async(s:Scope,r:TaskSessionReceipt,command:CommandReceipt)=>{
    const key=command.result?.body?.key,decoded=typeof key==='string'?decodeHubSessionId(key):undefined;
    if(command.state==='accepted'&&command.result?.status===201&&decoded?.connectionId===r.intent.connectionId
      &&decoded.remoteSessionKey.startsWith(r.intent.runtime+':'))return (await s.command({action:'creation',boardId:s.board,id:r.intent.requestId,
        outcome:{requestId:r.creationRequestId,state:'created',sessionId:key as string}})).receipt!;
    if(command.state==='rejected')return (await s.command({action:'creation',boardId:s.board,id:r.intent.requestId,
      outcome:{requestId:r.creationRequestId,state:'rejected'}})).receipt!;
    return r;
  };
  const binding=async(c:Context,s:Scope,r:TaskSessionReceipt)=>{
    const i=r.intent,session=decodeHubSessionId(r.sessionId??'');
    if(!session||session.connectionId!==i.connectionId||!session.remoteSessionKey.startsWith(i.runtime+':'))throw new HTTPException(409);
    const valid=async()=>{await s.check();await s.command({action:'read',boardId:s.board,id:i.requestId});await s.check();};
    await valid();
    const client=await deps.asyncConnectorClient(c.req.raw,i.connectionId,{expectedUserId:s.owner,boardBindingsOnly:true}).finally(valid);
    await valid();
    const path=`/sessions/${encodeURIComponent(session.remoteSessionKey)}/board-binding`;
    const read=async()=>{
      const value=await client.json<unknown>(path,{signal:AbortSignal.timeout(5000)}).finally(valid);
      if(!validTaskSessionRemote(value)||value.runtime!==i.runtime||session.remoteSessionKey!==`${value.runtime}:${value.sessionId}`)throw new HTTPException(502);
      // Compatible Connector response extensions must not enter fixed RPC.
      const remote:TaskSessionRemote={ready:value.ready,runtime:value.runtime,sessionId:value.sessionId,
        binding:value.binding?{id:value.binding.id,runtime:value.binding.runtime,sessionId:value.binding.sessionId,
          state:value.binding.state,expiresAt:value.binding.expiresAt}:null};
      return remote;
    };
    const settle=async(remote:TaskSessionRemote)=>{
      await valid();return (await s.command({action:'binding',boardId:s.board,id:i.requestId,remote})).receipt!;
    };
    return {client,path,valid,read,settle};
  };
  const safe=(handler:(c:Context)=>Promise<Response>)=>async(c:Context)=>{
    c.header('Cache-Control','no-store');
    const trace=guardedTrace(performanceDiagnostics,'hub-request-authority');trace.add('step',89);
    try{const response=await work.run(()=>handler(c));trace.add('settled',1);trace.finish();return response;}
    catch(error){trace.add('deferred',1);trace.finish(true);
      const message={error:'Task session unavailable. Inspect the original request; no message was sent.'};
      if(error instanceof HubMemberRequestError){
        if(error.status===499)return Response.json(message,{status:499,headers:{'Cache-Control':'no-store'}});
        return c.json(message,error.status);
      }
      return c.json(message,error instanceof HTTPException?error.status:409);
    }
  };
  const exclusive=async(s:Access,id:string,fn:()=>Promise<Response>)=>{
    const key=JSON.stringify([s.owner,id]);if(active.has(key))throw new HTTPException(409);
    if(active.size>=16)throw new HTTPException(429);active.add(key);
    try{return await fn();}finally{active.delete(key);}
  };
  app.post(base,safe(async c=>{
    const s=await scope(c),input=await readJsonBody(c.req.raw,16384).finally(()=>s.check());
    if(!validTaskSessionPreview(input))throw new HTTPException(400);
    if(!deps.endpoint)throw new HTTPException(409);
    const result=await s.command({action:'prepare',boardId:s.board,input,endpoint:deps.endpoint});await s.check();
    return c.json({receipt:result.receipt},201);
  }));
  app.get(`${base}/:id`,safe(async c=>{
    const s=await original(c),r=s.receipt;let receipt=r;
    if(r.state==='creation_unknown'){
      const t=await creation(c,s,r);
      if(await t.get(r.creationRequestId)){receipt=await settleCreation(s,r,await t.recover(r.creationRequestId));}
    }else if(r.state==='binding_unknown'){
      const t=await binding(c,s,r);try{receipt=await t.settle(await t.read());}catch{await t.valid();}
    }
    await s.check();return c.json({receipt});
  }));
  app.post(`${base}/:id/:phase`,safe(async c=>{
    const s=await original(c),phase=c.req.param('phase');
    const body=await readJsonBody(c.req.raw,64).finally(()=>s.check());
    if(!['create','bind','cancel'].includes(phase!)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw new HTTPException(400);
    return exclusive(s,s.receipt.intent.requestId,async()=>{
      const id=s.receipt.intent.requestId,latest=(await s.command({action:'read',boardId:s.board,id})).receipt!;
      if(phase==='cancel')return c.json({receipt:(await s.command({action:'cancelPrepared',boardId:s.board,id})).receipt});
      if(latest.state!==(phase==='create'?'prepared':'created'))return c.json({receipt:latest});
      await selection(s,latest);
      if(phase==='create'){
        if(!latest.intent.model)throw new HTTPException(409);
        const t=await creation(c,s,latest),client=await t.client().finally(()=>s.check());await s.check();await t.check();
        const catalog=await client.json<{models?:Array<{id?:unknown}>}>(`/models/${encodeURIComponent(latest.intent.runtime)}`,{signal:AbortSignal.timeout(5000)}).finally(()=>s.check());
        await s.check();await t.check();await selection(s,latest);
        if(!Array.isArray(catalog.models)||catalog.models.length>512||!catalog.models.some(m=>m?.id===latest.intent.model))throw new HTTPException(409);
        const claimed=await s.command({action:'claim',boardId:s.board,id});
        if(!claimed.claimed)return c.json({receipt:claimed.receipt});
        const payload={label:latest.intent.title,model:latest.intent.model};
        const {fresh}=await t.claim(latest.creationRequestId,payload);
        if(fresh)try{
          const target=await t.client(),delivery=await t.deliveryKey(latest.creationRequestId);
          await t.check();await selection(s,latest);
          const result=await target.jsonResponse<{command?:CommandReceipt;key?:string}>(t.upstream,{method:'POST',headers:{'content-type':'application/json','idempotency-key':delivery},
            body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
          await s.check();await t.bound(latest.creationRequestId);
          if(result.body.command)await t.settle(latest.creationRequestId,{...result.body.command,result:{status:result.status,body:{key:result.body.key}}});
        }catch{await s.check();await t.bound(latest.creationRequestId);}
        const receipt=await settleCreation(s,claimed.receipt,await t.recover(latest.creationRequestId));await s.check();
        return c.json({receipt});
      }
      const t=await binding(c,s,latest),remote=await t.read();await selection(s,latest);
      if(!remote.ready||remote.binding?.state==='installed')throw new HTTPException(409);
      const claimed=await s.command({action:'bindingClaim',boardId:s.board,id,endpoint:deps.endpoint!});
      if(!claimed.claimed)return c.json({receipt:claimed.receipt});
      if(!claimed.credential)throw new HTTPException(409);
      try{
        await t.valid();await selection(s,latest);
        await t.client.json(t.path,{method:'PUT',body:JSON.stringify({id:latest.bindingRequestId,credential:claimed.credential}),signal:AbortSignal.timeout(5000)});
        return c.json({receipt:await t.settle(await t.read())});
      }catch{await t.valid();return c.json({receipt:(await s.command({action:'read',boardId:s.board,id})).receipt});}
    });
  }));
  app.delete(`${base}/:id`,safe(async c=>{
    const s=await scope(c),id=c.req.param('id')!;if(!validBoardUuid(id))throw new HTTPException(400);
    const result=await s.command({action:'cancel',boardId:s.board,id});await s.check();
    return c.json({receipt:result.receipt,cancelled:true,requestId:id});
  }));
  let closing:Promise<void>|undefined;
  return {close:()=>closing??=work.close().then(async()=>{await Promise.all([deps.access.close(),deps.controls.close!()]);})};
}
