import type { Hono } from 'hono';
import { registerSessionReadRoutes } from './session-reads.js';
import { synchronousActorCall } from '../auth/synchronous-actor.js';
import { SessionReadAuthority, type SessionReadActor } from '../auth/session-read-authority.js';
import { nanoid } from 'nanoid';
import { MAX_TEXT_MESSAGE_BODY_BYTES, type ChatMessage } from '@agentopsdeck/shared';
import type { GatewayWsClient } from '../gateway/ws-client.js';
import type { DeckStore } from '../projection/deck-store.js';
import { MAX_TOTAL_MEDIA_BYTES, gatewayAttachmentsForMedia, normalizeSendMessageRequest, persistUploadedMedia, type PersistedUpload } from '../messages/send-message.js';
import { withArtifactCapability } from '../messages/artifact-receiver.js';
import type { OpenClawTurnQueue, ExplicitRoute } from '../openclaw/turn-queue.js';
import { SessionDeletionConflict, TurnAuthorizationError } from '../commands/turn-queue.js';
import { deleteConnectorSession } from '../connector/session-delete.js';
import { reportSessionStatus } from '../connector/session-status.js';
import { registerSessionSettingsRoutes } from '../connector/session-settings-http.js';
import { registerCreationReceipts, registerDeletionReceipts } from '../commands/http.js';
import type { CommandReceipts } from '../commands/receipts.js';
import { HTTPException } from 'hono/http-exception';
import { decodeHubSessionId, encodeHubSessionId } from './hub.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { readJsonBody } from '../utils/http-body.js';


// Preserve legacy empty/malformed JSON defaults, but never turn a stopped,
// oversized or failed transport into a write with the default `true` value.
async function readPreferenceBody(request: Request) {
  try { return await readJsonBody(request, 64 * 1024); }
  catch (error) {
    if (error instanceof HTTPException && error.status === 400) return {};
    throw error;
  }
}

function isCanonicalHubSessionId(requestedSessionKey: string, decodedHubSession: ReturnType<typeof decodeHubSessionId>): decodedHubSession is NonNullable<ReturnType<typeof decodeHubSessionId>> {
  return !!decodedHubSession && encodeHubSessionId(decodedHubSession.connectionId, decodedHubSession.remoteSessionKey) === requestedSessionKey;
}
const artifactCapabilityInjectedSessions = new Set<string>();

