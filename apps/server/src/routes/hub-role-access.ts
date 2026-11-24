import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ConnectorRole, EnvironmentAccess } from '../hub/role-access.js';
import { readJsonBody } from '../utils/http-body.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubMemberRoleConflictError, type AsyncHubMemberRoles } from '../hub/async-member-roles.js';
import { HubMemberMembershipConflictError, type AsyncHubMemberMemberships } from '../hub/async-member-memberships.js';
import type { AsyncHubMemberDirectory } from '../hub/async-member-directory.js';
import { copyOriginalRequest } from '../hub/original-request-scope.js';
import { requireLegacyHubRoute, type LegacyHubRouteDependencies, type AsyncOnlyHubRouteDependencies } from './hub-legacy-dependencies.js';

type RolePorts = {
  /** Candidate port only: application must not enable a second shared DB writer. */
  asyncRoles?: Pick<AsyncHubMemberRoles, 'authorize' | 'read' | 'set'>;
  asyncMemberships?: Pick<AsyncHubMemberMemberships, 'authorize' | 'read' | 'set'>;
  asyncDirectory?: Pick<AsyncHubMemberDirectory, 'read'> };
export function registerHubRoleAccessRoutes(app: Hono, deps: RolePorts & (LegacyHubRouteDependencies
  | AsyncOnlyHubRouteDependencies & Required<RolePorts>)) {
  if (deps.mode === 'async' && (!deps.asyncRoles?.authorize || !deps.asyncRoles.read || !deps.asyncRoles.set
    || !deps.asyncMemberships?.authorize || !deps.asyncMemberships.read || !deps.asyncMemberships.set
    || !deps.asyncDirectory?.read)) throw Error('hub_role_access_ports_required');
  const base = '/api/hub/v1/access', legacy = () => requireLegacyHubRoute(deps);
  app.use(`${base}/*`, async (context, next) => { context.header('Cache-Control', 'no-store'); await next(); });
  app.get(`${base}/directory`, async context => {
    if (deps.asyncDirectory) {
      try { return context.json(await deps.asyncDirectory.read(roleRequest(context))); }
      catch (error) {
        if (error instanceof HubMemberRequestError && error.status !== 503) {
          if (error.status === 499) return new Response(null, { status: 499 });
          throw new HTTPException(error.status);
        }
        return context.json({ error: 'Access directory is unavailable. Reload permissions before retrying.' }, 503);
      }
    }
    const actor = legacy().principal(context);
    return context.json({ administrator: actor.admin, connections: legacy().hubStore.roles.connections(actor), users: legacy().hubStore.roles.members(actor) });
  });
  app.get(`${base}/users/:userId/hub-role`, async context => {
    if (deps.asyncRoles) {
      try { return context.json(await deps.asyncRoles.read(roleRequest(context), context.req.param('userId'))); }
      catch (error) { return roleFailure(context, error); }
    }
    if (!legacy().principal(context).admin) throw new HTTPException(403);
    if (!legacy().hubStore.getUser(context.req.param('userId'))) throw new HTTPException(404);
    return context.json(legacy().hubStore.roles.hubRole(context.req.param('userId')));
  });
  app.put(`${base}/users/:userId/hub-role`, async context => {
    const request = deps.asyncRoles ? roleRequest(context) : undefined;
    if (deps.asyncRoles) {
      try { await deps.asyncRoles.authorize(request!); }
      catch (error) { return roleFailure(context, error); }
    } else if (!legacy().principal(context).admin) throw new HTTPException(403);
    const body = await readJsonBody(context.req.raw, 1024);
    if (!object(body) || !exact(body, ['role', 'version']) || !['admin', 'member'].includes(String(body.role)) || !version(body.version)) throw new HTTPException(400);
    if (deps.asyncRoles) {
      // Original clients send integer versions. Never permit increment overflow,
      // and preserve their conflict response instead of inventing a new schema.
      if (body.version === Number.MAX_SAFE_INTEGER) return roleConflict(context);
      try { return context.json(await deps.asyncRoles.set(request!, context.req.param('userId'), body.role as 'admin' | 'member', body.version as number)); }
      catch (error) { return roleFailure(context, error); }
    }
    try { return context.json(legacy().hubStore.roles.setHubRole(legacy().principal(context), context.req.param('userId'), body.role as 'admin' | 'member', body.version as number)); }
    catch { return context.json({ error: 'Role not saved. Self changes are prohibited; refresh the current role.' }, 409); }
  });
  const path = `${base}/:ownerUserId/connections/:connectionId/members/:userId`;
  const targetValue = (context: Context) => ({ ownerUserId: context.req.param('ownerUserId')!, connectionId: context.req.param('connectionId')!, userId: context.req.param('userId')! });
  const target = (context: Context) => {
    const value = targetValue(context);
    if (!legacy().hubStore.roles.canManage(legacy().principal(context), value) || !legacy().hubStore.getConnection(value.connectionId, value.ownerUserId)) throw new HTTPException(403);
    return value;
  };
  app.get(path, async context => {
    if (deps.asyncMemberships) {
      try { return context.json(await deps.asyncMemberships.read(roleRequest(context), targetValue(context))); }
      catch (error) { return membershipFailure(context, error); }
    }
    const value = target(context);
    if (!legacy().hubStore.getUser(value.userId)) throw new HTTPException(404);
    return context.json(legacy().hubStore.roles.snapshot(legacy().principal(context), value));
  });
  app.put(path, async context => {
    const request = deps.asyncMemberships ? roleRequest(context) : undefined;
    const before = deps.asyncMemberships ? targetValue(context) : target(context);
    if (deps.asyncMemberships) {
      try { await deps.asyncMemberships.authorize(request!, before); }
      catch (error) { return membershipFailure(context, error); }
    }
    const body = await readJsonBody(context.req.raw, 4096);
    // Reading the body yields; recheck management authority before applying changes.
    // RoleAccess.save also checks member and node versions inside its savepoint.
    if (deps.asyncMemberships) {
      try { await deps.asyncMemberships.authorize(request!, before); }
      catch (error) { return membershipFailure(context, error); }
    } else target(context);
    if (!object(body) || !exact(body, ['role', 'version', 'nodeVersion', 'environments', 'migrateLegacy',
      ...(Object.hasOwn(body, 'grantSetDigest') ? ['grantSetDigest'] : [])])
      || Object.hasOwn(body, 'grantSetDigest') && (typeof body.grantSetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.grantSetDigest))
      || !['none', 'admin', 'developer', 'observer'].includes(String(body.role)) || !version(body.version) || !version(body.nodeVersion)
      || typeof body.migrateLegacy !== 'boolean' || !object(body.environments) || !exact(body.environments, ['codex', 'openclaw'])
      || !['disabled', 'developer', 'observer'].includes(String(body.environments.codex)) || !['disabled', 'observer'].includes(String(body.environments.openclaw))) throw new HTTPException(400);
    if (deps.asyncMemberships) {
      if (body.version === Number.MAX_SAFE_INTEGER) return membershipConflict(context);
      try { return context.json(await deps.asyncMemberships.set(request!, before, {
        role: body.role as ConnectorRole, version: body.version as number, nodeVersion: body.nodeVersion as number,
        environments: body.environments as EnvironmentAccess, migrateLegacy: body.migrateLegacy,
        ...(typeof body.grantSetDigest === 'string' ? { grantSetDigest: body.grantSetDigest } : {}),
      })); }
      catch (error) { return membershipFailure(context, error); }
    }
    try {
      return context.json(legacy().hubStore.roles.save(legacy().principal(context), before, { role: body.role as ConnectorRole, version: body.version as number,
        nodeVersion: body.nodeVersion as number, environments: body.environments as EnvironmentAccess, migrateLegacy: body.migrateLegacy,
        ...(typeof body.grantSetDigest === 'string' ? { grantSetDigest: body.grantSetDigest } : {}) }));
    } catch { return context.json({ error: 'Access not saved. Refresh permissions, review legacy access, and retry. Only Hub administrators appoint Connector administrators.' }, 409); }
  });
}

