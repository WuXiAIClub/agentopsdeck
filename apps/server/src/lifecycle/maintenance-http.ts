import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from '../connector/node-identity.js';
import { readJsonBody } from '../utils/http-body.js';
import { MaintenanceConflict } from './maintenance-journal.js';
import { MaintenanceForbidden, MaintenanceInvalidRequest, type MaintenanceSupervisor } from './maintenance-supervisor.js';
import { validMaintenanceRecoveryObservation, type MaintenanceRecoveryObservation } from './maintenance-recovery.js';

export const MAINTENANCE_PROTOCOL_HEADER = 'X-AgentOpsDeck-Maintenance-Protocol';
export const MAINTENANCE_API = '/api/maintenance/v1';

/**
 * API for the independently supervised node process, NOT the Connector app.
 * The host provides a fresh durable credential view on every call, including
 * while the Connector is stopped. Never cache a Connector-process token store
 * here, and never expose this listener to browsers (no cookie/CORS auth).
 *
 * POST persists admission only. An external worker drives tick(); this handler
 * cannot restart a service, start a timer, or replay an ambiguous effect.
 */
export function createMaintenanceApp(deps: {
  supervisor: MaintenanceSupervisor;
  tokens: () => Pick<ConnectorTokenStore, 'requireScope'>;
  workerState?: () => 'running' | 'halted' | 'stopping';
  recovery?: () => Promise<MaintenanceRecoveryObservation>;
}) {
  const app = new Hono();
  const { supervisor } = deps;
  function authenticate(request: Request, expectedActor?: string) {
    const principal = deps.tokens().requireScope(request, 'connector:lifecycle');
    if (!principal || (expectedActor !== undefined && principal.tokenId !== expectedActor)) throw new MaintenanceForbidden();
    return principal.tokenId;
  }
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header(NODE_ID_HEADER, supervisor.nodeId);
    c.header(MAINTENANCE_PROTOCOL_HEADER, '1');
    // Unlike the legacy Connector protocol, lifecycle never guesses a missing
    // version/node identity. No effects or credential reads on mismatches.
    if (c.req.header('Origin') !== undefined) return c.json({ error: 'Browser access is not supported' }, 403);
    if (c.req.header(MAINTENANCE_PROTOCOL_HEADER) !== '1') return c.json({ error: 'Incompatible maintenance protocol' }, 426);
    if (c.req.header(EXPECTED_NODE_HEADER) !== supervisor.nodeId) return c.json({ error: 'Maintenance node identity mismatch' }, 409);
    await next();
  });
  app.get(`${MAINTENANCE_API}/status`, async c => {
    const actorId = authenticate(c.req.raw);
    const status = await supervisor.status(actorId);
    authenticate(c.req.raw, actorId);
    return c.json({ ...status, ...(deps.workerState ? { workerState: deps.workerState() } : {}) });
  });
  app.get(`${MAINTENANCE_API}/recovery`, async c => {
    const actorId = authenticate(c.req.raw);
    if (c.req.raw.signal.aborted) throw new HTTPException(408);
    if (!deps.recovery) return c.json({ error: 'Maintenance recovery observation unavailable' }, 503);
    const observation = await deps.recovery();
    authenticate(c.req.raw, actorId);
    if (c.req.raw.signal.aborted) throw new HTTPException(408);
    if (!validMaintenanceRecoveryObservation(observation)) throw new Error('Invalid maintenance recovery observation');
    // Observing a ready connection is not quiescence/release/retry authority.
    return c.json({ ...observation, ...(deps.workerState ? { workerState: deps.workerState() } : {}) });
  });
  app.get(`${MAINTENANCE_API}/commands/:commandKey`, async c => {
    const actorId = authenticate(c.req.raw);
    const command = await supervisor.command(actorId, c.req.param('commandKey'));
    authenticate(c.req.raw, actorId);
    return command ? c.json({ command }) : c.json({ error: 'Maintenance command not found' }, 404);
  });
  app.post(`${MAINTENANCE_API}/commands`, async c => {
    const actorId = authenticate(c.req.raw);
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) {
      return c.json({ error: 'JSON content type required' }, 415);
    }
    const request = await readJsonBody(c.req.raw, 1024);
    authenticate(c.req.raw, actorId);
    if (c.req.raw.signal.aborted) throw new HTTPException(408);
    // Receipts remain readable after a worker failure, but accepting new work
    // would falsely imply that someone is available to execute it.
    if (deps.workerState && deps.workerState() !== 'running') {
      return c.json({ error: 'Maintenance worker is not running; inspect the existing receipt' }, 503);
    }
    const command = await supervisor.submit(actorId, request);
    // Admission may already be durable if this check rejects. The client must
    // reconcile the original key, not create a second command after reconnect.
    authenticate(c.req.raw, actorId);
    return c.json({ command }, 202);
  });
  app.onError((error, c) => {
    // Never serialize adapter errors, bearer tokens, paths or command output.
    if (error instanceof MaintenanceForbidden) return c.json({ error: 'Lifecycle maintenance is not authorized' }, 403);
    if (error instanceof MaintenanceConflict) return c.json({ error: 'Maintenance command conflicts with existing work' }, 409);
    if (error instanceof MaintenanceInvalidRequest) return c.json({ error: 'Invalid maintenance request' }, 400);
    if (error instanceof HTTPException && [400, 408, 413].includes(error.status)) {
      return c.json({ error: 'Invalid or interrupted maintenance body' }, error.status);
    }
    return c.json({ error: 'Maintenance supervisor unavailable' }, 503);
  });
  return app;
}
