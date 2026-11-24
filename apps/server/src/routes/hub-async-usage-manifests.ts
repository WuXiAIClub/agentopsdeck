import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { tokenSnapshotRequestId } from '@agentopsdeck/shared';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import type { AsyncHubUsageManifests } from '../hub/async-usage-manifests.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import { ConnectorClientError } from '../hub/connector-client.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import { usageSelection, type UsageManifest, type UsageSelection } from '../hub/usage-manifests.js';
import { sessionDirectoryPage, sessionDirectoryParams } from '../projection/session-directory.js';
import { readJsonBody } from '../utils/http-body.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

export function registerAsyncHubUsageManifests(app: Hono, deps: { access: AsyncHubUsageManifests; asyncConnectorClient?: AsyncConnectorClientResolver }) {
  const base = '/api/hub/v1/usage-manifests', work = new HubRequestWork(8), active = new Set<string>();
  type Scope = Awaited<ReturnType<AsyncHubUsageManifests['begin']>>;
  // Fixed stages: prepare=1, read=2, confirm=3, continue=4, cancel=5.
  // No request IDs, URLs, credentials or selection content in diagnostic rows.
  const safe = (step: number, fn: (c: Context, scope: Scope, request: Request) => Promise<Response>) => async (c: Context) => {
    c.header('Cache-Control','no-store');
    const trace = performanceDiagnostics.start('hub-usage-manifest-http'); trace.add('step',step); let failed = true;
    try {
      const response = await work.run(async () => {
        if (c.req.url.includes('?')) throw new HTTPException(400);
        // Copy the original credentials before any await, independently of body.
        const request = new Request(c.req.url,{ headers: new Headers(c.req.raw.headers), signal: c.req.raw.signal });
        const scope = await deps.access.begin(request);
        const response = await fn(c,scope,request);
        await scope.check(); work.check(); return response;
      });
      failed = false; return response;
    } catch (error) {
      const status = error instanceof HubMemberRequestError || error instanceof HTTPException || error instanceof ConnectorClientError ? error.status : 409;
      return new Response(JSON.stringify({ error: 'Usage scope unavailable. Inspect the original request; partial member totals are not shown.' }),
        { status, headers: { 'Cache-Control':'no-store','Content-Type':'application/json' } });
    } finally { trace.finish(failed); }
  };
  const exclusive = async (scope: Scope, id: string, fn: () => Promise<Response>) => {
    const key = JSON.stringify([scope.owner,id]);
    if (active.has(key)) throw new HTTPException(409);
    active.add(key); try { return await fn(); } finally { active.delete(key); }
  };
  const client = async (scope: Scope, request: Request, connectionId: string, signal: AbortSignal) => {
    work.check(); await scope.check();
    if (!deps.asyncConnectorClient) throw new HubMemberRequestError(503);
    try {
      const value = await deps.asyncConnectorClient(new Request(request.url,{ headers: request.headers,signal }),connectionId,{ expectedUserId: scope.owner });
      await scope.check(); work.check(); return value;
    } catch (error) { await scope.check(); work.check(); throw error; }
  };
  const enumerate = async (scope: Scope, request: Request, selection: UsageSelection) => {
    const snapshot = await scope.command({ action:'catalog',selection });
    if (snapshot.action !== 'catalog') throw new HubMemberRequestError(503);
    const pin = snapshot.catalog.pin, entries: { connectionId: string; sessionKey: string; runtime: string }[] = [];
    const bounded = AbortSignal.any([request.signal,AbortSignal.timeout(5000)]);
    const check = async () => { work.check(); bounded.throwIfAborted(); await scope.command({ action:'check',selection,pin }); };
    for (const connection of snapshot.catalog.connections) {
      await check(); const connectionClient = await client(scope,request,connection.id,bounded); await check();
      let after: string | undefined, source: string | undefined;
      const cursors = new Set<string>();
      for (let pageCount = 0; ; pageCount++) {
        if (pageCount >= 101) throw Error('catalog-limit');
        await check(); const query = { limit:100, ...(after ? { after } : {}) };
        let raw: unknown;
        try { raw = await connectionClient.jsonOriginal(`/sessions/directory?${sessionDirectoryParams(query)}`,{ signal:bounded }); }
        catch (error) { await check(); throw error; }
        await check(); const page = sessionDirectoryPage(raw,query);
        if (!page.sourceCursor || source !== undefined && source !== page.sourceCursor) throw Error('catalog-source-changed');
        source = page.sourceCursor;
        for (const entry of page.sessions) {
          if (entries.length >= 10000) throw Error('catalog-limit');
          entries.push({ connectionId:connection.id,...entry });
        }
        if (page.nextCursor === null) break;
        if (!page.nextCursor || cursors.has(page.nextCursor)) throw Error('catalog-cursor-loop');
        cursors.add(page.nextCursor); after = page.nextCursor;
      }
    }
    await check(); return { selection,pin,entries };
  };
  const read = async (scope: Scope,id: string) => {
    const result = await scope.command({ action:'read',id });
    if (result.action !== 'read') throw new HubMemberRequestError(503);
    return result;
  };
  const view = async (c: Context,scope: Scope,id: string,status: 200 | 201 = 200) => {
    const result = await scope.command({ action:'view',id });
    if (result.action !== 'view') throw new HubMemberRequestError(503);
    return result.cancelled ? c.json({ manifest:null,cancelled:true,requestId:id }) : c.json({ manifest:result.view },status);
  };
  const collect = async (scope: Scope,request: Request,r: UsageManifest,creating: boolean) => {
    const trace = performanceDiagnostics.start('usage-manifest-collection'); let failed = true;
    const bounded = AbortSignal.any([request.signal,AbortSignal.timeout(15000)]);
    const check = async () => { work.check(); await scope.check(); bounded.throwIfAborted(); await read(scope,r.requestId); };
    try {
      for (const member of r.members) {
        if (bounded.aborted) { trace.add('deferred',1); break; }
        await check();
        if (member.state === 'complete' || !creating && member.state === 'prepared') continue;
        // Even an explicit continue never re-POSTs UNKNOWN. Recovery is GET of
        // the original child requestId, with its original immutable range.
        const post = creating && member.state === 'prepared';
        if (post) {
          const claim = await scope.command({ action:'claim',id:r.requestId,childId:member.requestId });
          if (claim.action !== 'claim') throw new HubMemberRequestError(503);
          if (!claim.claimed) continue;
        }
        await check();
        const decoded = decodeHubSessionId(member.member.sessionId);
        if (!decoded || decoded.connectionId !== member.member.connectionId) throw Error('member-identity');
        try {
          const connectionClient = await client(scope,request,decoded.connectionId,bounded); await check();
          const snapshot: unknown = await connectionClient.jsonOriginal(`/sessions/${encodeURIComponent(decoded.remoteSessionKey)}/token-usage/snapshots${post ? '' : '/'+member.requestId}`,
            { signal:bounded,...(post ? { method:'POST',headers:{ 'content-type':'application/json' },body:JSON.stringify({ requestId:member.requestId,from:r.selection.from,to:r.selection.to,bucketMs:r.selection.bucketMs }) } : {}) });
          await check(); await scope.command({ action:'record',id:r.requestId,childId:member.requestId,snapshot }); trace.add('records',1);
        } catch (error) {
          // Do not let a transport error hide revocation, changed member epoch,
          // closure or cancellation. A permitted failed snapshot stays UNKNOWN.
          await check(); trace.add('unknown',1);
        }
      }
      await scope.check(); work.check(); failed = false;
    } finally { trace.finish(failed); }
  };
  const emptyBody = async (c: Context,scope: Scope) => {
    const body = await readJsonBody(c.req.raw,32); await scope.check(); work.check();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new HTTPException(400);
  };
  app.post(base,safe(1,async (c,scope,request) => {
    const body = await readJsonBody(c.req.raw,4096); await scope.check(); work.check();
    const selection = usageSelection(body);
    return exclusive(scope,selection.requestId,async () => {
      const old = await read(scope,selection.requestId);
      if (old.receipt) {
        if (JSON.stringify(old.receipt.selection) !== JSON.stringify(selection)) throw Error('request-reused');
        return view(c,scope,selection.requestId);
      }
      const selected = await enumerate(scope,request,selection);
      await scope.command({ action:'prepare',...selected });
      return view(c,scope,selection.requestId,201);
    });
  }));
  app.get(`${base}/:id`,safe(2,async (c,scope,request) => {
    const id = tokenSnapshotRequestId(c.req.param('id'));
    return exclusive(scope,id,async () => {
      const old = await read(scope,id);
      if (!old.cancelled && !old.receipt) throw new HTTPException(404);
      if (old.receipt?.state === 'collecting') await collect(scope,request,old.receipt,false);
      return view(c,scope,id);
    });
  }));
  for (const action of ['confirm','continue'] as const) app.post(`${base}/:id/${action}`,safe(action === 'confirm' ? 3 : 4,async (c,scope,request) => {
    const id = tokenSnapshotRequestId(c.req.param('id')); await emptyBody(c,scope);
    return exclusive(scope,id,async () => {
      const old = await read(scope,id); let receipt = old.receipt;
      if (!receipt) throw new HTTPException(404);
      let creating = action === 'continue';
      if (action === 'confirm' && receipt.state === 'prepared') {
        const selection = await enumerate(scope,request,receipt.selection);
        const confirmed = await scope.command({ action:'confirm',id,...selection });
        if (confirmed.action !== 'confirm' || !confirmed.receipt) throw new HubMemberRequestError(503);
        receipt = confirmed.receipt; creating = confirmed.claimed;
      }
      if (receipt.state === 'collecting') await collect(scope,request,receipt,creating);
      return view(c,scope,id);
    });
  }));
  app.delete(`${base}/:id`,safe(5,async (c,scope) => {
    const id = tokenSnapshotRequestId(c.req.param('id')); await scope.command({ action:'cancel',id });
    return c.json({ manifest:null,cancelled:true,requestId:id });
  }));
  let closing: Promise<void> | undefined;
  return { close: () => { closing ??= work.close().then(() => deps.access.close()); return closing; } };
}
