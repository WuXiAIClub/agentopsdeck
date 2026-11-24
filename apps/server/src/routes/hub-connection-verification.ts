import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AsyncHubMemberRequests, HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { ConnectorClient, ConnectorClientError } from '../hub/connector-client.js';
import { normalizeConnectorUrl, type HubConnection } from '../hub/hub-store.js';
import { resolveConnectorRouteClient, validateConnectorRouteClients, type ConnectorRouteClients } from '../hub/connector-route-clients.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { CONNECTOR_SCOPES } from '../auth/connector-token.js';

type ProbeSchema = { [key: string]: ProbeSchema | 'string' | 'boolean' | 'number' | readonly string[] };
const flags = (...keys: string[]): ProbeSchema => Object.fromEntries(keys.map(key => [key, 'boolean']));
const readiness = ['disabled', 'starting', 'ready', 'maintenance', 'failed', 'closed'] as const;
const environment: ProbeSchema = { idHint: 'string', label: 'string' };
const features = flags('scopedTokens', 'sessions', 'messages', 'events', 'media', 'users', 'pairing', 'modelSet',
  'interactions', 'sessionFileIndex', 'connectorUpdate', 'workspaceFiles');
const runtime: ProbeSchema = { ...flags('enabled', 'ready', 'ownerOnly'), status: readiness,
  features: flags('text', 'queue', 'interrupt', 'history', 'attachments', 'compact', 'delete', 'modelOverride', 'interactions') };
const infoSchema: ProbeSchema = { service: ['aod-connector'], version: 'string', environment, features };
const healthSchema: ProbeSchema = { ok: 'boolean', status: ['online', 'degraded'], updatedAt: 'number',
  gateway: { ...flags('ok', 'enabled', 'degraded'), status: ['online', 'offline', 'degraded', 'unknown'],
    version: 'string', defaultAgentId: 'string', defaultModel: 'string', updatedAt: 'number',
    gatewayWs: flags('configured', 'connected'), adminRpc: flags('configured') },
  codex: flags('enabled', 'sessionListReady'),
  hermes: { ...flags('enabled', 'ready'), status: readiness },
  claude: { ...flags('enabled', 'ready'), status: readiness },
  copilot: { ...flags('enabled', 'ready'), status: readiness }, fallback: flags('openclawCli') };
const capabilitiesSchema: ProbeSchema = { protocol: { min: 'number', max: 'number' },
  connector: { service: ['aod-connector'], version: 'string', revision: 'string', build: { revision: 'string', dirty: 'boolean' } },
  environment, features, runtimes: { codex: runtime, openclaw: runtime, hermes: runtime, 'claude-code': runtime, ghcp: runtime },
  limits: { maxMessageChars: 'number', maxRequestsPerMinute: 'number', maxSseConnections: 'number' },
  gateway: { ...flags('statusVisible', 'opsAllowed'), version: 'string' },
  update: { ...flags('supported', 'rollbackAvailable', 'restartRequired'), currentVersion: 'string', currentRevision: 'string',
    channel: ['stable', 'candidate', 'manual'],
    state: ['idle', 'checking', 'available', 'downloading', 'verifying', 'installing', 'restarting', 'succeeded', 'failed', 'rolled_back'],
    targetVersion: 'string', targetRevision: 'string', lastAttemptAt: 'number', lastSuccessAt: 'number', updatedAt: 'number' } };

function projectProbe(value: unknown, schema: ProbeSchema): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>, result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    const candidate = source[key];
    if (typeof field === 'string') {
      if (typeof candidate === field && (field !== 'string' || (candidate as string).length <= 256)
        && (field !== 'number' || Number.isSafeInteger(candidate) && Number(candidate) >= 0)) result[key] = candidate;
    } else if (Array.isArray(field)) {
      if (typeof candidate === 'string' && field.includes(candidate)) result[key] = candidate;
    } else if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      result[key] = projectProbe(candidate, field as ProbeSchema);
    }
  }
  return result;
}

function projectCapabilities(value: unknown) {
  const result = projectProbe(value, capabilitiesSchema);
  const scopes = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).scopes : undefined;
  if (Array.isArray(scopes)) result.scopes = CONNECTOR_SCOPES.filter(scope => scopes.includes(scope));
  return result;
}

function publicProbeUrl(value: string) {
  const url = new URL(value); url.search = ''; url.hash = ''; url.username = ''; url.password = '';
  return url.toString().replace(/\/$/, '');
}

export function isHubConnectionVerificationRequest(method: string, path: string) {
  return method === 'POST' && /^\/api\/hub\/v1\/connections\/(?:test|[^/]+\/verify)$/.test(path);
}

/** Original request identity owns the upload, remote reads and pin COMMIT ACK.
 * A remote probe never borrows a saved/default connection credential. */
