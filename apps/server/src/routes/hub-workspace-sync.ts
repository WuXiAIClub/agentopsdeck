import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { stream } from 'hono/streaming';
import { parseWorkspaceSyncRequest, WORKSPACE_SYNC_MAX_FRAME_BYTES, type WorkspaceSyncFrame } from '@agentopsdeck/shared';
import { readJsonBody } from '../utils/http-body.js';
import { createConditionalHistory } from '../messages/conditional-history.js';
import { createWorkspaceReadScheduler } from '../hub/workspace-read-scheduler.js';
import { decodeHubSessionId, encodeHubSessionId } from '../hub/session-id.js';
import { ConnectorClientError, HistoryPreparing, type ConnectorClientResolver } from '../hub/connector-client.js';
import { HISTORY_ASYNC_HEADER, historyPendingBody } from '@agentopsdeck/shared';
import type { HubStore } from '../hub/hub-store.js';
import { mergeMessageIdentities } from '../messages/identity.js';
import type { HubConnection } from '../hub/hub-store.js';
import type { ChatMessage } from '@agentopsdeck/shared';
import { stableGatewayRowsRevision } from '../refresh/signature.js';
import { workspaceSyncTransfer } from '../messages/workspace-sync-transfer.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import { requestConnectorClient } from '../hub/request-connector-client.js';
import { HubMemberRequestError, type AsyncHubMemberRequests } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { pinOriginalRequestScope } from '../hub/original-request-scope.js';
import { OriginalTransportDrain } from '../connector/transport.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { hasBoardCapabilityCredential } from './workspace-agent.js';

