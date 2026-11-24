import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTPException } from 'hono/http-exception';
import { validWorkspaceFileCardResource } from '@agentopsdeck/shared';
import type { AsyncHubContentDocuments } from '../hub/async-content-documents.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { contentOverviewResponses, type ContentOverviewResponses } from '../hub/content-overview-responses.js';
import { contentOverviewView, matchesContentSnapshot, type ContentSnapshotRef } from '../hub/content-overview-domain.js';
import type { ContentBinding, ContentResource } from '../hub/content-proposal-store.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

/** Preserve the complete old wire response. No native/file/model effects,
 * partial JSON success, new identity resolver or request-time main-thread SQL. */
export function registerAsyncHubContentOverview(app:Hono,deps:{access:AsyncHubContentDocuments;enabled:()=>boolean;
  responses?:ContentOverviewResponses}) {
  const work=new HubRequestWork(64),responses=deps.responses??contentOverviewResponses;
  // Per-route delivered responses are cancelled on close without closing the
  // shared process budget used by another Hub composition.
  const deliveries=new Set<AbortController>();
  const handler=async(c:Context)=>{
    c.header('Cache-Control','no-store');
    const started=performance.now();
    const trace=performanceDiagnostics.start('hub-content-overview-http');trace.add('step',1);const warning=setTimeout(()=>trace.reportPending({pending:1}),30_000);warning.unref();let failed=true;
    try {
      const response=await work.run(async()=>{
        const resourceId=c.req.param('resourceId')!;
        const view=contentOverviewView(c.req.url);
        if(!validWorkspaceFileCardResource(resourceId)||view==='invalid')throw new HTTPException(400);
        const scope=await deps.access.begin(new Request(c.req.url,{headers:new Headers(c.req.raw.headers),signal:c.req.raw.signal}));
        const authenticated=performance.now();
        const original=await scope.command({action:'overview',resourceId,...(view==='hot'?{nativeView:'hot' as const}:{})});
        const readAt=performance.now();
        if(original.action!=='overview')throw new HTTPException(503);
        const manifest=original.manifest,reservation=responses.reserve(manifest.responseBytes);
        trace.add('step',2);
        try {
          const read=async(ref:ContentSnapshotRef,source:{source:'head'}|{source:'binding';id:string;generation:string})=>{
            work.check();
            const reply=await scope.command({action:'overview-snapshot',resourceId,snapshot:ref,...source});
            if(reply.action!=='overview-snapshot'||!matchesContentSnapshot(ref,reply.snapshot))throw new HTTPException(503);
            return reply.snapshot;
          };
          // Each immutable original snapshot is <=2MiB content. Do not reserve
          // a whole >32MiB overview on the shared SQL/RPC result lane.
          const head=manifest.head?await read(manifest.head,{source:'head'}):null;
          const cache=new Map<string,ContentResource>();
          if(head)cache.set(JSON.stringify([head.epoch,head.revision,head.hash]),head);
          const bindings:ContentBinding[]=[];
          for(const binding of manifest.bindings){
            const {initial:reference,...metadata}=binding;
            if(!reference){bindings.push(metadata);continue;}
            const ref=reference,key=JSON.stringify([ref.epoch,ref.revision,ref.hash]);
            let initial=cache.get(key);
            if(!initial) {
              initial=await read(ref,{source:'binding',id:binding.id,generation:binding.generation});cache.set(key,initial);
            }
            if(!matchesContentSnapshot(ref,initial))throw new HTTPException(503);
            bindings.push({...binding,initial});
          }
          work.check();await scope.check();work.check();trace.add('step',3);
          const body=JSON.stringify({enabled:deps.enabled(),head,native:manifest.native,bindings,...(manifest.nativeView?{nativeView:manifest.nativeView}:{})});
          const timing=`auth;dur=${(authenticated-started).toFixed(1)}, owner;dur=${(readAt-authenticated).toFixed(1)}, assemble;dur=${(performance.now()-readAt).toFixed(1)}`;
          // enabled:false is one byte longer than true. A changed shape or a
          // missing body is corruption, not a reason to deliver partial data.
          if(Buffer.byteLength(body)<manifest.responseBytes-1)throw new HTTPException(503);
          // Hono suppresses GET response bodies for HEAD without consuming
          // our stream. Never leave a response-memory lease behind for HEAD.
          if(c.req.method==='HEAD')return new Response(null,{headers:{'Content-Type':'application/json','Cache-Control':'no-store','Server-Timing':timing}});
          const delivery=new AbortController();deliveries.add(delivery);
          const abort=()=>delivery.abort();c.req.raw.signal.addEventListener('abort',abort,{once:true});
          const cleanup=()=>{deliveries.delete(delivery);c.req.raw.signal.removeEventListener('abort',abort);};
          if(c.req.raw.signal.aborted)delivery.abort();
          try {
            const delivered=reservation.response(body,delivery.signal,cleanup);
            delivered.headers.set('Server-Timing',timing);
            return delivered;
          }catch(error){delivery.abort();cleanup();throw error;}
        }finally{reservation.release();}
      });
      failed=false;return response;
    }catch(error){
      const raw=error instanceof HTTPException||error instanceof HubMemberRequestError?error.status:503;
      const status:ContentfulStatusCode=raw>=400&&raw<=599?raw as ContentfulStatusCode:503;
      return c.json({error:'shared_content_unavailable_inspect_original'},status);
    }finally{clearTimeout(warning);trace.finish(failed);}
  };
  app.get('/api/hub/v1/workspace/shared-content/:resourceId',handler);
  let closing:Promise<void>|undefined;
  return {close:()=>{
    if(closing)return closing;
    const drained=work.close();for(const delivery of deliveries)delivery.abort();deliveries.clear();
    closing=(async()=>{await drained;await deps.access.close();})();return closing;
  }};
}
