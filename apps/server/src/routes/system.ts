import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Hono } from 'hono';
import type { AgentSummary, GatewayHealth } from '@agentopsdeck/shared';
import type { ServerConfig } from '../config.js';
import { redactedConfig } from '../config.js';
import type { AdminRpcClient } from '../gateway/admin-client.js';
import type { GatewayWsClient } from '../gateway/ws-client.js';
import { readGatewayHealth } from '../gateway/health.js';
import type { DeckStore } from '../projection/deck-store.js';
import type { CodexAppServer } from '../codex/app-server.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
import { publicAdminRpc, publicGatewayHealth, publicGatewayWs } from './system-public-diagnostics.js';

const execFileAsync = promisify(execFile);

const GATEWAY_STATUS_TTL_MS = 5_000;
const AGENTS_TTL_MS = 30_000;

export type SystemReadDependencies = {
  config: ServerConfig;
  admin: AdminRpcClient;
  gateway: GatewayWsClient;
  store: Pick<DeckStore, 'updateGateway'> & Partial<Pick<DeckStore, 'memoryStats'>>;
  memoryDiagnostics?: () => Record<string, unknown>;
  normalizeError: (error: unknown) => string;
  diagnostics?: PerformanceDiagnostics;
  /** Trusted server/test setting. Bounds HTTP reads, never the original work. */
  requestWaitMs?: number;
  /** Original probe port; trusted composition/test input, never HTTP data. */
  statusProbe?: Parameters<typeof readGatewayHealth>[0]['statusProbe'];
  /** Trusted local management fence; never a user-supplied callback/grant. */
  restart?: { run(request: Request, work: (check: () => Promise<void>) => Promise<Response>): Promise<Response> } | undefined;
  restartEffect?: () => Promise<{ method: string; stdout: string; stderr: string }>;
};
export type SystemRoutesDependencies = SystemReadDependencies & {
  codex: Pick<CodexAppServer, 'enabled'>;
  refreshSessions: (options?: { maxAgeMs?: number }) => Promise<void>;
  fallbackAgents: (error?: string) => AgentSummary[] | PromiseLike<AgentSummary[]>;
  readsOnly?: false;
};

