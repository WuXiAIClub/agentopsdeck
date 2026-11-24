import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { reply } from '../commands/http.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import type { ServerConfig } from '../config.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import { readJsonBody } from '../utils/http-body.js';
import type { UpdateOperatorMode } from './connector-update-domain.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { ConnectorUpdateService, UpdateAuthorizationError } from './update-service.js';

type Operator<R extends void | Promise<void> = void | Promise<void>> = { actorId: string; recover: boolean; check: () => R };
export type ConnectorUpdateAuthority<R extends void | Promise<void> = void | Promise<void>> = {
  run<T>(request: Request, mode: UpdateOperatorMode, action: (operator: Operator<R>) => Promise<T>): Promise<T>;
};

/** Explicit compatibility mode only. Captures original evidence; never passes
 * an async callback to the legacy SQL/journal authority guards. */
export function synchronousUpdateAuthority(tokens: ConnectorTokenStore, nodeId: string): ConnectorUpdateAuthority<void> {
  return { async run(request, mode, action) {
    const authorization = request.headers.get('authorization') ?? '';
    const expectedNode = request.headers.get(EXPECTED_NODE_HEADER), protocol = request.headers.get(CONNECTOR_PROTOCOL_HEADER);
    const originPresent = request.headers.has('origin');
    const principal = () => {
      const current = tokens.authenticateAuthorization(authorization);
      if (!current) throw new UpdateAuthorizationError();
      const recover = current.scopes.includes('connector:update');
      const lifecycle = !originPresent && protocol === '1' && expectedNode === nodeId && current.scopes.includes('connector:lifecycle');
      if (mode === 'readiness' ? !lifecycle : !recover && !(mode === 'status' && current.scopes.includes('sessions:read'))
        && !(mode === 'maintenance' && lifecycle)) throw new UpdateAuthorizationError();
      return { actorId: current.tokenId, recover };
    };
    if (request.signal.aborted) throw new HTTPException(408, { message: 'Request interrupted' });
    const original = principal();
    const check = () => {
      const current = principal();
      if (current.actorId !== original.actorId || current.recover !== original.recover) throw new UpdateAuthorizationError();
    };
    check(); const value = await action({ ...original, check }); check(); return value;
  } };
}

/** One public transport for both roots. No SQL store, token getter, installer
 * substitute, detached effect or command retry lives here. */
