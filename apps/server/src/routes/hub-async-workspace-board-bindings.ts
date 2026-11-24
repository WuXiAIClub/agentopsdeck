import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validBoardId, validBoardUuid } from '@agentopsdeck/shared';
import type { AsyncHubBoardBindings } from '../hub/async-board-bindings.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { ConnectorClientError } from '../hub/connector-client.js';
import { validHubBoardBindingInput } from '../hub/workspace-board-bindings.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import type { HubBoardBindingTarget } from '../hub/member-board-binding-domain.js';
import { readJsonBody } from '../utils/http-body.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

type Remote = { runtime: string; sessionId: string; binding: null | { id: string; runtime: string; sessionId: string; expiresAt: number; state: string } };
const validRemote = (v: Remote | undefined): v is Remote => !!v && ['claude-code','ghcp','codex'].includes(v.runtime) && validBoardUuid(v.sessionId)
  && (v.binding === null || !!v.binding && validBoardUuid(v.binding.id) && v.binding.runtime === v.runtime && v.binding.sessionId === v.sessionId
    && Number.isSafeInteger(v.binding.expiresAt) && ['installed','removed'].includes(v.binding.state));

/** Five-entry whole-request owner. Original SQL and transport work remain
 * owned through abort/close; unknown installation is never replayed. */
