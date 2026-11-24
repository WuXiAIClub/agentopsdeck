import { constants, createReadStream, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { guardedBody } from '../connector/guarded-body.js';
import { connectorAuthorization } from '../hub/connector-authorization.js';

/** Shared byte transport only. Callers must resolve and authorize the file;
 * this helper never accepts a browser-supplied filesystem path.
 */
type FileResponseOptions = {
  filePath: string; name: string; mimeType: string; size: number; request: Request; authorize?: (signal: AbortSignal) => void | Promise<void>;
  openStream?: (start: number, end: number) => Readable;
};

// Resolve/check the allowed path before calling. Keep the opened inode through
// delivery, reject symlink substitution and close it even for HEAD/416/errors.
export async function verifiedFileResponse(params: FileResponseOptions & { info: Stats }) {
  await authorizeFile(params);
  const handle = await open(params.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let streaming = false;
  try {
    const info = await handle.stat();
    if (!info.isFile() || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => info[key as keyof Stats] !== params.info[key as keyof Stats]) || info.size !== params.size) throw new Error('File changed before opening');
    return await asyncFileResponse({ ...params, openStream: (start, end) => {
      const stream = handle.createReadStream({ start, end, autoClose: true });
      streaming = true;
      return stream;
    } });
  } finally { if (!streaming) await handle.close(); }
}

export function fileResponse(params: FileResponseOptions) {
  params.request.signal.throwIfAborted();
  const result = params.authorize?.(params.request.signal);
  // TS permits async functions at old void callback sites. Do not silently
  // serve bytes before that Promise settles; preserve the synchronous API and
  // direct async callers to the awaited interface. Observe any late rejection.
  if (result != null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
    Promise.resolve(result).catch(() => {});
    throw new Error('Asynchronous file authorization requires asyncFileResponse');
  }
  params.request.signal.throwIfAborted();
  return buildFileResponse(params);
}

async function authorizeFile(params: FileResponseOptions, lifetime?: AbortSignal) {
  params.request.signal.throwIfAborted();
  lifetime?.throwIfAborted();
  if (params.authorize) {
    const deadline = new AbortController();
    const signal = AbortSignal.any([params.request.signal, deadline.signal, ...(lifetime ? [lifetime] : [])]);
    const timer = setTimeout(() => deadline.abort(new Error('File authorization deadline exceeded')), 45_000);
    timer.unref?.();
    try { await connectorAuthorization(() => params.authorize!(signal), signal); }
    finally { clearTimeout(timer); }
  }
  params.request.signal.throwIfAborted();
  lifetime?.throwIfAborted();
}

export async function asyncFileResponse(params: FileResponseOptions) {
  await authorizeFile(params);
  return buildFileResponse(params);
}

function buildFileResponse(params: FileResponseOptions) {
  if (!Number.isSafeInteger(params.size) || params.size < 0) throw new Error('Invalid file size');
  const headers = new Headers({ 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-type': params.mimeType, 'content-disposition': disposition(params.name, /^(image|video)\//.test(params.mimeType)) });
  // Without an ETag/Last-Modified validator, If-Range cannot be proven equal.
  const rawRange = params.request.headers.has('if-range') ? null : params.request.headers.get('range');
  const range = rawRange === null ? undefined : parseRange(rawRange, params.size);
  if (range === null) {
    headers.set('content-range', `bytes */${params.size}`); headers.set('content-length', '0');
    return new Response(null, { status: 416, headers });
  }
  const start = range?.start ?? 0, end = range?.end ?? params.size - 1, length = end - start + 1;
  headers.set('content-length', String(length));
  if (range) headers.set('content-range', `bytes ${start}-${end}/${params.size}`);
  const status = range ? 206 : 200;
  if (params.request.method === 'HEAD' || !length) return new Response(params.request.method === 'HEAD' ? null : new Uint8Array(), { status, headers });
  // A fixed end also bounds files that grow after stat. One chunk of source
  // prefetch; downstream cancel/abort and every pull share the same auth gate.
  const source = Readable.toWeb(params.openStream?.(start, end) ?? createReadStream(params.filePath, { start, end }), { strategy: { highWaterMark: 1 } }) as ReadableStream<Uint8Array>;
  return new Response(guardedBody(source, { signal: params.request.signal, authorize: signal => authorizeFile(params, signal), maxBytes: length, expectedBytes: length }), { status, headers });
}

function parseRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || !size) return null;
  const first = Number(match[1]), last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  const start = match[1] ? first : Math.max(0, size - last), end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
  return start < 0 || start >= size || end < start || (!match[1] && last <= 0) ? null : { start, end };
}

function disposition(name: string, inline: boolean) {
  const clean = name.replace(/["\\\r\n]/g, ''), fallback = clean.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_') || 'download';
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"${clean === fallback ? '' : `; filename*=UTF-8''${encodeURIComponent(clean)}`}`;
}
