import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { SharedGrantPage, SharedGrantSummary } from '@agentopsdeck/shared';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import { parseNodeGrantPolicy } from '../hub/node-grants.js';
import { readJsonBody } from '../utils/http-body.js';
import { sessionRef } from '../hub/session-ref.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { isNodeId } from '../connector/node-identity.js';
import type { AsyncHubMemberGrants } from '../hub/async-member-grants.js';
import { registerAsyncHubNodeGrantRoutes } from './hub-node-grants-async.js';
import type { AsyncHubReceivedGrants } from '../hub/async-received-grants.js';
import { registerAsyncHubReceivedGrantRoute } from './hub-received-grants-async.js';
import type { LegacyHubRouteDependencies, AsyncOnlyHubRouteDependencies } from './hub-legacy-dependencies.js';

/** Owner policy administration and recipient-only discovery. Never provisions an issuer, copies a
 * credential, acquires a lease, or treats Hub admin as another node's owner.
 */
type GrantPorts = {
  /** Fixed awaited port: original writer, or exclusive worker after ALL shared
   * callers migrate. Never start a peer writer beside the original store. */
  asyncGrants?: Pick<AsyncHubMemberGrants, 'begin'>;
  asyncReceived?: Pick<AsyncHubReceivedGrants,'received'>;
};
export function registerHubNodeGrantRoutes(app: Hono, deps: GrantPorts & (LegacyHubRouteDependencies
  | AsyncOnlyHubRouteDependencies & Required<GrantPorts>)) {
  if (deps.mode === 'async') {
    if (!deps.asyncGrants?.begin || !deps.asyncReceived?.received) throw Error('hub_node_grant_ports_required');
    registerAsyncHubReceivedGrantRoute(app, deps.asyncReceived);
    registerAsyncHubNodeGrantRoutes(app, deps.asyncGrants, '/api/hub/v1/connections/:connectionId/grants');
    return;
  }
  const path = '/api/hub/v1/connections/:connectionId/grants', store = deps.hubStore;
  if (deps.asyncReceived) registerAsyncHubReceivedGrantRoute(app,deps.asyncReceived);
  else app.get('/api/hub/v1/shared/grants', c => {
    c.header('Cache-Control', 'no-store');
    const userId = deps.principal(c).userId, limit = c.req.query('limit'), after = c.req.query('after');
    store.roles.syncAdministrator(deps.principal(c));
    if (Object.keys(c.req.query()).some(key => !['limit', 'after'].includes(key))) return c.json({ error: 'Invalid grant page' }, 400);
    let page;
    try { page = store.grants.received(userId, after, limit === undefined ? 50 : Number(limit)); }
    catch { return c.json({ error: 'Invalid grant page' }, 400); }
    const grants: SharedGrantSummary[] = page.grants.filter(grant => grant.policy.actions.some(action => store.roles.permits({ userId,
      ownerUserId: grant.ownerUserId, connectionId: grant.connectionId, administrator: deps.principal(c).admin }, action, grant.policy, grant.id))).map(grant => {
      const availability = grant.nodeStatus === 'disabled' ? 'disabled' : !isNodeId(grant.nodeId) ? 'unverified'
        : grant.currentNodeVersion !== grant.nodeVersion ? 'reauthorization_required' : 'available';
      let sessionId: string | null = null;
      // Never infer an agent->session mapping from caller data or enumerate the
      // owner catalog to expand a wildcard. Every later exact GET reauthorizes.
      if (availability === 'available' && grant.policy.sessionKey && !grant.policy.agentId) {
        let ref;
        try { ref = sessionRef(grant.nodeId ?? undefined, grant.policy.sessionKey); } catch { /* Invalid legacy mapping. */ }
        if (ref && ref.runtimeId === grant.policy.runtime && store.grants.authorize({ userId, ownerUserId: grant.ownerUserId,
          connectionId: grant.connectionId, administrator: deps.principal(c).admin }, 'messages:read', { runtime: ref.runtimeId, sessionKey: grant.policy.sessionKey })) {
          const id = encodeHubSessionId(grant.connectionId, grant.policy.sessionKey);
          if (id.length <= 4096) sessionId = id;
        }
      }
      return { id: grant.id, ownerUserId: grant.ownerUserId, connectionId: grant.connectionId, version: grant.version,
        nodeVersion: grant.nodeVersion, policy: grant.policy, availability, sessionId };
    });
    return c.json({ grants, nextCursor: page.nextCursor } satisfies SharedGrantPage);
  });
  if (deps.asyncGrants) {
    registerAsyncHubNodeGrantRoutes(app, deps.asyncGrants, path);
    return;
  }
  const owned = (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const ownerUserId = deps.principal(c).userId, connectionId = c.req.param('connectionId')!;
    const connection = store.getConnection(connectionId, ownerUserId);
    if (!connection) throw new HTTPException(404, { message: 'connection not found' });
    return { ownerUserId, connectionId, connection, nodeVersion: store.connectionAuthority(connectionId, ownerUserId)! };
  };
  const input = async (c: Context, keys: string[]) => {
    const before = owned(c), raw = await readJsonBody(c.req.raw, 8 * 1024), current = owned(c);
    if (before.ownerUserId !== current.ownerUserId || before.nodeVersion !== current.nodeVersion) {
      throw new HTTPException(409, { message: 'Node authority changed; reload before continuing' });
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))
      || keys.some(key => !(key in raw))) throw new HTTPException(400, { message: 'Invalid grant request' });
    return { target: current, body: raw as Record<string, unknown> };
  };
  const policy = (target: ReturnType<typeof owned>, body: Record<string, unknown>) => {
    if (!target.connection.nodeId || target.connection.status === 'disabled' || body.nodeVersion !== target.nodeVersion) {
      throw new HTTPException(409, { message: 'Verified current node authority required' });
    }
    try {
      const parsed = parseNodeGrantPolicy(body.policy);
      if (parsed.actions.includes('sessions:create') && (parsed.runtime !== 'codex' || parsed.agentId || parsed.sessionKey)) throw new Error('Creation requires environment-wide Codex scope');
      return parsed;
    }
    catch { throw new HTTPException(400, { message: 'Invalid grant policy' }); }
  };
  const version = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new HTTPException(400, { message: 'Invalid grant version' });
    return value;
  };

  app.get(path, (c) => {
    const target = owned(c), limit = c.req.query('limit'), after = c.req.query('after');
    const verified = isNodeId(target.connection.nodeId) && target.connection.status !== 'disabled';
    const issuer = store.executionIssuers.current(target.ownerUserId, target.connectionId);
    try { return c.json({ nodeVersion: target.nodeVersion, verified,
      executionConfigured: verified && issuer?.nodeId === target.connection.nodeId,
      creationConfigured: verified && issuer?.nodeId === target.connection.nodeId && issuer?.creationAllowed === true,
      ...store.grants.list(target, after, limit === undefined ? 50 : Number(limit)) }); }
    catch { return c.json({ error: 'Invalid grant page' }, 400); }
  });
  app.post(path, async (c) => {
    const { target, body } = await input(c, ['userId', 'nodeVersion', 'policy']);
    const next = policy(target, body);
    if (typeof body.userId !== 'string' || !store.getUser(body.userId)) return c.json({ error: 'Invalid recipient' }, 400);
    if (!store.roles.permitsDirectGrant({ ...target, userId: body.userId }, next)) return c.json({ error: 'Use Roles & environments for this managed member' }, 409);
    try {
      const created = store.grants.create({ ...target, userId: body.userId }, next);
      return c.json({ grant: store.grants.get(target, created.id) }, 201);
    } catch { return c.json({ error: 'Grant could not be saved' }, 409); }
  });
  app.put(`${path}/:grantId`, async (c) => {
    const { target, body } = await input(c, ['version', 'nodeVersion', 'policy']);
    const next = policy(target, body), expected = version(body.version), id = c.req.param('grantId');
    const previous = store.grants.get(target, id);
    if (!previous) return c.json({ error: 'grant not found' }, 404);
    if (store.roles.managedGrant(id) || !store.roles.permitsDirectGrant({ ...target, userId: previous.userId }, next)) return c.json({ error: 'Use Roles & environments for managed permissions' }, 409);
    if (!store.grants.replace({ ...target, userId: previous.userId }, id, expected, next)) return c.json({ error: 'Grant version changed or revoked' }, 409);
    return c.json({ grant: store.grants.get(target, id) });
  });
  app.delete(`${path}/:grantId`, async (c) => {
    const { target, body } = await input(c, ['version']), expected = version(body.version), id = c.req.param('grantId');
    const previous = store.grants.get(target, id);
    if (!previous) return c.json({ error: 'grant not found' }, 404);
    if (store.roles.managedGrant(id)) return c.json({ error: 'Use Roles & environments to remove this role' }, 409);
    if (!store.grants.revoke({ ...target, userId: previous.userId }, id, expected)) return c.json({ error: 'Grant version changed or revoked' }, 409);
    return c.json({ grant: store.grants.get(target, id) });
  });
}
