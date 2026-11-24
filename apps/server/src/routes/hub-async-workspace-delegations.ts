import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTPException } from 'hono/http-exception';
import { validBoardId, validBoardUuid } from '@agentopsdeck/shared';
import type { AsyncHubDelegations } from '../hub/async-delegations.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { ConnectorClientError } from '../hub/connector-client.js';
import { validHubDelegationCommand, type HubDelegationCommand } from '../hub/member-delegation-domain.js';
import { asyncDelegationCatalog, type DelegationScope } from '../hub/async-workspace-delegation-directory.js';
import { AsyncDelegationRunner } from '../hub/async-workspace-delegation-runner.js';
import { readJsonBody } from '../utils/http-body.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

/** Whole four-entry production chain. Private SQL ACK lane lives until BOTH
 * ordinary effects and the independently bounded cancellation reserve drain. */
export function registerAsyncHubDelegations(app:Hono,deps:{access:AsyncHubDelegations;
  asyncConnectorClient?:AsyncConnectorClientResolver;endpoint?:string}) {
  const base = '/api/hub/v1/workspace/boards/:boardId/delegations';
  const work = new HubRequestWork(16), control = new HubRequestWork(4), active = new Set<string>();
  const safe = (step:number, fn:(c:Context,scope:DelegationScope,board:string,request:Request)=>Promise<Response>) => async (c:Context) => {
    c.header('Cache-Control','no-store');
    const trace = performanceDiagnostics.start('hub-delegation-http'); trace.add('step',step); let failed = true;
    try {
      const response = await (step === 4 ? control : work).run(async () => {
        const request = new Request(c.req.url,{headers:new Headers(c.req.raw.headers),signal:c.req.raw.signal});
        const scope = await deps.access.begin(request), board = c.req.param('boardId')!;
        if (!validBoardId(board) || c.req.url.includes('?')) throw new HTTPException(400);
        const value = await fn(c,scope,board,request); await scope.check(); return value;
      });
      failed = false; return response;
    } catch (error) {
      const rawStatus = error instanceof HTTPException || error instanceof HubMemberRequestError || error instanceof ConnectorClientError ? error.status : 502;
      const status: ContentfulStatusCode = rawStatus >= 400 && rawStatus <= 599 ? rawStatus as ContentfulStatusCode : 502;
      return c.json({error:'Batch unavailable; inspect the original request. No message was sent.'},status);
    } finally { trace.finish(failed); }
  };
  const id = (c:Context) => { const v = c.req.param('id')!; if (!validBoardUuid(v)) throw new HTTPException(404); return v; };
  const runner = (s:DelegationScope,r:Request,b:string) => new AsyncDelegationRunner(s,r,b,deps.asyncConnectorClient,deps.endpoint);
  const exclusive = async <T>(scope:DelegationScope,batchId:string,effect:()=>Promise<T>) => {
    const key = JSON.stringify([scope.owner,batchId]); if (active.has(key)) throw new HTTPException(409);
    active.add(key); try { return await effect(); } finally { active.delete(key); }
  };
  app.post(base,safe(1,async (c,scope,board,request) => {
    const body = await readJsonBody(c.req.raw,16384); await scope.check(); work.check();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HTTPException(400);
    // Validate wire fields before ANY enumeration/preflight. The catalog is
    // generated here, never accepted from the caller, including hidden extras.
    const command = {action:'prepare',boardId:board,...body,catalog:{generation:0,preferencesRevision:0,members:[]}};
    if (Object.keys(body).some(k => !['batchId','selection','taskIds','fields','expiresAt'].includes(k))
      || !validHubDelegationCommand(command) || command.action !== 'prepare') throw new HTTPException(400);
    if (!deps.endpoint) throw new HTTPException(503);
    return exclusive(scope,command.batchId,async () => {
      // Read preserves original missing-vs-existing behavior without a mutation.
      try { await scope.command({action:'read',boardId:board,batchId:command.batchId}); throw new HTTPException(409); }
      catch (error) { if (!(error instanceof HubMemberRequestError) || error.status !== 404) throw error; }
      const catalog = await asyncDelegationCatalog(scope,request,board,command.selection,command.taskIds,command.fields,deps.asyncConnectorClient);
      const result = await scope.command({...command,catalog} as Extract<HubDelegationCommand,{action:'prepare'}>);
      return c.json({batch:result.batch},201);
    });
  }));
  app.get(`${base}/:id`,safe(2,async (c,scope,board,request) => c.json({batch:await runner(scope,request,board).reconcile(id(c))})));
  app.post(`${base}/:id/confirm`,safe(3,async (c,scope,board,request) => {
    const batchId = id(c), body = await readJsonBody(c.req.raw,64); await scope.check(); work.check();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new HTTPException(400);
    return exclusive(scope,batchId,async () => {
      const original = await scope.command({action:'read',boardId:board,batchId});
      if (!original.batch) throw new HTTPException(404);
      if (original.batch.state !== 'prepared') return c.json({batch:original.batch});
      if (!deps.endpoint) throw new HTTPException(503);
      const p = original.batch.preview;
      const catalog = await asyncDelegationCatalog(scope,request,board,p.selection,p.resource.tasks.map(t => t.id),p.resource.fields,deps.asyncConnectorClient);
      await scope.command({action:'confirm',boardId:board,batchId,catalog});
      return c.json({batch:await runner(scope,request,board).run(batchId)});
    });
  }));
  app.delete(`${base}/:id`,safe(4,async (c,scope,board,request) => {
    const batchId = id(c), batch = await runner(scope,request,board).cancel(batchId);
    return c.json({batch,cancelled:true,batchId});
  }));
  let closing:Promise<void>|undefined;
  return {close:() => closing ??= Promise.all([work.close(),control.close()]).then(() => deps.access.close())};
}
