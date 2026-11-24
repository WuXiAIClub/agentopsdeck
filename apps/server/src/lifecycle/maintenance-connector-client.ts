import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from '../connector/node-identity.js';
import type { MaintenanceJob, QuiescenceProof } from './connector-maintenance.js';
import type { MaintenanceBusinessObservation } from '../connector/maintenance-readiness.js';
import { MaintenanceObservationUnavailable } from './maintenance-observation-error.js';
import { validStoppedCodexRuns } from '../codex/stopped-recovery.js';
import { boundedDispatch } from '../connector/transport.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const failure = () => new Error('Connector maintenance response unavailable or unverified');
const discardAsyncResult = (value: unknown) => {
  if (types.isPromise(value)) {
    try { void Promise.prototype.then.call(value, () => {}, () => {}); } catch { /* Remain denied. */ }
  }
};

/** Node-local transport used by the independent supervisor. Never retries a
 * mutation, follows redirects, accepts a URL from a job, or returns raw errors.
 * `credential` reads private operator configuration; `authorize` rechecks the
 * admitted actor's current durable authority, not the service token's scopes.
 */
export class MaintenanceConnectorClient {
  private readonly origin: string;
  constructor(private readonly options: {
    connectorUrl: string;
    nodeId: string;
    credential: () => string;
    authorize: (job: Readonly<MaintenanceJob>) => void;
    fetch?: typeof fetch;
    now?: () => number;
    diagnostics?: PerformanceDiagnostics;
  }) {
    this.options = { ...options };
    const url = new URL(options.connectorUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Maintenance requires an explicit loopback Connector origin');
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(options.nodeId)) throw new Error('Invalid maintenance node');
    this.origin = url.origin;
  }

