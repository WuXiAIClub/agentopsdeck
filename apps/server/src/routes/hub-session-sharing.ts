import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readJsonBody } from '../utils/http-body.js';
import { sharedSessionAccess } from './hub-shared-access.js';
import { sharingOutcome, SHARING_UNKNOWN } from './hub-sharing-outcome.js';
import type { AsyncHubSessionCollaborators } from '../hub/async-session-collaborators.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import type { AsyncHubSessionSharing } from '../hub/async-session-sharing.js';
import type { SessionShareOptions } from '../hub/node-grants.js';
import { requireLegacyHubRoute, type LegacyHubRouteDependencies, type AsyncOnlyHubRouteDependencies } from './hub-legacy-dependencies.js';

type SharingPorts = {
  asyncCollaborators?: Pick<AsyncHubSessionCollaborators, 'collaborators'>;
  asyncSharing?: Pick<AsyncHubSessionSharing, 'begin'>;
};
export function registerHubSessionSharingRoutes(app: Hono, deps: SharingPorts & (LegacyHubRouteDependencies
  | AsyncOnlyHubRouteDependencies & Required<SharingPorts>)) {
  if (deps.mode === 'async' && (!deps.asyncCollaborators?.collaborators || !deps.asyncSharing?.begin)) throw Error('hub_session_sharing_ports_required');
  const legacy = () => requireLegacyHubRoute(deps);
  const path = '/api/hub/v1/shared/:ownerUserId/sessions/:sessionId/collaborators';
  const access = (context: Context) => {
    const session = sharedSessionAccess(context, legacy());
    const proof = session.require('sessions:share');
    if (!legacy().hubStore.grants.ownedSession(proof)) throw new HTTPException(403, { message: 'Only the recorded session creator can share this session' });
    return { session, proof };
  };
  const asynchronous = async (work: () => Promise<Response>) => {
    try { return await work(); }
    catch (error) {
      if (error instanceof HTTPException) throw error;
      if (error instanceof HubMemberRequestError && error.status !== 503) {
        if (error.status === 499) return new Response(null, { status: 499, headers: { 'Cache-Control': 'no-store' } });
        throw new HTTPException(error.status);
      }
      return Response.json({ error: SHARING_UNKNOWN }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  };
  const options = (body: Record<string, unknown>): SessionShareOptions => Object.fromEntries(
    ['live', 'queue', 'media'].filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
  if (deps.asyncCollaborators) app.get(path, async context => {
    context.header('Cache-Control', 'no-store');
    try { return context.json(await deps.asyncCollaborators!.collaborators(context.req.raw, context.req.param('ownerUserId'), context.req.param('sessionId'))); }
    catch (error) {
      if (error instanceof HubMemberRequestError && error.status !== 503) {
        if (error.status === 499) return new Response(null, { status: 499 });
        throw new HTTPException(error.status);
      }
      return context.json({ error: 'Session permissions are temporarily unavailable. Reload the list before retrying.' }, 503);
    }
  });
  else app.get(path, context => {
    const { proof } = access(context);
    return context.json({ collaborators: legacy().hubStore.grants.collaborators(proof), candidates: legacy().hubStore.roles.sessionCandidates(proof, proof.resource) });
  });
  app.post(path, async context => asynchronous(async () => {
    const port = deps.asyncSharing && await deps.asyncSharing.begin(context.req.raw, context.req.param('ownerUserId'), context.req.param('sessionId'));
    const current = port ? null : access(context);
    const raw = await readJsonBody(context.req.raw, 2048);
    if (port) await port.check(); else current!.session.require('sessions:share');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['userId', 'role', 'live', 'queue', 'media'].includes(key))) {
      return context.json({ error: 'Invalid collaboration request' }, 400);
    }
    const body = raw as Record<string, unknown>;
    if (typeof body.userId !== 'string' || !port && !legacy().hubStore.getUser(body.userId)
      || !['observer', 'collaborator'].includes(String(body.role)) || ['live', 'queue', 'media'].some(key => key in body && typeof body[key] !== 'boolean')) return context.json({ error: 'Invalid recipient or role' }, 400);
    if (port) {
      try { return context.json(await port.create(body.userId, body.role as 'observer' | 'collaborator', options(body)), 201); }
      catch (error) {
        if (error instanceof HubMemberRequestError && error.status === 400) return context.json({ error: 'Invalid recipient or role' }, 400);
        if (error instanceof HubMemberRequestError && error.status === 409) return context.json({ error: 'Access was not saved. Refresh the list before retrying; revoke existing access before changing a role.' }, 409);
        throw error;
      }
    }
    const outcome = sharingOutcome(1, () => legacy().hubStore.grants.shareSession(current!.proof, body.userId as string, body.role as 'observer' | 'collaborator', body));
    if (outcome.ok) return context.json({ grant: outcome.value }, 201);
    return context.json({ error: outcome.status === 503 ? SHARING_UNKNOWN : 'Access was not saved. Refresh the list before retrying; revoke existing access before changing a role.' }, outcome.status);
  }));
  app.put(`${path}/:grantId`, async context => asynchronous(async () => {
    const port = deps.asyncSharing && await deps.asyncSharing.begin(context.req.raw, context.req.param('ownerUserId'), context.req.param('sessionId'));
    const current = port ? null : access(context);
    const raw = await readJsonBody(context.req.raw, 2048);
    if (port) await port.check(); else current!.session.require('sessions:share');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return context.json({ error: 'Invalid session permissions' }, 400);
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some(key => !['version', 'role', 'live', 'queue', 'media'].includes(key)) || !['observer', 'collaborator'].includes(String(body.role))
      || typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1
      || ['live', 'queue', 'media'].some(key => key in body && typeof body[key] !== 'boolean')) return context.json({ error: 'Invalid session permissions' }, 400);
    if (port) {
      try { return context.json(await port.update(context.req.param('grantId'), body.version as number, body.role as 'observer' | 'collaborator', options(body))); }
      catch (error) {
        if (error instanceof HubMemberRequestError && error.status === 409) return context.json({ error: 'Session permissions changed or exceed the member environment role. Refresh before retrying.' }, 409);
        throw error;
      }
    }
    const outcome = sharingOutcome(2, () => legacy().hubStore.grants.updateCollaborator(current!.proof, context.req.param('grantId'), body.version as number, body.role as 'observer' | 'collaborator', body));
    if (outcome.ok) return context.json({ grant: outcome.value });
    return context.json({ error: outcome.status === 503 ? SHARING_UNKNOWN : 'Session permissions changed or exceed the member environment role. Refresh before retrying.' }, outcome.status);
  }));
  app.delete(`${path}/:grantId`, async context => asynchronous(async () => {
    const port = deps.asyncSharing && await deps.asyncSharing.begin(context.req.raw, context.req.param('ownerUserId'), context.req.param('sessionId'));
    const current = port ? null : access(context);
    const raw = await readJsonBody(context.req.raw, 1024);
    if (port) await port.check(); else current!.session.require('sessions:share');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'version')
      || !('version' in raw) || typeof raw.version !== 'number' || !Number.isSafeInteger(raw.version) || raw.version < 1) {
      return context.json({ error: 'Current grant version required' }, 400);
    }
    const version = raw.version;
    if (port) {
      const result = await port.remove(context.req.param('grantId'), version);
      return context.json(result, result.ok ? 200 : 409);
    }
    const outcome = sharingOutcome(3, () => {
      const ok = legacy().hubStore.grants.revokeCollaborator(current!.proof, context.req.param('grantId'), version);
      if (!ok) return { ok };
      const revocation = legacy().hubStore.grants.collaboratorRevocation(current!.proof, context.req.param('grantId'), version);
      if (!revocation) throw new Error('hub_session_sharing_unavailable');
      return { ok, revocation };
    });
    if (!outcome.ok) return context.json({ error: SHARING_UNKNOWN }, outcome.status);
    return context.json(outcome.value, outcome.value.ok ? 200 : 409);
  }));
  app.get(`${path}/:grantId/revocation`, async context => asynchronous(async () => {
    const port = deps.asyncSharing && await deps.asyncSharing.begin(context.req.raw, context.req.param('ownerUserId'), context.req.param('sessionId'));
    const current = port ? null : access(context);
    const raw = context.req.query('version');
    if (!raw || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) return context.json({ error: 'Original grant version required' }, 400);
    if (port) return context.json(await port.revocation(context.req.param('grantId'), Number(raw)));
    const revocation = legacy().hubStore.grants.collaboratorRevocation(current!.proof, context.req.param('grantId'), Number(raw));
    return revocation ? context.json({ revocation }) : context.json({ error: 'Revocation not found' }, 404);
  }));
}
