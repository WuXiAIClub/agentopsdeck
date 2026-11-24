import type { MiddlewareHandler } from 'hono';
import { compress } from 'hono/compress';

const historyPath = /^\/api\/(?:(?:hub|connector)\/v1\/)?(?:shared\/[^/]+\/)?sessions\/[^/]+\/messages(?:\/[^/]+)?$/;
const compressJson = compress({ contentTypeFilter: /^application\/json(?:;|$)/i });

// Compress only successful history reads at the HTTP edge. Do not buffer SSE,
// transform file/range responses, or compress credential/auth responses. The
// in-process Connector transport remains plain JSON, with its existing bounds.
export const historyTransfer: MiddlewareHandler = async (context, next) => {
  if (context.req.method !== 'GET' || !historyPath.test(context.req.path)) return next();
  const startedAt = performance.now();
  await next();
  // Same-origin DevTools can distinguish handler/Connector wait from transfer.
  // This measures response preparation, NOT compression/body streaming or the
  // browser's network path. Never include IDs, text, paths or upstream URLs.
  if (context.res.status === 200 && /^application\/json(?:;|$)/i.test(context.res.headers.get('content-type') ?? '')) {
    const timing = context.res.headers.get('server-timing');
    const historyTiming = `agentopsdeck_history;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)};desc="History handler"`;
    context.header('Server-Timing', timing ? `${timing}, ${historyTiming}` : historyTiming);
  }
  const cacheControl = context.res.headers.get('cache-control');
  if (!cacheControl?.split(',').some(value => value.trim().toLowerCase() === 'no-store')) {
    context.header('Cache-Control', cacheControl ? `${cacheControl}, no-store` : 'no-store');
  }
  const vary = context.res.headers.get('vary')?.split(',').map(value => value.trim()) ?? [];
  if (!vary.some(value => value === '*' || value.toLowerCase() === 'accept-encoding')) {
    context.header('Vary', [...vary, 'Accept-Encoding'].join(', '));
  }
  if (context.res.status === 200) await compressJson(context, async () => {});
};
