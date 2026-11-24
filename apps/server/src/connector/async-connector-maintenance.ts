import type { Hono } from 'hono';
import type { ServerConfig } from '../config.js';
import type { DeckStore } from '../projection/deck-store.js';
import { registerRequestDrain, type AdmissionPause } from '../lifecycle/request-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { createAsyncRuntimeAssembly } from './async-runtime-assembly.js';
import { AsyncMaintenanceLifecycle } from './async-maintenance-lifecycle.js';
import { AsyncUpdatePersistence } from './async-update-persistence.js';
import { ConnectorUpdateService, UpdateAuthorizationError } from './update-service.js';
import { RuntimeMaintenancePersistence } from './runtime-maintenance-persistence.js';
import { createAsyncRuntimeMaintenanceInspection } from './async-runtime-maintenance-inspection.js';
import { createAsyncRuntimeMaintenanceProbe } from './async-runtime-maintenance-probe.js';
import { registerConnectorUpdates, type ConnectorUpdateAuthority } from './update-http.js';
import { registerAsyncMaintenanceInspection } from './maintenance-inspection.js';
import { registerAsyncMaintenanceReadiness } from './maintenance-readiness.js';

/** Original control allowlist: GETs can write projections too. In particular a
 * pause must not wait for its own handler, and readiness stays fenced by the
 * original service's maintenance lock, not by ordinary request admission. */
function isControl(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  if (request.method === 'POST') return /^\/api\/connector\/v1\/maintenance\/(commands\/(pause|resume)|readiness)$/.test(pathname);
  return ['GET', 'HEAD'].includes(request.method)
    && (!/^\/api(?:\/|$)/.test(pathname) || pathname === '/api/health'
      || /^\/api\/connector\/v1\/(identity|health|maintenance\/(status|inspection|storage\/recovery)|maintenance\/commands\/(pause|resume)\/[^/]+)$/.test(pathname));
}

/** Install BEFORE any surface route. Borrow the original owner/executors;
 * startup restores the ORIGINAL journal before any producer starts. close()
 * synchronously freezes, then physically drains the original assembly. SQL
 * remains borrowed: the root releases it after this barrier. */
