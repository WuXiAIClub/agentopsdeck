import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { isLoopbackListenHost, type ServerConfig } from './config.js';
import { authRequestSource } from './auth/request-source.js';
import { registerRequestDrain } from './lifecycle/request-drain.js';
import { historyTransfer } from './messages/history-transfer.js';
import { registerVoiceMessages } from './voice-messages.js';

/** Wire-only application boundary, shared by the original and worker roots.
 * No database, identity grant, background task or native effect is owned here. */
export function createApplicationHttpShell(config: ServerConfig, voiceOptions: Parameters<typeof registerVoiceMessages>[1] = {}) {
  if (!isLoopbackListenHost(config.listenHost ?? '127.0.0.1') && !config.accessKey?.trim()) {
    throw new Error('Non-loopback AOD_LISTEN_HOST requires AOD_ACCESS_KEY');
  }
  const app = new Hono();
  app.use('/api/*', authRequestSource(config.authTrustedProxies));
  const stopAdmissions = registerRequestDrain(app);
  app.use('/api/*', historyTransfer);
  app.get('/api.ts', c => c.body(null, 204, {
    'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store',
  }));
  function allowedBrowserOrigin(origin: string, request: Request) {
    try {
      const url = new URL(origin);
      if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) return false;
      if (config.allowedOrigins.includes(origin) || (config.publicBaseUrl && new URL(config.publicBaseUrl).origin === origin)) return true;
      const target = new URL(request.url);
      if (target.origin === origin) return true;
      const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
      return forwardedProto === 'https' && target.host === url.host && url.protocol === 'https:';
    } catch { return false; }
  }
  app.use('/api/*', cors({ origin: (origin, c) => allowedBrowserOrigin(origin, c.req.raw) ? origin : undefined,
    allowHeaders: ['content-type', 'if-match', 'if-none-match', 'x-agentopsdeck-history-delta', 'x-agentopsdeck-history-async', 'x-agentopsdeck-key', 'x-agentopsdeck-key', 'authorization', 'x-agentopsdeck-recovery-scope', 'x-agentopsdeck-notebook-format'],
    exposeHeaders: ['etag', 'x-agentopsdeck-history-meta', 'x-agentopsdeck-history-delta', 'x-agentopsdeck-workspace-sync'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], credentials: true }));
  const voice = new Hono();
  registerVoiceMessages(voice, voiceOptions);
  const dispatchVoice = voice.fetch;
  voice.fetch = app.fetch;
  app.use('/api/*', async (c, next) => {
    await next();
    if (c.res.status === 404 && c.req.method === 'POST'
      && /^\/api\/(?:hub\/v1\/)?(?:shared\/[^/]+\/)?sessions\/[^/]+\/voice$/.test(c.req.path)) {
      c.res = await dispatchVoice(c.req.raw, c.env);
    }
  });
  return { app, stopAdmissions, allowedBrowserOrigin };
}
