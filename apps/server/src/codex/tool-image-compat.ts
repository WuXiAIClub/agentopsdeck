import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type ToolImageCompatibilityOptions = {
  provider: string;
  upstreamBaseUrl: string;
  retryStaleConnectionItems?: boolean | undefined;
};

const STALE_CONNECTION_ITEM_ERROR = /input item(?: ID)? does not belong to this connection|"code"\s*:\s*"invalid_request_body"|\(code=invalid_request_body\)/i;
const MAX_RETRY_INSPECTION_BYTES = 64 * 1024;
const GEMINI_TOOL_IMAGE_MODELS = new Set(['gemini-4-carbon', 'gemini-4-neon']);

function normalizeSchemaRecordMap(value: RecordValue): RecordValue {
  let changed = false;
  const next: RecordValue = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeToolJsonSchema(entry, false);
    if (normalized !== entry) changed = true;
    next[key] = normalized;
  }
  return changed ? next : value;
}

function normalizeSchemaList(list: unknown[]): unknown[] {
  let changed = false;
  const next = list.map(entry => {
    const normalized = normalizeToolJsonSchema(entry, false);
    if (normalized !== entry) changed = true;
    return normalized;
  });
  return changed ? next : list;
}

function tupleItemsToSchema(list: unknown[]): RecordValue {
  const normalized = normalizeSchemaList(list);
  if (normalized.length === 0) return {};
  if (normalized.length === 1 && record(normalized[0])) return normalized[0];
  return { anyOf: normalized };
}

export function normalizeToolJsonSchema(schema: unknown, isRoot = true): unknown {
  if (!record(schema)) return schema;
  let changed = false;
  const copy: RecordValue = { ...schema };

  for (const mapKey of ['properties', '$defs', 'definitions', 'patternProperties'] as const) {
    const rawMap = schema[mapKey];
    if (record(rawMap)) {
      const nextMap = normalizeSchemaRecordMap(rawMap);
      if (nextMap !== rawMap) {
        copy[mapKey] = nextMap;
        changed = true;
      }
    }
  }

  for (const listKey of ['anyOf', 'oneOf', 'allOf'] as const) {
    const rawList = schema[listKey];
    if (Array.isArray(rawList)) {
      const nextList = normalizeSchemaList(rawList);
      if (nextList !== rawList) {
        copy[listKey] = nextList;
        changed = true;
      }
    }
  }

  for (const subKey of ['additionalProperties', 'not'] as const) {
    const rawSub = schema[subKey];
    if (record(rawSub)) {
      const nextSub = normalizeToolJsonSchema(rawSub, false);
      if (nextSub !== rawSub) {
        copy[subKey] = nextSub;
        changed = true;
      }
    }
  }

  if (Array.isArray(schema.items)) {
    copy.items = tupleItemsToSchema(schema.items);
    changed = true;
  } else if (record(schema.items)) {
    const nextItems = normalizeToolJsonSchema(schema.items, false);
    if (nextItems !== schema.items) {
      copy.items = nextItems;
      changed = true;
    }
  }

  if (Array.isArray(schema.prefixItems)) {
    if (!record(copy.items)) {
      copy.items = tupleItemsToSchema(schema.prefixItems);
    }
    delete copy.prefixItems;
    changed = true;
  }

  const isArrayType = schema.type === 'array'
    || (Array.isArray(schema.type) && schema.type.includes('array'));
  if (isArrayType && !record(copy.items)) {
    copy.items = {};
    changed = true;
  }

  if (isRoot && schema.type === 'object' && !record(copy.properties)) {
    copy.properties = {};
    changed = true;
  }

  if (record(copy.properties) && Array.isArray(copy.anyOf)
    && copy.anyOf.some(branch => record(branch) && branch.type === 'object')) {
    const outerProperties = copy.properties;
    const hasOuterRequired = Array.isArray(copy.required);
    const outerRequired = copy.required;
    const hasOuterAdditional = 'additionalProperties' in copy;
    const outerAdditional = copy.additionalProperties;
    copy.anyOf = copy.anyOf.map(branch => {
      if (!record(branch) || branch.type !== 'object') return branch;
      const mergedProps = record(branch.properties)
        ? { ...branch.properties, ...outerProperties }
        : outerProperties;
      const nextBranch: RecordValue = { ...branch, properties: mergedProps };
      if (hasOuterRequired && !Array.isArray(branch.required)) nextBranch.required = outerRequired;
      if (hasOuterAdditional) nextBranch.additionalProperties = outerAdditional;
      return nextBranch;
    });
    delete copy.properties;
    delete copy.required;
    delete copy.additionalProperties;
    delete copy.type;
    changed = true;
  }

  return changed ? copy : schema;
}

function normalizeToolEntry(tool: unknown): unknown {
  if (!record(tool)) return tool;
  if (tool.type === 'function' && record(tool.parameters)) {
    const parameters = normalizeToolJsonSchema(tool.parameters, true);
    return parameters === tool.parameters ? tool : { ...tool, parameters };
  }
  if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
    let changed = false;
    const tools = tool.tools.map(subTool => {
      const normalized = normalizeToolEntry(subTool);
      if (normalized !== subTool) changed = true;
      return normalized;
    });
    return changed ? { ...tool, tools } : tool;
  }
  return tool;
}

