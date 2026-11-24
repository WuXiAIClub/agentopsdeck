import { Readable, pipeline } from 'node:stream';
import { constants, createGzip } from 'node:zlib';
import type { MiddlewareHandler } from 'hono';

/** Flush each NDJSON write: a fast session must not wait for a slow peer just
 * because compression is enabled. Pipeline propagates downstream cancellation
 * back to the source, including the route's Connector abort controller. */
export const workspaceSyncTransfer: MiddlewareHandler = async (c, next) => {
  await next();
  const response = c.res;
  if (response.status !== 200 || !response.body || response.headers.has('content-encoding')
    || !response.headers.get('content-type')?.startsWith('application/x-ndjson')
    || /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '')) return;
  const vary = response.headers.get('vary')?.split(',').map(value => value.trim()) ?? [];
  if (!vary.some(value => value === '*' || value.toLowerCase() === 'accept-encoding')) c.header('Vary', [...vary, 'Accept-Encoding'].join(', '));
  const acceptsGzip = (c.req.header('accept-encoding') ?? '').split(',').some(part => {
    const [name, ...parameters] = part.trim().toLowerCase().split(';');
    if (name !== 'gzip') return false;
    const quality = parameters.map(value => value.trim()).find(value => value.startsWith('q='));
    return quality === undefined || (Number(quality.slice(2)) > 0 && Number(quality.slice(2)) <= 1);
  });
  if (!acceptsGzip) return;
  const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
  const gzip = createGzip({ flush: constants.Z_SYNC_FLUSH });
  pipeline(source, gzip, () => { /* Errors propagate through the output stream. */ });
  c.res = new Response(Readable.toWeb(gzip, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } }) as ReadableStream<Uint8Array>, response);
  c.res.headers.set('content-encoding', 'gzip'); c.res.headers.delete('content-length');
};
