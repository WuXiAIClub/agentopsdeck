import type { Hono } from 'hono';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import type { StoppedCodexRun } from '../codex/stopped-recovery.js';
import type { ConnectorUpdateAuthority } from './update-http.js';
import { UpdateAuthorizationError } from './update-service.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { nativeMaintenanceFailureReason } from '../codex/maintenance.js';

export type NativeMaintenanceObservation = {
  nodeId: string;
  observedAt: number;
  nativeVerified: true;
  activeRuns: number;
  backgroundTerminals: number;
  pendingExecutions: number;
  queuedMessages: number;
  inFlightWrites: number;
  fenceId?: string;
  recoveryRuns?: StoppedCodexRun[];
};

export type CurrentNativeMaintenanceObservation = NativeMaintenanceObservation & { assertCurrent(): void };

/** Async root transport. Authority retains the original request identity and
 * the actual native work; this consumer retains response/disconnect ownership.
 * Readiness mode is lifecycle-only, NOT the broader update authority. */
export function registerAsyncMaintenanceInspection(app: Hono, deps: {
  nodeId: string;
  authority: ConnectorUpdateAuthority<Promise<void>>;
  inspect?: (authorize: () => Promise<void>, assertLocal: () => void) => Promise<CurrentNativeMaintenanceObservation>;
  diagnostics?: PerformanceDiagnostics;
}) {
  const tasks = createTaskDrain();
  let closed = false;
  app.get('/api/connector/v1/maintenance/inspection', async c => {
    c.header('Cache-Control', 'no-store');
    if (c.req.header('Origin') !== undefined) return c.json({ error: 'Browser access is not supported' }, 403);
    if (c.req.header(CONNECTOR_PROTOCOL_HEADER) !== '1') return c.json({ error: 'Explicit compatible protocol required' }, 426);
    if (c.req.header(EXPECTED_NODE_HEADER) !== deps.nodeId) return c.json({ error: 'Exact maintenance node required' }, 409);
    const local = () => {
      if (closed || c.req.raw.signal.aborted) throw Error('Maintenance observation interrupted');
    };
    try {
      return await tasks.run(async () => {
        const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'connector-sqlite-command');
        trace.add('step', 346); let failed = true;
        const warning = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000); warning.unref();
        try {
          local();
          const observation = await deps.authority.run(c.req.raw, 'readiness', async operator => {
            local();
            if (!deps.inspect) return undefined;
            try {
              const result = await deps.inspect(operator.check, local);
              local(); result.assertCurrent();
              return result;
            } catch (error) {
              // Classify revoke without delivering native/private failure text.
              await operator.check();
              throw error;
            }
          });
          // run() awaited final current authority. NO await between these local
          // and native epoch checks and constructing the public response.
          local();
          if (!observation) return c.json({ error: 'Native maintenance inspection is not supported' }, 501);
          observation.assertCurrent();
          const { assertCurrent: _assertCurrent, ...result } = observation;
          failed = false; trace.add('settled', 1);
          return c.json(result);
        } finally { clearTimeout(warning); trace.finish(failed); }
      });
    } catch (error) {
      return !closed && !c.req.raw.signal.aborted && error instanceof UpdateAuthorizationError
        ? c.json({ error: 'Lifecycle maintenance is not authorized' }, 403)
        : c.json({ error: 'Native maintenance observation unavailable; no idle proof',
          ...(nativeMaintenanceFailureReason(error) ? { reason: nativeMaintenanceFailureReason(error) } : {}) }, 503);
    }
  });
  return () => { closed = true; return tasks.close(); };
}

/** Server-to-server read only. Lifecycle authority is separate from update,
 * execution and bootstrap scopes. Unsupported runtimes fail closed. */
export function registerMaintenanceInspection(app: Hono, deps: {
  nodeId: string;
  tokens: ConnectorTokenStore;
  inspect?: (check: () => void) => Promise<NativeMaintenanceObservation>;
}) {
  app.get('/api/connector/v1/maintenance/inspection', async c => {
    c.header('Cache-Control', 'no-store');
    if (c.req.header('Origin') !== undefined) return c.json({ error: 'Browser access is not supported' }, 403);
    if (c.req.header(CONNECTOR_PROTOCOL_HEADER) !== '1') return c.json({ error: 'Explicit compatible protocol required' }, 426);
    if (c.req.header(EXPECTED_NODE_HEADER) !== deps.nodeId) return c.json({ error: 'Exact maintenance node required' }, 409);
    const principal = deps.tokens.requireScope(c.req.raw, 'connector:lifecycle');
    if (!principal) return c.json({ error: 'Lifecycle maintenance is not authorized' }, 403);
    const current = () => deps.tokens.requireScope(c.req.raw, 'connector:lifecycle')?.tokenId === principal.tokenId;
    const check = () => {
      if (!current() || c.req.raw.signal.aborted) throw new Error('Maintenance observation interrupted');
    };
    if (!deps.inspect) return c.json({ error: 'Native maintenance inspection is not supported' }, 501);
    try {
      const result = await deps.inspect(check);
      check();
      return c.json(result);
    } catch (error) {
      // Native errors can contain private tool input/paths. Never relay them.
      return current()
        ? c.json({ error: 'Native maintenance observation unavailable; no idle proof',
          ...(nativeMaintenanceFailureReason(error) ? { reason: nativeMaintenanceFailureReason(error) } : {}) }, 503)
        : c.json({ error: 'Lifecycle maintenance is not authorized' }, 403);
    }
  });
}
