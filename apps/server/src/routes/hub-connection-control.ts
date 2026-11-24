import { randomUUID } from 'node:crypto';
import { AOD_MODEL_SET_ID, createCommandKey } from '@agentopsdeck/shared';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { resolveConnectorRouteClient, validateConnectorRouteClients, type ConnectorRouteClients } from '../hub/connector-route-clients.js';
import { connectionControlWire, validConnectionControlOperation, type ConnectionControlOperation } from '../hub/connection-control-contract.js';
import type { AsyncHubConnectionProxyAccess } from '../hub/async-connection-proxy-access.js';
import type { ConnectionControlSettlementOwner } from '../hub/member-connection-control-domain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

export function isHubConnectionControlRequest(method: string, path: string) {
  return ['GET', 'HEAD'].includes(method) && /^\/api\/hub\/v1\/connections\/[^/]+\/(?:capabilities|gateway\/model-set|update\/status|maintenance\/status|control\/receipts\/[^/]+)$/.test(path)
    || method === 'POST' && /^\/api\/hub\/v1\/connections\/[^/]+\/(?:gateway\/model-set\/reconcile|update\/check)$/.test(path);
}

/** Fixed controls only. Original effects and private settlement outlive current
 * delivery authority; receipt GET is read-only and can never re-dispatch. */
