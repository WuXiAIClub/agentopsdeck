import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { SharedSessionDirectoryPage } from '@agentopsdeck/shared';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import { ConnectorClientError, type ConnectorClientResolver } from '../hub/connector-client.js';
import { parseSessionDirectoryQuery } from '../projection/session-directory.js';
import { isNodeId } from '../connector/node-identity.js';
import { sessionRef } from '../hub/session-ref.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import type { AsyncHubSharedDirectory } from '../hub/async-shared-directory.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';

/** Explicit, one-grant/one-node discovery. Never fan out across a user's grants,
 * create execution authority, or use browser-provided filters as policy. */
type DirectoryDeps = {
  mode: 'async'; asyncDirectory: Pick<AsyncHubSharedDirectory, 'sessions'>;
} | {
  mode?: 'legacy';
  hubStore: HubStore; principal: (c: Context) => HubPrincipal; connectorClient: ConnectorClientResolver;
  asyncDirectory?: Pick<AsyncHubSharedDirectory, 'sessions'>;
};
export function registerHubSharedDirectoryRoutes(app: Hono, deps: DirectoryDeps) {
  if (deps.mode === 'async' && typeof deps.asyncDirectory?.sessions !== 'function') throw Error('hub_shared_directory_required');
  app.get('/api/hub/v1/shared/:ownerUserId/connections/:connectionId/grants/:grantId/sessions', async c => {
    c.header('Cache-Control', 'no-store');
    if (deps.asyncDirectory) {
      try { return c.json(await deps.asyncDirectory.sessions(c.req.raw, { ownerUserId: c.req.param('ownerUserId'),
        connectionId: c.req.param('connectionId'), grantId: c.req.param('grantId') })); }
      catch (error) {
        if (error instanceof HubMemberRequestError) return c.json({ error: error.status === 400
          ? 'Invalid shared directory page' : error.status === 401 ? 'unauthorized'
          : error.status === 404 ? 'Shared directory not found' : error.status === 403
          ? 'Shared directory access changed' : 'Shared directory unavailable' }, error.status === 499 ? 503 : error.status);
        const status = error instanceof ConnectorClientError && [401, 403, 404, 413, 499, 503].includes(error.status)
          ? error.status === 499 ? 503 : error.status as 401 | 403 | 404 | 413 | 503 : 502;
        return c.json({ error: 'Shared directory unavailable' }, status);
      }
    }
    if (deps.mode === 'async') throw Error('hub_shared_directory_required');
    const store = deps.hubStore, userId = deps.principal(c).userId;
    const target = { userId, ownerUserId: c.req.param('ownerUserId'), connectionId: c.req.param('connectionId'), administrator: deps.principal(c).admin };
    const grant = store.grants.get(target, c.req.param('grantId'));
    const connection = store.getConnection(target.connectionId, target.ownerUserId);
    if (!grant || grant.userId !== userId || grant.revoked || grant.policy.agentId !== undefined
      || !connection || connection.status === 'disabled' || !isNodeId(connection.nodeId)) {
      throw new HTTPException(404, { message: 'Shared directory not found' });
    }
    const { runtime, sessionKey } = grant.policy;
    const resource = { ...(runtime ? { runtime } : {}), ...(sessionKey ? { sessionKey } : {}) };
    const proof = store.grants.authorize(target, 'sessions:read', resource, grant.id);
    if (!proof) throw new HTTPException(404, { message: 'Shared directory not found' });
    const params = new URL(c.req.url).searchParams;
    let query;
    try {
      if ([...params.keys()].some(key => !['after', 'limit'].includes(key))) throw new Error('Invalid page');
      query = { ...parseSessionDirectoryQuery(params), ...resource };
    } catch { return c.json({ error: 'Invalid shared directory page' }, 400); }
    try {
      const page = await deps.connectorClient(connection.id, false, userId, proof).sessionDirectory(query, c.req.raw.signal);
      if (deps.principal(c).userId !== userId) throw new HTTPException(401, { message: 'unauthorized' });
      if (!store.grants.revalidate(proof)) throw new HTTPException(403, { message: 'Shared directory access changed' });
      const sessions = page.sessions.map(item => {
        let sessionId: string | null = null;
        // Discovery does not imply messages:read; another current grant can
        // authorize opening. Each eventual session route rechecks independently.
        const ref = sessionRef(connection.nodeId ?? undefined, item.sessionKey);
        if (ref && ref.runtimeId === item.runtime && store.grants.authorize(target, 'messages:read', item)) {
          const id = encodeHubSessionId(connection.id, item.sessionKey);
          if (id.length <= 4096) sessionId = id;
        }
        return { ...item, sessionId };
      });
      return c.json({ sessions, nextCursor: page.nextCursor, sourceCursor: page.sourceCursor } satisfies SharedSessionDirectoryPage);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      const status = error instanceof ConnectorClientError && [403, 404, 413].includes(error.status) ? error.status as 403 | 404 | 413 : 502;
      return c.json({ error: 'Shared directory unavailable' }, status);
    }
  });
}
