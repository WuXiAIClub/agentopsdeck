import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ConnectorClientError, type ConnectorClientResolver } from '../hub/connector-client.js';
import type { HubConnection, HubStore, HubUser } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import { observeHubAggregation } from '../hub/session-state-diagnostics.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { requestConnectorClient } from '../hub/request-connector-client.js';
import { HubMemberRequestError, type AsyncHubMemberRequests } from '../hub/async-member-request.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import { ConnectorResponseBudgetPool, ConnectorResponseBudgetExceeded } from '../hub/response-budget.js';
import { HubRequestWork } from '../hub/async-request-work.js';

type DisplayAuthority = {
  mode: 'async'; access: Pick<AsyncHubMemberRequests, 'begin'>;
  asyncConnectorClient: AsyncConnectorClientResolver; store?: never; principal?: never; client?: never;
} | {
  mode?: 'legacy';
  store: Pick<HubStore, 'listUsersAsync' | 'listConnectionsAsync' | 'connectionDirectoryVersion' | 'connectionAuthority'>;
  principal: (context: Context) => HubPrincipal; client: ConnectorClientResolver;
  asyncConnectorClient?: AsyncConnectorClientResolver; access?: Pick<AsyncHubMemberRequests, 'begin'>;
};

/** Display-only fan-in. It cannot authorize an execution, repair a writer or
 * retry a mutation. Keep the existing public serialization at the caller. */