export function registerConnectorUpdates(app: Hono, base: string, deps: {
  config: ServerConfig; service: ConnectorUpdateService; authority: ConnectorUpdateAuthority;
  normalizeError: (error: unknown) => string;
}) {
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const execute = <T>(request: Request, mode: UpdateOperatorMode, action: (operator: Operator) => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new UpdateAuthorizationError());
    const work = deps.authority.run(request, mode, async operator => {
      const check = () => { if (closed) throw new UpdateAuthorizationError(); return operator.check(); };
      await check(); const result = await action({ ...operator, check }); await check(); return result;
    });
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  const failure = (c: Context, error: unknown, mode: 'read' | 'update' | 'maintenance') => c.json({ error:
    error instanceof StorageAdmissionDeferred ? 'Command storage admission unavailable'
      : error instanceof HTTPException ? error.message : deps.normalizeError(error) },
  error instanceof UpdateAuthorizationError ? 403 : error instanceof HTTPException ? error.status
    : mode === 'read' ? 400 : error instanceof StorageAdmissionDeferred ? 503
      : error instanceof CommandConflict ? 409 : error instanceof CommandCapacity ? mode === 'maintenance' ? 507 : 503 : 400);
  const service = deps.service;
  app.get(`${base}/update/status`, async c => {
    c.header('Cache-Control', 'no-store');
    try { return await execute(c.req.raw, 'status', async op => c.json(await service.status(op.recover, op.check))); }
    catch (error) { return failure(c, error, 'read'); }
  });
  const updateRequest = (operation: 'check' | 'apply' | 'rollback') => async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    try { return await execute(c.req.raw, 'update', async op => {
      if (!deps.config.connector.updateEnabled) return c.json({ error: 'connector updates are disabled' }, 400);
      const raw = await readJsonBody(c.req.raw, 8192); await op.check();
      if (c.req.raw.signal.aborted) throw new HTTPException(408, { message: 'Request interrupted' });
      const fields = operation === 'apply' ? ['version', 'revision', 'manifestSha256', 'idempotencyKey']
        : operation === 'check' ? ['channel'] : ['idempotencyKey'];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !fields.includes(key))) {
        return c.json({ error: 'Invalid update request fields' }, 400);
      }
      const body = raw as Record<string, unknown>;
      if (operation !== 'check' && (typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(body.idempotencyKey))) {
        return c.json({ error: 'Invalid command key' }, 400);
      }
      if (operation === 'check' && body.channel !== undefined && body.channel !== 'stable' && body.channel !== 'candidate') {
        return c.json({ error: 'Invalid update channel' }, 400);
      }
      if (operation === 'apply' && (typeof body.version !== 'string' || typeof body.manifestSha256 !== 'string'
        || body.revision !== undefined && typeof body.revision !== 'string')) return c.json({ error: 'Invalid update request' }, 400);
      if (operation === 'check') return c.json(await service.check(body.channel as 'stable' | 'candidate' | undefined, op.check));
      const receipt = operation === 'apply' ? await service.applyCommand(op.actorId, body, op.check)
        : await service.rollbackCommand(op.actorId, body.idempotencyKey, op.check);
      await op.check(); return reply(c, receipt);
    }); } catch (error) { return failure(c, error, 'update'); }
  };
  app.post(`${base}/update/check`, updateRequest('check'));
  for (const operation of ['apply', 'rollback'] as const) {
    app.post(`${base}/update/${operation}`, async c => {
      c.header('Cache-Control', 'no-store');
      try { return await execute(c.req.raw, 'update', async () => c.json({ error:
        'Legacy update writes retired; use original command receipts. Do not resend uncertain earlier updates.' }, 410)); }
      catch (error) { return failure(c, error, 'read'); }
    });
    app.post(`${base}/update/commands/${operation}`, updateRequest(operation));
    app.get(`${base}/update/commands/${operation}/:commandKey`, async c => {
      c.header('Cache-Control', 'no-store');
      try { return await execute(c.req.raw, 'update', async op => {
        const key = c.req.param('commandKey');
        if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'Invalid command key' }, 400);
        const receipt = await service.command(op.actorId, operation, key, op.check); await op.check();
        return receipt ? c.json({ command: receipt }) : c.json({ error: 'Command not found' }, 404);
      }); } catch (error) { return failure(c, error, 'read'); }
    });
  }
  app.get(`${base}/maintenance/status`, async c => {
    c.header('Cache-Control', 'no-store');
    try { return await execute(c.req.raw, 'maintenance', async op => c.json(await service.maintenanceStatus(op.check))); }
    catch (error) { return failure(c, error, 'read'); }
  });
  for (const operation of ['pause', 'resume'] as const) {
    app.post(`${base}/maintenance/commands/${operation}`, async c => {
      c.header('Cache-Control', 'no-store');
      try { return await execute(c.req.raw, 'maintenance', async op => {
        const raw = await readJsonBody(c.req.raw, 8192); await op.check();
        if (c.req.raw.signal.aborted) throw new HTTPException(408, { message: 'Request interrupted' });
        const fields = operation === 'pause' ? ['idempotencyKey'] : ['idempotencyKey', 'fenceId'];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !fields.includes(key))) {
          return c.json({ error: 'Invalid maintenance request fields' }, 400);
        }
        const body = raw as Record<string, unknown>;
        const receipt = await service.changeMaintenance(op.actorId, operation, body.idempotencyKey, body.fenceId, op.check);
        await op.check(); return reply(c, receipt);
      }); } catch (error) { return failure(c, error, 'maintenance'); }
    });
    app.get(`${base}/maintenance/commands/${operation}/:commandKey`, async c => {
      c.header('Cache-Control', 'no-store');
      try { return await execute(c.req.raw, 'maintenance', async op => {
        const receipt = await service.maintenanceCommand(op.actorId, operation, c.req.param('commandKey'), op.check); await op.check();
        return receipt ? c.json({ command: receipt }) : c.json({ error: 'Command not found' }, 404);
      }); } catch (error) { return failure(c, error, 'read'); }
    });
  }
  return {
    status(request: Request, recover = false) {
      return execute(request, 'status', op => service.status(recover, op.check));
    },
    async close() { closed = true; while (pending.size) await Promise.allSettled([...pending]); },
  };
}
