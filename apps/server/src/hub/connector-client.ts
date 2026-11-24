import type { ChatMessage, SessionsState, SessionDirectoryQuery, SessionHistoryStatus } from '@agentopsdeck/shared';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER, acceptsConnectorProtocolHeader, isOwnerOnlyRuntimeResource, resolveMessageLimits, type MessageLimits } from '@agentopsdeck/shared';
import { createHash } from 'node:crypto';
import { boundedDispatch, OriginalTransportDrain, type Dispatch } from '../connector/transport.js';
import type { HubStore } from './hub-store.js';
import { parseConnectorEvents } from '../connector/sse.js';
import type { NodeGrantProof } from './node-grants.js';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER, isNodeId } from '../connector/node-identity.js';
import { guardedBody } from '../connector/guarded-body.js';
import { sessionExecutionSnapshot } from '../projection/session-execution.js';
import { connectWithRetry } from './connector-connect.js';
import { connectorAuthorization, type ConnectorAuthorization } from './connector-authorization.js';
import { parseSessionDirectoryQuery, sessionDirectoryParams, sessionDirectoryPage } from '../projection/session-directory.js';
import { createConditionalHistoryCache, restoreConditionalHistory, restoreHistoryDelta, HISTORY_DELTA_HEADER } from '@agentopsdeck/shared';
import { HISTORY_ASYNC_HEADER, isHistoryPending } from '@agentopsdeck/shared';
import { BOARD_MAX_BODY_BYTES, WORKSPACE_FILE_CARD_MAX_BYTES, validBoardUuid } from '@agentopsdeck/shared';

import type { ConnectorResponseCollector } from '../hub/response-budget.js';
import { connectionControlWire, connectionControlObservation, validConnectionControlOperation,
  type ConnectionControlOperation, type ConnectionControlObservation } from './connection-control-contract.js';
import { weixinActionWire, readWeixinActionResult, validWeixinAction, type WeixinAction, type WeixinActionResult } from './weixin-action-contract.js';

export class HistoryPreparing extends Error {
  constructor() { super('History is being prepared'); }
}

export class ConnectorClientError extends Error {
  constructor(readonly status: number, message: string, readonly source?: { reason: string; canApprove: boolean }) { super(message); }
}

export type MessagesPage = {
  limits?: MessageLimits;
  historyStatus?: SessionHistoryStatus;
  sourceCursor?: string;
  messages: ChatMessage[];
  totalCount: number;
  hiddenCount: number;
  updatedAt: number;
  revision?: string;
};
type ConnectorAuthorityScope = { signal?: AbortSignal | undefined; deadlineAt?: number | undefined; idle: boolean; drain?: OriginalTransportDrain | undefined };

