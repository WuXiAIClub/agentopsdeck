import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AgentSummary } from '@agentopsdeck/shared';
import type { ConnectorPrincipal, ConnectorScope } from '../auth/connector-token.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import type { ConnectorReadAuthority } from './read-authority.js';

type Awaitable<T> = T | PromiseLike<T>;
export type ConnectorAgentAuthority = {
  requireScope(request: Request, scope: ConnectorScope): Awaitable<ConnectorPrincipal | undefined>;
  hasScope(tokenId: string, scope: ConnectorScope): Awaitable<boolean>;
};
type Refusal = { error: string; status: 403 | 408 | 503 };
type Result = Refusal | { agents: AgentSummary[] };
export const CONNECTOR_AGENT_PENDING_LIMIT = 64;

/** Read-only discovery. One HTTP budget includes both original authority reads
 * and catalog IO. Ending the wait never releases/replaces the accepted work.
 * No awaited result is usable as a later mutation's transaction authority. */
export function registerConnectorAgentRoutes(app: Hono, deps: {
  tokens: ConnectorAgentAuthority | Pick<ConnectorReadAuthority, 'begin'>;
  agents: () => AgentSummary[] | PromiseLike<AgentSummary[]>;
  diagnostics?: PerformanceDiagnostics;
  requestWaitMs?: number;
}) {
  const waitMs = deps.requestWaitMs ?? 30_000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 2_147_483_647) throw Error('invalid_agent_request_wait');
  const diagnostics = deps.diagnostics ?? performanceDiagnostics;
  let inflight: Promise<AgentSummary[]> | undefined;
  const accepted = new Set<Promise<Result>>();
  let reportingCapacity = false;
  let stopped = false;
  let closing: Promise<void> | undefined;
  function catalog() {
    if (!inflight) inflight = Promise.resolve().then(async () => {
      const trace = guardedTrace(diagnostics, 'connector-agent-catalog'); trace.add('step', 2);
      const warning = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000); warning.unref();
      let failed = true;
      try {
        // A diagnostic can reenter close; never start new dependent IO then.
        if (stopped) throw Error('agent_catalog_unavailable');
        const agents = await deps.agents(); trace.add('settled', 1); failed = false; return agents;
      } catch { trace.add('deferred', 1); throw Error('agent_catalog_unavailable'); }
      finally { clearTimeout(warning); trace.finish(failed); }
    }).finally(() => { inflight = undefined; });
    return inflight;
  }
  app.get('/api/connector/v1/agents', async c => {
    c.header('Cache-Control', 'no-store');
    const request = c.req.raw;
    if (request.signal.aborted) return c.json({ error: 'request_cancelled' }, 408);
    if (stopped) return c.json({ error: 'agent_catalog_unavailable' }, 503);
    if (accepted.size >= CONNECTOR_AGENT_PENDING_LIMIT) {
      if (!reportingCapacity) {
        reportingCapacity = true;
        try {
          const trace = guardedTrace(diagnostics, 'connector-agent-catalog');
          trace.add('step', 6); trace.add('pending', accepted.size); trace.add('deferred', 1); trace.finish(true);
        } finally { reportingCapacity = false; }
      }
      return c.json({ error: 'agent_catalog_unavailable' }, 503);
    }
    let ended: Refusal | undefined;
    const interrupted = (): Refusal | undefined => request.signal.aborted
      ? { error: 'request_cancelled', status: 408 }
      : stopped ? { error: 'agent_catalog_unavailable', status: 503 } : ended;
    const authority = async <T>(step: 4 | 5, read: () => Awaitable<T>): Promise<T> => {
      const trace = guardedTrace(diagnostics, 'connector-agent-catalog'); trace.add('step', step);
      const warning = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000); warning.unref();
      let failed = true;
      try {
        if (interrupted()) throw Error('agent_catalog_unavailable');
        const result = await read(); trace.add('settled', 1); failed = false; return result;
      } finally { clearTimeout(warning); trace.finish(failed); }
    };
    // Publish before invoking any authority, provider or diagnostic callback.
    // Timed-out/disconnected callers remain here until the original settles.
    const original: Promise<Result> = Promise.resolve().then(async (): Promise<Result> => {
      try {
        const before = interrupted(); if (before) return before;
        const tokens = deps.tokens;
        const handle = 'begin' in tokens ? await authority(4, () => tokens.begin(request, 'agents:read')) : undefined;
        const principal = handle?.principal ?? ('requireScope' in tokens
          ? await authority(4, () => tokens.requireScope(request, 'agents:read')) : undefined);
        const authorized = interrupted(); if (authorized) return authorized;
        if (!principal) return { error: 'missing agents:read scope', status: 403 };
        const agents = await catalog();
        const discovered = interrupted(); if (discovered) return discovered;
        const current = await authority(5, async () => {
          if (handle) { await handle.check(); return true; }
          return 'hasScope' in tokens && await tokens.hasScope(principal.tokenId, 'agents:read');
        });
        const checked = interrupted(); if (checked) return checked;
        if (current !== true) return { error: 'missing agents:read scope', status: 403 };
        return { agents };
      } catch (error) { return interrupted() ?? (error instanceof HTTPException && error.status === 403
        ? { error: 'missing agents:read scope', status: 403 } : { error: 'agent_catalog_unavailable', status: 503 }); }
    }).finally(() => { accepted.delete(original); });
    accepted.add(original);
    let cancel!: () => void;
    const cancelled = new Promise<Refusal>(resolve => {
      cancel = () => { ended = { error: 'request_cancelled', status: 408 }; resolve(ended); };
      request.signal.addEventListener('abort', cancel, { once: true });
      if (request.signal.aborted) cancel();
    });
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<Refusal>(resolve => {
      timer = setTimeout(() => {
        ended = request.signal.aborted ? { error: 'request_cancelled', status: 408 }
          : { error: 'agent_read_timeout', status: 503 };
        resolve(ended);
      }, waitMs);
    });
    const trace = guardedTrace(diagnostics, 'connector-agent-catalog'); trace.add('step', 3);
    let failed = true;
    try {
      const result = await Promise.race([original, cancelled, deadline]);
      const refusal = interrupted() ?? ('error' in result ? result : undefined);
      if (refusal) {
        if (refusal.status === 408) { trace.add('cancelled', 1); trace.add('pending', 1); }
        else if (refusal.error === 'agent_read_timeout') { trace.add('timedOut', 1); trace.add('pending', 1); }
        return c.json({ error: refusal.error }, refusal.status);
      }
      if ('error' in result) return c.json({ error: result.error }, result.status);
      trace.add('settled', 1); failed = false;
      return c.json({ agents: result.agents });
    } finally {
      clearTimeout(timer); request.signal.removeEventListener('abort', cancel); trace.finish(failed);
    }
  });
  return {
    close(): Promise<void> {
      stopped = true;
      return closing ??= Promise.all([...accepted]).then(() => undefined);
    },
  };
}