  private now() {
    const read = this.options.now ?? Date.now;
    if (types.isAsyncFunction(read)) throw failure();
    const value = read();
    if (!Number.isSafeInteger(value) || value < 0) { discardAsyncResult(value); throw failure(); }
    return value;
  }
  private credential() {
    if (types.isAsyncFunction(this.options.credential)) throw failure();
    const value = this.options.credential();
    if (typeof value !== 'string' || !value || /[\r\n]/.test(value)) { discardAsyncResult(value); throw failure(); }
    return value;
  }
  private authorize(job: Readonly<MaintenanceJob>, step: number) {
    const trace = (this.options.diagnostics ?? performanceDiagnostics).start('maintenance-authority-check');
    trace.add('step', step);
    let failed = true;
    try {
      // This is a synchronous durable-authority check, not an async preflight.
      // Refuse known async functions without starting their continuation.
      if (types.isAsyncFunction(this.options.authorize)) { trace.add('deferred', 1); throw failure(); }
      const result: unknown = this.options.authorize(job);
      if (result !== undefined) {
        trace.add('unknown', 1);
        // Never consult a caller-owned then/getter, await, or grant late
        // permission. Consume native rejection only to avoid process noise.
        discardAsyncResult(result);
        throw failure();
      }
      trace.add('settled', 1); failed = false;
    } finally { trace.finish(failed); }
  }
  private async request(job: Readonly<MaintenanceJob>, path: string, body?: object, timeoutMs = 5000): Promise<Record<string, unknown>> {
    try {
      if (job.nodeId !== this.options.nodeId || job.deadline <= this.now()) throw failure();
      this.authorize(job, 1);
      const token = this.credential();
      const budget = Math.max(1, Math.min(timeoutMs, job.deadline - this.now()));
      const request = new Request(`${this.origin}/api/connector/v1/maintenance/${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store',
        headers: { authorization: `Bearer ${token}`, [CONNECTOR_PROTOCOL_HEADER]: '1', [EXPECTED_NODE_HEADER]: job.nodeId,
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const observationRead = path === 'inspection' && body === undefined;
      const response = await boundedDispatch(outgoing => (this.options.fetch ?? fetch)(outgoing), budget)(request).catch(() => {
        // Recheck authority even when the HTTP transport failed. A revoked
        // credential must not be misclassified as temporary unavailability.
        this.authorize(job, 2);
        if (observationRead && job.deadline > this.now()) throw new MaintenanceObservationUnavailable('transport_unavailable');
        throw failure();
      });
      if (observationRead && response.status === 503 && response.headers.get(NODE_ID_HEADER) === job.nodeId
        && response.headers.get(CONNECTOR_PROTOCOL_HEADER) === '1') {
        await response.body?.cancel();
        this.authorize(job, 3);
        if (job.deadline > this.now()) throw new MaintenanceObservationUnavailable('observation_unavailable');
        throw failure();
      }
      if (response.status !== 200 || response.headers.get(NODE_ID_HEADER) !== job.nodeId
        || response.headers.get(CONNECTOR_PROTOCOL_HEADER) !== '1' || !response.body) {
        await response.body?.cancel(); throw failure();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          this.authorize(job, 4);
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 32 * 1024) throw failure();
          chunks.push(next.value);
        }
      } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
      finally { reader.releaseLock(); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      this.authorize(job, 5);
      if (!record(value) || job.deadline <= this.now()) throw failure();
      return value;
    } catch (error) {
      if (error instanceof MaintenanceObservationUnavailable) throw error;
      throw failure();
    }
  }

  /** Hydration may need longer than a native idle observation. Still bounded
   * by the admitted deadline; never retries or releases the execution fence.
   * Release manifest verification is separately required on the node's disk.
   */
  async readiness(job: Readonly<MaintenanceJob>, sessionKey: string): Promise<MaintenanceBusinessObservation> {
    if (!job.fenceId || !/^[a-f0-9-]{36}$/.test(job.fenceId)
      || !/^(?:codex|claude-code|ghcp):[A-Za-z0-9-]{1,128}$/.test(sessionKey) || !job.release) throw failure();
    const value = await this.request(job, 'readiness', { fenceId: job.fenceId, sessionKey }, 60_000);
    const now = this.now();
    const expectedRun = job.operation === 'recover' ? job.recoveryRuns?.find(run => run.sessionKey === sessionKey) : undefined;
    const interrupted = !!expectedRun && value.recoveredRunId === expectedRun.runId;
    if (value.nodeId !== job.nodeId || value.fenceId !== job.fenceId || value.sessionKey !== sessionKey
      || value.revision !== job.release.revision || value.projectionVerified !== true || value.businessReadVerified !== true
      || !count(value.observedAt) || (value.observedAt as number) > now || (value.observedAt as number) < now - 5000
      || !count(value.messageCount) || (value.messageCount as number) < (interrupted ? 1 : 2)
      || (expectedRun && !interrupted)) throw failure();
    return { nodeId: job.nodeId, fenceId: job.fenceId, sessionKey, revision: value.revision as string,
      observedAt: value.observedAt as number, messageCount: value.messageCount as number,
      projectionVerified: true, businessReadVerified: true,
      ...(interrupted ? { recoveredRunId: expectedRun!.runId } : {}) };
  }

  async inspect(job: Readonly<MaintenanceJob>): Promise<QuiescenceProof> {
    const value = await this.request(job, 'inspection');
    const now = this.now();
    if (value.nodeId !== job.nodeId || value.nativeVerified !== true || !count(value.observedAt)
      || (value.observedAt as number) > now || (value.observedAt as number) < now - 5000
      || !['activeRuns', 'backgroundTerminals', 'pendingExecutions', 'queuedMessages', 'inFlightWrites'].every(key => count(value[key]))
      || (value.recoveryRuns !== undefined && !validStoppedCodexRuns(value.recoveryRuns))
      || (job.fenceId !== undefined && value.fenceId !== job.fenceId)
      || (value.fenceId !== undefined && (typeof value.fenceId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.fenceId)))) throw failure();
    // Whitelist only evidence fields. Never persist native errors or arbitrary
    // response payloads in the supervisor journal.
    return { nodeId: job.nodeId, observedAt: value.observedAt as number, nativeVerified: true,
      activeRuns: value.activeRuns as number, backgroundTerminals: value.backgroundTerminals as number,
      pendingExecutions: value.pendingExecutions as number, queuedMessages: value.queuedMessages as number,
      inFlightWrites: value.inFlightWrites as number,
      ...(validStoppedCodexRuns(value.recoveryRuns) ? { recoveryRuns: structuredClone(value.recoveryRuns) } : {}),
      ...(typeof value.fenceId === 'string' ? { fenceId: value.fenceId } : {}) };
  }

  private async change(job: Readonly<MaintenanceJob>, operation: 'pause' | 'resume') {
    const key = `lifecycle:${createHash('sha256').update(JSON.stringify([job.id, job.revision, operation])).digest('hex')}`;
    const value = await this.request(job, `commands/${operation}`, { idempotencyKey: key,
      ...(operation === 'resume' ? { fenceId: job.fenceId } : {}) });
    if (value.state !== (operation === 'pause' ? 'paused' : 'released') || value.boundary !== 'admission_only'
      || value.nativeQuiescent !== false || typeof value.fenceId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.fenceId)
      || !record(value.command) || value.command.state !== 'accepted' || value.command.key !== key
      || (operation === 'pause' ? value.command.id !== value.fenceId : value.fenceId !== job.fenceId)) throw failure();
    return { nodeId: job.nodeId, fenceId: value.fenceId };
  }
  fence(job: Readonly<MaintenanceJob>) { return this.change(job, 'pause'); }
  async releaseFence(job: Readonly<MaintenanceJob>) {
    if (!job.fenceId) throw failure();
    return { ...await this.change(job, 'resume'), released: true as const };
  }
}
