import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTPException } from 'hono/http-exception';
import { WORKSPACE_FILE_CARD_MAX_BYTES, validWorkspaceFileCardResource } from '@agentopsdeck/shared';
import type { AsyncHubContentDocuments } from '../hub/async-content-documents.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { validHubContentDocumentCommand, type HubContentDocumentCommand } from '../hub/member-content-document-domain.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { readJsonBody } from '../utils/http-body.js';

/** Original document ownership/receipts only, not replica/network execution. */
export function registerAsyncHubContentDocuments(app:Hono,deps:{access:AsyncHubContentDocuments;enabled:()=>boolean}) {
  const base='/api/hub/v1/workspace/shared-content/:resourceId',work=new HubRequestWork(16);
  type Scope=Awaited<ReturnType<AsyncHubContentDocuments['begin']>>;
  const safe=(step:number,build:(c:Context,scope:Scope,resourceId:string)=>Promise<HubContentDocumentCommand>|HubContentDocumentCommand)=>async(c:Context)=>{
    c.header('Cache-Control','no-store');
    const trace=performanceDiagnostics.start('hub-content-document-http');trace.add('step',step);const warning=setTimeout(()=>trace.reportPending({pending:1}),30_000);warning.unref();let failed=true;
    try {
      const response=await work.run(async()=>{
        const request=new Request(c.req.url,{headers:new Headers(c.req.raw.headers),signal:c.req.raw.signal});
        const scope=await deps.access.begin(request),resourceId=c.req.param('resourceId')!;
        if(!validWorkspaceFileCardResource(resourceId)||c.req.url.includes('?'))throw new HTTPException(400);
        const command=await build(c,scope,resourceId);
        if(!validHubContentDocumentCommand(command))throw new HTTPException(400);
        const mutation=['migrate','migration-recover','write','write-recover'].includes(command.action);
        if(mutation&&!deps.enabled())throw new HTTPException(503);
        work.check();const result=await scope.command(command);await scope.check();
        if(mutation&&!deps.enabled())throw new HTTPException(503);
        if(!('receipt'in result))throw new HTTPException(503);
        if(!('termination'in result))throw new HTTPException(503);
        return c.json(command.action==='migrate'||command.action==='write'?{receipt:result.receipt}:{receipt:result.receipt,termination:result.termination});
      });
      failed=false;return response;
    } catch(error) {
      const raw=error instanceof HTTPException||error instanceof HubMemberRequestError?error.status:503;
      const status:ContentfulStatusCode=raw>=400&&raw<=599?raw as ContentfulStatusCode:503;
      return c.json({error:'shared_content_unavailable_inspect_original'},status);
    } finally {clearTimeout(warning);trace.finish(failed);}
  };
  const body=async(c:Context,scope:Scope,names:string[])=>{
    const value=await readJsonBody(c.req.raw,WORKSPACE_FILE_CARD_MAX_BYTES+8192);await scope.check();work.check();
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...names].sort().join(','))throw new HTTPException(400);
    return value as Record<string,unknown>;
  };
  app.post(`${base}/migrate`,safe(1,async(c,scope,resourceId)=>({action:'migrate',resourceId,...await body(c,scope,['revision','requestId'])} as HubContentDocumentCommand)));
  app.get(`${base}/migrations/:requestId`,safe(2,(c,_scope,resourceId)=>({action:'migration-read',resourceId,requestId:c.req.param('requestId')!})));
  app.post(`${base}/migrations/:requestId/recover`,safe(3,async(c,scope,resourceId)=>{
    await body(c,scope,[]);return {action:'migration-recover',resourceId,requestId:c.req.param('requestId')!};
  }));
  app.put(`${base}/document`,safe(4,async(c,scope,resourceId)=>({action:'write',resourceId,...await body(c,scope,['mutationId','modeEpoch','baseRevision','baseHash','content'])} as HubContentDocumentCommand)));
  app.get(`${base}/writes/:epoch/:mutationId`,safe(5,(c,_scope,resourceId)=>({action:'write-read',resourceId,epoch:c.req.param('epoch')!,mutationId:c.req.param('mutationId')!})));
  app.post(`${base}/writes/:epoch/:mutationId/recover`,safe(6,async(c,scope,resourceId)=>{
    await body(c,scope,[]);return {action:'write-recover',resourceId,epoch:c.req.param('epoch')!,mutationId:c.req.param('mutationId')!};
  }));
  let closing:Promise<void>|undefined;
  return {close:()=>closing??=(async()=>{await work.close();await deps.access.close();})()};
}
