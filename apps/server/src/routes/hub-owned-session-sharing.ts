import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { decodeHubSessionId } from '../hub/session-id.js';
import { readJsonBody } from '../utils/http-body.js';
import { sharingOutcome, SHARING_UNKNOWN } from './hub-sharing-outcome.js';
import { AsyncHubOwnedSessionSharing, HubOwnedSessionSharingError } from '../hub/async-owned-session-sharing.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import type { SessionShareOptions } from '../hub/node-grants.js';
import { requireLegacyHubRoute, type LegacyHubRouteDependencies, type AsyncOnlyHubRouteDependencies } from './hub-legacy-dependencies.js';

type OwnedSharingPorts = { asyncOwnedSharing?: Pick<AsyncHubOwnedSessionSharing,'begin'> };
export function registerHubOwnedSessionSharingRoutes(app: Hono, deps: OwnedSharingPorts & (LegacyHubRouteDependencies
  | AsyncOnlyHubRouteDependencies & Required<OwnedSharingPorts>)) {
  if (deps.mode === 'async' && !deps.asyncOwnedSharing?.begin) throw Error('hub_owned_sharing_ports_required');
  const path = '/api/hub/v1/sessions/:sessionId/collaborators', legacy = () => requireLegacyHubRoute(deps);
  const access = (context: Context) => {
    context.header('Cache-Control', 'no-store');
    const actor = legacy().principal(context), decoded = decodeHubSessionId(context.req.param('sessionId')!);
    if (!decoded || !decoded.remoteSessionKey.startsWith('codex:')) throw new HTTPException(404);
    const target = { ownerUserId: actor.userId, userId: actor.userId, connectionId: decoded.connectionId };
    const connection = legacy().hubStore.getConnection(target.connectionId, target.ownerUserId);
    if (!connection?.nodeId || connection.status === 'disabled') throw new HTTPException(404);
    const nodeVersion = legacy().hubStore.connectionAuthority(target.connectionId, target.ownerUserId)!;
    const resource = { runtime: 'codex' as const, sessionKey: decoded.remoteSessionKey };
    const revalidate = () => {
      const current = legacy().hubStore.getConnection(target.connectionId, target.ownerUserId);
      if (legacy().principal(context).userId !== actor.userId || !current || current.status === 'disabled'
        || legacy().hubStore.connectionAuthority(target.connectionId, target.ownerUserId) !== nodeVersion) throw new HTTPException(409);
    };
    const rows = () => legacy().hubStore.grants.sessionGrants(target, resource).filter(grant => grant.nodeVersion === nodeVersion);
    return { target, resource, nodeVersion, revalidate, rows };
  };
  const asynchronous=async(work:()=>Promise<Response>)=>{
    try{return await work();}catch(error){
      if(error instanceof HTTPException)throw error;
      if(error instanceof HubOwnedSessionSharingError&&error.status===409&&error.conflict!=='precondition')
        return Response.json({error:error.conflict==='membership'?'Set this member’s Connector role first':'Access not saved. Refresh sharing and check the member environment role.'},{status:409,headers:{'Cache-Control':'no-store'}});
      if(error instanceof HubMemberRequestError&&error.status!==503){
        if(error.status===499)return new Response(null,{status:499,headers:{'Cache-Control':'no-store'}});throw new HTTPException(error.status);
      }
      return Response.json({error:SHARING_UNKNOWN},{status:503,headers:{'Cache-Control':'no-store'}});
    }
  };
  if(deps.asyncOwnedSharing)app.get(path,context=>asynchronous(async()=>{
    context.header('Cache-Control','no-store');
    const port=await deps.asyncOwnedSharing!.begin(context.req.raw,context.req.param('sessionId'));
    return context.json(await port.list());
  }));
  else app.get(path, context => {
    const auth = access(context);
    return context.json({ collaborators: auth.rows(), candidates: legacy().hubStore.roles.sessionCandidates(auth.target, auth.resource) });
  });
  const mutate = async (context: Context, operation: 'create' | 'update' | 'delete') => {
    context.header('Cache-Control','no-store');
    const port=deps.asyncOwnedSharing&&await deps.asyncOwnedSharing.begin(context.req.raw,context.req.param('sessionId')!);
    const auth=port?null:access(context),raw=await readJsonBody(context.req.raw,2048);
    if(port)await port.check();else auth!.revalidate();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HTTPException(400);
    const body = raw as Record<string, unknown>;
    const keys = operation === 'delete' ? ['version'] : [operation === 'create' ? 'userId' : 'version', 'role', 'live', 'media', 'queue'];
    if (Object.keys(body).some(key => !keys.includes(key)) || operation !== 'create' && (!Number.isSafeInteger(body.version) || Number(body.version) < 1)) throw new HTTPException(400);
    if (operation !== 'delete' && (!['observer', 'collaborator'].includes(String(body.role)) || ['live', 'queue', 'media'].some(key => key in body && typeof body[key] !== 'boolean'))) throw new HTTPException(400);
    if(port){
      if(operation==='delete')return context.json(await port.remove(context.req.param('grantId')!,body.version as number));
      const options:SessionShareOptions=Object.fromEntries(['live','queue','media'].filter(k=>Object.hasOwn(body,k)).map(k=>[k,body[k]]));
      if(operation==='create'){
        if(typeof body.userId!=='string')throw new HTTPException(400);
        return context.json(await port.create(body.userId,body.role as 'observer'|'collaborator',options),201);
      }
      return context.json(await port.update(context.req.param('grantId')!,body.version as number,body.role as 'observer'|'collaborator',options));
    }
    const previous = operation === 'create' ? undefined : auth!.rows().find(grant => grant.id === context.req.param('grantId'));
    if (operation !== 'create' && (!previous || previous.version !== body.version || legacy().hubStore.roles.managedGrant(previous.id))) throw new HTTPException(409);
    const userId = previous?.userId ?? body.userId;
    if (typeof userId !== 'string' || !legacy().hubStore.getUser(userId) || userId === auth!.target.ownerUserId) throw new HTTPException(400);
    const recipient = { ...auth!.target, userId };
    if (operation === 'delete') {
      const outcome = sharingOutcome(6, () => legacy().hubStore.grants.revoke(recipient, previous!.id, previous!.version));
      return outcome.ok ? context.json({ ok: outcome.value }) : context.json({ error: SHARING_UNKNOWN }, outcome.status);
    }
    if (!legacy().hubStore.roles.membership(recipient).version) return context.json({ error: 'Set this member’s Connector role first' }, 409);
    const outcome = sharingOutcome(operation === 'create' ? 4 : 5, () => legacy().hubStore.grants.saveSessionAccess(recipient, auth!.resource,
      body.role as 'observer' | 'collaborator', body, auth!.nodeVersion, previous ? { id: previous.id, version: previous.version } : undefined));
    if (outcome.ok) return context.json({ grant: outcome.value }, operation === 'create' ? 201 : 200);
    return context.json({ error: outcome.status === 503 ? SHARING_UNKNOWN : 'Access not saved. Refresh sharing and check the member environment role.' }, outcome.status);
  };
  app.post(path, context => asynchronous(()=>mutate(context, 'create')));
  app.put(`${path}/:grantId`, context => asynchronous(()=>mutate(context, 'update')));
  app.delete(`${path}/:grantId`, context => asynchronous(()=>mutate(context, 'delete')));
}
