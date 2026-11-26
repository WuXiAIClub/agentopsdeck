import { requestConnectorClient } from '../hub/request-connector-client.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ChatMessage, SharedSessionAccessHints } from '@agentopsdeck/shared';
import { resolveMessageLimits } from '@agentopsdeck/shared';
import { ConnectorClientError, type ConnectorClientResolver } from '../hub/connector-client.js';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import { dedupeMessageIdentitiesInOrder } from '../messages/identity.js';
import { createConditionalHistory } from '../messages/conditional-history.js';
import { projectMessageMedia } from '../hub/message-projection.js';
import { sharedSessionAccess } from './hub-shared-access.js';
import type { HubEventBrokers } from '../hub/event-broker.js';
import { hubEventResponse } from '../hub/event-stream.js';
import { resolveExplicitChannelRoute } from '../messages/channel-route.js';
import type { AsyncHubSharedReadsPort } from '../hub/async-shared-reads.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { sharedReadEvent } from '../hub/member-shared-read-domain.js';
import type { NodeGrantProof } from '../hub/node-grants.js';
import type { HubRequestWork } from '../hub/async-request-work.js';
import type { OriginalTransportDrain } from '../connector/transport.js';

type SharedReadDeps = {
  mode: 'async'; asyncSharedReads: AsyncHubSharedReadsPort; asyncConnectorClient: AsyncConnectorClientResolver;
  brokers: HubEventBrokers;
  lifetime: {
    work: HubRequestWork; signal: AbortSignal;
    transport<T>(open: (drain: OriginalTransportDrain) => Promise<T>): Promise<T>;
    retainMedia(response: Response, signal: AbortSignal): Promise<Response>;
  };
} | {
  mode?: 'legacy';
  hubStore: HubStore; principal: (c: Context) => HubPrincipal; asyncConnectorClient?: AsyncConnectorClientResolver; connectorClient: ConnectorClientResolver; brokers: HubEventBrokers;
  asyncSharedReads?: AsyncHubSharedReadsPort;
};
export function registerHubSharedReadRoutes(app: Hono, deps: SharedReadDeps) {
  if (deps.mode === 'async' && (!deps.asyncSharedReads || !deps.asyncConnectorClient || !deps.lifetime)) throw Error('hub_shared_reads_required');
  const base = '/api/hub/v1/shared/:ownerUserId/sessions/:sessionId';
  const conditionalHistory = createConditionalHistory();
  const access = async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    if (deps.asyncSharedReads) {
      try { return await deps.asyncSharedReads.open(c.req.raw, { ownerUserId: c.req.param('ownerUserId')!, sessionId: c.req.param('sessionId')! }); }
      catch (error) { if (error instanceof HubMemberRequestError) throw new HTTPException(error.status === 499 ? 503 : error.status, { message: 'Shared resource unavailable' }); throw error; }
    }
    if (deps.mode === 'async') throw Error('hub_shared_reads_required');
    const auth = sharedSessionAccess(c, deps);
    return { ...auth, hints: (): SharedSessionAccessHints => ({ messagesSend: auth.allows('messages:send'),
      messagesMirror: auth.ref.runtimeId === 'openclaw' && !!resolveExplicitChannelRoute(auth.resource.sessionKey, '')
        && auth.allowsTogether('messages:send', 'messages:mirror'),
      eventsRead: auth.connection.capabilities.includes('events') && auth.allows('events:read'),
      ...(auth.allows('sessions:share') ? { sessionsShare: deps.hubStore.grants.ownedSession(auth.require('sessions:share')) } : {}) }) };
  };
  const signal = (c: Context) => deps.mode === 'async'
    ? AbortSignal.any([c.req.raw.signal, deps.lifetime.signal]) : c.req.raw.signal;
  const client = async (c: Context, auth: Awaited<ReturnType<typeof access>>, proof: NodeGrantProof = auth.readProof) => {
    if (deps.mode !== 'async') return requestConnectorClient(deps, c.req.raw, auth.connection.id, false, auth.target.userId, proof);
    deps.lifetime.work.check();
    const resolved = await deps.asyncConnectorClient(c.req.raw, auth.connection.id, { expectedUserId: auth.target.userId, grant: proof });
    await auth.read(); deps.lifetime.work.check();
    return resolved.withLocalFence(() => deps.lifetime.work.check());
  };
  const wrap = (message: ChatMessage, auth: Awaited<ReturnType<typeof access>>) => {
    const base = `/api/hub/v1/shared/${encodeURIComponent(auth.target.ownerUserId)}/sessions/${encodeURIComponent(auth.target.sessionId)}`;
    const media = projectMessageMedia(message, auth.resource.sessionKey, base);
    return { ...message, sessionKey: auth.target.sessionId, sessionRef: auth.ref, ...(media ? { media } : {}) };
  };
  const failure = (c: Context, error: unknown) => {
    if (error instanceof HTTPException) throw error;
    if (error instanceof HubMemberRequestError) return c.json({ error: 'Shared resource unavailable' }, error.status === 499 ? 503 : error.status);
    const status = error instanceof ConnectorClientError && [403, 404, 413].includes(error.status) ? error.status as 403 | 404 | 413 : 502;
    return c.json({ error: 'Shared resource unavailable' }, status);
  };
  app.get(`${base}/state`, async c => {
    const auth = await access(c);
    try {
      const connector = await client(c, auth);
      const snapshot = deps.mode === 'async' ? await connector.sessionExecutionOriginal(auth.resource.sessionKey, signal(c))
        : await connector.sessionExecution(auth.resource.sessionKey, signal(c));
      await auth.read();
      return c.json({ ...snapshot, sessionKey: auth.target.sessionId, sessionRef: auth.ref });
    } catch (error) { return failure(c, error); }
  });
  app.get(`${base}/events/stream`, async c => {
    const auth = await access(c);
    let subscription: ReturnType<HubEventBrokers['acquire']> | undefined;
    try {
      await auth.require('events:read');
      if (!auth.connection.capabilities.includes('events')) return c.json({ error: 'Shared event subscription unavailable' }, 503);
      // Pin the original journal head before the broker can start its pump.
      const replay = 'replay' in auth ? await auth.replay() : undefined;
      c.req.raw.signal.throwIfAborted();
      subscription = deps.brokers.acquire(auth.target.ownerUserId, auth.connection.id);
      if (!replay && deps.mode === 'async') throw new HubMemberRequestError(503);
      const eventDeps = {
        ...(deps.mode === 'async' ? { work: deps.lifetime.work, signal: deps.lifetime.signal } : {}),
        ownerUserId: auth.target.ownerUserId, subscription, connectionId: auth.connection.id,
        authorize: async () => { await auth.require('events:read'); },
        project: (event: Parameters<typeof sharedReadEvent>[0]) => sharedReadEvent(event, auth.target, auth.ref.nodeId) };
      if (replay) return hubEventResponse(c, { ...eventDeps, replay });
      if (deps.mode === 'async') throw new HubMemberRequestError(503);
      return hubEventResponse(c, { ...eventDeps, store: deps.hubStore });
    } catch (error) {
      subscription?.release();
      if (error instanceof HTTPException || error instanceof HubMemberRequestError) return failure(c, error);
      return c.json({ error: 'Shared event subscription unavailable' }, 503, { 'Retry-After': '1', 'Cache-Control': 'no-store' });
    }
  });
  app.get(`${base}/messages`, async c => {
    const auth = await access(c), limit = c.req.query('limit');
    if (limit !== undefined && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 500)) return c.json({ error: 'Invalid message limit' }, 400);
    try {
      const connector = await client(c, auth);
      const asynchronous = c.req.header('x-agentopsdeck-history-async') === '1';
      const page = deps.mode === 'async'
        ? await deps.lifetime.transport(drain => connector.messages(auth.resource.sessionKey, limit, signal(c), c.req.query('before'), asynchronous, drain))
        : await connector.messages(auth.resource.sessionKey, limit, signal(c), c.req.query('before'), asynchronous);
      await auth.read();
      // Explicit envelope: no arbitrary upstream identity/owner fields.
      const messages = dedupeMessageIdentitiesInOrder(page.messages).map(message => wrap(message, auth));
      const access = await auth.hints();
      return conditionalHistory(c, { messages, totalCount: page.totalCount, hiddenCount: page.hiddenCount, updatedAt: page.updatedAt, revision: page.revision, sourceCursor: page.sourceCursor,
        ...(page.historyStatus === 'cached' || page.historyStatus === 'verified-session' ? { historyStatus: page.historyStatus } : {}), limits: resolveMessageLimits(page.limits), access });
    } catch (error) { return failure(c, error); }
  });
  app.get(`${base}/messages/:messageId`, async c => {
    const auth = await access(c), id = c.req.param('messageId');
    if (!id.length || id.length > 4096) return c.json({ error: 'Message not found' }, 404);
    try {
      const connector = await client(c, auth);
      const page = deps.mode === 'async'
        ? await deps.lifetime.transport(drain => connector.message(auth.resource.sessionKey, id, signal(c), drain))
        : await connector.message(auth.resource.sessionKey, id, signal(c));
      await auth.read();
      if (page.message?.id !== id) throw new ConnectorClientError(502, 'Invalid shared message identity');
      return c.json({ message: wrap(page.message, auth), updatedAt: page.updatedAt });
    } catch (error) { return failure(c, error); }
  });
  app.get(`${base}/messages/:messageId/media/:resourceId`, async c => {
    const auth = await access(c), id = c.req.param('resourceId'), messageId = c.req.param('messageId');
    if (!/^[a-f0-9]{64}$/.test(id) || !messageId.length || messageId.length > 4096) return c.json({ error: 'Media not found' }, 404);
    try {
      const proof = await auth.require('media:read');
      const connector = await client(c, auth, proof), transportSignal = signal(c);
      const open = (drain?: OriginalTransportDrain) => connector.sessionMedia(auth.resource.sessionKey, messageId, id,
        transportSignal, async () => { await auth.require('media:read'); }, c.req.header('range'), c.req.header('if-range'), drain);
      if (deps.mode !== 'async') return await open();
      const response = await deps.lifetime.transport(open);
      return await deps.lifetime.retainMedia(response, transportSignal);
    } catch (error) { return failure(c, error); }
  });
}
