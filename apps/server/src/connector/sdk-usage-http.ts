import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { sessionRuntimeId, tokenUsageRange, tokenSnapshotRequestId, tokenSnapshotSelection } from '@agentopsdeck/shared';
import { readJsonBody } from '../utils/http-body.js';
import { ReadRequestError } from '../lifecycle/read-request-owner.js';
import type { NativeTokenUsage, NativeTokenUsageExport, NativeTokenSnapshot } from '@agentopsdeck/shared';

export type SdkUsageHttp = Pick<OwnedUsageHttp<'claude-code' | 'ghcp' | 'antigravity'>, 'usage' | 'timeoutMs' | 'authorization' | 'around' | 'requestUsage'>;
type UsageResult = { error: 401 | 403 | 404 | 409 | 413 | 503; code?: 'token_export_limit' }
  | { body: NativeTokenUsage | NativeTokenUsageExport | NativeTokenSnapshot };
type Range = { from: number; to: number; bucketMs: number };
type Scope<R> = { runtime: R; key: string; authorization: string };
export type OwnedUsageHttp<R extends 'codex' | 'claude-code' | 'ghcp' | 'antigravity'> = {
  timeoutMs?: number;
  authorization?(c: Context): string;
  around?(c: Context, work: () => Promise<Response>): Promise<Response>;
  requestUsage?(c: Context): OwnedUsageHttp<R>['usage'];
  select(key: string): R | undefined;
  usage: {
    range(input: Scope<R> & Range, request: Request): Promise<UsageResult>;
    export(input: Scope<R> & Range, request: Request): Promise<UsageResult>;
    createSnapshot(input: Scope<R> & Range & { requestId: string }, request: Request): Promise<UsageResult>;
    readSnapshot(input: Scope<R> & { requestId: string }, request: Request): Promise<UsageResult>;
  };
};
/** Wire parsing only. Runtime selection never changes worker command authority. */
export function registerSdkUsageHttp(app: Hono, base: string, deps: SdkUsageHttp) {
  return registerOwnedUsageHttp(app, base, { ...deps, select(key) {
    const runtime = sessionRuntimeId(key); return runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity' ? runtime : undefined;
  } });
}
export function registerOwnedUsageHttp<R extends 'codex' | 'claude-code' | 'ghcp' | 'antigravity'>(app: Hono, base: string, deps: OwnedUsageHttp<R>) {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite usage HTTP deadline required');
  let readers = 0;
  for (const [method, suffix, kind] of [
    ['GET', '', 'range'], ['GET', '/export', 'export'], ['POST', '/snapshots', 'createSnapshot'], ['GET', '/snapshots/:requestId', 'readSnapshot'],
  ] as const) app.on(method, `${base}/token-usage${suffix}`, async (c, next) => {
    const key = c.req.param('sessionKey')!, runtime = deps.select(key);
    if (runtime === undefined) return next();
    const work = async (): Promise<Response> => {
    c.header('Cache-Control', 'no-store');
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'Token usage requires owner authority' }, 403);
    let reading = false;
    try {
      const authorization = deps.authorization ? deps.authorization(c) : c.req.header('authorization') ?? '';
      if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
      const usage = deps.requestUsage?.(c) ?? deps.usage;
      const scope = { runtime, key, authorization }, request = c.req.raw;
      let result;
      if (kind === 'createSnapshot') {
        if (readers >= 2) return c.json({ error: 'Token snapshot input capacity reached' }, 503);
        readers++; reading = true;
        const raw = await readJsonBody(request, 1024, timeoutMs);
        let selection;
        try { selection = tokenSnapshotSelection(raw); }
        catch { return c.json({ error: 'Invalid token snapshot selection' }, 400); }
        result = await usage.createSnapshot({ ...scope, ...selection }, request);
      } else if (kind === 'readSnapshot') {
        let requestId;
        try { requestId = tokenSnapshotRequestId(c.req.param('requestId')); }
        catch { return c.json({ error: 'Invalid token snapshot request ID' }, 400); }
        result = await usage.readSnapshot({ ...scope, requestId }, request);
      } else {
        let range;
        try { range = tokenUsageRange(c.req.query('from'), c.req.query('to'), c.req.query('bucketMs')); }
        catch { return c.json({ error: 'Invalid token usage range' }, 400); }
        result = await usage[kind]({ ...scope, ...range }, request);
      }
      if ('error' in result) return c.json({ error: result.error === 409 ? 'Snapshot selection or reader conflict'
        : result.error === 404 ? 'session or snapshot not found' : result.error === 413 ? kind === 'export' ? 'Shorten the token export period' : 'Token snapshot capacity exceeded'
          : result.error === 503 ? 'Token snapshot admission unavailable' : 'Owner authority unavailable', ...('code' in result ? { code: result.code } : {}) }, result.error);
      return c.json(result.body);
    } catch (error) {
      if (error instanceof ReadRequestError) return c.json({ error: 'Token usage read interrupted or unavailable' }, error.status);
      if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
      return c.json({ error: 'Token usage unavailable; recover snapshots with the original request ID' }, 503);
    } finally { if (reading) readers--; }
    };
    return deps.around ? deps.around(c, work) : work();
  });
}