type LegacyDependencies = {
  mode?: 'legacy';
  store: HubStore; client: ConnectorClientResolver; asyncConnectorClient?: AsyncConnectorClientResolver; owner: (c: Context) => string;
  access?: Pick<AsyncHubMemberRequests, 'begin'>;
};
type AsyncDependencies = {
  mode: 'async'; access: Pick<AsyncHubMemberRequests, 'begin' | 'close'>;
  asyncConnectorClient: AsyncConnectorClientResolver;
  store?: never; client?: never; owner?: never;
};
export function isAsyncHubWorkspaceSyncRequest(method: string, path: string) {
  return method === 'POST' && (path === '/api/hub/v1/workspace/sync' || path === '/api/hub/v1/workspace/check');
}
export function registerHubWorkspaceSync(app: Hono, deps: (LegacyDependencies | AsyncDependencies) & {
  wrap: (message: ChatMessage, sessionKey: string, connection: HubConnection) => ChatMessage;
  diagnostics?: PerformanceDiagnostics;
}) {
  if (deps.mode === 'async' && (typeof deps.access?.begin !== 'function' || typeof deps.access?.close !== 'function'
    || typeof deps.asyncConnectorClient !== 'function')) throw Error('hub_workspace_sync_ports_required');
  const schedule = createWorkspaceReadScheduler(), history = createConditionalHistory();
  const work = new HubRequestWork(), active = new Set<() => void>();
  const diagnostics = deps.diagnostics ?? performanceDiagnostics;
  // Calibration is a stable, metadata-only safety read. It never enables the
  // Preview transport or transfers transcript bodies. Both paths retain fresh
  // per-item authorization and independent errors/backpressure fences.
  for (const calibration of [false, true]) {
  const path = `/api/hub/v1/workspace/${calibration ? 'check' : 'sync'}`;
  app.use(path, async (c, next) => {
    if (c.req.method !== 'POST') return next();
    c.header('Cache-Control', 'no-store');
    if (deps.mode === 'async' && hasBoardCapabilityCredential(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    try { await work.run(next); }
    catch (error) {
      const status = error instanceof HubMemberRequestError || error instanceof HTTPException ? error.status : 503;
      c.res = new Response(JSON.stringify({ error: 'Workspace access temporarily unavailable' }), {
        status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
  });
  app.use(path, workspaceSyncTransfer);
  app.post(path, async c => {
    let access: Awaited<ReturnType<AsyncHubMemberRequests['begin']>> | undefined;
    let owner: string;
    try {
      access = await deps.access?.begin(c.req.raw);
      if (deps.access && !access) throw new HubMemberRequestError(503);
      owner = deps.mode === 'async' ? access!.principal.userId : deps.owner(c);
      if (access && access.principal.userId !== owner) throw new HTTPException(401);
      if (deps.mode === 'async') {
        const expected = c.req.header('x-agentopsdeck-recovery-scope');
        if (expected !== undefined && expected !== access!.recoveryScope) throw new HTTPException(409);
        pinOriginalRequestScope(c.req.raw, access!.recoveryScope);
      }
      work.check();
    } catch (error) {
      const status = error instanceof HubMemberRequestError || error instanceof HTTPException ? error.status : 503;
      return new Response(JSON.stringify({ error: status === 401 ? 'unauthorized' : 'Workspace access temporarily unavailable' }), {
        status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    let items;
    try { items = parseWorkspaceSyncRequest(await readJsonBody(c.req.raw, 64 * 1024)); }
    catch (error) {
      work.check(); await access?.check(); work.check();
      if (error instanceof HTTPException) throw error;
      return c.json({ error: 'Invalid workspace sync request' }, 400);
    }
    work.check(); await access?.check(); work.check();
    c.req.raw.signal.throwIfAborted();
    c.header('Content-Type', 'application/x-ndjson');
    c.header('Cache-Control', 'no-store');
    c.header('X-Accel-Buffering', 'no');
    c.header('X-AgentOpsDeck-Workspace-Sync', '1');
    return stream(c, async output => {
      try { await work.run(async () => {
      const trace = guardedTrace(diagnostics, 'hub-workspace-sync');
      const pending = setTimeout(() => trace.reportPending({ pending: work.pending }), 30_000); pending.unref();
      const controller = new AbortController();
      const abort = () => { controller.abort(); output.abort(); };
      active.add(abort);
      c.req.raw.signal.addEventListener('abort', abort, { once: true });
      output.onAbort(() => controller.abort());
      const timer = setTimeout(abort, 25_000);
      let writes = Promise.resolve(), totalBytes = 0;
      try {
        if (c.req.raw.signal.aborted) abort();
        await Promise.all(items.map(async item => {
          const actor = () => { work.check(); if (deps.mode !== 'async' && deps.owner(c) !== owner) throw new HTTPException(401); };
          let itemAccess: typeof access;
          let authorize = async () => { actor(); await itemAccess?.check(); actor(); };
          const failure = (error: unknown): WorkspaceSyncFrame => error instanceof HistoryPreparing
            ? { sessionKey: item.sessionKey, status: 202, body: historyPendingBody() }
            : ({ sessionKey: item.sessionKey,
            status: error instanceof HTTPException || error instanceof HubMemberRequestError ? error.status : error instanceof ConnectorClientError ? error.status : 503,
            body: { error: error instanceof HTTPException || error instanceof HubMemberRequestError ? (error.status === 404 ? 'session not found' : 'Workspace access changed')
              : error instanceof ConnectorClientError ? error.message : 'Workspace history temporarily unavailable' } });
          let frame: WorkspaceSyncFrame;
          try {
            // A failed target must not poison unrelated items' request state.
            // Each pin still belongs to the same original account and scope.
            if (deps.access) {
              itemAccess = await deps.access.begin(c.req.raw);
              if (!itemAccess) throw new HubMemberRequestError(503);
              if (itemAccess.principal.userId !== owner || itemAccess.principal.admin !== access?.principal.admin
                || itemAccess.recoveryScope !== access?.recoveryScope) throw new HTTPException(401);
            }
            await authorize(); controller.signal.throwIfAborted();
            const decoded = decodeHubSessionId(item.sessionKey);
            if (!decoded || encodeHubSessionId(decoded.connectionId, decoded.remoteSessionKey) !== item.sessionKey) throw new HTTPException(404);
            // Select the original awaited authority lane once. A refused or
            // unavailable owner must never fall back to synchronous SQL.
            const target = itemAccess ? await itemAccess.connection(decoded.connectionId) : undefined;
            actor(); controller.signal.throwIfAborted();
            if (itemAccess && !target) throw new HubMemberRequestError(503);
            const connection = target ? target.connection : deps.mode !== 'async' ? deps.store.getConnection(decoded.connectionId, owner) : undefined;
            if (!connection || connection.status === 'disabled') throw new HTTPException(404);
            const version = target ? target.epoch : deps.mode !== 'async' ? deps.store.connectionAuthority(connection.id, owner) : undefined;
            authorize = async () => {
              actor();
              if (target) {
                try { await target.check(); }
                catch (error) {
                  // Preserve this streaming transport's historical 403 on a
                  // changed connection; account revocation remains 401.
                  if (error instanceof HubMemberRequestError && (error.status === 409 || error.status === 404)) throw new HTTPException(403);
                  throw error;
                }
              } else if (deps.mode === 'async' || deps.store.connectionAuthority(connection.id, owner) !== version) throw new HTTPException(403);
              actor();
            };
            // Node identity, not display label. No cross-owner result cache.
            const connector = connection.nodeId ?? JSON.stringify([owner, connection.id, version]);
            const itemPriority = item.priority ?? (calibration ? 4 : 0);
            const page = await schedule.read(connector, controller.signal, async () => {
              await authorize(); controller.signal.throwIfAborted();
              const resolved = deps.mode === 'async' ? await deps.asyncConnectorClient(c.req.raw, connection.id, { expectedUserId: owner })
                : await requestConnectorClient({ connectorClient: deps.client,
                ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}) },
                c.req.raw, connection.id, false, owner, undefined, controller.signal);
              const client = deps.mode === 'async' ? resolved.withLocalFence(() => work.check()) : resolved;
              await authorize(); controller.signal.throwIfAborted();
              const drain = new OriginalTransportDrain();
              let result;
              try { result = await client.messages(decoded.remoteSessionKey, String(item.limit), controller.signal, undefined, c.req.header(HISTORY_ASYNC_HEADER) === '1', drain); }
              finally { await drain.wait(); }
              await authorize(); controller.signal.throwIfAborted();
              const messages = mergeMessageIdentities(result.messages).map(message => deps.wrap(message, item.sessionKey, connection));
              return { ...result, messages, revision: result.revision ?? stableGatewayRowsRevision(messages) };
            }, itemPriority);
            await authorize(); controller.signal.throwIfAborted();
            const url = new URL(`/api/hub/v1/sessions/${encodeURIComponent(item.sessionKey)}/messages?limit=${item.limit}`, c.req.url);
            if (calibration) {
              const checked = history.check(url.href, item.etag, page);
              frame = { sessionKey: item.sessionKey, status: checked.status,
                headers: { ...checked.headers, ...(checked.status === 200 ? { 'x-agentopsdeck-history-check': 'changed' } : {}) },
                ...(checked.status === 304 ? {} : { body: { changed: true } }) };
            } else {
              const encoded = history.encode(url.href, item.etag, true, page);
              frame = { sessionKey: item.sessionKey, status: encoded.status, headers: encoded.headers,
                ...(encoded.body === null ? {} : { body: JSON.parse(encoded.body) }) };
            }
          } catch (error) { frame = failure(error); }
          // Serialize writes, but not reads. Re-check authority AFTER waiting for
          // backpressure: revocation must not leak a buffered successful frame.
          const write = writes.then(async () => {
            if (controller.signal.aborted) return;
            try { await authorize(); } catch (error) { frame = failure(error); }
            // Cancellation/deadline may happen during the last authority
            // await, including after a successful frame has been buffered.
            if (controller.signal.aborted) return;
            let line = JSON.stringify(frame) + '\n';
            if (Buffer.byteLength(line) > WORKSPACE_SYNC_MAX_FRAME_BYTES || totalBytes + Buffer.byteLength(line) > 32 * 1024 * 1024) {
              line = JSON.stringify({ sessionKey: item.sessionKey, status: 502, body: { error: 'Workspace history exceeds transport budget' } }) + '\n';
            }
            totalBytes += Buffer.byteLength(line);
            await output.write(line);
          });
          writes = write.catch(abort);
          await writes;
        }));
      } finally {
        clearTimeout(timer); clearTimeout(pending); active.delete(abort);
        c.req.raw.signal.removeEventListener('abort', abort); controller.abort(); trace.finish(controller.signal.aborted && totalBytes === 0);
      }
      }); } catch { output.abort(); }
    });
  });
  }
  const drain = createIndependentDrain([() => work.close(), () => deps.mode === 'async' ? deps.access.close() : undefined], 'hub-route-drain', diagnostics);
  return { close() {
    const result = drain();
    for (const abort of active) abort();
    return result;
  }, get pending() { return work.pending; } };
}
