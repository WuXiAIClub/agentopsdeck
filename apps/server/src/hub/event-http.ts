import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import type { HubEventBrokers } from './event-broker.js';
import type { AsyncHubEventReplayPort } from './async-event-replay.js';
import { HubMemberRequestError } from './async-member-request.js';
import { hasBoardCapabilityCredential } from '../routes/workspace-agent.js';
import { hubEventResponse } from './event-stream.js';

export function registerHubEventRoutes(app: Hono, base: string, deps: {
  brokers: Pick<HubEventBrokers, 'acquire'>;
} & ({ asyncEvents: AsyncHubEventReplayPort; store?: HubStore; principal?: (c: Context) => HubPrincipal }
  | { store: HubStore; principal(c: Context): HubPrincipal; asyncEvents?: undefined })) {
  if (deps.asyncEvents ? typeof deps.asyncEvents.open !== 'function' : !deps.store || typeof deps.principal !== 'function')
    throw Error('Hub event dependencies unavailable');
  app.get(`${base}/events/stream`, async c => {
    c.header('Cache-Control', 'no-store');
    if (hasBoardCapabilityCredential(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    let subscription: ReturnType<HubEventBrokers['acquire']> | undefined;
    try {
      // Do not start the feed until cursor capture and current authority settle.
      if (deps.asyncEvents) {
        const replay = await deps.asyncEvents.open(c.req.raw);
        c.req.raw.signal.throwIfAborted();
        subscription = deps.brokers.acquire(replay.ownerUserId);
        return hubEventResponse(c, { ownerUserId: replay.ownerUserId, subscription, workspaceResources: true,
          replay, authorize: () => replay.check() });
      }
      const { store, principal } = deps;
      const ownerUserId = principal(c).userId;
      c.req.raw.signal.throwIfAborted();
      subscription = deps.brokers.acquire(ownerUserId);
      return hubEventResponse(c, { store, ownerUserId, subscription, workspaceResources: true, authorize: () => { principal(c); } });
    } catch (error) {
      subscription?.release();
      const status = error instanceof HubMemberRequestError || error instanceof HTTPException ? error.status : c.req.raw.signal.aborted ? 499 : 503;
      const response = c.json({ error: status === 409 ? 'Authenticated account or Hub changed; reload before continuing'
        : status === 401 ? 'unauthorized' : 'Hub event subscription unavailable' });
      if (status === 503) response.headers.set('Retry-After', '1');
      return new Response(response.body, { status, headers: response.headers });
    }
  });
}
