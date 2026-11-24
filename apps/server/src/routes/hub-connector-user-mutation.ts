import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HubConnection, HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import type { ConnectorUser } from '../connector/connector-user-store.js';
import type { ConnectorClientResolver } from '../hub/connector-client.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import { requestConnectorClient } from '../hub/request-connector-client.js';
import { HubMemberRequestError, type AsyncHubMemberRequests } from '../hub/async-member-request.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { readJsonBody } from '../utils/http-body.js';

type Dependencies = ({
  mode: 'async'; access: Pick<AsyncHubMemberRequests, 'begin'>;
  asyncConnectorClient: AsyncConnectorClientResolver;
  readBody: (request: Request, maxBytes: number) => Promise<unknown>;
  check: () => void;
  store?: never; principal?: never; connectorClient?: never;
} | {
  mode?: 'legacy';
  store: Pick<HubStore, 'getConnection' | 'connectionAuthority' | 'listUsersAsync'>;
  principal: (context: Context) => HubPrincipal;
  connectorClient: ConnectorClientResolver;
  asyncConnectorClient?: AsyncConnectorClientResolver;
  access?: Pick<AsyncHubMemberRequests, 'begin'>;
  readBody?: never;
  check?: never;
}) & {
  present: (connection: HubConnection, users: Array<{ id: string; label: string }>, user: ConnectorUser) => unknown;
  readError: (context: Context, error: unknown) => Response;
  diagnostics?: PerformanceDiagnostics;
};

/** One original remote effect, followed by display IO. A late read failure or
 * cancellation never compensates, retries or replays the remote mutation.
 * Configured async authority cannot fall back to synchronous metadata reads. */
export async function proxyHubConnectorUserMutation(c: Context, deps: Dependencies,
  method: 'POST' | 'PATCH', userId?: string) {
  c.header('Cache-Control', 'no-store');
  const trace = (deps.diagnostics ?? performanceDiagnostics).start('hub-connector-user-change');
  // 1=pin, 2=body, 3=original remote effect, 4=directory, 5=delivery.
  let step = 1, failed = true;
  const warning = setTimeout(() => trace.reportPending({ step, pending: 1 }), 30_000);
  warning.unref();
  let current: (() => Promise<void>) | undefined;
  const unavailable = () => c.json({ error: 'hub_connector_users_unavailable' }, 503);
  const authorityError = (error: unknown) => {
    if (error instanceof HubMemberRequestError) {
      if (error.status === 401 || error.status === 403) throw new HTTPException(error.status, { message: 'unauthorized' });
      throw new HTTPException(503, { message: 'hub_connector_users_unavailable' });
    }
    throw error;
  };
  const legacy = () => { if (deps.mode === 'async') throw new HubMemberRequestError(503); return deps; };
  try {
    const access = await deps.access?.begin(c.req.raw);
    const { userId: ownerUserId, admin } = deps.mode === 'async' ? access!.principal : legacy().principal(c), id = c.req.param('connectionId')!;
    const actor = () => {
      if (deps.mode === 'async') deps.check();
      const now = deps.mode === 'async' ? access!.principal : deps.principal(c);
      if (now.userId !== ownerUserId || now.admin !== admin) throw new HTTPException(401, { message: 'unauthorized' });
      if (c.req.raw.signal.aborted) throw new HTTPException(503, { message: 'hub_connector_users_unavailable' });
    };
    actor();
    if (deps.access && !access) return unavailable();
    if (access && (access.principal.userId !== ownerUserId || access.principal.admin !== admin)) throw new HTTPException(401, { message: 'unauthorized' });
    const target = access ? await access.connection(id) : undefined;
    actor();
    if (access && !target) return unavailable();
    const connection = target ? target.connection : legacy().store.getConnection(id, ownerUserId);
    if (!connection || access && connection.status === 'disabled') return c.json({ error: 'connection not found' }, 404);
    const epoch = target ? target.epoch : legacy().store.connectionAuthority(connection.id, ownerUserId);
    current = async () => {
      actor();
      if (target) {
        try { await target.check(); } catch (error) { authorityError(error); }
      } else if (epoch === undefined || legacy().store.connectionAuthority(connection.id, ownerUserId) !== epoch) {
        throw new HTTPException(503, { message: 'hub_connector_users_unavailable' });
      }
      actor();
    };
    step = 2;
    const body = await (deps.mode === 'async' ? deps.readBody(c.req.raw, 64 * 1024) : readJsonBody(c.req.raw, 64 * 1024)).catch(error => {
      // Retain the original malformed/empty-input 400 contract. Oversized or
      // stalled streams must stop before any remote effect is admitted.
      if (error instanceof HTTPException && error.status === 400) return {};
      throw error;
    }) as { label?: unknown } | null;
    await current();
    if (typeof body?.label !== 'string' || !body.label.trim()) return c.json({ error: 'label is required' }, 400);
    const client = deps.mode === 'async'
      ? await deps.asyncConnectorClient(c.req.raw, connection.id, { maintenance: false, expectedUserId: ownerUserId })
      : await requestConnectorClient(deps, c.req.raw, connection.id, false, ownerUserId);
    // Resolver waits may overlap revocation. Do not dispatch a remote effect
    // on the strength of the earlier body/connection proof.
    await current();
    step = 3;
    trace.add('admitted', 1);
    const send = deps.mode === 'async' ? client.jsonResponseOriginal.bind(client) : client.jsonResponse.bind(client);
    const result = await send<{ user: ConnectorUser; updatedAt: number }>(
      userId ? `/users/${encodeURIComponent(userId)}` : '/users',
      { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: c.req.raw.signal });
    trace.add('settled', 1);
    step = 4;
    await current();
    let users: Array<{ id: string; label: string }>;
    if (access) {
      const snapshot = await access.connections();
      if (!snapshot) return unavailable();
      users = snapshot.users;
    } else users = await legacy().store.listUsersAsync(ownerUserId, admin);
    step = 5;
    await current();
    const response = c.json({ user: result.body.user, connection: deps.present(connection, users, result.body.user),
      updatedAt: result.body.updatedAt }, result.status as any);
    // Serialization/presentation is not authority. A synchronous presenter
    // may change local state; final owner proof also fences buffered output.
    await current();
    failed = false;
    return response;
  } catch (error) {
    if (step === 3) trace.add('unknown', 1);
    // Current revocation outranks concurrent transport/display failure, but
    // does not infer that an already admitted remote effect was cancelled.
    if (current) {
      try { await current(); } catch (changed) { error = changed; }
    }
    if (error instanceof HubMemberRequestError) {
      if (error.status === 401 || error.status === 403) throw new HTTPException(error.status, { message: 'unauthorized' });
      if (step === 1 && error.status === 404) return c.json({ error: 'connection not found' }, 404);
      return unavailable();
    }
    if (error instanceof HTTPException) throw error;
    if (step === 1 || step === 4 || step === 5) return unavailable();
    return deps.readError(c, error);
  } finally {
    clearTimeout(warning); trace.add('step', step); trace.finish(failed);
  }
}
