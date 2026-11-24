import { createHash } from 'node:crypto';
import type { Context,Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { tokenSnapshotRequestId } from '@agentopsdeck/shared';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import type { ConnectorClientResolver } from '../hub/connector-client.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import { delegationDirectory } from '../hub/workspace-delegation-directory.js';
import { readDelegationCatalog, type DelegationCatalogSource } from '../hub/workspace-delegation-catalog.js';
import { usageSelection, type UsageSelection, type UsageManifest } from '../hub/usage-manifests.js';
import { readJsonBody } from '../utils/http-body.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import { requestConnectorClient } from '../hub/request-connector-client.js';
import type { AsyncHubUsageManifests } from '../hub/async-usage-manifests.js';
import { registerAsyncHubUsageManifests } from './hub-async-usage-manifests.js';

export function registerHubUsageManifests(app:Hono,deps:{hubStore:HubStore;principal:(c:Context)=>HubPrincipal;
  connectorClient:ConnectorClientResolver;asyncConnectorClient?:AsyncConnectorClientResolver;directory?:DelegationCatalogSource;access?:AsyncHubUsageManifests}) {
  if(deps.access)return registerAsyncHubUsageManifests(app,{access:deps.access,...(deps.asyncConnectorClient?{asyncConnectorClient:deps.asyncConnectorClient}:{})});
  const hub=deps.hubStore,store=hub.usageManifests;
  const base='/api/hub/v1/usage-manifests',active=new Set<string>();let closed=false;
  const safe=(fn:(c:Context)=>Promise<Response>)=>async(c:Context)=>{
    c.header('Cache-Control','no-store');
    try{if(closed)throw new HTTPException(503);if(c.req.url.includes('?'))throw new HTTPException(400);return await fn(c);}
    catch(e){return c.json({error:'Usage scope unavailable. Inspect the original request; partial member totals are not shown.'},e instanceof HTTPException?e.status:409);}
  };
  const scope=(c:Context)=>{const owner=deps.principal(c).userId;return{owner,check:()=>{if(closed||deps.principal(c).userId!==owner)throw new HTTPException(403);if(c.req.raw.signal.aborted)throw new HTTPException(409);}};};
  const exclusive=async(owner:string,id:string,fn:()=>Promise<Response>)=>{
    const key=JSON.stringify([owner,id]);if(active.has(key))throw new HTTPException(409);if(active.size>=8)throw new HTTPException(429);
    active.add(key);try{return await fn();}finally{active.delete(key);}
  };
  const selection=async(owner:string,s:UsageSelection,request:Request,check:()=>void)=>{
    const source=deps.directory??delegationDirectory(hub,async(id,maintenance,user,grant,_options,signal)=>{
      check();const client=await requestConnectorClient(deps,request,id,maintenance,user,grant,signal);
      check();return client;
    });
    const catalog=await readDelegationCatalog(owner,source);let layout:unknown=null,layoutKeys:Set<string>|undefined;
    if(s.layoutId){
      const kind=s.layoutId==='current'?'current':'saved',document=hub.layouts.get(owner,kind);
      const content=document.content?JSON.parse(document.content):null;
      const saved=kind==='current'?content:Array.isArray(content)?content.find((x:{id:string})=>x.id===s.layoutId):undefined;
      if(!saved)throw Error('layout-unavailable');
      layout=[kind,document.revision,saved];layoutKeys=new Set<string>();
      // Only actual session cards are members, never notebook/task links. The
      // layout is presentation data; matching the trusted directory grants no
      // additional authority. Reject malformed panes instead of empty totals.
      // Floating entries are geometry references into panes, not extra panes.
      if(!Array.isArray(saved.workspace?.panes)||!Array.isArray(saved.workspace?.floating))throw Error('invalid-layout');
      for(const floating of saved.workspace.floating)if(!saved.workspace.panes.some((p:{id:string})=>p.id===floating?.id))throw Error('invalid-layout');
      for(const pane of saved.workspace.panes){
        if(!pane||typeof pane!=='object')throw Error('invalid-layout');
        if(pane.kind===undefined||pane.kind==='session'){
          if(typeof pane.sessionKey!=='string')throw Error('invalid-layout');layoutKeys.add(pane.sessionKey);
        }
      }
      const known=new Set(catalog.members.map(m=>m.sessionId));if([...layoutKeys].some(k=>!known.has(k)))throw Error('layout-member-unavailable');
    }
    const members=catalog.members.filter(m=>(!s.groupId||m.groupId===s.groupId)&&(!s.connectionId||m.connectionId===s.connectionId)
      &&(!s.runtime||m.runtime===s.runtime)&&(!layoutKeys||layoutKeys.has(m.sessionId))
      &&(!s.tags.length||(s.tagMode==='all'?s.tags.every(t=>m.tags.includes(t)):s.tags.some(t=>m.tags.includes(t)))));
    if(members.length>128)throw Error('narrow-scope');
    return{members,revision:createHash('sha256').update(JSON.stringify([catalog.generation,catalog.preferencesRevision,catalog.members,layout])).digest('hex')};
  };
  const collect=async(r:UsageManifest,creating:boolean,check:()=>void,request:Request)=>{
    const trace=performanceDiagnostics.start('usage-manifest-collection');let failed=true;
    try{
    const bounded=AbortSignal.any([request.signal,AbortSignal.timeout(15000)]);
    const dispatchCheck=()=>{check();if(bounded.aborted)throw Error('collection-aborted');store.read(r.owner,r.requestId);};
    for(const member of r.members){
      if(bounded.aborted){trace.add('deferred',1);break;}dispatchCheck();
      if(member.state==='complete'||(!creating&&member.state==='prepared'))continue;
      if(creating&&!await store.claimAsync(r.owner,r.requestId,member.requestId,dispatchCheck))continue;
      dispatchCheck();
      const decoded=decodeHubSessionId(member.member.sessionId);
      if(!decoded||decoded.connectionId!==member.member.connectionId)throw Error('member-identity');
      try{
        const client=await requestConnectorClient(deps,request,decoded.connectionId,false,r.owner,undefined,bounded);
        dispatchCheck();
        const raw=await client.json<unknown>(
          `/sessions/${encodeURIComponent(decoded.remoteSessionKey)}/token-usage/snapshots${creating?'':'/'+member.requestId}`,
          {signal:bounded,...(creating?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:member.requestId,from:r.selection.from,to:r.selection.to,bucketMs:r.selection.bucketMs})}:{})});
        dispatchCheck();store.record(r.owner,r.requestId,member.requestId,raw);trace.add('records',1);
      }catch{trace.add('unknown',1);/* Unknown is durable. Do not re-POST or fabricate zero usage. */}
    }
    check();const result=store.read(r.owner,r.requestId)!;failed=false;return result;
    }finally{trace.finish(failed);}
  };
  app.post(base,safe(async c=>{
    const{owner,check}=scope(c);const s=usageSelection(await readJsonBody(c.req.raw,4096));
    return exclusive(owner,s.requestId,async()=>{
      const old=store.read(owner,s.requestId);if(old){if(JSON.stringify(old.selection)!==JSON.stringify(s))throw Error('request-reused');return c.json({manifest:store.view(old)});}
      const selected=await selection(owner,s,c.req.raw,check);check();
      return c.json({manifest:store.view(await store.prepareAsync(owner,s,selected.revision,selected.members,check))},201);
    });
  }));
  app.get(`${base}/:id`,safe(async c=>{
    const{owner,check}=scope(c),id=tokenSnapshotRequestId(c.req.param('id'));
    return exclusive(owner,id,async()=>{if(store.cancelled(owner,id))return c.json({manifest:null,cancelled:true,requestId:id});let r=store.read(owner,id);if(!r)throw new HTTPException(404);
      if(r.state==='collecting')r=await collect(r,false,check,c.req.raw);check();return c.json({manifest:store.view(r)});});
  }));
  app.post(`${base}/:id/confirm`,safe(async c=>{
    const{owner,check}=scope(c),id=tokenSnapshotRequestId(c.req.param('id')),body=await readJsonBody(c.req.raw,32);
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw new HTTPException(400);
    return exclusive(owner,id,async()=>{
      let r=store.read(owner,id);if(!r)throw new HTTPException(404);
      if(r.state!=='prepared')return c.json({manifest:store.view(r)});
      const selected=await selection(owner,r.selection,c.req.raw,check);check();if(selected.revision!==r.directoryRevision)throw Error('scope-changed');
      const confirmed=store.confirm(owner,id);r=confirmed.receipt;
      if(confirmed.claimed)r=await collect(r,true,check,c.req.raw);check();return c.json({manifest:store.view(r)});
    });
  }));
  // Explicitly continue only members that have NEVER been dispatched. Original
  // UNKNOWN claims are never posted again, even across process loss/coordinators.
  app.post(`${base}/:id/continue`,safe(async c=>{
    const{owner,check}=scope(c),id=tokenSnapshotRequestId(c.req.param('id')),body=await readJsonBody(c.req.raw,32);
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw new HTTPException(400);
    return exclusive(owner,id,async()=>{
      let r=store.read(owner,id);if(!r)throw new HTTPException(404);
      if(r.state==='collecting')r=await collect(r,true,check,c.req.raw);
      check();return c.json({manifest:store.view(r)});
    });
  }));
  app.delete(`${base}/:id`,safe(async c=>{const{owner}=scope(c),id=tokenSnapshotRequestId(c.req.param('id'));store.cancel(owner,id);return c.json({manifest:null,cancelled:true,requestId:id});}));
  return{close(){closed=true;}};
}
