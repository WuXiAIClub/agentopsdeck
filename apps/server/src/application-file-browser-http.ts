import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { ApplicationCommandScopeError, type createApplicationCommandScopes } from './auth/application-command-scope.js';
import { SessionReadAuthority, type SessionReadActor } from './auth/session-read-authority.js';
import { ConnectorOwnerUnavailable } from './connector/connector-owner-domain.js';
import { EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import type { PerformanceDiagnostics } from './diagnostics/performance.js';
import { ReadRequestError } from './lifecycle/read-request-owner.js';
import { registerFileRoutes } from './routes/files.js';
import type { NativeFileRoots } from './config.js';

/** Original pure-FS business chain. No SQL/native command, synthetic grant,
 * private bearer or replayable receipt is introduced for local file edits. */
export function registerApplicationFileBrowserHttp(app: Hono, deps: {
  roots?: NativeFileRoots;
  commands: Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>;
  observeActor: SessionReadActor;
  available(): boolean;
  diagnostics?: PerformanceDiagnostics;
  requestWaitMs?: number;
}) {
  let closed = false;
  const available = () => !closed && deps.available();
  const authority = new SessionReadAuthority(request => {
    if (!available()) throw new ConnectorOwnerUnavailable();
    return deps.observeActor(request);
  }, deps.diagnostics, deps.requestWaitMs);
  const originals = new WeakMap<Request, () => Promise<void>>();
  const original = new Hono();
  const files = registerFileRoutes(original, { ...(deps.roots ? { roots: deps.roots } : {}), mutate: async (request, mutation, work) => {
    const check = originals.get(request);
    if (!available() || !check) throw Object.assign(new Error('file operation unavailable'), { status: 503 });
    // Bind the local lifetime to the resolved original paths/content without
    // making private paths part of diagnostics or retaining the upload twice.
    const payloadDigest = createHash('sha256').update(JSON.stringify(mutation)).digest('hex');
    try {
      return await deps.commands.run(request, {
        action: 'files', runtime: 'openclaw', resource: `file-browser:${payloadDigest}`,
        commandKey: randomUUID(), payloadDigest,
      }, async scope => {
        await check(); await scope.authorize('prepare'); scope.local();
        return work(async () => {
          await check(); await scope.authorize('effect'); scope.local();
        });
      });
    } catch (error) {
      // The original route owns HTTP error formatting. Never expose a private
      // source error or turn a revoked/cancelled operation into success.
      if (error instanceof ApplicationCommandScopeError || error instanceof ReadRequestError) {
        const status = error instanceof ReadRequestError ? error.status : error.code === 'unauthorized' ? 403
          : error.code === 'cancelled' ? 408 : error.code === 'invalid' ? 400 : 503;
        throw Object.assign(new Error('file authorization or lifetime changed'), { status });
      }
      throw error;
    }
  } });
  const reads = ['/api/files/roots', '/api/files/gateway', '/api/files/agents/:agentId',
    '/api/files/gateway/preview', '/api/files/agents/:agentId/preview',
    '/api/files/gateway/download', '/api/files/agents/:agentId/download'];
  const writes = [
    ['POST', '/api/files/gateway/upload'], ['POST', '/api/files/agents/:agentId/upload'],
    ['PATCH', '/api/files/gateway/rename'], ['PATCH', '/api/files/agents/:agentId/rename'],
    ['DELETE', '/api/files/gateway'], ['DELETE', '/api/files/agents/:agentId'],
  ] as const;
  const dispatch = async (c: import('hono').Context) => {
    c.header('Cache-Control', 'no-store');
    if (!available()) return c.json({ error: 'server_draining' }, 503);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined || c.req.header(EXPECTED_NODE_HEADER) !== undefined)
      return c.json({ error: 'Invalid local file authority' }, 403);
    const request = c.req.raw;
    const response = await authority.run(request, async check => {
      originals.set(request, check);
      try { return await original.fetch(request); }
      finally { originals.delete(request); }
    });
    const headers = new Headers(response.headers); headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
  for (const route of reads) app.get(route, dispatch);
  for (const [method, route] of writes) app.on(method, route, dispatch);
  let closing: Promise<void> | undefined;
  return Object.freeze({ close: () => {
    closed = true;
    // Freeze both lanes now, retain original FS even if the HTTP deadline won.
    return closing ??= Promise.all([authority.close(), files.close()]).then(() => undefined);
  } });
}
