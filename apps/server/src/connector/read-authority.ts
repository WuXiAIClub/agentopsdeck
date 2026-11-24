import { HTTPException } from 'hono/http-exception';
import type { ConnectorPrincipal, ConnectorScope, ConnectorTokenStore } from '../auth/connector-token.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ReadRequestOwner } from '../lifecycle/read-request-owner.js';
import type { ChangeSignal } from '../utils/change-signal.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { validConnectorOwnerOutput } from './connector-owner-domain.js';

type Awaitable<T> = T | PromiseLike<T>;
/** A delivery proof for reads only. Never use this handle to authorize a SQL
 * mutation, a native call, or a later command's transaction. */
export type ConnectorReadHandle = {
  readonly principal: ConnectorPrincipal;
  check(signal?: AbortSignal): Awaitable<void>;
};
export type ConnectorReadAuthority = {
  readonly changes: Pick<ChangeSignal, 'revision' | 'wait'>;
  begin(request: Request, scope: ConnectorScope): Awaitable<ConnectorReadHandle>;
};

/** Explicit compatibility adapter. Async roots never create this adapter or a
 * main-thread token store. Both paths bind checks to the original header. */
export function synchronousConnectorReadAuthority(tokens: ConnectorTokenStore): ConnectorReadAuthority {
  return {
    changes: tokens.changes,
    begin(request, scope) {
      const authorization = request.headers.get('authorization') ?? '';
      const evidence = new Request('http://connector.example.invalid/', { headers: { authorization } });
      const principal = tokens.requireScope(evidence, scope);
      if (!principal) throw new HTTPException(403);
      const tokenId = principal.tokenId;
      return { principal: structuredClone(principal), check(signal) {
        request.signal.throwIfAborted(); signal?.throwIfAborted();
        const current = tokens.requireScope(evidence, scope);
        if (!current || current.tokenId !== tokenId) throw new HTTPException(403);
      } };
    },
  };
}

/** Same-worker original evidence checks, bounded independently of response
 * waits. close drains physical commands, including timed-out/aborted callers. */
export class AsyncConnectorReadAuthority implements ConnectorReadAuthority {
  readonly changes: ConnectorReadAuthority['changes'];
  private readonly reads: ReadRequestOwner;
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command' | 'authorityChanges'>,
    options: { diagnostics?: PerformanceDiagnostics; timeoutMs?: number } = {}) {
    this.changes = owner.authorityChanges;
    this.reads = new ReadRequestOwner('connector-event-projection', {
      diagnostics: options.diagnostics, waitMs: options.timeoutMs, limit: 128,
    });
  }
  async begin(request: Request, scope: ConnectorScope): Promise<ConnectorReadHandle> {
    const authorization = request.headers.get('authorization') ?? '';
    const read = async (signal?: AbortSignal, tokenId?: string): Promise<ConnectorPrincipal> => {
      const lifetime = signal ? AbortSignal.any([request.signal, signal]) : request.signal;
      const original = new Request('http://connector.example.invalid/', { signal: lifetime });
      return (await this.reads.run(original, async context => {
        const { value } = await context.stage(1, () => this.owner.command('tokenAuthenticate', { authorization }));
        if (!validConnectorOwnerOutput('tokenAuthenticate', value)) throw new HTTPException(503);
        if (!value || !value.scopes.includes(scope) || tokenId !== undefined && value.tokenId !== tokenId) {
          throw new HTTPException(403);
        }
        return structuredClone(value);
      })).value;
    };
    const principal = await read(), tokenId = principal.tokenId;
    return { principal, check: async signal => { await read(signal, tokenId); } };
  }
  close(): Promise<void> { return this.reads.close(); }
}
