import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type ToolImageCompatibilityOptions = { provider: string; upstreamBaseUrl: string };

export function toolImageCompatibilityArguments(options: ToolImageCompatibilityOptions, baseUrl: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(options.provider)) throw new Error('Invalid tool image compatibility provider');
  return ['-c', `model_providers.${options.provider}.base_url=${JSON.stringify(baseUrl)}`];
}

export function rewriteGeminiToolImages(body: unknown): unknown {
  if (!record(body) || body.model !== 'gemini-4-carbon' || !Array.isArray(body.input)) return body;
  const calls = new Map<string, RecordValue>();
  const duplicates = new Set<string>();
  const outputs = new Set<string>();
  for (const item of body.input) {
    if (!record(item) || typeof item.call_id !== 'string') continue;
    if (item.type === 'function_call') {
      if (calls.has(item.call_id)) duplicates.add(item.call_id);
      calls.set(item.call_id, item);
    } else if (item.type === 'function_call_output') {
      if (outputs.has(item.call_id)) duplicates.add(item.call_id);
      outputs.add(item.call_id);
    }
  }
  const input: unknown[] = [];
  let images: RecordValue[] = [];
  let changed = false;
  const precedingCalls = new Set<string>();
  const flush = () => { input.push(...images); images = []; };
  for (const item of body.input) {
    if (!record(item) || item.type !== 'function_call_output') flush();
    if (record(item) && item.type === 'function_call' && typeof item.call_id === 'string') precedingCalls.add(item.call_id);
    const call = record(item) && typeof item.call_id === 'string' ? calls.get(item.call_id) : undefined;
    if (!record(item) || item.type !== 'function_call_output' || call?.name !== 'view_image'
      || typeof item.call_id !== 'string' || !precedingCalls.has(item.call_id) || duplicates.has(item.call_id) || !Array.isArray(item.output)
      || !item.output.some(part => record(part) && part.type === 'input_image')
      || !item.output.every(part => record(part) && (
        (part.type === 'input_text' && typeof part.text === 'string')
        || (part.type === 'input_image' && typeof part.image_url === 'string' && part.image_url.length > 0)))) {
      input.push(item);
      continue;
    }
    const parts = item.output as RecordValue[];
    const content = parts.filter(part => part.type === 'input_image');
    input.push({ ...item, output: parts.map(part => part.type === 'input_image'
      ? { type: 'input_text', text: 'Image included in the following user message for this tool call.' } : part) });
    images.push({ type: 'message', role: 'user', content: [
      { type: 'input_text', text: `Images returned by view_image tool call ${item.call_id}, in original order:` }, ...content,
    ] });
    changed = true;
  }
  flush();
  return changed ? { ...body, input } : body;
}

function forwardingHeaders(headers: IncomingHttpHeaders) {
  const blocked = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade']);
  for (const name of (headers.connection ?? '').split(',')) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !blocked.has(name)));
}

export async function createToolImageCompatibilityRelay(options: ToolImageCompatibilityOptions,
  limits = { bodyBytes: 32 * 1024 * 1024, concurrent: 2, timeoutMs: 10 * 60_000 }) {
  toolImageCompatibilityArguments(options, 'http://127.0.0.1');
  if (!Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0) || limits.timeoutMs > 2_147_483_647) {
    throw new Error('Invalid tool image compatibility limits');
  }
  let upstream: URL;
  try { upstream = new URL(options.upstreamBaseUrl); } catch { throw new Error('Invalid tool image compatibility upstream'); }
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('Invalid tool image compatibility upstream');
  }
  const prefix = `/${randomBytes(24).toString('hex')}`;
  const active = new Set<() => void>();
  let closed = false;
  const server = createServer(async (incoming, outgoing) => {
    const route = incoming.url?.slice(prefix.length);
    if (closed || !incoming.url?.startsWith(`${prefix}/`) || !(
      (incoming.method === 'POST' && (route === '/responses' || route === '/responses/compact'))
      || (incoming.method === 'GET' && route === '/models'))) {
      outgoing.writeHead(404).end(); return;
    }
    if (active.size >= limits.concurrent) { outgoing.writeHead(503).end(); return; }
    let cancelUpstream: (() => void) | undefined;
    const cancel = () => { cancelUpstream?.(); incoming.destroy(); outgoing.destroy(); };
    active.add(cancel);
    const timer = setTimeout(cancel, limits.timeoutMs); timer.unref();
    incoming.once('aborted', cancel);
    outgoing.once('close', () => { cancelUpstream?.(); clearTimeout(timer); active.delete(cancel); });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > limits.bodyBytes) { outgoing.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      let payload = Buffer.concat(chunks);
      if (incoming.method === 'POST') {
        if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') {
          outgoing.writeHead(415).end(); return;
        }
        let original: unknown;
        try { original = JSON.parse(payload.toString('utf8')); } catch { outgoing.writeHead(400).end(); return; }
        const rewritten = route === '/responses' ? rewriteGeminiToolImages(original) : original;
        if (rewritten !== original) payload = Buffer.from(JSON.stringify(rewritten));
        if (payload.length > limits.bodyBytes) { outgoing.writeHead(413).end(); return; }
      }
      if (closed || outgoing.destroyed) return;
      const target = new URL(upstream.href);
      target.pathname = upstream.pathname.replace(/\/$/, '') + route;
      const headers = forwardingHeaders(incoming.headers);
      delete headers['content-length'];
      if (incoming.method === 'POST') headers['content-length'] = String(payload.length);
      const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method: incoming.method, headers,
      }, response => {
        response.on('error', () => outgoing.destroy());
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
          response.resume(); outgoing.writeHead(502).end(); return;
        }
        outgoing.writeHead(response.statusCode ?? 502, forwardingHeaders(response.headers));
        response.pipe(outgoing);
      });
      cancelUpstream = () => request.destroy();
      request.on('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502).end(); else outgoing.destroy();
      });
      request.end(payload);
    } catch {
      if (!outgoing.destroyed) {
        if (!outgoing.headersSent) outgoing.writeHead(502).end(); else outgoing.destroy();
      }
    }
  });
  server.requestTimeout = limits.timeoutMs;
  server.headersTimeout = Math.min(limits.timeoutMs, 60_000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Tool image compatibility listener unavailable');
  let closing: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}${prefix}`,
    close() {
      if (!closing) {
        closed = true;
        for (const cancel of active) cancel();
        closing = new Promise<void>(resolve => server.close(() => resolve()));
        server.closeAllConnections();
      }
      return closing;
    },
  };
}