export function registerHubConnectorUserDisplay(app: Hono, deps: DisplayAuthority & {
  present: (connection: HubConnection, users: HubUser[], supported: boolean,
    remoteUsers: unknown[], error?: string) => Record<string, unknown>;
  diagnostics?: PerformanceDiagnostics;
  responseLimits?: { requestBytes: number; retainedBytes: number };
}) {
  if (deps.mode === 'async' && (typeof deps.access?.begin !== 'function' || typeof deps.asyncConnectorClient !== 'function'))
    throw Error('Async Connector directory ports are required before route registration');
  const work = new HubRequestWork();
  const legacy = () => { if (deps.mode === 'async') throw new HubMemberRequestError(503); return deps; };
  let acceptedReads = 0;
  const requestBytes = deps.responseLimits?.requestBytes ?? 32 * 1024 * 1024;
  const responseBudget = new ConnectorResponseBudgetPool(deps.responseLimits?.retainedBytes ?? 128 * 1024 * 1024);
  responseBudget.acquire(requestBytes).close();
  app.get('/api/hub/v1/connector-users', context => work.run(async () => {
    context.header('Cache-Control', 'no-store');
    const initialAccess = deps.mode === 'async' ? await deps.access.begin(context.req.raw) : undefined;
    const { userId, admin } = initialAccess ? initialAccess.principal : legacy().principal(context);
    const signal = context.req.raw.signal;
    const observation = observeHubAggregation('hub-connector-users-read', signal, deps.diagnostics);
    let buffered = false, records = 0, reserved = false;
    let access: Awaited<ReturnType<AsyncHubMemberRequests['begin']>> | undefined;
    let collector: ReturnType<ConnectorResponseBudgetPool['acquire']> | undefined;
    const current = () => {
      work.check();
      if (deps.mode === 'async') return;
      const actor = deps.principal(context);
      if (actor.userId !== userId || actor.admin !== admin) {
        observation.changed();
        throw new HTTPException(401, { message: 'unauthorized' });
      }
    };
    const unavailable = () => context.json({ error: 'hub_connector_users_unavailable' }, 503);
    try {
      const pending = acceptedReads;
      if (pending >= 8) { observation.admission(pending, false); return unavailable(); }
      acceptedReads++; reserved = true;
      collector = responseBudget.acquire(requestBytes);
      observation.admission(pending, true);
      // One scoped snapshot, not a synchronous full users scan per connector.
      access = initialAccess ?? await deps.access?.begin(context.req.raw);
      current();
      if (signal.aborted || deps.access && !access) return unavailable();
      if (access && (access.principal.userId !== userId || access.principal.admin !== admin))
        throw new HTTPException(401, { message: 'unauthorized' });
      const directory = await access?.connectionDirectory();
      current();
      if (signal.aborted || access && !directory) return unavailable();
      const users = directory ? directory.users : await legacy().store.listUsersAsync(userId, admin);
      current();
      if (signal.aborted) return unavailable();
      const directoryVersion = directory ? undefined : legacy().store.connectionDirectoryVersion(userId);
      const connections = (directory ? directory.connections : await legacy().store.listConnectionsAsync(userId)).filter(row => row.status !== 'disabled');
      const checkDirectory = async () => {
        if (directory) { await directory.check(); return; }
        if (legacy().store.connectionDirectoryVersion(userId) !== directoryVersion) {
          observation.changed();
          throw new HTTPException(503, { message: 'Connector directory changed' });
        }
      };
      current();
      if (signal.aborted) return unavailable();
      await checkDirectory();
      const authority = new Map(directory ? [] : connections.map(row => [row.id, legacy().store.connectionAuthority(row.id, userId)]));
      const checkConnection = async (connection: HubConnection) => {
        current();
        if (signal.aborted) throw new HTTPException(503);
        if (directory) {
          // The fixed target command checks generation AND epoch atomically.
          // Do not double every row into another full identity/read round trip.
          await directory.check(connection.id);
          current();
          if (signal.aborted) throw new HTTPException(503);
          return;
        }
        await checkDirectory();
        current();
        if (signal.aborted) throw new HTTPException(503);
        if (authority.get(connection.id) === undefined
          || legacy().store.connectionAuthority(connection.id, userId) !== authority.get(connection.id)) {
          observation.changed();
          throw new HTTPException(503, { message: 'Connector directory changed' });
        }
      };
      observation.stage(2);
      const results: { supported: boolean; users: unknown[]; error?: string }[] = new Array(connections.length);
      let next = 0, refused = false;
      // At most four original requests in flight, even for a large directory.
      // A refused lane stops new dispatch; all already-started reads settle.
      const lane = async () => {
        try {
          while (!refused && !collector?.snapshot().refused && next < connections.length) {
            const index = next++, connection = connections[index]!;
            await checkConnection(connection);
            let result: typeof results[number];
            try {
              const client = deps.mode === 'async'
                ? await deps.asyncConnectorClient(context.req.raw, connection.id, { maintenance: false, expectedUserId: userId })
                : await requestConnectorClient({ connectorClient: deps.client,
                ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}) },
                context.req.raw, connection.id, false, userId);
              await checkConnection(connection); // Resolver waits cannot certify an earlier directory.
              const body = await client.json<{ users: unknown[] }>('/users', { signal }, collector);
              if (!Array.isArray(body?.users)) throw new ConnectorClientError(502, 'Invalid Connector users response');
              result = { supported: true, users: body.users };
            } catch (error) {
              if (error instanceof ConnectorResponseBudgetExceeded) throw error;
              result = { supported: false, users: [],
                error: error instanceof ConnectorClientError ? error.message : 'Connector unavailable' };
            }
            await checkConnection(connection);
            results[index] = result;
          }
        } catch (error) { refused = true; throw error; }
      };
      const lanes = await Promise.allSettled(Array.from({ length: Math.min(4, connections.length) }, lane));
      current();
      if (signal.aborted) return unavailable();
      const failed = lanes.find(row => row.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      if (collector.snapshot().refused) return unavailable();
      observation.stage(3);
      await checkDirectory();
      if (!directory) for (const connection of connections) await checkConnection(connection);
      observation.stage(4);
      const publicRows = connections.map((connection, index) => {
        const result = results[index]!;
        return deps.present(connection, users, result.supported, result.users, result.error);
      });
      current();
      if (signal.aborted) return unavailable();
      await checkDirectory();
      if (!directory) for (const connection of connections) await checkConnection(connection);
      const response = context.json({ connections: publicRows, updatedAt: Date.now() });
      current();
      if (signal.aborted) return unavailable();
      if (!directory) for (const connection of connections) await checkConnection(connection);
      await checkDirectory(); // Atomic generation proof after every awaited target check.
      current();
      if (signal.aborted) return unavailable();
      observation.stage(5);
      buffered = true; records = publicRows.length;
      return response;
    } catch (error) {
      // A lost/cancelled read never turns into a fresh remote request. The
      // original owner retains its physical drain fence after HTTP settles.
      if (access) {
        try { await access.check(); } catch (changed) { error = changed; }
      }
      if (error instanceof HubMemberRequestError && error.status === 401)
        throw new HTTPException(401, { message: 'unauthorized' });
      current(); // Revocation outranks a concurrent readonly failure.
      if (error instanceof HTTPException && error.status === 401) throw error;
      return unavailable();
    } finally {
      // A disconnect or refused response does not refund a pending lane.
      // All accepted original route/client promises settle before this point;
      // the SQL observer retains its separate physical-owner exit fence.
      if (collector) {
        const snapshot = collector.snapshot();
        observation.responseBudget(snapshot.retainedBytes, snapshot.refused);
        collector.close();
      }
      if (reserved) acceptedReads--;
      observation.finish(buffered, records);
    }
  }).catch(error => {
    if (error instanceof HubMemberRequestError) return context.json({ error: 'hub_connector_users_unavailable' }, error.status === 499 ? 503 : error.status);
    throw error;
  }));
  return { close: () => work.close() };
}
