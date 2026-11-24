import type { Hono } from 'hono';
import type { AgentSummary } from '@agentopsdeck/shared';
import { AuthPersistenceError } from '../auth/private-store.js';
import { SessionReadAuthority, type SessionReadActor } from '../auth/session-read-authority.js';
import { AwaitedRequestAuthorization } from '../auth/awaited-request-authorization.js';
import type { DeckStore } from '../projection/deck-store.js';
import { registerSessionReadRoutes } from '../routes/session-reads.js';
import { registerEventRoutes, type EventReplayRead, type EventSnapshotRead } from '../routes/events.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';

/** Old frontend observation only. The application supplies its original admin
 * identity check; neither a Connector bearer nor a local execution actor is
 * substituted here. No write routes or command authority are registered. */
export function registerAsyncLegacySessionReads(app: Hono, deps: {
  deck: DeckStore; observeActor: SessionReadActor; available(): boolean;
  refreshSessions(options?: { maxAgeMs?: number }): Promise<void>;
  refreshMessages(key: string, options?: { maxAgeMs?: number }): Promise<void>;
  snapshot: EventSnapshotRead; replay: EventReplayRead;
  agents?: () => AgentSummary[] | PromiseLike<AgentSummary[]>;
  diagnostics?: PerformanceDiagnostics; waitMs?: number;
}) {
  let closed = false, closing: Promise<void> | undefined;
  const available = () => !closed && deps.available() === true;
  const observe: SessionReadActor = request => {
    if (!available()) throw new AuthPersistenceError();
    return deps.observeActor(request);
  };
  const authority = new SessionReadAuthority(observe, deps.diagnostics, deps.waitMs);
  const capture: EventSnapshotRead = async read => {
    if (!available()) throw new AuthPersistenceError();
    try {
      return await deps.snapshot(cursor => {
        if (!available()) throw new AuthPersistenceError();
        return read(cursor);
      });
    } catch { throw new AuthPersistenceError(); }
  };
  for (const path of ['/api/sessions/*', '/api/events/stream', '/api/attention', '/api/agents']) app.use(path, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!available()) return c.json({ error: 'server_draining' }, 503);
    await next();
  });
  const sessions = registerSessionReadRoutes(app, { store: deps.deck, authority,
    refreshSessions: deps.refreshSessions, refreshMessages: deps.refreshMessages, snapshot: capture });
  if (deps.agents) {
    const agents = deps.agents;
    app.get('/api/agents', c => authority.run(c.req.raw, async () => {
      try { return c.json({ agents: await agents(), updatedAt: Date.now() }); }
      catch { return c.json({ error: 'agent_catalog_unavailable' }, 503); }
    }));
  }
  // Continuity is not a permission cache: each frame still observes current
  // application authority. A different admin must open its own stream.
  const identities = new WeakMap<Request, string>();
  const events = registerEventRoutes(app, deps.deck, async request => {
    const actor = await observe(request);
    if (typeof actor !== 'string' || !actor) return false;
    const previous = identities.get(request);
    if (previous !== undefined && previous !== actor) return false;
    identities.set(request, actor); return available();
  }, new AwaitedRequestAuthorization(deps.diagnostics, undefined, deps.waitMs), deps.replay,
  deps.diagnostics, { ...(deps.waitMs === undefined ? {} : { waitMs: deps.waitMs }),
    attention: (request, read) => authority.run(request, () => capture(read)) });
  return {
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      const drains = [sessions.close(), events.close()];
      return closing = Promise.allSettled(drains).then(results => {
        if (results.some(result => result.status === 'rejected')) throw new ConnectorOwnerUnavailable();
      });
    },
    get pending() { return sessions.pending; },
  };
}