export function registerHubConnectionControl(app: Hono, deps: ConnectorRouteClients & {
  createAccess: () => {access: AsyncHubConnectionProxyAccess; settlement: ConnectionControlSettlementOwner};
  error: (c: Context, error: unknown) => Response;
}) {
  validateConnectorRouteClients(deps);
  const base = '/api/hub/v1/connections/:connectionId', work = new HubRequestWork();
  let ports: ReturnType<typeof deps.createAccess> | undefined = deps.mode === 'async' ? deps.createAccess() : undefined;
  if (deps.mode === 'async' && (typeof ports?.access?.begin !== 'function' || typeof ports.access.close !== 'function'
    || typeof ports.settlement?.command !== 'function')) throw Error('hub_connection_control_ports_required');
  const uploads = new Set<() => Promise<void>>();
  const unavailable = () => new HubMemberRequestError(503);
  const begin = async (c: Context) => {
    if (!deps.asyncConnectorClient) throw unavailable();
    // Lazy: incomplete injected compositions fail this domain, not app startup.
    try { ports ??= deps.createAccess(); } catch { throw unavailable(); }
    const original = await ports.access.begin(c.req.raw, c.req.param('connectionId')!);
    work.check(); return original;
  };
  const handle = (c: Context, fn: (original: Awaited<ReturnType<typeof begin>>) => Promise<Response>) => {
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 104);
    return work.run(async () => fn(await begin(c))).then(result => {trace.add('settled', 1); trace.finish(); return result;}, error => {
      trace.add('deferred', 1); trace.finish(true);
      if (error instanceof HubMemberRequestError) return new Response(JSON.stringify({error: 'Connector authority or original control receipt is unavailable', status: error.status}),
        {status: error.status, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
      if (error instanceof HTTPException) return error.getResponse();
      return deps.error(c, error);
    });
  };
  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const source = c.req.raw.body;
    if (!source) return {};
    const reader = source.getReader(), signal = c.req.raw.signal;
    let ended = false, cancelling: Promise<void> | undefined, expired = false;
    const remove = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); uploads.delete(cancel); reader.releaseLock(); };
    const cancel = () => {
      if (cancelling) return cancelling;
      if (ended) return Promise.resolve();
      ended = true; cancelling = Promise.resolve().then(() => reader.cancel()).finally(remove); return cancelling;
    };
    const abort = () => {void cancel().catch(() => {});};
    const timer = setTimeout(() => {expired = true; abort();}, 30_000); timer.unref?.();
    uploads.add(cancel); signal.addEventListener('abort', abort, {once: true});
    try {
      if (signal.aborted) throw new HubMemberRequestError(499);
      if (Number(c.req.header('content-length')) > 48 * 1024) throw new HTTPException(413);
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const next = await reader.read(); work.check();
        if (signal.aborted) throw new HubMemberRequestError(499);
        if (expired) throw new HTTPException(408);
        if (next.done) break;
        size += next.value.byteLength; if (size > 48 * 1024) throw new HTTPException(413); chunks.push(next.value);
      }
      ended = true; remove();
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HTTPException(400);
      return raw as Record<string, unknown>;
    } catch (error) {await cancel(); if (error instanceof SyntaxError) throw new HTTPException(400); throw error;}
  };
  const dispatch = async (c: Context, original: Awaited<ReturnType<typeof begin>>, control: ConnectionControlOperation, key: string) => {
    await original.check();
    const claimed = await original.claimControl({action: 'claim', id: original.connection.id, expectedEpoch: original.epoch, control, key});
    if (!claimed.fresh) return c.json({error: 'Original control already admitted; query its receipt, do not resend', command: {
      key, operation: control.operation, state: claimed.receipt.state, ...(claimed.receipt.result ? {status: claimed.receipt.result.status} : {}),
    }}, 409);
    work.check();
    const client = await resolveConnectorRouteClient(deps, c.req.raw, original.connection.id, connectionControlWire(control).maintenance, original.principal.userId);
    await original.check(); work.check();
    const result = await client.connectionControlOriginal(control, async observation => {
      // Do not check current request authority here. This capability can settle
      // only the pinned original receipt; close waits for its original ACK.
      await ports!.settlement.command({reference: claimed.reference, observation});
    }, c.req.raw.signal);
    await original.check(); work.check();
    return c.json(result.body as never, result.status as 200);
  };
  for (const [path, operation] of [['capabilities', 'capabilities'], ['gateway/model-set', 'modelSet'],
    ['update/status', 'updateStatus'], ['maintenance/status', 'maintenanceStatus']] as const) {
    app.get(`${base}/${path}`, c => handle(c, original => dispatch(c, original, {operation}, createCommandKey(randomUUID()))));
  }
  for (const [path, operation] of [['gateway/model-set/reconcile', 'reconcile'], ['update/check', 'updateCheck']] as const) {
    app.post(`${base}/${path}`, c => handle(c, async original => {
      const raw = await body(c), key = raw.idempotencyKey;
      if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({error: 'A stable idempotencyKey is required; reload the client before starting a new control'}, 428);
      if (Object.keys(raw).some(k => !(operation === 'reconcile' ? ['setId','idempotencyKey','dryRun'] : ['channel','idempotencyKey']).includes(k))) return c.json({error: 'Invalid control request'}, 400);
      const control: ConnectionControlOperation = operation === 'reconcile'
        ? {operation, request: {setId: (raw.setId ?? AOD_MODEL_SET_ID) as typeof AOD_MODEL_SET_ID, idempotencyKey: key, ...(raw.dryRun !== undefined ? {dryRun: raw.dryRun as true} : {})}}
        : {operation, request: {...(raw.channel !== undefined ? {channel: raw.channel as 'stable' | 'candidate'} : {})}};
      if (!validConnectionControlOperation(control)) return c.json({error: 'Invalid control request'}, 400);
      return dispatch(c, original, control, key);
    }));
  }
  app.get(`${base}/control/receipts/:key`, c => handle(c, async original => {
    const key = c.req.param('key')!, query = c.req.queries(), operation = c.req.query('operation');
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key) || Object.keys(query).length !== 1 || query.operation?.length !== 1
      || operation !== 'reconcile' && operation !== 'updateCheck') return c.json({error: 'Invalid control receipt query'}, 400);
    return c.json({command: await original.controlReceipt(key, operation)});
  }));
  let closing: Promise<void> | undefined;
  return {close: () => {
    if (closing) return closing;
    const waiting = work.close();
    const cancelled = Promise.allSettled([...uploads].map(cancel => cancel()));
    closing = Promise.all([waiting, cancelled]).then(async ([, results]) => {
      await ports?.access.close();
      if (results.some(result => result.status === 'rejected')) throw unavailable();
    });
    return closing;
  }};
}
