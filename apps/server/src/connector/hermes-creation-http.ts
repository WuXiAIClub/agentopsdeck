import { randomUUID } from 'node:crypto';
import { createCommandKey, type CommandReceipt } from '@agentopsdeck/shared';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import type { ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { HTTPException } from 'hono/http-exception';
import { runNativeOperation } from './native-operation.js';
import { readJsonBody } from '../utils/http-body.js';
import { reply } from '../commands/http.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type CreateInput = { authorization: string; commandKey: string; payloadJson: string; rejectFresh?: 'runtime_unavailable'; application?: ApplicationTransactionEvidence };
type CreateResult = { error: 401 | 403 | 409 | 503 } | { commandKey: string; receipt: CommandReceipt };
type ReceiptResult = { error: 401 | 403 } | { commandKey: string; receipt: CommandReceipt | null };
export type SessionCreationHttp = { creation: {
  create(input: CreateInput): Promise<CreateResult>;
  receipt(authorization: string, commandKey: string): Promise<{ error: 401 | 403 } | { commandKey: string; receipt: CommandReceipt | null }>;
};
  physical?: { createPhysical(input: CreateInput, authority?: ApplicationCommandScope): Promise<CreateResult>;
    receiptPhysical(authorization: string, commandKey: string): Promise<ReceiptResult> };
  requestCreation?(c: Context): SessionCreationHttp['creation'];
  authorization?(c: Context): string;
  around?(c: Context, work: () => Promise<Response>): Promise<Response>;
  ready(): boolean; timeoutMs?: number; diagnostics?: PerformanceDiagnostics };
export type HermesCreationHttp = SessionCreationHttp;
const validKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const unavailable = (c: Context, commandKey: string) => c.json({ error: 'Command outcome unavailable; read the original command key, do not resend', status: 'outcome_unknown', commandKey }, 503);

/** Mount after node/protocol gates and BEFORE legacy synchronous receipt gates.
 * Non-Hermes routes retain their original body and authorization path. */
export function registerHermesCreationHttp(app: Hono, base: string, deps: HermesCreationHttp) {
  registerSessionCreationHttp(app, base, deps, 'hermes');
}

/** Agent-specific registration shares the original bounded body/key/receipt
 * contract. Native execution and authority still belong to each fixed domain. */
export function registerSessionCreationHttp(app: Hono, base: string, deps: SessionCreationHttp, agent: 'hermes' | 'codex') {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw Error('Finite creation HTTP deadline required');
  const path = `${base}/agents/:agentId/sessions`;
  const owned = (handler: MiddlewareHandler): MiddlewareHandler => async (c, next) => {
    if (c.req.param('agentId') !== agent) return next();
    if (!deps.around) return handler(c, next);
    return deps.around(c, async () => {
      const response = await handler(c, next);
      return response instanceof Response ? response : c.res;
    });
  };
  let readers = 0;
  app.post(path, owned(async (c, next) => {
    if (c.req.param('agentId') !== agent) return next();
    c.header('Cache-Control', 'no-store');
    const authorization = deps.authorization ? deps.authorization(c) : c.req.header('authorization') ?? '';
    if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: `${agent === 'hermes' ? 'Hermes' : 'Codex'} creation requires owner authority` }, 403);
    if (readers >= 2) return c.json({ error: 'Creation input capacity reached' }, 503);
    readers++;
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, agent === 'hermes' ? 'hermes-session-creation' : 'codex-session-creation');
    let commandKey = createCommandKey(randomUUID()), failed = true;
    const wait = { timeoutMs, signal: c.req.raw.signal };
    try {
      const creation = deps.requestCreation?.(c) ?? deps.creation;
      trace.add('step', 4);
      const probe = await runNativeOperation(() => creation.receipt(authorization, commandKey), wait);
      if ('error' in probe) return c.json({ error: 'Creation authority unavailable' }, probe.error);
      const raw = await readJsonBody(c.req.raw, 8192, timeoutMs);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
      const { idempotencyKey, ...payload } = raw as Record<string, unknown>;
      const header = c.req.header('idempotency-key');
      if (header !== undefined && idempotencyKey !== undefined && idempotencyKey !== header) return c.json({ error: 'Conflicting command keys' }, 400);
      const selected = header ?? idempotencyKey ?? commandKey;
      if (!validKey(selected)) return c.json({ error: 'Invalid command key' }, 400);
      commandKey = selected; c.header('X-AgentOpsDeck-Command-Key', commandKey);
      if (Object.keys(payload).some(k => !['title', 'label', 'model'].includes(k))
        || (agent === 'hermes' ? Object.values(payload).some(v => v !== null && typeof v !== 'string')
          : payload.model !== undefined && payload.model !== null && typeof payload.model !== 'string')) return c.json({ error: 'Invalid creation input' }, 400);
      // Once entered, original runtime work outlives this independent waiter.
      const result = await runNativeOperation(() => creation.create({ authorization, commandKey, payloadJson: JSON.stringify(payload),
        ...(deps.ready() !== true ? { rejectFresh: 'runtime_unavailable' as const } : {}) }), wait);
      if ('error' in result) return c.json({ error: 'Creation unavailable' }, result.error);
      const current = await runNativeOperation(() => creation.receipt(authorization, commandKey), wait);
      if ('error' in current) return c.json({ error: 'Creation authority unavailable' }, current.error);
      if (!current.receipt || current.receipt.id !== result.receipt.id) return unavailable(c, commandKey);
      failed = false;
      return reply(c, current.receipt);
    } catch (error) {
      return error instanceof HTTPException && error.status < 500 ? c.json({ error: 'Invalid creation input' }, error.status) : unavailable(c, commandKey);
    } finally { readers--; trace.finish(failed); }
  }));
  app.get(`${path}/creation-commands/:commandKey`, owned(async (c, next) => {
    if (c.req.param('agentId') !== agent) return next();
    c.header('Cache-Control', 'no-store');
    const authorization = deps.authorization ? deps.authorization(c) : c.req.header('authorization') ?? '', commandKey = c.req.param('commandKey')!;
    if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: `${agent === 'hermes' ? 'Hermes' : 'Codex'} creation requires owner authority` }, 403);
    if (!validKey(commandKey)) return c.json({ error: 'Invalid command key' }, 400);
    try {
      const creation = deps.requestCreation?.(c) ?? deps.creation;
      const result = await runNativeOperation(() => creation.receipt(authorization, commandKey), { timeoutMs, signal: c.req.raw.signal });
      if ('error' in result) return c.json({ error: 'Creation authority unavailable' }, result.error);
      return result.receipt ? c.json({ command: result.receipt }) : c.json({ error: 'Command not found' }, 404);
    } catch { return unavailable(c, commandKey); }
  }));
}
