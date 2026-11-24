import { AuthPersistenceError } from './private-store.js';
import { AuthRoutePersistence, type Awaitable } from './route-persistence.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ReadRequestError, ReadRequestOwner } from '../lifecycle/read-request-owner.js';

export type SessionReadActor = (request: Request) => Awaitable<string | undefined>;
class SessionReadDeniedError extends Error {}

/** Read observations never grant transaction/effect authority. One bounded
 * HTTP wait covers admission, original history work and delivery observation.
 * Timeout/cancellation suppresses delivery, not original ownership: capacity
 * and shutdown remain tied to actual settlement, including failed SQL reads.
 */
export class SessionReadAuthority {
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: ReadRequestOwner;
  private closed = false;
  private closeWork: Promise<void> | undefined;
  private readonly responseLifetimes = new Set<Promise<void>>();
  private discardFailed = false;

  constructor(private readonly actor: SessionReadActor,
    diagnostics?: PerformanceDiagnostics, readWaitMs?: number) {
    this.persistence = new AuthRoutePersistence(diagnostics);
    this.reads = new ReadRequestOwner('session-read-request', { diagnostics, waitMs: readWaitMs, limit: 256 });
  }
  get pending() { return this.reads.pending; }
  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closed = true;
    this.closeWork = Promise.all([this.reads.close(), this.persistence.close(),
      ...this.responseLifetimes]).then(() => { if (this.discardFailed) throw new AuthPersistenceError(); });
    return this.closeWork;
  }
  async run(request: Request, work: (check: () => Promise<void>, actor: string) => Awaitable<Response>,
    discard?: (response: Response) => Promise<void>): Promise<Response> {
    if (discard && this.responseLifetimes.size >= 256)
      return Response.json({ error: 'auth_persistence_failed' }, { status: 503 });
    // Capture credentials before the owner's deferred dispatch. Each separate
    // observation receives a fresh Request, never a mutable or cached grant.
    const url = request.url, method = request.method, headers = [...request.headers];
    let produced: Response | undefined, disposing: Promise<void> | undefined;
    let started = false, originalDone = false, waiterDone = false, disposed = false;
    let release: (() => void) | undefined;
    // A final delivery check can fail AFTER the original read settled. Reserve
    // that gap before dispatch: close must also retain outer-only cancellation.
    if (discard && !this.closed) {
      const lifetime = new Promise<void>(resolve => { release = resolve; });
      this.responseLifetimes.add(lifetime);
      void lifetime.then(() => this.responseLifetimes.delete(lifetime));
    }
    const finish = () => { if (originalDone && waiterDone && (!disposing || disposed)) release?.(); };
    const dispose = () => {
      if (!produced || !discard) return Promise.resolve();
      if (!disposing) {
        disposing = Promise.resolve().then(() => discard(produced!));
        void disposing.then(() => { disposed = true; finish(); }, () => {
          this.discardFailed = true; disposed = true; finish();
        });
      }
      return disposing;
    };
    try {
      const { value: response } = await this.reads.run(request, async context => {
        started = true;
        try {
          const lookup = async () => {
            context.check();
            if (this.closed) throw new AuthPersistenceError();
            const { value } = await this.persistence.run(6, () => this.actor(new Request(url, {
              // Independent weak dependencies avoid listener accumulation and
              // expose advisory cancellation without abandoning the original.
              method, headers, signal: AbortSignal.any([request.signal, context.signal]),
            })));
            context.check();
            if (value === undefined || value === '') throw new SessionReadDeniedError();
            if (typeof value !== 'string') throw new AuthPersistenceError();
            return value;
          };
          const actor = await lookup();
          const check = async () => { if (await lookup() !== actor) throw new SessionReadDeniedError(); };
          let response: Response;
          try {
            response = await work(check, actor); produced = response;
            context.check(); await check();
          }
          catch (error) {
            // Includes a physical response produced after its HTTP deadline.
            // Retain the original stream cancellation ACK before releasing work.
            try { await dispose(); } catch { throw new AuthPersistenceError(); }
            // A late history rejection is still an ended request, not a fresh
            // provider failure to deliver or log with private source details.
            context.check();
            throw error;
          }
          return response;
        } finally { originalDone = true; finish(); }
      });
      return response;
    } catch (error) {
      // End delivery promptly, not physical ownership. The reservation above
      // keeps a slow/failed cancellation ACK visible to shutdown.
      void dispose();
      if (error instanceof ReadRequestError) return Response.json({ error: error.status === 408
        ? 'request_cancelled' : 'auth_persistence_failed' }, { status: error.status });
      if (error instanceof SessionReadDeniedError) return Response.json({ error: 'session authorization changed' }, { status: 403 });
      if (error instanceof AuthPersistenceError) return Response.json({ error: 'auth_persistence_failed' }, { status: 503 });
      throw error;
    } finally {
      waiterDone = true;
      // Admission refused, or interruption won before deferred dispatch. The
      // original owner's check prevents this callback from starting later.
      if (!started) originalDone = true;
      finish();
    }
  }
}