export function normalizeResponsesTools(body: unknown): unknown {
  if (!record(body) || !Array.isArray(body.tools)) return body;
  let changed = false;
  const tools = body.tools.map(tool => {
    const normalized = normalizeToolEntry(tool);
    if (normalized !== tool) changed = true;
    return normalized;
  });
  return changed ? { ...body, tools } : body;
}

export function normalizeResponsesInput(body: unknown): unknown {
  if (!record(body) || !Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.map(item => {
    if (!record(item) || item.type !== 'function_call_output') return item;
    const hasCallId = typeof item.call_id === 'string' && item.call_id.length > 0;
    const hasExtraField = 'name' in item || 'namespace' in item;
    if (hasCallId && !hasExtraField) return item;
    changed = true;
    if (!hasCallId) {
      const label = typeof item.name === 'string' && item.name ? `[${item.name}]\n` : '';
      const text = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      return {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: `${label}${text}` }],
      };
    }
    const copy: RecordValue = { ...item };
    delete copy.name;
    delete copy.namespace;
    return copy;
  });
  return changed ? { ...body, input } : body;
}

export function toolImageCompatibilityArguments(options: ToolImageCompatibilityOptions, baseUrl: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(options.provider)) throw new Error('Invalid tool image compatibility provider');
  return ['-c', `model_providers.${options.provider}.base_url=${JSON.stringify(baseUrl)}`];
}

export function stripStaleConnectionItems(body: unknown): unknown {
  if (!record(body) || !Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.map(item => {
    if (!record(item)) return item;
    const stripId = 'id' in item;
    const stripEncrypted = item.type === 'reasoning' && 'encrypted_content' in item;
    if (!stripId && !stripEncrypted) return item;
    changed = true;
    const copy: RecordValue = { ...item };
    delete copy.id;
    if (stripEncrypted) delete copy.encrypted_content;
    return copy;
  });
  return changed ? { ...body, input } : body;
}

export function rewriteGeminiToolImages(body: unknown): unknown {
  if (!record(body) || typeof body.model !== 'string' || !GEMINI_TOOL_IMAGE_MODELS.has(body.model) || !Array.isArray(body.input)) return body;
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
  limits = { bodyBytes: 32 * 1024 * 1024, concurrent: 8, timeoutMs: 10 * 60_000 }) {
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
      let rewritten: unknown;
      if (incoming.method === 'POST') {
        if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') {
          outgoing.writeHead(415).end(); return;
        }
        let original: unknown;
        try { original = JSON.parse(payload.toString('utf8')); } catch { outgoing.writeHead(400).end(); return; }
        const normalized = normalizeResponsesTools(normalizeResponsesInput(original));
        rewritten = route === '/responses' ? rewriteGeminiToolImages(normalized) : normalized;
        if (rewritten !== original) payload = Buffer.from(JSON.stringify(rewritten));
        if (payload.length > limits.bodyBytes) { outgoing.writeHead(413).end(); return; }
      }
      if (closed || outgoing.destroyed) return;
      const target = new URL(upstream.href);
      target.pathname = upstream.pathname.replace(/\/$/, '') + route;
      const baseHeaders = forwardingHeaders(incoming.headers);
      delete baseHeaders['content-length'];
      const sendUpstream = (bodyBuffer: Buffer, allowStaleRetry: boolean) => {
        if (closed || outgoing.destroyed) return;
        const headers = { ...baseHeaders };
        if (incoming.method === 'POST') headers['content-length'] = String(bodyBuffer.length);
        const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
          method: incoming.method, headers,
        }, response => {
          response.on('error', () => outgoing.destroy());
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
            response.resume(); outgoing.writeHead(502).end(); return;
          }
          if (allowStaleRetry && response.statusCode === 400) {
            const errorChunks: Buffer[] = [];
            let errorBytes = 0;
            let overflowed = false;
            const flushErrorResponse = (pipeRemainder: boolean) => {
              if (closed || outgoing.destroyed) { response.resume(); return; }
              outgoing.writeHead(400, forwardingHeaders(response.headers));
              for (const part of errorChunks) outgoing.write(part);
              if (pipeRemainder) response.pipe(outgoing); else outgoing.end();
            };
            const onData = (chunk: Buffer | string) => {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              errorBytes += buf.length;
              errorChunks.push(buf);
              if (errorBytes > MAX_RETRY_INSPECTION_BYTES) {
                overflowed = true;
                response.off('data', onData);
                response.off('end', onEnd);
                flushErrorResponse(true);
              }
            };
            const onEnd = () => {
              if (overflowed || closed || outgoing.destroyed) return;
              const text = Buffer.concat(errorChunks).toString('utf8');
              if (STALE_CONNECTION_ITEM_ERROR.test(text)) {
                const stripped = stripStaleConnectionItems(rewritten);
                if (stripped !== rewritten) {
                  const retryPayload = Buffer.from(JSON.stringify(stripped));
                  if (retryPayload.length <= limits.bodyBytes) {
                    sendUpstream(retryPayload, false);
                    return;
                  }
                }
              }
              flushErrorResponse(false);
            };
            response.on('data', onData);
            response.once('end', onEnd);
            return;
          }
          outgoing.writeHead(response.statusCode ?? 502, forwardingHeaders(response.headers));
          response.pipe(outgoing);
        });
        cancelUpstream = () => request.destroy();
        request.on('error', () => {
          if (!outgoing.headersSent) outgoing.writeHead(502).end(); else outgoing.destroy();
        });
        request.end(bodyBuffer);
      };
      sendUpstream(payload, Boolean(options.retryStaleConnectionItems) && incoming.method === 'POST');
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
