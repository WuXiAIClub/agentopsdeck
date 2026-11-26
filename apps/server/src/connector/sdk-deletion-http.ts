import { randomUUID } from 'node:crypto';
import { createCommandKey, sessionRuntimeId, type CommandReceipt } from '@agentopsdeck/shared';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { reply } from '../commands/http.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { ConnectorSdkLifecycleCommands } from './connector-sdk-lifecycle-domain.js';
import { runNativeOperation } from './native-operation.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';

export type SdkDeletionHttp = {
  owner: Pick<AsyncConnectorOwner, 'command'>;
  /** Original owned runtime only: no replacement owner, native retry or fallback. */
  remove: (runtime: SdkAgentId, key: string, commandKey: string, authorization: string, signal: AbortSignal)
    => Promise<ConnectorSdkLifecycleCommands['sdkDeletionClaim']['output']>;
  removePhysical?: (input: ConnectorSdkLifecycleCommands['sdkDeletionClaim']['input'], authority: ApplicationCommandScope)
    => Promise<ConnectorSdkLifecycleCommands['sdkDeletionClaim']['output']>;
  ready: (runtime: SdkAgentId) => boolean;
  timeoutMs?: number;
  diagnostics?: PerformanceDiagnostics;
};
const validKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const unknown = (c: Context, commandKey: string) => c.json({
  error: 'Deletion outcome unavailable; read the original command key, do not resend', status: 'outcome_unknown', commandKey,
}, 503);

/** Register after node/protocol gates, before synchronous SDK/receipt guards.
 * GET is strictly observation; HTTP timeouts never replay or cancel original
 * deletion work, which the owned runtime continues to track and drain. */
export function registerSdkDeletionHttp(app: Hono, path: string, deps: SdkDeletionHttp): void {
  registerOwnedDeletionHttp<SdkAgentId>(app, path, {
    ...deps,
    remove: (...args) => deps.remove(...args),
    ready: runtime => deps.ready(runtime),
    runtime: key => { const r = sessionRuntimeId(key); return r === 'claude-code' || r === 'ghcp' || r === 'antigravity' ? r : undefined; },
    receipt: (runtime, key, commandKey, authorization) => deps.owner.command('sdkDeletionReceiptRead', { runtime, key, commandKey, authorization }),
    operation: 'sdk-deletion-http',
  });
}

export type DeletionView = { error: 401 | 403 | 409 | 503 } | { receipt: CommandReceipt | null };
export type DeletionPorts<R extends string> = {
  receipt(runtime: R, key: string, commandKey: string, authorization: string): Promise<DeletionView>;
  remove(runtime: R, key: string, commandKey: string, authorization: string, signal: AbortSignal): Promise<DeletionView>;
};
/** Shared wire protocol, not shared authority: each domain supplies its own
 * original owner commands. No synchronous receipt/identity fallback. */
export function registerOwnedDeletionHttp<R extends string>(app: Hono, path: string, deps: DeletionPorts<R> & {
  runtime(key: string): R | undefined;
  authorization?(c: Context): string;
  requestPorts?(c: Context): DeletionPorts<R>;
  around?(c: Context, work: () => Promise<Response>): Promise<Response>;
  ready(runtime: R): boolean; timeoutMs?: number; diagnostics?: PerformanceDiagnostics;
  operation: 'sdk-deletion-http' | 'hermes-session-deletion' | 'codex-session-deletion';
}): void {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite SDK deletion deadline required');
  const scope = (c: Context) => {
    const key = c.req.param('sessionKey')!, runtime = deps.runtime(key);
    return runtime === undefined ? undefined : { key, runtime };
  };
  const authority = (c: Context) => {
    const authorization = deps.authorization?.(c) ?? c.req.raw.headers.get('authorization') ?? '';
    if (!authorization.trim()) throw new HTTPException(401);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) throw new HTTPException(403);
    return authorization;
  };
  const wait = <T>(c: Context, work: () => Promise<T>) => runNativeOperation(work, { timeoutMs, signal: c.req.raw.signal });
  const failed = (c: Context, error: unknown, key?: string) => error instanceof HTTPException && error.status < 500
    ? c.json({ error: 'Invalid deletion request or authority' }, error.status)
    : key ? unknown(c, key) : c.json({ error: 'Deletion receipt unavailable' }, 503);

  app.get(`${path}/deletion-commands/:commandKey`, async (c, next) => {
    const current = scope(c); if (!current) return next();
    const work = async () => {
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, deps.operation);
    let unavailable = true;
    try {
      trace.add('step', 1);
      const authorization = authority(c), commandKey = c.req.param('commandKey')!, ports = deps.requestPorts?.(c) ?? deps;
      if (!validKey(commandKey)) return c.json({ error: 'Invalid deletion command key' }, 400);
      const view = await wait(c, () => ports.receipt(current.runtime, current.key, commandKey, authorization));
      if ('error' in view) return c.json({ error: 'Deletion receipt authority unavailable' }, view.error);
      if (!view.receipt) return c.json({ error: 'Command not found' }, 404);
      unavailable = false; return c.json({ command: view.receipt });
    } catch (error) { return failed(c, error); }
    finally { trace.finish(unavailable); }
    }; return deps.around ? deps.around(c, work) : work();
  });
  app.delete(path, async (c, next) => {
    const current = scope(c); if (!current) return next();
    const work = async () => {
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, deps.operation);
    let unavailable = true, commandKey: string | undefined;
    try {
      trace.add('step', 2);
      const authorization = authority(c), supplied = c.req.header('idempotency-key'), ports = deps.requestPorts?.(c) ?? deps;
      if (supplied !== undefined && !validKey(supplied)) return c.json({ error: 'Invalid deletion command key' }, 400);
      commandKey = supplied ?? createCommandKey(randomUUID());
      c.header('X-AgentOpsDeck-Command-Key', commandKey);
      const original = await wait(c, () => ports.receipt(current.runtime, current.key, commandKey!, authorization));
      if ('error' in original) return c.json({ error: 'Deletion authority unavailable' }, original.error);
      if (original.receipt) { unavailable = false; return reply(c, original.receipt); }
      if (deps.ready(current.runtime) !== true) return c.json({ error: 'Agent is not ready for deletion' }, 409);
      trace.add('step', 3);
      const result = await wait(c, () => ports.remove(current.runtime, current.key, commandKey!, authorization, c.req.raw.signal));
      if ('error' in result) return c.json({ error: 'Deletion was not admitted' }, result.error);
      // Original native acceptance is already durable. Revocation can hide the
      // HTTP result, never erase that fact or authorize another native effect.
      trace.add('step', 4);
      const view = await wait(c, () => ports.receipt(current.runtime, current.key, commandKey!, authorization));
      if ('error' in view) return c.json({ error: 'Deletion receipt authority unavailable' }, view.error);
      if (!view.receipt || !result.receipt || view.receipt.id !== result.receipt.id) return unknown(c, commandKey);
      unavailable = false; return reply(c, view.receipt);
    } catch (error) { return failed(c, error, commandKey); }
    finally { trace.finish(unavailable); }
    }; return deps.around ? deps.around(c, work) : work();
  });
}