export function registerSessionRoutes(app: Hono, deps: {
  store: DeckStore;
  gateway: GatewayWsClient;
  refreshSessions: (options?: { maxAgeMs?: number }) => Promise<void>;
  refreshMessages: (sessionKey: string, options?: { maxAgeMs?: number }) => Promise<void>;
  resolveExplicitChannelRoute: (sessionKey: string) => ExplicitRoute | undefined;
  mirrorAssistantReplyToChannel: (params: { sessionKey: string; after: number; inputText: string; explicitRoute: ExplicitRoute; idempotencyKey: string; actorId?: string }) => Promise<void>;
  normalizeError: (error: unknown) => string;
  queue: OpenClawTurnQueue;
  commands: CommandReceipts;
  deletionAdmission: (sessionKey: string) => boolean;
  settingsAdmission: (sessionKey: string) => boolean;
  queueActor: (request: Request) => string | undefined;
  observeActor?: SessionReadActor;
  readWaitMs?: number;
  inboundDir?: string;
  artifactCapability?: { enabled: boolean; maxBytes: number };
}) {
  const queueActor = (request: Request) => synchronousActorCall(deps.queueActor, [request], deps);
  // Read observations may wait; command/effect guards below deliberately
  // remain fresh synchronous checks in their original mutation scope.
  const readAuthority = new SessionReadAuthority(deps.observeActor ?? queueActor, undefined, deps.readWaitMs);
  const localCommandAuthority = (request: Request) => {
    const actor = queueActor(request);
    return () => {
      if (request.signal.aborted) throw new HTTPException(408, { res: Response.json({ error: 'Request cancelled' }, { status: 408 }) });
      if (!actor || queueActor(request) !== actor) throw new HTTPException(403, { res: Response.json({ error: 'Session authorization changed' }, { status: 403 }) });
    };
  };
  // Read-only observation: a stalled request never releases authority, retries
  // a save, or treats a possibly persisted preference as rolled back.
  const changePreference = async <Body>(request: Request, step: 1 | 2 | 3,
    read: () => Promise<Body>, write: (body: Body) => Response): Promise<Response> => {
    const trace = performanceDiagnostics.start('session-preference-change');
    trace.add('step', step);
    let mutationStarted = false;
    const timer = setTimeout(() => trace.reportPending({ pending: 1 }), 1_000);
    timer.unref();
    try {
      const authorize = localCommandAuthority(request);
      authorize();
      const body = await read();
      authorize();
      mutationStarted = true;
      const result = write(body);
      trace.add('settled', 1);
      trace.finish();
      return result;
    } catch (error) {
      trace.add(mutationStarted ? 'unknown' : 'deferred', 1);
      if (request.signal.aborted) trace.add('cancelled', 1);
      else if (error instanceof HTTPException && error.status === 408) trace.add('timedOut', 1);
      trace.finish(true);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  registerSessionReadRoutes(app, { ...deps, authority: readAuthority });

  registerSessionSettingsRoutes(app, '/api/sessions/:sessionKey', {
    ...deps, receipts: deps.commands,
    sessionKey: c => {
      const requested = c.req.param('sessionKey')!, decoded = decodeHubSessionId(requested);
      return isCanonicalHubSessionId(requested, decoded) ? decoded.remoteSessionKey : requested;
    },
    actor: c => {
      const actor = queueActor(c.req.raw);
      if (!actor) throw new HTTPException(403, { message: 'Session authorization changed' });
      return actor;
    },
  });

  app.patch('/api/sessions/:sessionKey/visibility', (c) => changePreference(c.req.raw, 1,
    () => readPreferenceBody(c.req.raw) as Promise<{ hidden?: boolean }>, (body) => {
    const sessionKey = c.req.param('sessionKey');
    const hidden = body.hidden !== false;
    if (hidden) deps.store.hideSession(sessionKey);
    else deps.store.unhideSession(sessionKey);
    return c.json({ ok: true, sessionKey, hidden, updatedAt: Date.now() });
  }));

  app.patch('/api/sessions/:sessionKey/archive', (c) => changePreference(c.req.raw, 2,
    () => readPreferenceBody(c.req.raw) as Promise<{ archived?: boolean }>, (body) => {
    const sessionKey = c.req.param('sessionKey');
    const archived = body.archived !== false;
    if (archived) deps.store.archiveSession(sessionKey);
    else deps.store.unarchiveSession(sessionKey);
    return c.json({ ok: true, sessionKey, archived, updatedAt: Date.now() });
  }));

  app.patch('/api/sessions/:sessionKey/pin', (c) => changePreference(c.req.raw, 3,
    () => readPreferenceBody(c.req.raw) as Promise<{ pinned?: boolean }>, (body) => {
    const sessionKey = c.req.param('sessionKey');
    const pinned = body.pinned !== false;
    if (pinned) deps.store.pinSession(sessionKey);
    else deps.store.unpinSession(sessionKey);
    return c.json({ ok: true, sessionKey, pinned, updatedAt: Date.now() });
  }));

  registerDeletionReceipts(app, '/api/sessions/:sessionKey', {
    receipts: deps.commands,
    deletionAdmission: c => deps.deletionAdmission(c.req.param('sessionKey')!),
    scope: c => {
      const actor = queueActor(c.req.raw);
      if (!actor) throw new HTTPException(403, { message: 'session authorization changed' });
      return JSON.stringify([actor, c.req.param('sessionKey')]);
    },
  });
  app.delete('/api/sessions/:sessionKey', async (c) => {
    const sessionKey = c.req.param('sessionKey');
    const actor = queueActor(c.req.raw);
    const authorize = () => {
      c.req.raw.signal.throwIfAborted();
      if (!actor || queueActor(c.req.raw) !== actor) throw new TurnAuthorizationError();
      if (!deps.deletionAdmission(sessionKey)) throw new SessionDeletionConflict();
    };
    try {
      return c.json(await deleteConnectorSession(deps, sessionKey, authorize,
        body => c.get('acknowledgeDeletion')({ status: 200, body })));
    } catch (error) {
      if (error instanceof SessionDeletionConflict) return c.json({ error: error.message }, 409);
      if (error instanceof TurnAuthorizationError) return c.json({ error: 'session authorization changed' }, 403);
      return c.json({ error: deps.normalizeError(error) }, 502);
    }
  });

  app.post('/api/sessions/:sessionKey/compact', async (c) => {
    const authorize = localCommandAuthority(c.req.raw);
    authorize();
    const sessionKey = c.req.param('sessionKey');
    await deps.refreshSessions({ maxAgeMs: 5_000 }).catch(() => undefined);
    authorize();
    const session = deps.store.getSession(sessionKey);
    const idempotencyKey = nanoid();
    const deliver = false;
    const estimatedSkipReason = estimateCompactSkipReason(session);
    try {
      const { payload: result } = await deps.gateway.requestBound<any>('chat.send', {
        sessionKey,
        message: '/compact',
        deliver,
        idempotencyKey,
      }, undefined, authorize);
      deps.store.markSessionBusy(sessionKey);
      deps.store.append('queued_message.sent', { sessionKey, idempotencyKey, deliveryMode: 'web-only', deliver, localCommand: '/compact', result }, { sessionKey });
      return c.json({
        runId: String(result?.runId ?? result?.id ?? idempotencyKey),
        status: result?.status ?? 'started',
        idempotencyKey,
        deliveryMode: 'web-only',
        deliver,
        media: [],
        message: estimatedSkipReason
          ? `Compact requested. This session may be skipped because ${estimatedSkipReason}; Gateway will write the final result into the transcript.`
          : 'Compact requested. Gateway will write the final result into the transcript.',
        ...(estimatedSkipReason ? { estimatedSkipReason } : {}),
      });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      // A lost native reply does not prove that compaction was rejected.
      return c.json({ error: deps.normalizeError(error), idempotencyKey, status: 'outcome_unknown' }, 202);
    }
  });

  app.post('/api/sessions/:sessionKey/messages', async (c) => {
    const authorize = localCommandAuthority(c.req.raw);
    const sessionKey = c.req.param('sessionKey');
    await deps.refreshSessions({ maxAgeMs: 5_000 }).catch(() => undefined);
    authorize();
    const rawBody = await readJsonBody(c.req.raw, MAX_TOTAL_MEDIA_BYTES * 4 / 3 + MAX_TEXT_MESSAGE_BODY_BYTES);
    authorize();
    const validated = normalizeSendMessageRequest(rawBody);
    if ('error' in validated) return c.json({ error: validated.error }, 400);
    if (validated.message.trim() === '/stop') return c.json({ error: 'Use the versioned command endpoint with an observed run identity' }, 410);
    if (validated.deliveryMode === 'mirror' && validated.media.length === 0 && ['/status', '/compact'].includes(validated.message.trim())) {
      return c.json({ error: 'Mirror delivery for local controls requires native completion correlation; not dispatched' }, 409);
    }
    let uploadedMedia: PersistedUpload[];
    try {
      uploadedMedia = await persistUploadedMedia(validated.media, { inboundDir: deps.inboundDir });
    } catch (error) {
      return c.json({ error: deps.normalizeError(error) }, 400);
    }
    const message = validated.message;
    const gatewayAttachments = gatewayAttachmentsForMedia(uploadedMedia);
    const deliveryMode = validated.deliveryMode;
    const explicitRoute = deliveryMode === 'mirror' ? deps.resolveExplicitChannelRoute(sessionKey) : undefined;
    const deliver = false;
    if (!message && uploadedMedia.length === 0) return c.json({ error: 'message or media is required' }, 400);
    if (deliveryMode === 'mirror' && !explicitRoute) return c.json({ error: 'mirror delivery requires a channel-scoped session' }, 400);

    let activeSession = deps.store.getSession(sessionKey);
    if (!activeSession) return c.json({ error: 'session is no longer available; refresh the session list or create a new chat' }, 404);
    const isLocalCommand = uploadedMedia.length === 0 && ['/status', '/compact'].includes(message.trim());
    if (!isLocalCommand && activeSession?.hasActiveRun) {
      await deps.refreshMessages(sessionKey, { maxAgeMs: 0 }).catch(() => undefined);
      activeSession = deps.store.getSession(sessionKey);
    }
    if (!isLocalCommand) {
      const queued = {
        id: nanoid(),
        sessionKey,
        payload: {
        actorId: queueActor(c.req.raw),
        message,
        deliveryMode,
        ...(explicitRoute ? { explicitRoute } : {}),
        media: uploadedMedia.map((item) => ({ media: item.media, filePath: item.filePath })),
        },
        createdAt: Date.now(),
      };
      try { await deps.queue.enqueueAsync(queued, undefined, () => { authorize(); }); }
      catch (error) { return c.json({ error: error instanceof SessionDeletionConflict ? error.message : 'queue admission unavailable' },
        error instanceof SessionDeletionConflict ? 409 : 503); }
      deps.store.append('queued_message.created', { sessionKey, idempotencyKey: queued.id, deliveryMode }, { sessionKey });
      return c.json({
        runId: queued.id,
        status: 'queued',
        idempotencyKey: queued.id,
        deliveryMode,
        deliver: deliveryMode === 'mirror',
        explicitRoute,
        media: uploadedMedia.map((item) => item.media),
      });
    }

    authorize();
    const idempotencyKey = nanoid();
    const localMessage: ChatMessage = {
      id: idempotencyKey,
      sessionKey,
      role: 'user',
      text: validated.message,
      media: uploadedMedia.map((item) => item.media),
      status: 'sending',
      createdAt: Date.now(),
    };
    if (message.trim() === '/status' && uploadedMedia.length === 0) {
      const result = reportSessionStatus(deps.store, sessionKey, idempotencyKey, message);
      return result ? c.json(result) : c.json({ error: 'session not found' }, 404);
    }
    let dispatched = false;
    try {
      const sendParams: Record<string, unknown> = {
        sessionKey,
        message: messageWithSessionArtifactCapability(deps, sessionKey, message),
        deliver,
        idempotencyKey,
        ...(gatewayAttachments.length ? { attachments: gatewayAttachments } : {}),
      };
      const { payload: result } = await deps.gateway.requestBound<any>('chat.send', sendParams, undefined, () => {
        authorize();
        dispatched = true;
      });
      deps.store.addMessage({ ...localMessage, status: 'sent', updatedAt: Date.now() });
      deps.store.append('queued_message.sent', { sessionKey, idempotencyKey, deliveryMode, deliver, explicitRoute, result }, { sessionKey });
      return c.json({
        runId: String(result?.runId ?? result?.id ?? idempotencyKey),
        status: result?.status ?? 'started',
        idempotencyKey,
        deliveryMode,
        deliver: deliveryMode === 'mirror',
        explicitRoute,
        media: uploadedMedia.map((item) => item.media),
      });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      const normalizedError = deps.normalizeError(error);
      if (dispatched) deps.store.addMessage({ ...localMessage, status: 'outcome_unknown', updatedAt: Date.now() });
      return c.json({ error: normalizedError, idempotencyKey, status: 'outcome_unknown' }, 202);
    }
  });

  // Retire the unbound writer instead of maintaining a second stop protocol
  // without durable receipts. The current UI already uses versioned commands.
  app.post('/api/sessions/:sessionKey/stop', (c) =>
    c.json({ error: 'Use the versioned command endpoint with an observed run identity' }, 410));

  // No unversioned, actor-less back door to the Connector-owned queue.
  for (const method of ['PATCH', 'DELETE']) app.on(method, '/api/sessions/:sessionKey/queue/:messageId', (c) =>
    c.json({ error: 'Use the canonical Hub session queue endpoint with an observed queue version' }, 410));

  app.post('/api/agents/:agentId/sessions', async (c, next) => {
    const authorize = localCommandAuthority(c.req.raw); authorize();
    const body = await readJsonBody(c.req.raw, 64 * 1024);
    authorize(); c.req.bodyCache.json = Promise.resolve(body);
    await next();
  });
  registerCreationReceipts(app, '/api/agents/:agentId/sessions', {
    receipts: deps.commands,
    scope: c => {
      const actor = queueActor(c.req.raw);
      if (!actor) throw new HTTPException(403, { res: c.json({ error: 'session authorization required' }, 403) });
      return JSON.stringify([actor, c.req.param('agentId')]);
    },
  });
  app.post('/api/agents/:agentId/sessions', async (c) => {
    const actor = queueActor(c.req.raw);
    if (!actor) return c.json({ error: 'session authorization required' }, 403);
    const authorize = () => {
      c.req.raw.signal.throwIfAborted();
      if (queueActor(c.req.raw) !== actor) throw new TurnAuthorizationError();
    };
    const requestedAgentId = c.req.param('agentId');
    const agentId = requestedAgentId || deps.store.getGateway().defaultAgentId || 'main';
    const body = (await c.req.json().catch(() => ({}))) as { label?: string; model?: string };
    try {
      authorize();
      const { payload: result } = await deps.gateway.requestBound<any>('sessions.create', {
        agentId,
        label: body.label || `Web session ${new Date().toLocaleString()}`,
        ...(body.model ? { model: body.model } : {}),
      }, undefined, authorize);
      const key = String(result?.key ?? result?.sessionKey);
      if (!key || key === 'undefined') return c.json({ error: 'gateway did not return a session key' }, 502);
      if (deps.commands.sessionDeletion(key)) throw new SessionDeletionConflict();
      c.get('acknowledgeCreation')({ status: 200, body: { key } });
      const customTitle = typeof body.label === 'string' ? body.label.trim() : '';
      if (customTitle) deps.store.persistSessionTitleOverride(key, customTitle);
      deps.store.upsertSession({
        sessionKey: key,
        agentId,
        title: customTitle || 'New web session',
        status: 'idle',
        source: 'web',
        lastActiveAt: Date.now(),
      });
      return c.json({ key });
    } catch (error) {
      if (error instanceof TurnAuthorizationError) return c.json({ error: 'session authorization changed' }, 403);
      return c.json({ error: deps.normalizeError(error) }, error instanceof SessionDeletionConflict ? 409 : 502);
    }
  });

  return { close: () => readAuthority.close(), get pending() { return readAuthority.pending; } };
}

function messageWithSessionArtifactCapability(deps: Parameters<typeof registerSessionRoutes>[1], sessionKey: string, message: string) {
  if (deps.artifactCapability?.enabled !== true) return message;
  if (artifactCapabilityInjectedSessions.has(sessionKey)) return message;
  artifactCapabilityInjectedSessions.add(sessionKey);
  return withArtifactCapability(message, true, deps.artifactCapability.maxBytes);
}

function estimateCompactSkipReason(session: any) {
  const used = Number(session?.totalTokens);
  const limit = Number(session?.contextTokens);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || used <= 0 || limit <= 0) return undefined;
  const ratio = used / limit;
  if (ratio < 0.5) return `estimated context is below the compaction threshold (${Math.max(1, Math.round(ratio * 100))}% used)`;
  return undefined;
}
