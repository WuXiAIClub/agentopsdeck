import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import { HubMemberRequestError, type AsyncHubMemberRequests } from '../hub/async-member-request.js';

/** Account display only. A configured domain refusal never falls back to the
 * legacy display reader or becomes a cached permission for a later mutation. */
export function registerHubAccountDirectory(app: Hono, deps: {
  store: Pick<HubStore, 'listUsersAsync' | 'listConnectionsAsync'>;
  principal: (context: Context) => HubPrincipal;
  access?: Pick<AsyncHubMemberRequests, 'begin'>;
  present: (connections: Awaited<ReturnType<HubStore['listConnectionsAsync']>>,
    users: Awaited<ReturnType<HubStore['listUsersAsync']>>) => unknown;
}) {
  for (const kind of ['users', 'connections'] as const) {
    app.get(`/api/hub/v1/${kind}`, async c => {
      c.header('Cache-Control', 'no-store');
      const pin = deps.principal(c);
      const current = () => {
        const actor = deps.principal(c);
        if (actor.userId !== pin.userId || actor.admin !== pin.admin) throw new HTTPException(401, { message: 'unauthorized' });
      };
      try {
        let users: Awaited<ReturnType<HubStore['listUsersAsync']>>;
        let connections: Awaited<ReturnType<HubStore['listConnectionsAsync']>> = [];
        if (deps.access) {
          const raw = c.req.raw;
          const access = await deps.access.begin(new Request(raw.url, { headers: new Headers(raw.headers), signal: raw.signal }));
          current();
          if (access.principal.userId !== pin.userId || access.principal.admin !== pin.admin) throw new HTTPException(401);
          if (kind === 'connections') {
            const result = await access.connectionDirectory();
            users = result.users; connections = result.connections;
            await result.check();
          } else users = (await access.users()).users;
        } else {
          users = await deps.store.listUsersAsync(pin.userId, pin.admin);
          current();
          if (c.req.raw.signal.aborted) throw new HTTPException(503);
          if (kind === 'connections') connections = await deps.store.listConnectionsAsync(pin.userId);
        }
        current();
        if (c.req.raw.signal.aborted) throw new HTTPException(503);
        return c.json(kind === 'users' ? { users, updatedAt: Date.now() }
          : { connections: deps.present(connections, users), updatedAt: Date.now() });
      } catch (error) {
        current(); // A current revocation outranks an unavailable projection.
        if (error instanceof HubMemberRequestError && (error.status === 401 || error.status === 403)) throw new HTTPException(error.status);
        if (error instanceof HTTPException && error.status !== 503) throw error;
        return c.json({ error: kind === 'users' ? 'hub_users_unavailable' : 'hub_connections_unavailable' }, 503);
      }
    });
  }
}
