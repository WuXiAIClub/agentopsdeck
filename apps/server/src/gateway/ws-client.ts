import { synchronousEffectAuthority } from '../auth/synchronous-effect-authority.js';
import WebSocket from 'ws';
import { nanoid } from 'nanoid';
import { GatewayRpcError } from './rpc-error.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

const REQUEST_TIMEOUT_MS = 15_000;
const READ_REQUEST_TIMEOUT_MS = 60_000;
const GATEWAY_RECOVERY_COOLDOWN_MS = 30_000;
const MAX_INFLIGHT_READS = 64;
const MAX_OBSERVATIONS = 128;
const MAX_OBSERVATION_BYTES = 8 * 1024 * 1024;
const OBSERVED_EFFECT_METHODS = new Set(['agent', 'chat.send', 'sessions.create', 'sessions.patch', 'sessions.delete']);
const DEDUPED_READ_METHODS = new Set([
  'agents.list',
  'diagnostics.stability',
  'sessions.list',
  'chat.history',
]);
const CRITICAL_WRITE_METHODS = new Set([
  'chat.send',
  'sessions.create',
  'sessions.patch',
]);

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

export type GatewayAsyncObserver = {
  event(event: unknown, connectionId: string): Promise<unknown>;
  connectionChanged(connectionId: string | undefined): Promise<void>;
  /** Local veto only; failure never grants permission or replays a native effect. */
  unavailable(): void;
};

export type GatewayWsClientOptions = {
  url: string | undefined;
  ownerToken: string | undefined;
  password: string | undefined;
  onEvent?: (event: any, connectionId: string) => void;
  onConnectionChange?: (connectionId: string | undefined) => void;
  asyncObserver?: GatewayAsyncObserver;
  diagnostics?: PerformanceDiagnostics;
};
export type GatewayReply<T> = { payload: T; connectionId: string };