export function registerHubConnectionVerification(app: Hono, deps: ConnectorRouteClients & {
  createAccess: () => { requests: AsyncHubMemberRequests; close(): Promise<void> };
  defaultConnectionId: string;
  present: (connection: HubConnection, users?: Array<{id: string; label: string}>) => unknown;
  error: (c: Context, error: unknown) => Response;
}) {
  validateConnectorRouteClients(deps);
  const work = new HubRequestWork(), uploads = new Set<() => Promise<void>>();
  let access: ReturnType<typeof deps.createAccess> | undefined = deps.mode === 'async' ? deps.createAccess() : undefined;
  if (deps.mode === 'async' && (typeof access?.requests?.begin !== 'function' || typeof access.close !== 'function'))
    throw Error('hub_connection_verification_ports_required');
  const begin = async (c: Context) => {
    try { access ??= deps.createAccess(); } catch { throw new HubMemberRequestError(503); }
    const original = await access.requests.begin(c.req.raw);
    const scope = c.req.header('x-agentopsdeck-recovery-scope');
    if (scope !== undefined && scope !== original.recoveryScope) throw new HubMemberRequestError(409);
    work.check(); return original;
  };
  const handle = (c: Context, fn: (original: Awaited<ReturnType<typeof begin>>) => Promise<Response>) => {
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 105);
    return work.run(async () => fn(await begin(c))).then(result => {
      trace.add('settled', 1); trace.finish(); return result;
    }, error => {
      trace.add('deferred', 1); trace.finish(true);
      if (error instanceof HubMemberRequestError) return new Response(JSON.stringify({error: 'Connection verification authority is unavailable', status: error.status}),
        {status: error.status, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
      if (error instanceof HTTPException) return error.getResponse();
      return deps.error(c, error);
    });
  };
  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const source = c.req.raw.body;
    if (!source) return {};
    const reader = source.getReader(), signal = c.req.raw.signal;
    let ended = false, expired = false, cancelling: Promise<void> | undefined;
    const remove = () => {clearTimeout(timer); signal.removeEventListener('abort', abort); uploads.delete(cancel); reader.releaseLock();};
    const cancel = () => {
      if (cancelling) return cancelling;
      if (ended) return Promise.resolve();
      cancelling = Promise.resolve().then(() => reader.cancel()).finally(remove); return cancelling;
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
        size += next.value.byteLength;
        if (size > 48 * 1024) throw new HTTPException(413);
        chunks.push(next.value);
      }
      ended = true; remove();
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HTTPException(400);
      return value as Record<string, unknown>;
    } catch (error) {await cancel(); if (error instanceof SyntaxError) throw new HTTPException(400); throw error;}
  };
  app.post('/api/hub/v1/connections/:connectionId/verify', c => handle(c, async original => {
    if (!deps.asyncConnectorClient) throw new HubMemberRequestError(503);
    const target = await original.connection(c.req.param('connectionId')!);
    const client = await resolveConnectorRouteClient(deps, c.req.raw, target.connection.id, false, original.principal.userId);
    await target.check(); work.check();
    const nodeId = await client.identity(c.req.raw.signal);
    await target.check(); work.check();
    const result = await target.pin(nodeId); // Never recheck the now-obsolete pre-pin epoch.
    work.check();
    if (!result || !('connection' in result)) throw new HubMemberRequestError(503);
    return c.json({connection: deps.present(result.connection)});
  }));
  app.post('/api/hub/v1/connections/test', c => handle(c, async original => {
    const raw = await body(c);
    if (Object.keys(raw).some(key => !['connectorUrl', 'token'].includes(key))
      || raw.connectorUrl !== undefined && typeof raw.connectorUrl !== 'string'
      || raw.token !== undefined && typeof raw.token !== 'string') throw new HTTPException(400);
    const connectorUrl = normalizeConnectorUrl(raw.connectorUrl as string | undefined);
    if (raw.connectorUrl && !connectorUrl) throw new HTTPException(400);
    await original.check(); work.check();
    if (connectorUrl && connectorUrl !== 'local://aod-connector') {
      const client = new ConnectorClient(connectorUrl, (raw.token as string | undefined) ?? '', undefined, 10_000, 8 * 1024 * 1024,
        {authorize: original.check});
      // Promise.all would release route ownership while the sibling original
      // dispatch/body/cancel ACK is still pending after the first rejection.
      const [info, health] = await Promise.allSettled([
        client.jsonOriginal('/info', {signal: c.req.raw.signal}), client.jsonOriginal('/health', {signal: c.req.raw.signal}),
      ]);
      await original.check(); work.check();
      if (info.status === 'fulfilled' && health.status === 'fulfilled')
        return c.json({ok: true, connectorUrl: publicProbeUrl(connectorUrl), connector: projectProbe(info.value, infoSchema),
          health: projectProbe(health.value, healthSchema), updatedAt: Date.now()});
      const error = info.status === 'rejected' ? info.reason : health.status === 'rejected' ? health.reason : undefined;
      return c.json({ok: false, connectorUrl: publicProbeUrl(connectorUrl), error: error instanceof ConnectorClientError ? error.message : 'Connector connection failed', updatedAt: Date.now()});
    }
    if (!deps.asyncConnectorClient) throw new HubMemberRequestError(503);
    // Directory generation binds both connection and owner-label projection.
    const directory = await original.connectionDirectory(), id = deps.defaultConnectionId;
    const connection = directory.connections.find(value => value.id === id);
    if (!connection) throw new HubMemberRequestError(404);
    await directory.check(id); work.check();
    const client = await resolveConnectorRouteClient(deps, c.req.raw, id, false, original.principal.userId);
    await directory.check(id); work.check();
    const connector = await client.jsonOriginal('/capabilities', {signal: c.req.raw.signal});
    await directory.check(id); work.check();
    return c.json({ok: true, connection: deps.present(connection, directory.users), connector: projectCapabilities(connector), updatedAt: Date.now()});
  }));
  let closing: Promise<void> | undefined;
  return {close: () => {
    if (closing) return closing;
    const waiting = work.close(), cancelled = Promise.allSettled([...uploads].map(cancel => cancel()));
    closing = Promise.all([waiting, cancelled]).then(async ([, results]) => {
      await access?.close();
      if (results.some(result => result.status === 'rejected')) throw new HubMemberRequestError(503);
    });
    return closing;
  }};
}