export function createAsyncConnectorMaintenance(app: Hono, deps: {
  owner: Pick<AsyncConnectorOwner, 'command'>; nodeId: string; config: ServerConfig;
  runtimes: Awaited<ReturnType<typeof createAsyncRuntimeAssembly>>; deck: DeckStore;
  available(): boolean; pauseRefresh(): AdmissionPause; diagnostics?: PerformanceDiagnostics;
}) {
  const diagnostics = deps.diagnostics ?? performanceDiagnostics;
  const report = (step: number, failed: boolean) => {
    const trace = guardedTrace(diagnostics, 'connector-sqlite-command');
    trace.add('step', step); trace.finish(failed);
  };
  const requests = registerRequestDrain(app, { writesOnRead: true, isControl });
  const persistence = new AsyncUpdatePersistence(deps.owner, deps.nodeId, diagnostics);
  const service = new ConnectorUpdateService(deps.config, persistence);
  const lifecycle = new AsyncMaintenanceLifecycle(deps.owner, [() => {
    // An already failed assembly has fenced its children. Retain its actual
    // cleanup instead of asking a dead runtime for a new reusable pause lease.
    if (state === 'closing' || ['failed', 'closing', 'closed'].includes(deps.runtimes.state))
      return { drained: deps.runtimes.close(), resume: () => false };
    return deps.runtimes.pauseQueueWorkers();
  }, deps.pauseRefresh, requests.pauseWrites], diagnostics);
  const durable = new RuntimeMaintenancePersistence(persistence.maintenance, diagnostics);
  const sdk = (['claude-code', 'ghcp'] as const).flatMap(id => {
    const runtime = id === 'claude-code' ? deps.runtimes.sdk.claude : deps.runtimes.sdk.copilot;
    return runtime ? [{ id, inspectMaintenance: () => runtime.inspectMaintenance(),
      refreshSession: (key: string, options: { fresh: true }) => runtime.refreshSession(key, options),
      isSessionHistoryReady: (key: string) => runtime.isSessionHistoryReady(key) }] : [];
  });
  const unsupportedNative = () => !!(deps.config.hermes?.enabled || deps.config.gatewayWsUrl || deps.config.localOpenClawCli);
  let state: 'created' | 'starting' | 'ready' | 'failed' | 'closing' | 'closed' = 'created';
  let startup: Promise<void> | undefined, closing: Promise<void> | undefined;
  const inspection = createAsyncRuntimeMaintenanceInspection({ nodeId: deps.nodeId, updateService: service,
    persistence: durable, codex: deps.runtimes.codex, sdk, requests, unsupportedNative, probes: () => probe.probes() });
  const probe = createAsyncRuntimeMaintenanceProbe({ nodeId: deps.nodeId, revision: () => deps.config.connector.revision,
    requests, unsupportedNative, codex: deps.runtimes.codex, sdk,
    projection: { refresh: deps.runtimes.refreshProjection, assertCurrent: deps.runtimes.assertProjectionCurrent },
    deck: deps.deck, persistence: durable, inspect: inspection.inspect,
    resumes: local => persistence.maintenanceResumes(deps.runtimes.codex.maintenanceResumeSettlement, local), diagnostics });
  const authority: ConnectorUpdateAuthority<Promise<void>> = { run(request, mode, action) {
    if (state !== 'ready' || !deps.available()) return Promise.reject(new UpdateAuthorizationError());
    return persistence.run(request, mode, operator => action({ ...operator, check: async () => {
      if (state !== 'ready' || !deps.available()) throw new UpdateAuthorizationError();
      await operator.check();
      if (state !== 'ready' || !deps.available()) throw new UpdateAuthorizationError();
    } }));
  } };
  const updates = registerConnectorUpdates(app, '/api/connector/v1', { config: deps.config, service, authority,
    normalizeError: () => 'Connector maintenance or update unavailable' });
  const closeInspection = registerAsyncMaintenanceInspection(app, { nodeId: deps.nodeId, authority, inspect: inspection.inspect, diagnostics });
  const readiness = registerAsyncMaintenanceReadiness(app, { nodeId: deps.nodeId, authority, updateService: service, probe: probe.probe });
  const start = (): Promise<void> => {
    if (state === 'closing' || state === 'closed' || state === 'failed') return Promise.reject(new UpdateAuthorizationError());
    if (startup) return startup;
    state = 'starting';
    return startup = Promise.resolve().then(async () => {
      const restored = await service.maintenanceAtStartupAsync();
      if (state !== 'starting') throw new UpdateAuthorizationError();
      service.bindAsyncMaintenanceLifecycle(lifecycle.pause, restored);
      if (restored && restored.state !== 'released') await lifecycle.pause().drained;
      if (state !== 'starting') throw new UpdateAuthorizationError();
      state = 'ready'; report(360, false);
    }).catch(() => {
      if (state === 'starting') state = 'failed';
      report(360, true); throw new UpdateAuthorizationError();
    });
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    state = 'closing';
    // All calls below fence synchronously, before yielding to any caller.
    const drains = [updates.close(), closeInspection(), readiness.close(), requests(), lifecycle.close(),
      probe.close(), inspection.close()];
    return closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...drains, ...(startup ? [startup] : [])]);
      // Original accepted operations settle before their persistence closes.
      const ports = await Promise.allSettled([durable.close(), persistence.close()]);
      const failed = [...results.slice(0, drains.length), ...ports].some(result => result.status === 'rejected');
      state = failed ? 'failed' : 'closed'; report(361, failed);
      if (failed) throw Error('Connector maintenance shutdown could not confirm drain');
    });
  };
  return { start, close, status: (request: Request) => updates.status(request, false) };
}
