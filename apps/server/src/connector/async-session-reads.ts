import type { ConnectorPrincipal } from '../auth/connector-token.js';
import type { SessionDirectoryQuery } from '@agentopsdeck/shared';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { validConnectorOwnerOutput, ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import type { DeckStore } from '../projection/deck-store.js';
import { parseSessionDirectoryQuery, sessionDirectoryParams } from '../projection/session-directory.js';
import type { EventSnapshotRead } from '../routes/events.js';
import { ReadRequestOwner } from '../lifecycle/read-request-owner.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';

export class SessionReadError extends Error {
  constructor(readonly status: 400 | 403 | 409 | 503) { super('Session read unavailable'); }
}
export type AsyncSessionReadsOptions = {
  projection: Pick<DeckStore, 'getSessionDirectory' | 'getSessionsState'>;
  snapshot: EventSnapshotRead;
  /** The original complete refresh group, not one runtime's substitute proof. */
  refreshers: ReadonlyArray<(options: { maxAgeMs: number }) => Promise<void>>;
  snapshotReady(): boolean;
  connector: { environmentId: string; environmentLabel: string };
  timeoutMs?: number;
  diagnostics?: PerformanceDiagnostics;
};

/** One public catalog owner shared by all runtimes. Does not open SQL/native,
 * resend input, wait for Goal idle, or close the shared database owner. */
export class AsyncSessionReads {
  private readonly reads: ReadRequestOwner;
  private readonly refreshers: AsyncSessionReadsOptions['refreshers'];
  private readonly connector: AsyncSessionReadsOptions['connector'];
  private refreshWork: Promise<void> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>, private readonly options: AsyncSessionReadsOptions) {
    if (typeof options.snapshot !== 'function' || typeof options.snapshotReady !== 'function'
      || !Array.isArray(options.refreshers) || !options.refreshers.length || options.refreshers.some(f => typeof f !== 'function')) {
      throw new TypeError('Original catalog snapshot and complete refresh group required');
    }
    this.refreshers = [...options.refreshers];
    this.connector = { ...options.connector };
    this.reads = new ReadRequestOwner('connector-event-projection', { waitMs: options.timeoutMs, diagnostics: options.diagnostics, limit: 8 });
  }
  private async authorize(authorization: string, reader?: ConnectorPrincipal): Promise<ConnectorPrincipal> {
    const value = await this.owner.command('tokenAuthenticate', { authorization });
    if (!validConnectorOwnerOutput('tokenAuthenticate', value)) throw new ConnectorOwnerUnavailable();
    if (!value || !value.scopes.includes('sessions:read')) throw new SessionReadError(403);
    if (reader && reader.tokenId !== value.tokenId) throw new SessionReadError(409);
    return value;
  }
  private refresh(): Promise<void> {
    if (this.closed) return Promise.reject(new SessionReadError(503));
    if (this.refreshWork) return this.refreshWork;
    // Reserve before calling any participant. Even synchronous failure of one
    // participant must not abandon the other's physical work during shutdown.
    const work = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(this.refreshers.map(refresh => Promise.resolve().then(() => refresh({ maxAgeMs: 2_000 }))));
      if (results.some(result => result.status === 'rejected')) throw new SessionReadError(503);
    });
    this.refreshWork = work;
    void work.then(() => { if (this.refreshWork === work) this.refreshWork = undefined; },
      () => { if (this.refreshWork === work) this.refreshWork = undefined; });
    return work;
  }
  directory(authorization: string, selection: SessionDirectoryQuery | URLSearchParams, request: Request) {
    return this.reads.run(request, async context => {
      const { value: reader } = await context.stage(90, () => this.authorize(authorization));
      // Validate a direct caller too; never silently drop unknown filters.
      let query: SessionDirectoryQuery;
      try { query = parseSessionDirectoryQuery(selection instanceof URLSearchParams ? selection : sessionDirectoryParams(selection)); }
      catch { throw new SessionReadError(400); }
      const { value: body } = await context.stage(91, () => this.options.snapshot(cursor => {
        context.check(); this.cursor(cursor);
        return this.options.projection.getSessionDirectory(query, cursor);
      }));
      await context.stage(92, () => this.authorize(authorization, reader));
      return body;
    }).then(result => result.value);
  }
  state(authorization: string, flags: { includeHidden: boolean; includeArchived: boolean }, request: Request) {
    return this.reads.run(request, async context => {
      const { value: reader } = await context.stage(90, () => this.authorize(authorization));
      await context.stage(93, () => this.refresh());
      const { value: body } = await context.stage(91, () => this.options.snapshot(cursor => {
        context.check(); this.ready(); this.cursor(cursor);
        return { ...this.options.projection.getSessionsState(flags), sourceCursor: cursor, connector: this.connector };
      }));
      await context.stage(92, () => this.authorize(authorization, reader));
      this.ready(); context.check();
      return body;
    }).then(result => result.value);
  }
  private cursor(cursor: string | undefined): asserts cursor is string {
    if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || /[\x00-\x1f\x7f]/.test(cursor)) throw new SessionReadError(503);
  }
  private ready() { if (this.options.snapshotReady() !== true) throw new SessionReadError(503); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const reads = this.reads.close(), refresh = this.refreshWork;
    return this.closing = Promise.allSettled([reads, ...(refresh ? [refresh] : [])]).then(() => undefined);
  }
}
