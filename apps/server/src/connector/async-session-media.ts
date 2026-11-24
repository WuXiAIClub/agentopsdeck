import { HTTPException } from 'hono/http-exception';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { cancelGuardedBody, guardedBody } from './guarded-body.js';
import { validConnectorSessionMediaOutput, type ConnectorSessionMediaCommands, type SessionMediaInput,
  type SessionMediaObservation } from './connector-session-media-domain.js';

export interface SessionMediaAccess {
  observe(input: SessionMediaInput): Promise<SessionMediaObservation>;
  chunk(input: ConnectorSessionMediaCommands['sessionMediaChunk']['input']): Promise<Uint8Array>;
  run(request: Request, work: () => Promise<Response>): Promise<Response>;
}

/** Request/stream lifetime belongs to the root, not the HTTP waiter. Freeze
 * before draining worker calls, source previews and retained file streams. */
export class AsyncSessionMedia implements SessionMediaAccess {
  private readonly tasks = createTaskDrain();
  private readonly bodies = new Map<ReadableStream<Uint8Array>, AbortController>();
  private closed = false;
  private closing?: Promise<void>;
  private active = 0;
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}
  private check() { if (this.closed) throw new HTTPException(503, { message: 'Connector media is closing' }); }
  private async command<K extends 'sessionMediaObserve' | 'sessionMediaChunk'>(kind: K, input: ConnectorSessionMediaCommands[K]['input']):
    Promise<Exclude<ConnectorSessionMediaCommands[K]['output'], { error: number }>> {
    this.check();
    return this.tasks.run(async () => {
      this.check();
      const trace = guardedTrace(this.diagnostics, 'connector-session-media');
      trace.add('step', kind === 'sessionMediaObserve' ? 1 : 2);
      let failed = true;
      try {
        const result = await this.owner.command(kind, input); this.check();
        if (!validConnectorSessionMediaOutput(kind, result)) throw new ConnectorOwnerUnavailable();
        if ('error' in result) throw new HTTPException(result.error === 409 ? 403 : result.error, { message: 'Session media unavailable' });
        if (result.key !== input.key || result.messageId !== input.messageId || result.resourceId !== input.resourceId
          || input.expected && (input.expected.readerId !== result.readerId || input.expected.nativeSessionId !== result.nativeSessionId)
          || input.approval && !result.mayApprove) throw new ConnectorOwnerUnavailable();
        failed = false; return result as Exclude<ConnectorSessionMediaCommands[K]['output'], { error: number }>;
      } finally { trace.finish(failed); }
    });
  }
  observe(input: SessionMediaInput) { return this.command('sessionMediaObserve', input); }
  async chunk(input: ConnectorSessionMediaCommands['sessionMediaChunk']['input']) {
    const result = await this.command('sessionMediaChunk', input);
    if (!('data' in result) || result.offset !== input.offset || result.size !== input.size) throw new ConnectorOwnerUnavailable();
    return new Uint8Array(Buffer.from(result.data, 'base64'));
  }
  async run(request: Request, work: () => Promise<Response>): Promise<Response> {
    this.check(); request.signal.throwIfAborted();
    if (this.active + this.bodies.size >= 32) throw new HTTPException(503, { message: 'Connector media capacity exceeded' });
    this.active++;
    try {
      return await this.tasks.run(async () => {
        const response = await work();
        if (this.closed || request.signal.aborted) {
          if (response.body) { await cancelGuardedBody(response.body); await response.body.cancel(); }
          this.check(); request.signal.throwIfAborted();
        }
        if (!response.body) return response;
        const lifetime = new AbortController(), original = response.body;
        let body!: ReadableStream<Uint8Array>;
        body = guardedBody(original, {
          signal: AbortSignal.any([request.signal, lifetime.signal]),
          authorize: () => this.check(),
          drain: async () => { try { await cancelGuardedBody(original); } finally { this.bodies.delete(body); } },
          onComplete: () => { this.bodies.delete(body); },
        });
        this.bodies.set(body, lifetime);
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      });
    } finally { this.active--; }
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    // Cancel even idle bodies; await the original cancellation ACK and any
    // already accepted worker/file work. No retry or replacement owner.
    const bodies = [...this.bodies];
    for (const [, lifetime] of bodies) lifetime.abort();
    return this.closing = Promise.allSettled([this.tasks.close(), ...bodies.map(([body]) => cancelGuardedBody(body))]).then(results => {
      if (results.some(result => result.status === 'rejected')) throw new ConnectorOwnerUnavailable();
    });
  }
}
