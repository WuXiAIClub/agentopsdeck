import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { sessionRuntimeId, type SessionFilePage, type SessionFileRebuild } from '@agentopsdeck/shared';
import { readJsonBody } from '../utils/http-body.js';
import { ReadRequestError } from '../lifecycle/read-request-owner.js';

export type SdkFilesHttp = Pick<OwnedFilesHttp<'claude-code' | 'ghcp' | 'antigravity'>, 'files' | 'timeoutMs' | 'authorization' | 'around' | 'requestFiles'>;
type Scope<R> = { runtime: R; key: string; authorization: string };
type Result<T> = { error: 401 | 403 | 404 | 409 | 429 } | { body: T };
export type OwnedFilesHttp<R extends 'codex' | 'claude-code' | 'ghcp' | 'antigravity'> = {
  timeoutMs?: number;
  authorization?(c: Context): string;
  around?(c: Context, work: () => Promise<Response>): Promise<Response>;
  requestFiles?(c: Context): OwnedFilesHttp<R>['files'];
  select(key: string): R | undefined;
  files: {
    page(input: Scope<R> & { cursor?: string }, request: Request): Promise<Result<SessionFilePage>>;
    start(input: Scope<R>, request: Request): Promise<Result<SessionFileRebuild>>;
    step(input: Scope<R> & { jobId: string; step: number }, request: Request): Promise<Result<SessionFileRebuild>>;
    cancel(input: Scope<R> & { jobId: string }, request: Request): Promise<Result<SessionFileRebuild>>;
  };
};
/** Wire only; selecting a runtime does not expand the worker authority. */
export function registerSdkFilesHttp(app: Hono, base: string, deps: SdkFilesHttp) {
  return registerOwnedFilesHttp(app, base, { ...deps, select(key) {
    const runtime = sessionRuntimeId(key); return runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity' ? runtime : undefined;
  } });
}
export function registerOwnedFilesHttp<R extends 'codex' | 'claude-code' | 'ghcp' | 'antigravity'>(app: Hono, base: string, deps: OwnedFilesHttp<R>) {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite files HTTP deadline required');
  let readers = 0;
  for (const [method, suffix, kind] of [
    ['GET', '', 'page'], ['POST', '/rebuild', 'start'], ['POST', '/rebuild/:jobId', 'step'], ['DELETE', '/rebuild/:jobId', 'cancel'],
  ] as const) app.on(method, `${base}/files${suffix}`, async (c, next) => {
    const key = c.req.param('sessionKey')!, runtime = deps.select(key);
    if (runtime === undefined) return next();
    const work = async (): Promise<Response> => {
    c.header('Cache-Control', 'no-store');
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'File index requires owner authority' }, 403);
    const authorization = deps.authorization ? deps.authorization(c) : c.req.header('authorization') ?? '';
    if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    let reading = false;
    try {
      const scope = { runtime, key, authorization }, request = c.req.raw;
      const files = deps.requestFiles ? deps.requestFiles(c) : deps.files;
      let result;
      if (kind === 'page') {
        const cursor = c.req.query('cursor');
        if (cursor !== undefined && (!cursor.length || cursor.length > 1024 || /[\u0000-\u001f\u007f]/.test(cursor))) return c.json({ error: 'Invalid file cursor' }, 400);
        result = await files.page({ ...scope, ...(cursor === undefined ? {} : { cursor }) }, request);
      } else if (kind === 'start') result = await files.start(scope, request);
      else {
        const jobId = c.req.param('jobId')!;
        if (!/^[a-f0-9-]{36}$/.test(jobId)) return c.json({ error: 'Invalid file rebuild ID' }, 400);
        if (kind === 'cancel') result = await files.cancel({ ...scope, jobId }, request);
        else {
          if (readers >= 2) return c.json({ error: 'File rebuild input capacity reached' }, 503);
          readers++; reading = true;
          const raw = await readJsonBody(request, 256, timeoutMs) as { step?: unknown } | null;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Number.isSafeInteger(raw.step)
            || Number(raw.step) < 0 || Number(raw.step) > 10_000) return c.json({ error: 'Invalid file rebuild step' }, 400);
          result = await files.step({ ...scope, jobId, step: raw.step as number }, request);
        }
      }
      if ('error' in result) return c.json({ error: 'File index unavailable' }, result.error);
      return c.json(result.body);
    } catch (error) {
      if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
      if (error instanceof ReadRequestError) return c.json({ error: 'File index unavailable' }, error.status);
      return c.json({ error: 'File index unavailable' }, 503);
    } finally { if (reading) readers--; }
    };
    return deps.around ? deps.around(c, work) : work();
  });
}