export class ConnectorClient {
  // Delivery checks share the original non-streaming deadline. Idle streams
  // retain their idle transport owner and bound each authority wait separately.
  private readonly authorityScopes = new WeakMap<Response, ConnectorAuthorityScope>();
  get expectedNodeId() { return this.access.nodeId; }
  // Opaque partition key: a changed endpoint/credential must not reuse cached data.
  get eventDomain() { return createHash('sha256').update(JSON.stringify([this.origin, this.token, this.access.domain])).digest('hex'); }
  constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly dispatch: Dispatch | undefined = undefined,
    private readonly deadlineMs = 10_000,
    private readonly maxResponseBytes = 8 * 1024 * 1024,
    private readonly access: { authorize?: ConnectorAuthorization; request?: (path: string, method: string) => void | Promise<void>; domain?: string; nodeId?: string } = {},
    private readonly historyCache = createConditionalHistoryCache(),
  ) {}

  /** Denial-only lifecycle fence. It cannot grant authority or bypass the
   * original database authorization, including late dispatch/body checks. */
  withLocalFence(check: () => void): ConnectorClient {
    const authorize = this.access.authorize;
    return new ConnectorClient(this.origin, this.token, this.dispatch, this.deadlineMs,
      this.maxResponseBytes, { ...this.access, authorize: async () => {
        check(); await authorize?.(); check();
      } }, this.historyCache);
  }

  private async checkAuthority(check: ConnectorAuthorization | undefined,
    scope: ConnectorAuthorityScope) {
    scope.signal?.throwIfAborted();
    if (!check) return;
    const remaining = scope.deadlineAt === undefined ? 45_000 : Math.ceil(scope.deadlineAt - performance.now());
    if (remaining <= 0) throw new Error('Deadline exceeded');
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('Deadline exceeded')), remaining);
    const signal = scope.signal ? AbortSignal.any([scope.signal, deadline.signal]) : deadline.signal;
    try { await connectorAuthorization(scope.drain ? () => {
      // An interrupted authority wait must not release its original worker ACK.
      // Retain it on the same owner as dispatch/body cancellation, without
      // allowing its late completion to dispatch or publish anything.
      const original = Promise.resolve().then(check);
      scope.drain!.track(original);
      return original;
    } : check, signal); }
    finally { clearTimeout(timer); }
  }

  private async authorizeResponse(response: Response, additional?: ConnectorAuthorization, bodySignal?: AbortSignal) {
    const original = this.authorityScopes.get(response)!;
    const scope = bodySignal ? { ...original, signal: original.signal ? AbortSignal.any([original.signal, bodySignal]) : bodySignal } : original;
    await this.checkAuthority(this.access.authorize, scope);
    await this.checkAuthority(additional, scope);
  }

  async json<T>(path: string, init: RequestInit = {}, collector?: ConnectorResponseCollector): Promise<T> {
    return (await this.jsonResponse<T>(path, init, collector)).body;
  }

  /** Lifecycle-owned effects must retain the original dispatch/cancellation ACK,
   * not just the HTTP deadline response. This never retries a lost mutation. */
  async jsonOriginal<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.jsonResponseOriginal<T>(path, init)).body;
  }

  /** Preserve wire status AND original effect/cancellation ownership. */
  async jsonResponseOriginal<T>(path: string, init: RequestInit = {}): Promise<{ body: T; status: number }> {
    const drain = new OriginalTransportDrain();
    try {
      const response = await this.open(path, init, false, false, false, drain);
      return { body: await this.readJson<T>(response), status: response.status };
    }
    finally { await drain.wait(); }
  }

  /** Private original-effect collection for FIXED controls only. Current user
   * authority gates dispatch and delivery, never erases an already known effect
   * before its original audit/receipt settlement. No generic skip-auth option. */
  async connectionControlOriginal(command: ConnectionControlOperation,
    settle: (observation: ConnectionControlObservation) => Promise<void>, signal?: AbortSignal): Promise<{ body: unknown; status: number }> {
    if (!validConnectionControlOperation(command)) throw new ConnectorClientError(400, 'Invalid connection control');
    // Pin a caller-owned object before the first asynchronous authority check.
    const pinned: ConnectionControlOperation = JSON.parse(JSON.stringify(command));
    return this.fixedOriginal(connectionControlWire(pinned), async (status, body) => {
      await settle(connectionControlObservation(pinned, status, body));
    }, signal);
  }

  /** Private known-result observation does not authorize response delivery. */
  async weixinActionOriginal(command: WeixinAction, observe: (result: WeixinActionResult) => Promise<void>, signal?: AbortSignal) {
    if (!validWeixinAction(command)) throw new ConnectorClientError(400, 'Invalid Weixin action');
    const pinned: WeixinAction = JSON.parse(JSON.stringify(command));
    return this.fixedOriginal(weixinActionWire(pinned), async (status, body) => {
      const known = readWeixinActionResult(pinned, status, body, this.expectedNodeId);
      if (known) await observe(known);
    }, signal);
  }

  /** Called only by the two validated fixed business contracts above. */
  private async fixedOriginal(wire: { path: string; method: string; body?: string; headers?: Record<string, string> },
    observe: (status: number, body: unknown) => Promise<void>, signal?: AbortSignal): Promise<{ body: unknown; status: number }> {
    const drain = new OriginalTransportDrain();
    const scope = { signal, deadlineAt: performance.now() + this.deadlineMs, idle: false, drain };
    try {
      await this.checkAuthority(this.access.request ? () => this.access.request!(wire.path, wire.method) : undefined, scope);
      await this.checkAuthority(this.access.authorize, scope);
      signal?.throwIfAborted();
      const headers = new Headers({ authorization: `Bearer ${this.token}`, [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) });
      for (const [key, value] of Object.entries(wire.headers ?? {})) headers.set(key, value);
      if (this.access.nodeId) headers.set(EXPECTED_NODE_HEADER, this.access.nodeId);
      if ('body' in wire) headers.set('content-type', 'application/json');
      const remaining = Math.ceil(scope.deadlineAt - performance.now());
      if (remaining <= 0) throw Error('Deadline exceeded');
      // Fixed operation paths cannot select arbitrary endpoints. No connect retry
      // or credential refresh can re-dispatch a possibly executed control.
      const response = await boundedDispatch(this.dispatch ?? (request => fetch(request)), remaining, false, drain)(new Request(
        `${this.origin}/api/connector/v1${wire.path}`, { method: wire.method, headers, signal: signal ?? null,
          redirect: 'error', ...('body' in wire ? {body: wire.body} : {}) }));
      try {
        if (!acceptsConnectorProtocolHeader(response.headers.get(CONNECTOR_PROTOCOL_HEADER))) throw new ConnectorClientError(426, 'Incompatible Connector protocol');
        if (this.access.nodeId && response.headers.get(NODE_ID_HEADER) !== this.access.nodeId) throw new ConnectorClientError(502, 'Connector identity mismatch');
        // Do not turn 3xx/5xx, unknown bodies or target mismatch into a known
        // rejection/success. They retain their admitted uncertainty fence.
        if (response.status < 200 || response.status >= 500 || response.status >= 300 && response.status < 400) {
          throw new ConnectorClientError(response.status, `Connector request failed: HTTP ${response.status}`);
        }
        if (!response.body) throw new ConnectorClientError(502, 'Connector response is empty');
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let size = 0, body: unknown;
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > this.maxResponseBytes) throw new ConnectorClientError(502, 'Connector response exceeds size limit');
            chunks.push(item.value);
          }
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { throw new ConnectorClientError(502, 'Invalid Connector JSON response'); }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        // Original private settlement deliberately precedes current delivery
        // checks, including abort/revocation that happens after known EOF.
        await observe(response.status, body);
        await this.checkAuthority(this.access.authorize, scope);
        if (!response.ok) throw new ConnectorClientError(response.status, `Connector request failed: HTTP ${response.status}`);
        return {body, status: response.status};
      } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
    } finally { await drain.wait(); }
  }

  async terminalOutput<T>(id: string, cursor: number, signal: AbortSignal): Promise<T> {
    const drain = new OriginalTransportDrain();
    try {
      const response = await this.open(`/terminals/${encodeURIComponent(id)}/output?cursor=${cursor}`, { signal }, true, false, false, drain);
      return await this.readJson<T>(response);
    } finally { await drain.wait(); }
  }

  async websiteSocketOutput<T>(accessId: string, socketId: string, signal: AbortSignal): Promise<T> {
    const drain = new OriginalTransportDrain();
    try {
      const response = await this.open(`/website-access/${encodeURIComponent(accessId)}/sockets/${encodeURIComponent(socketId)}/output`, { signal }, true, false, false, drain);
      return await this.readJson<T>(response);
    } finally { await drain.wait(); }
  }

  async jsonResponse<T>(path: string, init: RequestInit = {}, collector?: ConnectorResponseCollector): Promise<{ body: T; status: number }> {
    // Aggregation reservations belong to original transport work, not its
    // deadline/abort response. Retain them through late dispatch and source
    // cancellation acknowledgement. Legacy callers keep HTTP timeout behavior.
    const drain = collector ? new OriginalTransportDrain() : undefined;
    try {
      const response = await this.open(path, init, false, false, false, drain);
      return { body: await this.readJson<T>(response, collector), status: response.status };
    } finally { await drain?.wait(); }
  }

  private async open(path: string, init: RequestInit = {}, idle = false, allowRangeError = false, allowNotModified = false, drain?: OriginalTransportDrain) {
    const scope = { signal: init.signal ?? undefined, deadlineAt: idle ? undefined : performance.now() + this.deadlineMs, idle, drain };
    const url = new URL(`${this.origin}/api/connector/v1${path}`);
    if (!path.startsWith('/') || path.startsWith('//') || url.origin !== new URL(this.origin).origin || !url.pathname.startsWith('/api/connector/v1/')) throw new Error('Invalid Connector path');
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.token}`);
    headers.set(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max));
    // Callers cannot override the trusted expected target.
    headers.delete(EXPECTED_NODE_HEADER);
    if (this.access.nodeId) headers.set(EXPECTED_NODE_HEADER, this.access.nodeId);
    const method = (init.method ?? 'GET').toUpperCase();
    await this.checkAuthority(this.access.request ? () => this.access.request!(path, method) : undefined, scope);
    await this.checkAuthority(this.access.authorize, scope);
    scope.signal?.throwIfAborted();
    const dispatch: Dispatch = this.dispatch ?? (request => {
      // In-process handlers and arbitrary/streaming bodies are never retried.
      // The only retryable fact is refusal of the TCP connection, before any
      // HTTP request could arrive. Rebuild the body; never reuse a used stream.
      if (method !== 'POST' || !/^\/sessions\/[^/]+\/messages$/.test(path)
        || (init.body != null && typeof init.body !== 'string')) return fetch(request);
      return connectWithRetry(() => fetch(new Request(url, { ...init, headers, signal: request.signal, redirect: 'error' })),
        request.signal, async () => {
          await this.access.request?.(path, method);
          request.signal.throwIfAborted();
          await this.access.authorize?.();
        });
    });
    const remaining = scope.deadlineAt === undefined ? 45_000 : Math.ceil(scope.deadlineAt - performance.now());
    if (remaining <= 0) throw new Error('Deadline exceeded');
    const response = await boundedDispatch(dispatch, remaining, idle, drain)(new Request(url, {
      ...init, headers, redirect: 'error',
    }));
    this.authorityScopes.set(response, scope);
    try {
      await this.authorizeResponse(response);
      if (!acceptsConnectorProtocolHeader(response.headers.get(CONNECTOR_PROTOCOL_HEADER))) throw new ConnectorClientError(426, 'Incompatible Connector protocol');
      if (this.access.nodeId && response.headers.get(NODE_ID_HEADER) !== this.access.nodeId) {
        // An old/misrouted server could have ignored the request header and
        // executed a mutation. Do not turn this into a definitive rejection.
        throw new ConnectorClientError(502, 'Connector identity mismatch');
      }
    }
    catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
    if (allowNotModified && response.status === 304) return response;
    if (allowRangeError && response.status === 416) return response;
    if (!response.ok) {
      await response.body?.cancel();
      const reason = response.headers.get('x-agentopsdeck-source-error');
      if (response.status === 404 && /^\/sessions\/[^/]+\/messages\/[^/]+\/media\/[a-f0-9]{64}$/.test(path)
        && reason && ['outside-roots', 'missing', 'unsafe-file', 'too-large', 'changed', 'unsupported-text', 'line-missing'].includes(reason)) {
        throw new ConnectorClientError(404, 'Source preview unavailable', { reason, canApprove: reason === 'outside-roots' && response.headers.get('x-agentopsdeck-source-approval') === 'available' });
      }
      // Do not relay arbitrary upstream errors (which may contain credentials).
      if (path.startsWith('/files/')) {
        if (method === 'POST' && /^\/files\/agents\/[^/]+\/text$/.test(path)) {
          if (response.status === 409) throw new ConnectorClientError(409, 'File save conflicted or workspace is unavailable. Keep your draft and check the file before retrying.');
          if (response.status === 403) throw new ConnectorClientError(403, 'File editing requires files:read and files:write and an authorized workspace path.');
        }
        if (response.status === 409) throw new ConnectorClientError(409, 'Workspace browsing is not configured. Set AOD_FILE_ROOTS_JSON on this Connector and grant files:read to its Hub credential.');
        if (response.status === 403) throw new ConnectorClientError(403, 'Workspace access denied. The Connector credential needs files:read and the requested path must be inside its allowed roots.');
        if (response.status === 404) throw new ConnectorClientError(404, 'Workspace unavailable. Configure AOD_FILE_ROOTS_JSON for this agent on the Connector, or check that the requested file still exists.');
      }
      throw new ConnectorClientError(response.status, `Connector request failed: HTTP ${response.status}`);
    }
    if (!response.body) throw new ConnectorClientError(502, 'Connector response is empty');
    return response;
  }

  private async readJson<T>(response: Response, collector?: ConnectorResponseCollector): Promise<T> {
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        await this.authorizeResponse(response);
        if (done) break;
        size += value.byteLength;
        if (size > this.maxResponseBytes) throw new ConnectorClientError(502, 'Connector response exceeds size limit');
        collector?.consume(value.byteLength);
        chunks.push(value);
      }
      await this.authorizeResponse(response);
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T; }
      catch { throw new ConnectorClientError(502, 'Invalid Connector JSON response'); }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async identity(signal?: AbortSignal) {
    const drain = new OriginalTransportDrain();
    try {
      const response = await this.open('/identity', { ...(signal ? { signal } : {}) }, false, false, false, drain);
      const body = await this.readJson<{ nodeId: string; protocol: number }>(response);
      if (!isNodeId(body?.nodeId) || body.protocol !== 1 || response.headers.get(NODE_ID_HEADER) !== body.nodeId) {
        throw new ConnectorClientError(502, 'Invalid Connector identity');
      }
      return body.nodeId;
    } finally { await drain.wait(); }
  }

  async media(name: string, signal?: AbortSignal, authorize?: ConnectorAuthorization, range?: string, ifRange?: string, drain?: OriginalTransportDrain) {
    return this.mediaAt(`/media/inbound/${encodeURIComponent(name)}`, signal, authorize, range, ifRange, drain);
  }

  async workspaceFile(agentId: string, path: string, signal?: AbortSignal, authorize?: ConnectorAuthorization, drain?: OriginalTransportDrain) {
    return this.mediaAt(`/files/agents/${encodeURIComponent(agentId)}/download?${new URLSearchParams({ path })}`, signal, authorize, undefined, undefined, drain);
  }

  async sessionMedia(sessionKey: string, messageId: string, resourceId: string, signal?: AbortSignal, authorize?: ConnectorAuthorization, range?: string, ifRange?: string, drain?: OriginalTransportDrain) {
    return this.mediaAt(`/sessions/${encodeURIComponent(sessionKey)}/messages/${encodeURIComponent(messageId)}/media/${encodeURIComponent(resourceId)}`, signal, authorize, range, ifRange, drain);
  }

  private async mediaAt(path: string, signal?: AbortSignal, authorize?: ConnectorAuthorization, range?: string, ifRange?: string, drain = new OriginalTransportDrain()) {
    await this.checkAuthority(authorize, { signal, idle: true });
    const requestHeaders = new Headers();
    if (range !== undefined) requestHeaders.set('range', range);
    if (ifRange !== undefined) requestHeaders.set('if-range', ifRange);
    const response = await this.open(path, { headers: requestHeaders, ...(signal ? { signal } : {}) }, true, true, false, drain);
    const check = (bodySignal?: AbortSignal) => this.authorizeResponse(response, authorize, bodySignal);
    try { await check(); } catch (error) { void response.body?.cancel(error).catch(() => {}); throw error; }
    // Only a bounded streaming body; no whole-file buffering or private headers.
    const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    if (response.status === 416) {
      await response.body?.cancel(); await check();
      const contentRange = response.headers.get('content-range');
      if (!contentRange || !/^bytes \*\/\d+$/.test(contentRange) || !Number.isSafeInteger(Number(contentRange.slice(8)))) throw new ConnectorClientError(502, 'Invalid Connector range response');
      headers.set('content-range', contentRange); headers.set('content-length', '0'); headers.set('accept-ranges', 'bytes');
      return new Response(null, { status: 416, headers });
    }
    const length = response.headers.get('content-length');
    let expectedBytes = length === null ? undefined : Number(length);
    try {
      if (![200, 206].includes(response.status) || (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(expectedBytes) || expectedBytes! > 64 * 1024 * 1024))) throw new Error();
      const contentRange = response.headers.get('content-range');
      if (response.status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? '');
        if (!range || !match) throw new Error();
        const [start, end, total] = match.slice(1).map(Number);
        if (![start, end, total].every(Number.isSafeInteger) || start! > end! || end! >= total!) throw new Error();
        const rangeLength = end! - start! + 1;
        if (rangeLength > 64 * 1024 * 1024 || (expectedBytes !== undefined && expectedBytes !== rangeLength)) throw new Error();
        expectedBytes = rangeLength;
      } else if (contentRange !== null) throw new Error();
    } catch {
      await response.body?.cancel();
      throw new ConnectorClientError(502, 'Invalid Connector media response');
    }
    for (const key of ['content-type', 'content-length', 'content-disposition', 'accept-ranges', 'content-range']) {
      const value = response.headers.get(key);
      if (value) headers.set(key, value);
    }
    const body = guardedBody(response.body!, { authorize: check, drain: () => drain.wait(), ...(signal ? { signal } : {}), ...(expectedBytes !== undefined ? { expectedBytes, maxBytes: expectedBytes } : {}) });
    return new Response(body, { status: response.status, headers });
  }

  async sessions(signal?: AbortSignal, collector?: ConnectorResponseCollector) {
    // Fetch all preferences; Hub applies its own per-user filtering afterwards.
    const state = await this.json<SessionsState>('/sessions/state?includeHidden=1&includeArchived=1', { ...(signal ? { signal } : {}) }, collector);
    if (!state || !Array.isArray(state.groups) || state.groups.some((group) => !group || typeof group.agentId !== 'string' || !Array.isArray(group.sessions))) throw new ConnectorClientError(502, 'Invalid Connector sessions response');
    return state;
  }

  async sessionDirectory(query: SessionDirectoryQuery = {}, signal?: AbortSignal) {
    const page = await this.json<unknown>(`/sessions/directory?${sessionDirectoryParams(query)}`, { ...(signal ? { signal } : {}) });
    try { return sessionDirectoryPage(page, query); }
    catch { throw new ConnectorClientError(502, 'Invalid Connector session directory'); }
  }

  async sessionDirectoryOriginal(query: SessionDirectoryQuery = {}, signal?: AbortSignal) {
    const page = await this.jsonOriginal<unknown>(`/sessions/directory?${sessionDirectoryParams(query)}`, { ...(signal ? { signal } : {}) });
    try { return sessionDirectoryPage(page, query); }
    catch { throw new ConnectorClientError(502, 'Invalid Connector session directory'); }
  }

  async sessionExecution(sessionKey: string, signal?: AbortSignal) {
    const snapshot = await this.json<unknown>(`/sessions/${encodeURIComponent(sessionKey)}/state`, { ...(signal ? { signal } : {}) });
    try { return sessionExecutionSnapshot(snapshot, sessionKey); }
    catch { throw new ConnectorClientError(502, 'Invalid Connector execution snapshot'); }
  }

  async sessionExecutionOriginal(sessionKey: string, signal?: AbortSignal) {
    const snapshot = await this.jsonOriginal<unknown>(`/sessions/${encodeURIComponent(sessionKey)}/state`, { ...(signal ? { signal } : {}) });
    try { return sessionExecutionSnapshot(snapshot, sessionKey); }
    catch { throw new ConnectorClientError(502, 'Invalid Connector execution snapshot'); }
  }

  async messages(sessionKey: string, limit?: string, signal?: AbortSignal, before?: string, asynchronous = false, drain?: OriginalTransportDrain) {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', limit);
    if (before !== undefined) params.set('before', before);
    const query = params.size ? `?${params}` : '';
    const path = `/sessions/${encodeURIComponent(sessionKey)}/messages${query}`;
    // Resolver-owned budget across all connections. Identity binds the target,
    // credential and authority/grant generation, never just the session name.
    const key = `${this.eventDomain} ${this.expectedNodeId ?? ''} ${path}`;
    const previous = this.historyCache.get(key);
    try {
      const headers = new Headers({ [HISTORY_DELTA_HEADER]: '1' });
      if (asynchronous) headers.set(HISTORY_ASYNC_HEADER, '1');
      if (previous) headers.set('if-none-match', previous.etag);
      const response = await this.open(path, { headers, ...(signal ? { signal } : {}) }, false, false, true, drain);
      if (response.status === 202) {
        const body = await this.readJson<unknown>(response);
        await this.authorizeResponse(response); signal?.throwIfAborted();
        if (!asynchronous || !isHistoryPending(body)) throw new ConnectorClientError(502, 'Invalid Connector history preparation');
        throw new HistoryPreparing();
      }
      let page: MessagesPage;
      if (response.status === 304) {
        await response.body?.cancel();
        page = restoreConditionalHistory(previous, response.headers.get('etag'), response.headers.get('x-agentopsdeck-history-meta')) as MessagesPage;
      } else {
        const body = await this.readJson<MessagesPage>(response);
        page = response.headers.get(HISTORY_DELTA_HEADER) === '1' ? restoreHistoryDelta(previous, body, this.maxResponseBytes) as MessagesPage : body;
      }
      await this.authorizeResponse(response); signal?.throwIfAborted();
      if (!page || !Array.isArray(page.messages) || page.messages.some((message) => !message || typeof message.id !== 'string')) throw new ConnectorClientError(502, 'Invalid Connector messages response');
      if (before !== undefined && page.messages.some(message => message.id === before)) throw new ConnectorClientError(502, 'Connector does not support history pagination');
      if (response.status !== 304) this.historyCache.put(key, response.headers.get('etag'), page);
      return { ...page, limits: resolveMessageLimits(page.limits) };
    } catch (error) {
      if (!(error instanceof HistoryPreparing)) this.historyCache.remove(key);
      throw error;
    }
  }

  async message(sessionKey: string, messageId: string, signal?: AbortSignal, drain?: OriginalTransportDrain) {
    return this.readJson<{ message: ChatMessage; updatedAt: number }>(await this.open(`/sessions/${encodeURIComponent(sessionKey)}/messages/${encodeURIComponent(messageId)}`, { ...(signal ? { signal } : {}) }, false, false, false, drain));
  }

  async *fileBoardEvents(ids: string[], signal: AbortSignal) {
    yield* this.workspaceFileEvents('board-files', ids, signal, BOARD_MAX_BODY_BYTES);
  }
  async *fileCardEvents(ids: string[], signal: AbortSignal) {
    yield* this.workspaceFileEvents('card-files', ids, signal, WORKSPACE_FILE_CARD_MAX_BYTES);
  }
  private async *workspaceFileEvents(namespace: 'board-files' | 'card-files', ids: string[], signal: AbortSignal, maxBytes: number) {
    if (!ids.length || ids.length > 64 || !ids.every(validBoardUuid) || new Set(ids).size !== ids.length) throw new ConnectorClientError(400, 'Invalid file panel subscription');
    const response = await this.open(`/workspace/${namespace}/subscribe`, {
      method: 'POST', headers: { accept: 'text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ ids }), signal,
    }, true);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel(); throw new ConnectorClientError(502, 'Invalid file panel stream');
    }
    for await (const frame of parseConnectorEvents(response.body!, signal, maxBytes + 4096)) {
      // A heartbeat contains no business data and the consumer discards it.
      // Do not turn a long-lived idle subscription into periodic SQL work.
      // Every snapshot/closed frame still rechecks current authority.
      signal.throwIfAborted();
      if (frame.event !== 'heartbeat') await this.authorizeResponse(response);
      yield frame;
    }
  }

  async *events(signal: AbortSignal, cursor?: string) {
    const drain = new OriginalTransportDrain();
    try {
    const headers = new Headers({ accept: 'text/event-stream' });
    if (cursor) headers.set('last-event-id', cursor);
    const response = await this.open('/events/stream', { headers, signal }, true, false, false, drain);
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      throw new ConnectorClientError(response.ok ? 502 : response.status, `Connector stream failed: HTTP ${response.status}`);
    }
    for await (const frame of parseConnectorEvents(response.body, signal)) {
      await this.authorizeResponse(response);
      yield frame;
    }
    } finally {
      // Includes abort before headers, rejected authority and the first reader
      // cancellation. An HTTP rejection alone never authorizes a new feed.
      await drain.wait();
    }
  }
}

export type ConnectorClientResolver = (connectionId: string, maintenance?: boolean, ownerUserId?: string, grant?: NodeGrantProof,
  options?: { sourceApproval?: boolean; admin?: boolean }) => ConnectorClient;

export function createConnectorClientResolver(hubStore: HubStore, local?: { connectionId: string; token: string; maintenanceToken?: string; sourceApprovalToken?: string; dispatch: Dispatch }, boardBindingsOnly: boolean | 'file-boards' | 'card-files' | 'content-replicas' = false): ConnectorClientResolver {
  const historyCache = createConditionalHistoryCache();
  return (connectionId, maintenance = false, ownerUserId = 'default', grant, options) => {
    const sourceApproval = options?.sourceApproval === true;
    if ((boardBindingsOnly || sourceApproval) && (maintenance || grant)) throw new ConnectorClientError(403, 'Task binding requires connection ownership');
    if (boardBindingsOnly && sourceApproval) throw new ConnectorClientError(403, 'Source approval requires session media transport');
    // A grant is produced by trusted Hub policy code, never parsed from a user
    // body/header. This bridge enables only exact-session read parity; shared
    // writes and unfiltered streams stay closed pending Connector delegation.
    if (grant && (maintenance || grant.connectionId !== connectionId || grant.userId !== ownerUserId || !hubStore.grants.revalidate(grant))) {
      throw new ConnectorClientError(403, 'Invalid node grant');
    }
    const credentialOwner = grant?.ownerUserId ?? ownerUserId;
    const connection = hubStore.getConnection(connectionId, credentialOwner);
    if (!connection || connection.status === 'disabled') throw new ConnectorClientError(404, 'Connector connection not available');
    const version = hubStore.connectionAuthority(connectionId, credentialOwner);
    const credential = () => maintenance ? hubStore.getMaintenanceCredentialToken(connection.id, credentialOwner) : hubStore.getCredentialToken(connection.id, credentialOwner);
    const guard = () => {
      // Every authority mutation advances this durable generation. One indexed
      // metadata read per delivery; no credential decryption or network RPC.
      if (hubStore.connectionAuthority(connectionId, credentialOwner) !== version || (grant && !hubStore.grants.revalidate(grant))) {
        throw new ConnectorClientError(403, 'Connector authorization changed');
      }
    };
    const access = { authorize: guard, ...(connection.nodeId ? { nodeId: connection.nodeId } : {}), domain: JSON.stringify([ownerUserId, version, connection.nodeId, grant?.grantId, grant?.version]),
      ...(boardBindingsOnly ? { request: boardBindingsOnly === 'file-boards' ? authorizeFileBoardRequest
        : boardBindingsOnly === 'card-files' ? authorizeCardFileRequest
        : boardBindingsOnly === 'content-replicas' ? authorizeContentReplicaRequest : authorizeBoardBindingRequest }
        : sourceApproval ? { request: authorizeSourceApprovalMediaRequest }
        : grant ? { request: (path: string, method: string) => authorizeGrantedRead(grant, path, method) } : {}) };
    if (connection.kind === 'local') {
      if (!local || credentialOwner !== 'default' || local.connectionId !== connection.id) throw new ConnectorClientError(503, 'Local Connector is not running in this process');
      const token = maintenance ? local.maintenanceToken
        : sourceApproval && options?.admin && local.sourceApprovalToken ? local.sourceApprovalToken : local.token;
      if (!token) throw new ConnectorClientError(401, 'Connector maintenance credential is missing');
      return new ConnectorClient('http://connector.example.invalid', token, local.dispatch, undefined, undefined, access, historyCache);
    }
    const token = credential();
    if (!token) throw new ConnectorClientError(401, maintenance ? 'Connector maintenance credential is missing' : 'Connector credential is missing');
    return new ConnectorClient(connection.connectorUrl, token, undefined, undefined, undefined, access, historyCache);
  };
}

// A binding transport cannot become a second ordinary/maintenance client.
export function authorizeFileBoardRequest(path: string, method: string) {
  authorizeWorkspaceFileRequest('/workspace/board-files', path, method);
}

export function authorizeCardFileRequest(path: string, method: string) {
  authorizeWorkspaceFileRequest('/workspace/card-files', path, method);
}

/** Replica transport is owner-only and cannot address arbitrary file or
 * session APIs. Keep this separate from the ordinary file-card policy. */
export function authorizeContentReplicaRequest(path: string, method: string) {
  if (path === '/workspace/content-replicas' && method === 'GET') return;
  const match = /^\/workspace\/content-replicas\/([^/]+)(?:\/(observe|resolve|project|projection-receipt|proposals\/([^/]+)\/(claim|receipt)))?$/.exec(path);
  if (match && validBoardUuid(match[1])) {
    if (!match[2] && ['GET', 'PUT', 'DELETE'].includes(method)) return;
    if (['observe', 'resolve', 'project', 'projection-receipt'].includes(match[2]!) && method === 'POST') return;
    if (validBoardUuid(match[3]) && method === 'POST') return;
  }
  throw new ConnectorClientError(403, 'Content replica transport does not authorize this operation');
}

function authorizeWorkspaceFileRequest(base: string, path: string, method: string) {
  if (path === base && method === 'GET' || path === `${base}/subscribe` && method === 'POST') return;
  if (path.startsWith(`${base}/`)) {
    const parts = path.slice(base.length + 1).split('/');
    if (validBoardUuid(parts[0])) {
      if (parts.length === 1 && ['GET', 'PUT', 'DELETE'].includes(method)) return;
      if (parts.length === 2 && parts[1] === 'snapshot' && method === 'GET') return;
      if (parts[1] === 'writes') {
        if (parts.length === 2 && method === 'POST') return;
        if (parts.length === 3 && validBoardUuid(parts[2]) && method === 'GET') return;
      }
    }
  }
  throw new ConnectorClientError(403, 'File board transport does not authorize this operation');
}

export function authorizeSourceApprovalMediaRequest(path: string, method: string) {
  const match = /^\/sessions\/([^/?#]+)\/messages\/([^/?#]+)\/media\/([a-f0-9]{64})(?:\/(approval))?$/.exec(path);
  let key = '', messageId = '';
  try { key = decodeURIComponent(match?.[1] ?? ''); messageId = decodeURIComponent(match?.[2] ?? ''); } catch { /* denied below */ }
  if (match && key && key.length <= 2048 && messageId && messageId.length <= 4096
    && (match[4] ? method === 'POST' || method === 'DELETE' : method === 'GET')) return;
  throw new ConnectorClientError(403, 'Session media transport does not authorize this operation');
}

export function authorizeBoardBindingRequest(path: string, method: string) {
  const match = /^\/sessions\/([^/?#]+)\/board-binding(?:\/([a-f0-9-]{36}))?$/.exec(path);
  let key = '';
  try { key = decodeURIComponent(match?.[1] ?? ''); } catch { /* denied below */ }
  if (!match || !/^(codex|claude-code|ghcp):[^/?#]+$/.test(key)
    || (match[2] ? method !== 'DELETE' : method !== 'GET' && method !== 'PUT')) {
    throw new ConnectorClientError(403, 'Task binding transport does not authorize this operation');
  }
}

export function authorizeGrantedRead(grant: NodeGrantProof, path: string, method: string) {
  const { sessionKey, runtime, agentId } = grant.resource;
  if (isOwnerOnlyRuntimeResource(grant.resource)) throw new ConnectorClientError(403, 'This runtime is owner-only');
  const route = path.split('?')[0]!;
  if (route === '/sessions/directory' && method === 'GET' && grant.action === 'sessions:read' && agentId === undefined) {
    let query;
    try {
      if (path.includes('#')) throw new Error('Invalid directory URL');
      query = parseSessionDirectoryQuery(new URL(path, 'http://connector').searchParams);
    } catch { throw new ConnectorClientError(403, 'Node grant does not authorize this operation'); }
    if ((runtime === undefined || query.runtime === runtime) && (sessionKey === undefined || query.sessionKey === sessionKey)) return;
  }
  const pattern = grant.action === 'media:read'
    ? /^\/sessions\/([^/]+)\/messages\/[^/]+\/media\/[a-f0-9]{64}$/
    : /^\/sessions\/([^/]+)\/(?:state|messages(?:\/[^/]+)?)$/;
  const match = pattern.exec(route);
  let target: string | undefined;
  try { target = match?.[1] && decodeURIComponent(match[1]); } catch { /* denied below */ }
  if (method !== 'GET' || !['messages:read', 'media:read'].includes(grant.action) || !sessionKey || target !== sessionKey || agentId !== undefined
    || runtime !== (sessionKey.startsWith('codex:') ? 'codex' : 'openclaw')) {
    throw new ConnectorClientError(403, 'Node grant does not authorize this operation');
  }
}