export class GatewayWsClient {
  private socket: WebSocket | undefined;
  private pending = new Map<string, PendingRequest>();
  private readInflight = new Map<string, Promise<GatewayReply<unknown>>>();
  private connected = false;
  private connecting: Promise<void> | undefined;
  private recoveryUntil = 0;
  private lastFailure: string | undefined;
  private closed = false;
  private cancelConnect: (() => void) | undefined;
  private connectionGeneration: string | undefined;
  private observerTail: Promise<void> | undefined;
  private observerPending = 0;
  private observerBytes = 0;
  private observerFailed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: GatewayWsClientOptions) {
    if (options.asyncObserver && (options.onEvent || options.onConnectionChange))
      throw new TypeError('Gateway observer modes cannot be combined');
    if (options.asyncObserver && ['event', 'connectionChanged', 'unavailable'].some(
      key => typeof options.asyncObserver![key as keyof GatewayAsyncObserver] !== 'function'))
      throw new TypeError('Complete Gateway async observer required');
  }

  // Preserve the legacy void contract, including use inside synchronous
  // beforeSend guards. Async owners must explicitly await closeAndDrain().
  close(): void { void this.closeAndDrain(); }

  closeAndDrain(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Publish before cleanup can reenter. Final disconnect joins the same lane
    // synchronously, before this microtask captures its drain barrier.
    this.closing = Promise.resolve().then(() => this.drainObservers());
    this.cancelConnect?.();
    this.socket?.terminate();
    this.socket = undefined;
    const wasConnected = this.connected;
    this.connected = false;
    this.rejectAll('Gateway WS client closed');
    this.readInflight.clear();
    if (wasConnected) this.notifyConnection();
    return this.closing;
  }

  /** Snapshot of accepted physical work, not a wait for native Goal idleness. */
  drainObservers(): Promise<void> { return this.observerTail ?? Promise.resolve(); }

  private failObserver(step: number) {
    if (this.observerFailed) return;
    this.observerFailed = true;
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'gateway-observation');
    trace.add('step', step); trace.add('pending', this.observerPending); trace.add('sourceBytes', this.observerBytes); trace.finish(true);
    try { this.options.asyncObserver?.unavailable(); } catch { /* Local veto remains latched. */ }
  }

  private observe(work: () => Promise<unknown>, bytes: number, step: number) {
    if (this.observerFailed) return;
    if (this.observerPending >= MAX_OBSERVATIONS || bytes > MAX_OBSERVATION_BYTES - this.observerBytes) {
      this.failObserver(3); return;
    }
    this.observerPending++; this.observerBytes += bytes;
    const previous = this.observerTail;
    const task = Promise.resolve(previous).then(async () => {
      const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'gateway-observation');
      trace.add('step', step); trace.add('pending', this.observerPending); trace.add('sourceBytes', bytes);
      try { await work(); trace.finish(); }
      catch { this.failObserver(step); trace.finish(true); }
    }).finally(() => {
      this.observerPending--; this.observerBytes -= bytes;
      if (this.observerTail === task) this.observerTail = undefined;
    });
    this.observerTail = task;
  }

  private async observationBarrier(method: string) {
    if (!this.options.asyncObserver || !OBSERVED_EFFECT_METHODS.has(method)) return;
    await this.drainObservers();
    // New observations may have arrived while awaiting the snapshot. Deny
    // this effect rather than chase a continuously running Goal forever.
    this.assertObservedEffectAllowed(method);
  }

  private assertObservedEffectAllowed(method: string) {
    if (this.options.asyncObserver && OBSERVED_EFFECT_METHODS.has(method) && (this.observerFailed || this.observerPending))
      throw new Error('Gateway observations unavailable or pending');
  }

  status() {
    return {
      configured: Boolean(this.options.url),
      connected: this.connected,
      url: this.options.url,
      pending: this.pending.size,
      inflightReads: this.readInflight.size,
      observerPending: this.observerPending,
      observerFailed: this.observerFailed,
      degraded: this.isRecovering(),
      recoveryUntil: this.recoveryUntil || undefined,
      lastFailure: this.lastFailure,
    };
  }

  connectionId() {
    return this.connected && this.socket?.readyState === WebSocket.OPEN ? this.connectionGeneration : undefined;
  }

  // Runtime recovery/control must stay on the connection which accepted the
  // run. An expected identity never opens/rebinds a connection or replays work.
  async requestBound<T = unknown>(method: 'agent' | 'agent.wait' | 'chat.abort' | 'chat.send' | 'sessions.describe' | 'sessions.delete' | 'sessions.create' | 'sessions.patch', params: Record<string, unknown>, expectedConnectionId?: string,
    beforeSend?: () => void): Promise<GatewayReply<T>> {
    this.assertRequestAllowed(method);
    if (expectedConnectionId !== undefined && this.connectionId() !== expectedConnectionId) throw new Error('Gateway WS connection changed');
    const paramsJson = JSON.stringify(params);
    if (paramsJson === undefined) throw new Error('Invalid Gateway request params');
    return this.sendRequest<T>(method, paramsJson, expectedConnectionId, beforeSend);
  }

  /** Establish the original transport before awaited worker authorization.
   * The subsequent write MUST use this exact connection via requestBound;
   * reconnecting after authority was checked requires a new preparation. */
  async prepareWriteConnection(): Promise<string> {
    this.assertRequestAllowed('agent');
    await this.ensureConnected();
    if (this.options.asyncObserver) await this.observationBarrier('agent');
    this.assertRequestAllowed('agent');
    this.assertObservedEffectAllowed('agent');
    const connectionId = this.connectionId();
    if (!connectionId) throw new Error('Gateway WS disconnected before send');
    return connectionId;
  }

  /** Read-only transport preparation. Finish the accepted connection-observer
   * snapshot before a reader captures its generation; do not chase events or
   * wait for a continuing native Goal to become idle. No business request or
   * execution authority is created here. */
  async prepareReadConnection(): Promise<string> {
    this.assertRequestAllowed('sessions.list');
    await this.ensureConnected();
    const connectionId = this.connectionId();
    await this.drainObservers();
    this.assertRequestAllowed('sessions.list');
    if (this.observerFailed || !connectionId || connectionId !== this.connectionId())
      throw new Error('Gateway read connection unavailable');
    return connectionId;
  }

  private assertRequestAllowed(method: string) {
    if (this.closed) throw new Error('Gateway WS client closed');
    if (!this.options.url) throw new Error('Gateway WS URL is not configured');
    if (this.observerFailed && OBSERVED_EFFECT_METHODS.has(method)) throw new Error('Gateway observations unavailable');
    if (this.isRecovering() && !CRITICAL_WRITE_METHODS.has(method)) {
      throw new Error(`Gateway WS in recovery after timeout: ${this.lastFailure ?? method}`);
    }
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return (await this.requestWithConnection<T>(method, params)).payload;
  }

  // Preserve the native reply identity without bypassing read coalescing.
  async requestWithConnection<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<GatewayReply<T>> {
    this.assertRequestAllowed(method);
    // Capture the exact wire parameters before any connection await. Distinct
    // sessions/filters must never share a result; caller mutation must not
    // change the request after its coalescing identity has been chosen.
    const paramsJson = JSON.stringify(params);
    if (paramsJson === undefined) throw new Error('Invalid Gateway request params');
    if (DEDUPED_READ_METHODS.has(method)) {
      const key = JSON.stringify([method, paramsJson]);
      const existing = this.readInflight.get(key);
      if (existing) return existing as Promise<GatewayReply<T>>;
      if (this.readInflight.size >= MAX_INFLIGHT_READS) throw new Error('Gateway WS read capacity exceeded');
      const request = this.sendRequest<T>(method, paramsJson).finally(() => {
        if (this.readInflight.get(key) === request) this.readInflight.delete(key);
      });
      this.readInflight.set(key, request);
      return request;
    }
    return this.sendRequest<T>(method, paramsJson);
  }

  private async sendRequest<T = unknown>(method: string, paramsJson: string, expectedConnectionId?: string,
    beforeSend?: () => void): Promise<GatewayReply<T>> {
    if (expectedConnectionId === undefined) await this.ensureConnected();
    if (this.options.asyncObserver && OBSERVED_EFFECT_METHODS.has(method)) await this.observationBarrier(method);
    if (this.closed) throw new Error('Gateway WS client closed');
    this.assertObservedEffectAllowed(method);
    const socket = this.socket;
    const connectionId = this.connectionId();
    if (!socket || !connectionId) {
      throw new Error('Gateway WS disconnected before send');
    }
    if (expectedConnectionId !== undefined && connectionId !== expectedConnectionId) throw new Error('Gateway WS connection changed');
    // Connection setup may await authentication. Validate live authority and
    // ownership at the write boundary, with no await before socket.send.
    synchronousEffectAuthority(beforeSend);
    this.assertObservedEffectAllowed(method);
    if (this.socket !== socket || this.connectionId() !== connectionId) throw new Error('Gateway WS connection changed');
    const id = nanoid();
    // paramsJson is already JSON-encoded, including any large attachments.
    const payload = `{"id":${JSON.stringify(id)},"type":"req","method":${JSON.stringify(method)},"params":${paramsJson}}`;
    const timeoutMs = DEDUPED_READ_METHODS.has(method) ? READ_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;

    return new Promise<GatewayReply<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.markUnhealthy(`Gateway WS request timed out: ${method}`);
        reject(new Error(`Gateway WS request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: (payload) => resolve({ payload: payload as T, connectionId }), reject, timer });
      socket.send(payload, (error) => {
        // A response or disconnect may settle this request before the write
        // callback arrives. It must not poison later requests/connections.
        if (this.socket !== socket || !this.pending.has(id)) return;
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          this.markUnhealthy(`Gateway WS send failed: ${method}`);
          reject(error);
        }
      });
    });
  }

  private async ensureConnected() {
    if (this.socket?.readyState === WebSocket.OPEN && this.connected) return;
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }

  private async connect() {
    if (!this.options.url) return;
    const url = new URL(this.options.url);

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: this.options.ownerToken
          ? { authorization: `Bearer ${this.options.ownerToken}` }
          : undefined,
      });
      let settled = false;
      let connectId: string | undefined;
      const failTimer = setTimeout(() => fail(new Error('Gateway WS connect timed out')), 8_000);

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.cancelConnect = undefined;
        clearTimeout(failTimer);
        try {
          socket.terminate();
        } catch {
          // Best-effort cleanup: the handshake has already failed.
        }
        reject(error);
      };

      const succeed = () => {
        if (settled) return;
        if (this.closed) return fail(new Error('Gateway WS client closed'));
        settled = true;
        this.cancelConnect = undefined;
        clearTimeout(failTimer);
        this.socket = socket;
        this.connectionGeneration = nanoid();
        this.connected = true;
        socket.on('close', () => {
          if (this.socket !== socket) return;
          this.socket = undefined;
          this.connected = false;
          this.rejectAll('Gateway WS disconnected');
          this.notifyConnection();
        });
        socket.on('error', () => {
          if (this.socket !== socket) return;
          // Retire pending work together with its socket; otherwise its old
          // timeout can later invalidate a successfully reconnected socket.
          this.markUnhealthy('Gateway WS socket error');
        });
        this.notifyConnection();
        resolve();
      };

      this.cancelConnect = () => fail(new Error('Gateway WS client closed'));

      socket.on('message', (raw) => {
        if (settled && socket !== this.socket) return;
        const text = raw.toString();
        if (!settled) {
          let message: any;
          try {
            message = JSON.parse(text);
          } catch {
            return;
          }
          if (!message || typeof message !== 'object' || Array.isArray(message)) return;
          if (message.type === 'event' && message.event === 'connect.challenge') {
            if (connectId) return;
            connectId = nanoid();
            socket.send(JSON.stringify({
              type: 'req',
              id: connectId,
              method: 'connect',
              params: {
                minProtocol: 3,
                maxProtocol: 4,
                client: {
                  id: 'gateway-client',
                  version: '0.1.0',
                  platform: process.platform,
                  mode: 'backend',
                },
                role: 'operator',
                scopes: ['operator.read', 'operator.write', 'operator.admin'],
                caps: [],
                commands: [],
                permissions: {},
                auth: {
                  ...(this.options.ownerToken ? { token: this.options.ownerToken } : {}),
                  ...(this.options.password ? { password: this.options.password } : {}),
                },
                locale: 'en-US',
                userAgent: 'agentopsdeck-server/0.1.0',
              },
            }));
            return;
          }
          if (connectId && message.type === 'res' && message.id === connectId) {
            if (message.ok !== true || message.error !== undefined) {
              fail(new Error(`Gateway WS connect failed: ${JSON.stringify(message.error ?? message.payload ?? message)}`));
              socket.close();
              return;
            }
            succeed();
            return;
          }
          // Only the correlated successful handshake admits this socket's
          // events. Unauthenticated frames must not mutate runtime facts.
          return;
        }
        this.onMessage(text);
      });
      socket.once('error', fail);
      socket.once('close', () => {
        if (!settled) fail(new Error('Gateway WS closed during handshake'));
      });
    });
  }

  private isRecovering() {
    return Date.now() < this.recoveryUntil;
  }

  private markUnhealthy(reason: string) {
    this.lastFailure = reason;
    this.recoveryUntil = Date.now() + GATEWAY_RECOVERY_COOLDOWN_MS;
    const wasConnected = this.connected;
    this.connected = false;
    this.connecting = undefined;
    this.readInflight.clear();
    this.rejectAll(reason);
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.terminate();
    } catch {
      // Best-effort cleanup; callers already see the timeout/send error.
    }
    if (wasConnected) this.notifyConnection();
  }

  private notifyConnection() {
    const observer = this.options.asyncObserver;
    if (observer) {
      const id = this.connectionId();
      this.observe(() => observer.connectionChanged(id), 0, 2); return;
    }
    // Observers cannot prevent transport cleanup or leave connect unresolved.
    // The runtime observer is responsible for invalidating failed projections.
    try { this.options.onConnectionChange?.(this.connectionId()); } catch { /* observer failure */ }
  }

  private onMessage(raw: string) {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.type === 'event' || message.event || message.kind === 'event') {
      const connectionId = this.connectionId();
      if (connectionId) {
        const observer = this.options.asyncObserver;
        if (observer) this.observe(() => observer.event(message, connectionId), Buffer.byteLength(raw), 1);
        else this.options.onEvent?.(message, connectionId);
      }
      return;
    }
    const id = message.id;
    if (message.type !== 'res' || typeof id !== 'string' || !this.pending.has(id)) return;
    const pending = this.pending.get(id)!;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (message.ok === false && message.error && typeof message.error === 'object'
      && !Array.isArray(message.error) && typeof message.error.code === 'string' && message.error.code
      && typeof message.error.message === 'string' && message.error.message) {
      pending.reject(new GatewayRpcError(pending.method, message.error.code, message.error.message));
      return;
    }
    if (message.ok !== true || message.error !== undefined) {
      pending.reject(new Error(`Gateway WS invalid response: ${pending.method}`));
      return;
    }
    pending.resolve(message.payload ?? message.result ?? message.data ?? message);
  }

  private rejectAll(reason: string) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
