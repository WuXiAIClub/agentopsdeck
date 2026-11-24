import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import type { ConnectorClientResolver } from '../hub/connector-client.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import { GuidanceConflict } from '../hub/session-guidance-store.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubSessionGuidanceRoutes, type HubSessionGuidanceScope } from './hub-session-guidance-port.js';

/** Legacy store facade retains same-task permission checks, including inside
 * original root transactions. Promise-shaped permissions are not SQL grants. */
export function registerHubSessionGuidance(app: Hono, deps: {
  hubStore: HubStore; principal(c: Context): HubPrincipal;
  connectorClient: ConnectorClientResolver; diagnostics?: PerformanceDiagnostics;
}) {
  const store = deps.hubStore.sessionGuidance; let closed = false;
  const begin = (c: Context, id: string): HubSessionGuidanceScope => {
    const owner = deps.principal(c).userId, decoded = decodeHubSessionId(id);
    if (closed || !decoded || id.length > 4096) throw new HTTPException(404);
    const connection = deps.hubStore.getConnection(decoded.connectionId, owner);
    const epoch = deps.hubStore.connectionAuthority(decoded.connectionId, owner);
    if (!connection?.nodeId || connection.status === 'disabled') throw new HTTPException(404);
    const target = JSON.stringify([id, connection.nodeId, epoch]);
    const check = () => {
      const current = deps.hubStore.getConnection(decoded.connectionId, owner);
      if (closed || deps.principal(c).userId !== owner || !current || current.status === 'disabled'
        || current.nodeId !== connection.nodeId || deps.hubStore.connectionAuthority(decoded.connectionId, owner) !== epoch)
        throw new HTTPException(403);
    };
    const authorized = () => { check(); return true; };
    return Object.freeze({
      request: c.req.raw, nodeId: connection.nodeId,
      ownerUserId: owner, connectionId: decoded.connectionId, remoteSessionKey: decoded.remoteSessionKey, check,
      inspect() { check(); return store.inspect(owner, target); },
      save(revision, text, enabled) { check(); store.save(owner, target, revision, text, enabled, authorized); },
      prepare(requestId, revision, input) { check(); return store.prepare(owner, target, requestId, revision, input, authorized); },
      lookup(requestId) {
        check(); const cancelled = store.cancelled(owner, target, requestId);
        return { cancelled, receipt: cancelled ? null : store.receipt(owner, target, requestId) ?? null };
      },
      cancel(requestId) { check(); store.cancel(owner, target, requestId, authorized); },
      claim(requestId) { check(); return store.claim(owner, target, requestId, authorized); },
      reconcile(requestId, ack) {
        check(); const original = store.receipt(owner, target, requestId);
        if (!original?.commandKey || original.commandKey !== ack.key) throw new GuidanceConflict('ack-key');
        store.reconcile(owner, target, requestId, ack.state === 'accepted'
          ? { state: 'submitted', queueReceipt: ack.id } : { state: 'rejected', queueReceipt: null }, authorized);
      },
    } satisfies HubSessionGuidanceScope);
  };
  const routes = registerHubSessionGuidanceRoutes(app, { begin,
    connectorClient: (connection, user) => deps.connectorClient(connection, false, user),
    ...(deps.diagnostics ? { diagnostics: deps.diagnostics } : {}),
  });
  return { close() { closed = true; return routes.close(); } };
}
