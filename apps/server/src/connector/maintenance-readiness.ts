import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandConflict } from '../commands/receipts.js';
import { readJsonBody } from '../utils/http-body.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import type { ConnectorUpdateService } from './update-service.js';
import { UpdateAuthorizationError } from './update-service.js';
import { synchronousUpdateAuthority, type ConnectorUpdateAuthority } from './update-http.js';

export type MaintenanceBusinessObservation = {
  nodeId: string;
  fenceId: string;
  observedAt: number;
  revision: string;
  sessionKey: string;
  messageCount: number;
  projectionVerified: true;
  businessReadVerified: true;
  /** Payload-free proof through the runtime's exclusively owned connection. */
  preservation?: {
    queueSha256: string;
    execution?: {
      commandId: string; connectionId: string; runId?: string | undefined; phase: string; sync: string;
      executionProtection?: { state: string; reason?: string };
    };
  };
  /** Exact interrupted run with independently recorded stopped-process proof.
   * It may legitimately have no assistant reply if interrupted immediately.
   */
  recoveredRunId?: string;
};

/** The only hydration entry permitted under the retained maintenance fence.
 * It returns proof metadata, never message contents, paths, or tool results.
 * Native turn starts, ordinary reads/writes and queues remain paused.
 */
export function registerMaintenanceReadiness(app: Hono, deps: {
  nodeId: string;
  tokens: ConnectorTokenStore;
  updateService: ConnectorUpdateService;
  probe?: (sessionKey: string, check: () => void) => Promise<Omit<MaintenanceBusinessObservation, 'fenceId'>>;
}) {
  return registerReadiness(app, { ...deps, authority: synchronousUpdateAuthority(deps.tokens, deps.nodeId) });
}

/** Async root must supply an awaited probe: a Promise guard must not escape
 * into the original runtime's synchronous check callbacks. */
export function registerAsyncMaintenanceReadiness(app: Hono, deps: {
  nodeId: string;
  authority: ConnectorUpdateAuthority;
  updateService: ConnectorUpdateService;
  probe?: (sessionKey: string, check: () => Promise<void>) => Promise<Omit<MaintenanceBusinessObservation, 'fenceId'>>;
}) {
  const authority: ConnectorUpdateAuthority<Promise<void>> = { run: (request, mode, action) =>
    deps.authority.run(request, mode, operator => action({ ...operator, check: async () => { await operator.check(); } })) };
  return registerReadiness(app, { ...deps, authority });
}

function registerReadiness<R extends void | Promise<void>>(app: Hono, deps: {
  nodeId: string;
  authority: ConnectorUpdateAuthority<R>;
  updateService: ConnectorUpdateService;
  probe?: (sessionKey: string, check: () => R) => Promise<Omit<MaintenanceBusinessObservation, 'fenceId'>>;
}) {
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  app.post('/api/connector/v1/maintenance/readiness', async c => {
    c.header('Cache-Control', 'no-store');
    if (c.req.header('Origin') !== undefined) return c.json({ error: 'Browser access is not supported' }, 403);
    if (c.req.header(CONNECTOR_PROTOCOL_HEADER) !== '1') return c.json({ error: 'Explicit compatible protocol required' }, 426);
    if (c.req.header(EXPECTED_NODE_HEADER) !== deps.nodeId) return c.json({ error: 'Exact maintenance node required' }, 409);
    try {
      if (closed) throw new UpdateAuthorizationError();
      // Capture original credentials before reading a possibly streamed body.
      const work = deps.authority.run(c.req.raw, 'readiness', async operator => {
      const check = () => {
        if (closed) throw new UpdateAuthorizationError();
        if (c.req.raw.signal.aborted) throw new Error('Readiness probe interrupted');
        return operator.check();
      };
      await check();
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: 'JSON content type required' }, 415);
      const value = await readJsonBody(c.req.raw, 8192);
      await check();
      if (!value || typeof value !== 'object' || Array.isArray(value)) return c.json({ error: 'Invalid readiness request' }, 400);
      const body = value as Record<string, unknown>;
      if (Object.keys(body).some(key => !['fenceId', 'sessionKey'].includes(key))
        || typeof body.fenceId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.fenceId)
        || typeof body.sessionKey !== 'string' || !/^(?:codex|claude-code|ghcp):[A-Za-z0-9-]{1,128}$/.test(body.sessionKey)) {
        return c.json({ error: 'Invalid readiness request' }, 400);
      }
      if (!deps.probe) return c.json({ error: 'Business maintenance probe is not supported' }, 501);
      const sessionKey = body.sessionKey, fenceId = body.fenceId;
      const proof = await deps.updateService.withMaintenanceProbe(operator.actorId, fenceId, check,
        () => deps.probe!(sessionKey, check));
      await check();
      return c.json({ ...proof, fenceId });
      });
      pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work));
      return await work;
    } catch (error) {
      if (error instanceof UpdateAuthorizationError) return c.json({ error: 'Lifecycle maintenance is not authorized' }, 403);
      if (error instanceof CommandConflict) return c.json({ error: 'Original paused maintenance fence required' }, 409);
      if (error instanceof HTTPException && [400, 408, 413].includes(error.status)) return c.json({ error: 'Invalid readiness body' }, error.status);
      return c.json({ error: 'Business readiness unavailable; execution remains fenced' }, 503);
    }
  });
  return { async close() { closed = true; while (pending.size) await Promise.allSettled([...pending]); } };
}