export function registerSystemRoutes(app: Hono, deps: SystemRoutesDependencies | (SystemReadDependencies & { readsOnly: true })) {
  const requestWaitMs = deps.requestWaitMs ?? 30_000;
  if (!Number.isSafeInteger(requestWaitMs) || requestWaitMs < 1 || requestWaitMs > 2_147_483_647) {
    throw new Error('invalid_system_request_wait');
  }
  // Cache and original in-flight work belong to THIS application. A new
  // runtime must never inherit another runtime's result or pending request.
  let gatewayStatusCache: { value: GatewayHealth; at: number } | undefined;
  let gatewayStatusInflight: Promise<GatewayHealth> | undefined;
  let agentsCache: { value: { agents: AgentSummary[]; degraded?: boolean }; at: number } | undefined;
  let agentsInflight: Promise<{ agents: AgentSummary[]; degraded?: boolean }> | undefined;
  const diagnostics = deps.diagnostics ?? performanceDiagnostics;
  const tasks = createTaskDrain();
  let closed = false;
  for (const route of ['/api/health', '/api/config/debug', '/api/gateway/status',
    ...(!deps.readsOnly || deps.restart ? ['/api/gateway/restart'] : []),
    ...(deps.readsOnly ? [] : ['/api/agents'])]) {
    app.use(route, async (c, next) => closed ? c.json({ error: 'server_draining' }, 503) : next());
  }
  // Defer dispatch until the original promise is published, including before
  // diagnostic clock/sink reentry. Warning is observation only: it cannot
  // cancel, clear, replace or replay the original request/restart.
  const observed = <T>(step: 1 | 2 | 3, work: (degraded: () => void) => Promise<T>): Promise<T> => tasks.run(async () => {
    // Own the accepted task before dispatch/diagnostic reentry. Closing never
    // disposes sources while an HTTP waiter has merely stopped waiting.
    await Promise.resolve();
    const trace = guardedTrace(diagnostics, 'system-operation'); trace.add('step', step);
    const warning = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000); warning.unref();
    let failed = true, degraded = false;
    try {
      const value = await work(() => { degraded = true; trace.add('deferred', 1); });
      trace.add('settled', 1); failed = degraded; return value;
    } catch (error) {
      trace.add(step === 3 ? 'unknown' : 'deferred', 1); throw error;
    } finally { clearTimeout(warning); trace.finish(failed); }
  });
  // A request owns only its wait. Deadline/disconnect must not clear the shared
  // original promise, publish a fallback as success, or issue a replacement.
  const waitForRead = async <T>(request: Request, step: 1 | 2, original: Promise<T>): Promise<
    { state: 'ready'; value: T } | { state: 'timeout' } | { state: 'cancelled' }
  > => {
    // A diagnostic clock may synchronously reenter this route. Publish the
    // shared request first and leave that clock before measuring its waiter;
    // otherwise the observer correctly refuses recursive clock reads and the
    // joined request loses its settlement observation. No provider is replayed.
    await Promise.resolve();
    const trace = guardedTrace(diagnostics, 'system-read-wait'); trace.add('step', step);
    let abort!: () => void, timer: ReturnType<typeof setTimeout> | undefined;
    let failed = true;
    const cancelled = new Promise<{ state: 'cancelled' }>(resolve => {
      abort = () => resolve({ state: 'cancelled' });
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
    });
    const expired = new Promise<{ state: 'timeout' }>(resolve => {
      timer = setTimeout(() => resolve({ state: 'timeout' }), requestWaitMs);
    });
    try {
      // The rejection handler remains attached after the HTTP wait ends.
      const result = await Promise.race([original.then(value => ({ state: 'ready' as const, value })), cancelled, expired]);
      if (request.signal.aborted || result.state === 'cancelled') {
        trace.add('deferred', 1); return { state: 'cancelled' };
      }
      if (result.state === 'timeout') { trace.add('timedOut', 1); trace.add('pending', 1); return result; }
      trace.add('settled', 1); failed = false; return result;
    } catch (error) {
      trace.add('deferred', 1); throw error;
    } finally {
      clearTimeout(timer); request.signal.removeEventListener('abort', abort); trace.finish(failed);
    }
  };
  app.get('/api/health', (c) => c.json({ ok: true, service: 'agentopsdeck', ts: Date.now() }));

  app.get('/api/config/debug', (c) =>
    c.json({
      config: redactedConfig(deps.config),
      gatewayWs: publicGatewayWs(deps.gateway.status()),
      adminRpc: publicAdminRpc(deps.admin.status()),
      memory: {
        process: process.memoryUsage(),
        ...(deps.store.memoryStats ? { projection: deps.store.memoryStats() } : {}),
        ...(deps.memoryDiagnostics ? deps.memoryDiagnostics() : {}),
      },
    }),
  );

  app.get('/api/gateway/status', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.raw.signal.aborted) return c.json({ error: 'request_cancelled' }, 408);
    if (gatewayStatusCache && Date.now() - gatewayStatusCache.at < GATEWAY_STATUS_TTL_MS) {
      return c.json(gatewayStatusCache.value);
    }
    if (!gatewayStatusInflight) {
      gatewayStatusInflight = observed(2, () => readGatewayHealth({
        admin: deps.admin,
        gateway: deps.gateway,
        defaultAgentId: deps.config.defaultAgentId,
        normalizeError: () => 'gateway_probe_failed',
        localOpenClawCli: deps.config.localOpenClawCli,
        ...(deps.statusProbe ? { statusProbe: deps.statusProbe } : {}),
      }).then((rawHealth) => {
        const gatewayHealth = publicGatewayHealth(rawHealth, deps.config.defaultAgentId);
        gatewayStatusCache = { value: gatewayHealth, at: Date.now() };
        deps.store.updateGateway(gatewayHealth);
        return gatewayHealth;
      })).finally(() => {
        gatewayStatusInflight = undefined;
      });
    }
    const result = await waitForRead(c.req.raw, 2, gatewayStatusInflight);
    if (result.state === 'cancelled') return c.json({ error: 'request_cancelled' }, 408);
    if (result.state === 'timeout') return c.json({ error: 'system_read_timeout' }, 503);
    return c.json(result.value);
  });

  if (!deps.readsOnly || deps.restart) app.post('/api/gateway/restart', async (c) => {
    try {
      return await observed(3, async () => {
        const work = async (check: () => Promise<void>) => {
          await check();
          // Even trusted effect injection must not bypass remote-deployment policy.
          if (!deps.config.localOpenClawCli) throw new Error('Gateway restart via local CLI is disabled for remote deployment');
          await (deps.restartEffect ? deps.restartEffect()
            : restartGateway(deps.admin, deps.config.localOpenClawCli));
          const gatewayHealth = publicGatewayHealth(await readGatewayHealth({
            admin: deps.admin,
            gateway: deps.gateway,
            defaultAgentId: deps.config.defaultAgentId,
            normalizeError: () => 'gateway_probe_failed',
            localOpenClawCli: deps.config.localOpenClawCli,
            ...(deps.statusProbe ? { statusProbe: deps.statusProbe } : {}),
          }), deps.config.defaultAgentId);
          gatewayStatusCache = { value: gatewayHealth, at: Date.now() };
          deps.store.updateGateway(gatewayHealth);
          return c.json({ ok: true, result: { method: 'openclaw gateway restart' }, gateway: gatewayHealth, updatedAt: Date.now() });
        };
        return deps.restart ? deps.restart.run(c.req.raw, work) : work(async () => {});
      });
    } catch (error) {
      if (deps.restart && error instanceof SystemRestartFenceError)
        return c.json({ error: 'gateway authorization or lifetime changed' }, error.status);
      return c.json({ error: 'gateway_restart_failed' }, 502);
    }
  });

  if (!deps.readsOnly) app.get('/api/agents', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.raw.signal.aborted) return c.json({ error: 'request_cancelled' }, 408);
    const localOnly = !deps.config.localOpenClawCli && !deps.config.gatewayWsUrl && !deps.config.adminRpcUrl;
    if (!localOnly && agentsCache && Date.now() - agentsCache.at < AGENTS_TTL_MS) {
      return c.json({ ...agentsCache.value, updatedAt: Date.now() });
    }
    if (!agentsInflight) {
      agentsInflight = observed(1, async degraded => {
        // No-upstream mode has always returned fresh local state. Retain that
        // policy while bounding the wait and sharing its original async read.
        if (localOnly) return { agents: await deps.fallbackAgents() };
        try {
          const result: any = await deps.gateway.request('agents.list');
          const rows = Array.isArray(result) ? result : (result.agents ?? result.rows ?? []);
          const agents: AgentSummary[] = rows.map((row: any) => ({
            id: String(row.id ?? row.agentId ?? row.name),
            label: row.label ?? row.name,
            status: row.status,
          }));
          if (deps.codex.enabled && !agents.some((agent) => agent.id === 'codex')) agents.push({ id: 'codex', label: 'Codex · local harness', status: 'available' });
          const value = { agents };
          agentsCache = { value, at: Date.now() };
          return value;
        } catch (error) {
          degraded();
          const agents = [...await deps.fallbackAgents('gateway_unavailable')];
          if (deps.codex.enabled && !agents.some((agent) => agent.id === 'codex')) agents.push({ id: 'codex', label: 'Codex · local harness', status: 'available' });
          const fallback = { agents, degraded: true };
          agentsCache = { value: fallback, at: Date.now() };
          return fallback;
        }
      }).finally(() => {
        agentsInflight = undefined;
      });
    }
    let result;
    try { result = await waitForRead(c.req.raw, 1, agentsInflight); }
    catch { return c.json({ error: 'agent_catalog_unavailable' }, 503); }
    if (result.state === 'cancelled') return c.json({ error: 'request_cancelled' }, 408);
    if (result.state === 'timeout') return c.json({ error: 'system_read_timeout' }, 503);
    return c.json({ ...result.value, updatedAt: Date.now() });
  });
  return Object.freeze({ close: () => { closed = true; return tasks.close(); } });
}

export class SystemRestartFenceError extends Error {
  constructor(readonly status: 400 | 403 | 408 | 503) { super('gateway authorization or lifetime changed'); }
}

async function restartGateway(admin: AdminRpcClient, localOpenClawCli = true) {
  if (!localOpenClawCli) throw new Error('Gateway restart via local CLI is disabled for remote deployment');
  const { stdout, stderr } = await execFileAsync('openclaw', ['gateway', 'restart'], { timeout: 120_000 });
  return { method: 'openclaw gateway restart', stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) };
}