function roleRequest(context: Context) {
  return copyOriginalRequest(context.req.raw);
}
function membershipConflict(context: Context) {
  return context.json({ error: 'Access not saved. Refresh permissions, review legacy access, and retry. Only Hub administrators appoint Connector administrators.' }, 409);
}
function membershipFailure(context: Context, error: unknown) {
  if (error instanceof HubMemberMembershipConflictError) return membershipConflict(context);
  if (error instanceof HubMemberRequestError && error.status !== 503) {
    if (error.status === 499) return new Response(null, { status: 499 });
    if (error.status === 401) return context.json({ error: 'Unauthorized' }, 401);
    throw new HTTPException(error.status);
  }
  return context.json({ error: 'Access persistence is unavailable. Reload permissions before retrying.' }, 503);
}
function roleConflict(context: Context) {
  return context.json({ error: 'Role not saved. Self changes are prohibited; refresh the current role.' }, 409);
}
function roleFailure(context: Context, error: unknown) {
  if (error instanceof HubMemberRoleConflictError) return roleConflict(context);
  if (error instanceof HubMemberRequestError) {
    const status = error.status;
    if (status === 499) return new Response(null, { status });
    if (status !== 503) throw new HTTPException(status);
  }
  // No automatic resend: a lost confirmation does not prove a write failed.
  return context.json({ error: 'Role persistence is unavailable. Reload the current role before retrying.' }, 503);
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && keys.every(key => key in value); }
function version(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