export function registerAsyncHubBoardBindings(app: Hono, deps: { access: AsyncHubBoardBindings;
  asyncConnectorClient?: AsyncConnectorClientResolver; endpoint?: string }) {
  const base = '/api/hub/v1/workspace/boards/:boardId/bindings', work = new HubRequestWork(16), control = new HubRequestWork(4), pending = new Set<string>();
  type Scope = Awaited<ReturnType<AsyncHubBoardBindings['begin']>>;
  const safe = (step: number, fn: (c: Context, scope: Scope, board: string, request: Request) => Promise<Response>) => async (c: Context) => {
    c.header('Cache-Control','no-store');
    const trace = performanceDiagnostics.start('hub-board-binding-http'); trace.add('step',step); let failed = true;
    try {
      // Reads/installations cannot consume the bounded cancellation reserve.
      const lane = step === 4 || step === 5 ? control : work;
      const response = await lane.run(async () => {
        const request = new Request(c.req.url,{headers:new Headers(c.req.raw.headers),signal:c.req.raw.signal});
        const scope = await deps.access.begin(request), board = c.req.param('boardId')!;
        if (!validBoardId(board)) throw new HTTPException(404);
        const value = await fn(c,scope,board,request); await scope.check(); work.check(); return value;
      });
      failed = false; return response;
    } catch (error) {
      const status = error instanceof HTTPException || error instanceof HubMemberRequestError || error instanceof ConnectorClientError ? error.status : 502;
      return new Response(JSON.stringify({error:'Task binding unavailable. Inspect the original binding; no message was sent.'}),
        {status,headers:{'Cache-Control':'no-store','Content-Type':'application/json'}});
    } finally { trace.finish(failed); }
  };
  const id = (c: Context) => { const value = c.req.param('id')!; if (!validBoardUuid(value)) throw new HTTPException(404); return value; };
  const target = async (scope: Scope, board: string, sessionId: string) =>
    (await scope.command({action:'target',boardId:board,sessionId})).target;
  const check = async (scope: Scope, board: string, pin: HubBoardBindingTarget) => {
    work.check(); await scope.command({action:'check',boardId:board,target:pin}); work.check();
  };
  const remote = async (scope: Scope, board: string, request: Request, pin: HubBoardBindingTarget) => {
    await check(scope,board,pin);
    if (!deps.asyncConnectorClient) throw new HubMemberRequestError(503);
    try {
      const client = await deps.asyncConnectorClient(request,pin.connectionId,{expectedUserId:scope.owner,boardBindingsOnly:true});
      await check(scope,board,pin);
      return { client,path:`/sessions/${encodeURIComponent(pin.remoteSessionKey)}/board-binding` };
    } catch (error) { await check(scope,board,pin); throw error; }
  };
  const readRemote = async (scope: Scope, board: string, request: Request, pin: HubBoardBindingTarget,
    lane: Awaited<ReturnType<typeof remote>>) => {
    let value: Remote;
    try { value = await lane.client.jsonOriginal<Remote>(lane.path,{signal:request.signal}); }
    catch (error) { await check(scope,board,pin); throw error; }
    await check(scope,board,pin);
    if (!validRemote(value) || !pin.remoteSessionKey.startsWith(value.runtime+':')) throw new HTTPException(502);
    return value;
  };
  app.get(base,safe(1,async (c,scope,board) => {
    const value = await scope.command({action:'list',boardId:board});
    return c.json({enabled:!!deps.endpoint && value.enabled,bindings:value.bindings});
  }));
  app.post(base,safe(2,async (c,scope,board,request) => {
    const input = await readJsonBody(c.req.raw,16_384); await scope.check(); work.check();
    if (!validHubBoardBindingInput(input)) throw new HTTPException(400);
    const decoded = decodeHubSessionId(input.sessionId);
    if (!decoded || !/^(codex|claude-code|ghcp):/.test(decoded.remoteSessionKey)) throw new HTTPException(400);
    if (!deps.endpoint) throw new HTTPException(503);
    const catalog = await scope.command({action:'list',boardId:board}); if (!catalog.enabled) throw new HTTPException(503);
    const pin = await target(scope,board,input.sessionId), key = JSON.stringify([scope.owner,input.sessionId]);
    if (pending.has(key)) throw new HTTPException(409);
    pending.add(key);
    try {
      const original = await scope.command({action:'read',boardId:board,id:input.requestId});
      if (original.binding) {
        const matched = await scope.command({action:'prepare',boardId:board,input,target:pin,endpoint:deps.endpoint});
        if (!matched.binding) throw new HTTPException(409);
        await check(scope,board,pin); return c.json({binding:matched.binding,repeated:true});
      }
      const lane = await remote(scope,board,request,pin), found = await readRemote(scope,board,request,pin,lane);
      if (found.binding?.state === 'installed') throw new HTTPException(409);
      const prepared = await scope.command({action:'prepare',boardId:board,input,target:pin,endpoint:deps.endpoint});
      if (!prepared.binding) throw new HTTPException(409);
      const claim = await scope.command({action:'claim',boardId:board,id:input.requestId,target:pin});
      if (!claim.credential) { await check(scope,board,pin); return c.json({binding:claim.binding,repeated:true}); }
      // UNKNOWN is durable before PUT. Never expose this private credential.
      try {
        await check(scope,board,pin);
        const result = await lane.client.jsonOriginal<{ binding: Remote['binding'] }>(lane.path,
          {method:'PUT',body:JSON.stringify({id:input.requestId,credential:claim.credential}),signal:request.signal});
        await check(scope,board,pin);
        if (!validRemote({...found,binding:result?.binding}) || result.binding?.id !== input.requestId || result.binding.state !== 'installed'
          || result.binding.expiresAt !== claim.binding.expiresAt) throw new HTTPException(502);
        const settled = await scope.command({action:'outcome',boardId:board,id:input.requestId,target:pin,state:'installed'});
        await check(scope,board,pin); return c.json({binding:settled.binding},201);
      } catch {
        await check(scope,board,pin);
        const value = await scope.command({action:'read',boardId:board,id:input.requestId}); return c.json({binding:value.binding},202);
      }
    } finally { pending.delete(key); }
  }));
  app.get(`${base}/:id`,safe(3,async (c,scope,board,request) => {
    const requestId = id(c), original = await scope.command({action:'read',boardId:board,id:requestId});
    if (!original.binding) throw new HTTPException(404);
    if (['revoked','expired','unavailable'].includes(original.binding.state)) return c.json({binding:original.binding});
    const pin = await target(scope,board,original.binding.sessionId), lane = await remote(scope,board,request,pin);
    const found = await readRemote(scope,board,request,pin,lane);
    const installed = found.binding?.id === requestId && found.binding.expiresAt === original.binding.expiresAt && found.binding.state === 'installed';
    const settled = await scope.command({action:'outcome',boardId:board,id:requestId,target:pin,state:installed ? 'installed' : 'uncertain'});
    await check(scope,board,pin); return c.json({binding:settled.binding});
  }));
  app.post(`${base}/:id/cancel-intent`,safe(4,async (c,scope,board) => {
    const requestId = id(c); if (c.req.url.includes('?')) throw new HTTPException(400);
    const body = await readJsonBody(c.req.raw,64); await scope.check(); work.check();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new HTTPException(400);
    const result = await scope.command({action:'cancel',boardId:board,id:requestId});
    return c.json({cancelled:result.cancelled,requestId:result.requestId,binding:result.binding});
  }));
  app.delete(`${base}/:id`,safe(5,async (c,scope,board,request) => {
    const requestId = id(c), revoked = await scope.command({action:'revoke',boardId:board,id:requestId});
    if (!revoked.binding) throw new HTTPException(404);
    let cleanup = 'pending', pin: HubBoardBindingTarget | undefined;
    try {
      pin = await target(scope,board,revoked.binding.sessionId);
      const lane = await remote(scope,board,request,pin);
      const result = await lane.client.jsonOriginal<{id:string;state:string}>(`${lane.path}/${encodeURIComponent(requestId)}`,{method:'DELETE',signal:request.signal});
      await check(scope,board,pin); if (result?.id === requestId && result.state === 'removed') cleanup = 'confirmed';
    } catch { /* Revoke remains committed; recovery never reinstalls. */ }
    if (pin) await check(scope,board,pin);
    await scope.check(); return c.json({binding:revoked.binding,cleanup});
  }));
  let closing: Promise<void> | undefined;
  // Array evaluation freezes BOTH lanes synchronously, before any await or
  // private SQL lane retirement. Aborts never release original transport work.
  return { close: () => closing ??= Promise.all([work.close(),control.close()]).then(() => deps.access.close()) };
}
