import { createHash, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { SessionReadAuthority, type SessionReadActor } from './auth/session-read-authority.js';
import { ConnectorOwnerUnavailable } from './connector/connector-owner-domain.js';
import { cancelGuardedBody, guardedBody } from './connector/guarded-body.js';
import { EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import type { PerformanceDiagnostics } from './diagnostics/performance.js';
import { createTaskDrain } from './lifecycle/task-drain.js';
import { artifactResponse, openArtifactDownload, type ArtifactReceiverConfig, type ArtifactRegistryAccess } from './messages/artifact-receiver.js';
import { registerMediaRoutes } from './routes/media.js';
import type { MediaLibrary } from './routes/media-library.js';

export type ApplicationMediaPorts = {
  inboundDir?: string | undefined;
  artifactConfig: ArtifactReceiverConfig;
  artifactRegistry: ArtifactRegistryAccess;
  library: MediaLibrary;
};

/** Original local media wire with original Auth. Not a machine-token proxy,
 * native execution grant, or a second artifact/library owner. */
export function registerApplicationMediaHttp(app: Hono, deps: ApplicationMediaPorts & {
  commands: Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>;
  observeActor: SessionReadActor;
  available(): boolean;
  publicBaseUrl?: string;
  diagnostics?: PerformanceDiagnostics;
  requestWaitMs?: number;
}) {
  let closed = false, active = 0;
  const available = () => !closed && deps.available();
  const tasks = createTaskDrain();
  const bodies = new Map<ReadableStream<Uint8Array>, AbortController>();
  const observe: SessionReadActor = request => {
    if (!available()) throw new ConnectorOwnerUnavailable();
    return new URL(request.url).pathname === '/api/media-library/stream'
      ? deps.library.isSignedStreamRequest(request) ? 'original-signed-media-stream' : undefined
      : deps.observeActor(request);
  };
  const authority = new SessionReadAuthority(observe, deps.diagnostics, deps.requestWaitMs);
  const checks = new WeakMap<Request, () => Promise<void>>();
  const original = new Hono();
  registerMediaRoutes(original, {
    ...(deps.publicBaseUrl ? { publicBaseUrl: deps.publicBaseUrl } : {}), ...(deps.inboundDir ? { inboundDir: deps.inboundDir } : {}),
    artifact: { config: deps.artifactConfig, registry: deps.artifactRegistry, open: openArtifactDownload, response: artifactResponse },
    publish: async (request, payload, work) => {
      const check = checks.get(request);
      if (!available() || !check) throw new ConnectorOwnerUnavailable();
      const payloadDigest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      return deps.commands.run(request, { action: 'files', runtime: 'openclaw', resource: `media-publish:${payloadDigest}`,
        commandKey: randomUUID(), payloadDigest }, async scope => {
        await check(); await scope.authorize('prepare'); scope.local();
        return work(async () => { await check(); await scope.authorize('effect'); scope.local(); });
      });
    },
  });
  deps.library.register(original);
  const discard = async (response: Response) => {
    if (!response.body) return;
    await cancelGuardedBody(response.body);
    if (!response.body.locked) await response.body.cancel().catch(() => {});
  };
  const dispatch = async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    if (!available()) return c.json({ error: 'server_draining' }, 503);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined || c.req.header(EXPECTED_NODE_HEADER) !== undefined)
      return c.json({ error: 'Invalid local media authority' }, 403);
    if (active + bodies.size >= 32) return c.json({ error: 'media_capacity_exceeded' }, 503);
    const request = c.req.raw;
    // Long-lived pulls receive immutable original evidence, never the already
    // completed HTTP request's check or a newly minted transport credential.
    const url = request.url, method = request.method, headers = [...request.headers];
    const binary = /^\/api\/(?:media\/inbound\/|artifacts\/|media-library\/stream$)/.test(new URL(url).pathname);
    active++;
    try {
      const response = await authority.run(request, (check, actor) => tasks.run(async () => {
        checks.set(request, check);
        let response: Response;
        try { response = await original.fetch(request); }
        finally { checks.delete(request); }
        if (!binary || !response.ok || !response.body) return response;
        const lifetime = new AbortController(), source = response.body;
        let body!: ReadableStream<Uint8Array>;
        body = guardedBody(source, {
          signal: AbortSignal.any([request.signal, lifetime.signal]), maxBytes: Number.MAX_SAFE_INTEGER,
          authorize: async signal => {
            if (!available()) throw new ConnectorOwnerUnavailable();
            const observation = await authority.run(new Request(url, { method, headers, signal }), (_, current) => {
              if (current !== actor) throw new ConnectorOwnerUnavailable();
              return new Response(null, { status: 204 });
            });
            if (observation.status !== 204) throw new ConnectorOwnerUnavailable();
          },
          drain: async () => { try { await cancelGuardedBody(source); } finally { bodies.delete(body); } },
          onComplete: () => { bodies.delete(body); },
        });
        bodies.set(body, lifetime);
        // An already aborted input can cancel synchronously during start().
        // Retain its exact ACK, then clear the newly installed bookkeeping.
        if (request.signal.aborted || !available()) { lifetime.abort(); await cancelGuardedBody(body); bodies.delete(body); }
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      }), discard);
      const headersOut = new Headers(response.headers);
      if (!headersOut.has('cache-control')) headersOut.set('cache-control', 'no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: headersOut });
    } finally { active--; }
  };
  app.post('/api/media/publish', dispatch);
  for (const route of ['/api/media/inbound/:name', '/api/artifacts/:id', '/api/media-library']) app.get(route, dispatch);
  app.on(['GET', 'HEAD'], '/api/media-library/stream', dispatch);
  let closing: Promise<void> | undefined;
  return Object.freeze({ close: () => {
    if (closing) return closing;
    closed = true;
    const retained = [...bodies];
    const draining = [authority.close(), tasks.close()];
    for (const [, controller] of retained) controller.abort();
    return closing = Promise.allSettled([...draining, ...retained.map(([body]) => cancelGuardedBody(body))]).then(results => {
      if (results.some(result => result.status === 'rejected')) throw new ConnectorOwnerUnavailable();
    });
  } });
}
