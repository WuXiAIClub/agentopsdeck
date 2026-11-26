import { randomUUID } from 'node:crypto';
import { createCommandKey, sessionRuntimeId, MAX_MESSAGE_CHARS, MAX_TEXT_MESSAGE_BODY_BYTES } from '@agentopsdeck/shared';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { reply } from '../commands/http.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { readJsonBody } from '../utils/http-body.js';
import type { AsyncSdkQueue } from './async-sdk-queue.js';
import { runNativeOperation } from './native-operation.js';
import type { SdkAgentId } from './sdk-execution-journal.js';

export type SdkQueueHttp = {
  queue: Pick<AsyncSdkQueue, 'page' | 'commandPage' | 'edit' | 'cancel' | 'readReceipt'>;
  /** Veto only; current worker authority and transaction remain mandatory. */
  ready: (runtime: SdkAgentId) => boolean;
  timeoutMs?: number;
  diagnostics?: PerformanceDiagnostics;
};
type QueueMethod = 'page' | 'commandPage' | 'edit' | 'cancel' | 'readReceipt';
type Evidence = { expectedNode?: string; grantRef?: string };
export type OwnedQueueHttp<R extends string> = Omit<SdkQueueHttp, 'queue' | 'ready'> & {
  queue: { [K in QueueMethod]: (input: Omit<Parameters<AsyncSdkQueue[K]>[0], 'runtime'> & { runtime: R } & Evidence
    & { method?: 'PATCH' | 'DELETE' }) => ReturnType<AsyncSdkQueue[K]> };
  ready(runtime: R): boolean;
  runtime(key: string): R | undefined;
  evidence?(c: Context): Evidence;
  /** Local application composition only; never replaces the original Request. */
  authorization?(c: Context): string;
  requestQueue?(c: Context): OwnedQueueHttp<R>['queue'];
  around?(c: Context, work: () => Promise<Response>): Promise<Response>;
  mutationMethod?: boolean;
  operation: 'sdk-queue-http' | 'hermes-queue-http' | 'native-queue-http';
};
const validKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const unknown = (c: Context, commandKey: string) => c.json({ error: 'Queue outcome unavailable; read the original mutation key, do not resend',
  status: 'outcome_unknown', commandKey }, 503);

/** Owns all SDK queue paths before the old authority/receipts middleware.
 * HTTP timeout never cancels the original owner transaction or resends work. */
export function registerSdkQueueHttp(app: Hono, path: string, deps: SdkQueueHttp): void {
  registerOwnedQueueHttp<SdkAgentId>(app, path, {
    ...deps, ready: runtime => deps.ready(runtime),
    queue: { page: input => deps.queue.page(input), commandPage: input => deps.queue.commandPage(input),
      edit: input => deps.queue.edit(input), cancel: input => deps.queue.cancel(input), readReceipt: input => deps.queue.readReceipt(input) },
    runtime: key => { const runtime = sessionRuntimeId(key); return runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity' ? runtime : undefined; },
    operation: 'sdk-queue-http',
  });
}
export function registerOwnedQueueHttp<R extends string>(app: Hono, path: string, deps: OwnedQueueHttp<R>): void {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite SDK queue deadline required');
  let bodyReaders = 0;
  const scope = (c: Context) => {
    const key = c.req.param('sessionKey')!, runtime = deps.runtime(key);
    return runtime === undefined ? undefined : { key, runtime };
  };
  const authority = (c: Context): string => {
    const authorization = deps.authorization ? deps.authorization(c) : c.req.raw.headers.get('authorization') ?? '';
    if (!authorization.trim()) throw new HTTPException(401);
    if (!deps.evidence && c.req.header('x-agentopsdeck-execution-grant') !== undefined) throw new HTTPException(403);
    return authorization;
  };
  const target = (c: Context) => {
    const commandKey = c.req.param('commandKey');
    if (commandKey !== undefined) {
      if (!validKey(commandKey)) throw new HTTPException(400);
      return { commandKey };
    }
    return { messageId: c.req.param('messageId')! };
  };
  const wait = <T>(c: Context, work: () => Promise<T>) => runNativeOperation(work, { timeoutMs, signal: c.req.raw.signal });
  const errorReply = (c: Context, error: unknown, mutationKey?: string) => error instanceof HTTPException && error.status < 500
    ? c.json({ error: 'Invalid queue request or authority' }, error.status)
    : mutationKey ? unknown(c, mutationKey) : c.json({ error: 'Queue read unavailable' }, 503);
  const owned = (handler: MiddlewareHandler): MiddlewareHandler => async (c, next) => {
    if (!scope(c)) return next();
    if (!deps.around) return handler(c, next);
    return deps.around(c, async () => {
      const response = await handler(c, next);
      return response instanceof Response ? response : c.res;
    });
  };

  for (const commands of [false, true]) app.get(`${path}/queue${commands ? '/commands' : ''}`, owned(async (c, next) => {
    const current = scope(c); if (!current) return next();
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, deps.operation);
    let failed = true;
    try {
      trace.add('step', commands ? 2 : 1);
      const queue = deps.requestQueue?.(c) ?? deps.queue;
      const authorization = authority(c), cursor = c.req.query('cursor') ?? '0';
      if (!/^\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) return c.json({ error: 'invalid queue cursor' }, 400);
      const input = { ...current, authorization, ...deps.evidence?.(c), after: Number(cursor) };
      const result = commands ? await wait(c, () => queue.commandPage(input)) : await wait(c, () => queue.page(input));
      if ('error' in result) return c.json({ error: 'Queue authority unavailable' }, result.error);
      failed = false; return c.json(result.page);
    } catch (error) { return errorReply(c, error); }
    finally { trace.finish(failed); }
  }));
  app.on('GET', [`${path}/queue/:messageId/commands/:mutationKey`, `${path}/commands/:commandKey/queue/commands/:mutationKey`], owned(async (c, next) => {
    const current = scope(c); if (!current) return next();
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, deps.operation);
    let failed = true;
    try {
      trace.add('step', 3);
      const queue = deps.requestQueue?.(c) ?? deps.queue;
      const authorization = authority(c), mutationKey = c.req.param('mutationKey')!;
      if (!validKey(mutationKey)) return c.json({ error: 'invalid mutation key' }, 400);
      const result = await wait(c, () => queue.readReceipt({ ...current, authorization, ...deps.evidence?.(c), target: target(c), mutationKey }));
      if ('error' in result) return c.json({ error: 'Queue receipt authority unavailable' }, result.error);
      if (!result.receipt) return c.json({ error: 'Queue mutation not found' }, 404);
      failed = false; return c.json({ command: result.receipt });
    } catch (error) { return errorReply(c, error); }
    finally { trace.finish(failed); }
  }));
  for (const method of ['PATCH', 'DELETE'] as const) app.on(method, [`${path}/queue/:messageId`, `${path}/commands/:commandKey/queue`], owned(async (c, next) => {
    const current = scope(c); if (!current) return next();
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, deps.operation);
    let failed = true, reading = false, mutationKey = createCommandKey(randomUUID());
    try {
      trace.add('step', method === 'PATCH' ? 4 : 5);
      const queue = deps.requestQueue?.(c) ?? deps.queue;
      const authorization = authority(c), addressed = target(c), header = c.req.header('idempotency-key');
      if ('commandKey' in addressed && header === undefined) return c.json({ error: 'Queue mutation key is required' }, 400);
      if (header !== undefined && !validKey(header)) return c.json({ error: 'Invalid mutation key' }, 400);
      mutationKey = header ?? mutationKey;
      c.header('X-AgentOpsDeck-Command-Key', mutationKey);
      const match = c.req.header('if-match');
      if (match === undefined) return c.json({ error: 'queue version is required' }, 428);
      if (!/^"[1-9]\d{0,15}:[1-9]\d{0,15}"$/.test(match)) return c.json({ error: 'invalid queue version' }, 400);
      const input = { ...current, authorization, ...deps.evidence?.(c), target: addressed, mutationKey };
      const mutationAuthority = deps.mutationMethod ? { method } : {};
      // Worker validates original authority before body buffering. This is a
      // read, not a claim: it cannot authorize the subsequent mutation.
      const probe = await wait(c, () => queue.readReceipt({ ...input, ...mutationAuthority, purpose: 'mutation' }));
      if ('error' in probe) return c.json({ error: 'Queue authority unavailable' }, probe.error);
      let text = '';
      if (method === 'PATCH') {
        if (bodyReaders >= 2) return c.json({ error: 'Queue input capacity reached' }, 503);
        bodyReaders++; reading = true;
        const body = await readJsonBody(c.req.raw, MAX_TEXT_MESSAGE_BODY_BYTES, timeoutMs) as { message?: unknown } | null;
        if (!body || typeof body.message !== 'string' || !body.message.trim() || body.message.length > MAX_MESSAGE_CHARS)
          return c.json({ error: `message must contain 1–${MAX_MESSAGE_CHARS} characters` }, 400);
        text = body.message.trim();
      }
      const write = { ...input, version: match.slice(1, -1),
        ...(method === 'PATCH' && deps.ready(current.runtime) !== true ? { rejectFresh: 'runtime_unavailable' as const } : {}) };
      const result = await wait(c, () => method === 'PATCH' ? queue.edit({ ...write, text }) : queue.cancel(write));
      if ('error' in result) return c.json({ error: 'Queue admission unavailable' }, result.error);
      trace.add('step', 6);
      const saved = await wait(c, () => queue.readReceipt({ ...input, ...mutationAuthority, purpose: 'mutation' }));
      if ('error' in saved) return c.json({ error: 'Queue receipt authority unavailable' }, saved.error);
      if (!saved.receipt) return unknown(c, mutationKey);
      if (saved.receipt.id !== result.receipt.id || saved.targetId !== result.targetId) return c.json({ error: 'Queue authority changed' }, 403);
      failed = false;
      return header === undefined && saved.receipt.result
        ? c.json(saved.receipt.result.body, saved.receipt.result.status as 200) : reply(c, saved.receipt);
    } catch (error) { return errorReply(c, error, mutationKey); }
    finally { if (reading) bodyReaders--; trace.finish(failed); }
  }));
}
