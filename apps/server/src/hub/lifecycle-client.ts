import { createHash } from 'node:crypto';
import { boundedDispatch, type Dispatch } from '../connector/transport.js';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER, isNodeId } from '../connector/node-identity.js';
import { MAINTENANCE_API, MAINTENANCE_PROTOCOL_HEADER } from '../lifecycle/maintenance-http.js';
import { validMaintenanceJob, type MaintenanceJob, type MaintenanceOperation } from '../lifecycle/connector-maintenance.js';

export type LifecycleEndpoint = { ownerUserId: string; connectionId: string; nodeId: string; origin: string };
const unavailable = () => new Error('Independent Connector maintenance unavailable');
const keyValid = (key: string) => /^[A-Za-z0-9._:-]{1,200}$/.test(key);

/** Operator-owned opt-in, never a URL/command supplied by the browser. */
export function parseLifecycleEndpoints(raw: string | undefined): LifecycleEndpoint[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 128) throw unavailable();
    const seen = new Set<string>();
    return value.map(entry => {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'connectionId,nodeId,origin,ownerUserId'
        || ![entry.ownerUserId, entry.connectionId].every(item => typeof item === 'string' && keyValid(item))
        || !isNodeId(entry.nodeId) || typeof entry.origin !== 'string') throw unavailable();
      const origin = lifecycleOrigin(entry.origin), key = JSON.stringify([entry.ownerUserId, entry.connectionId]);
      if (seen.has(key)) throw unavailable();
      seen.add(key);
      return { ownerUserId: entry.ownerUserId, connectionId: entry.connectionId, nodeId: entry.nodeId, origin };
    });
  } catch { throw new Error('Invalid AOD_HUB_LIFECYCLE_ENDPOINTS_JSON'); }
}

export function lifecycleOrigin(value: string) {
  const url = new URL(value);
  // Cleartext credentials are only allowed over explicit loopback (e.g. an
  // operator-managed tunnel). LAN/public endpoints require authenticated TLS.
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw unavailable();
  return url.origin;
}

export type LifecycleStatus = { version: 1; nodeId: string; operations: MaintenanceOperation[];
  blocked: boolean; automaticUpdates: false; workerState: 'running' | 'halted' | 'stopping'; job?: MaintenanceJob };

/** Separate protocol/listener from ordinary Connector traffic. Never retry a
 * POST. Identity, deadline, authority and response bounds apply to the body too.
 */
export class LifecycleClient {
  private readonly origin: string;
  constructor(private readonly nodeId: string, origin: string, private readonly credential: string,
    private readonly authorize: () => void | Promise<void>, private readonly dispatch: Dispatch = request => fetch(request)) {
    this.origin = lifecycleOrigin(origin);
    if (!isNodeId(nodeId) || !credential || credential.length > 8192 || /[\r\n]/.test(credential)) throw unavailable();
  }
  private async request(path: string, signal?: AbortSignal, body?: object): Promise<unknown> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await this.authorize(); signal?.throwIfAborted();
      const response = await boundedDispatch(this.dispatch, 10_000)(new Request(`${this.origin}${MAINTENANCE_API}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', ...(signal ? { signal } : {}),
        headers: { authorization: `Bearer ${this.credential}`, [EXPECTED_NODE_HEADER]: this.nodeId,
          [MAINTENANCE_PROTOCOL_HEADER]: '1', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }));
      if (response.status !== (body ? 202 : 200) || response.headers.get(NODE_ID_HEADER) !== this.nodeId
        || response.headers.get(MAINTENANCE_PROTOCOL_HEADER) !== '1' || !response.body) {
        await response.body?.cancel(); throw unavailable();
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const next = await reader.read(); await this.authorize(); signal?.throwIfAborted();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 32 * 1024) throw unavailable();
        chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { await reader?.cancel().catch(() => {}); throw unavailable(); }
    finally { reader?.releaseLock(); }
  }
  async status(signal?: AbortSignal): Promise<LifecycleStatus> {
    const value = await this.request('/status', signal) as LifecycleStatus;
    if (!value || value.version !== 1 || value.nodeId !== this.nodeId || typeof value.blocked !== 'boolean'
      || value.automaticUpdates !== false || !['running', 'halted', 'stopping'].includes(value.workerState)
      || !Array.isArray(value.operations) || !value.operations.length || value.operations.length > 2
      || new Set(value.operations).size !== value.operations.length || value.operations.some(op => !['restart', 'upgrade'].includes(op))
      || (value.job !== undefined && (!validMaintenanceJob(value.job) || value.job.nodeId !== this.nodeId || !value.blocked))) throw unavailable();
    return { version: 1, nodeId: this.nodeId, operations: value.operations, blocked: value.blocked,
      automaticUpdates: false, workerState: value.workerState, ...(value.job ? { job: value.job } : {}) };
  }
  async command(key: string, operation: MaintenanceOperation, signal?: AbortSignal, submit = false): Promise<MaintenanceJob> {
    if (!keyValid(key) || !['restart', 'upgrade'].includes(operation)) throw unavailable();
    const value = await this.request(submit ? '/commands' : `/commands/${encodeURIComponent(key)}`, signal,
      submit ? { commandKey: key, operation } : undefined) as { command?: unknown };
    const job = value?.command;
    if (!validMaintenanceJob(job) || job.nodeId !== this.nodeId || job.operation !== operation
      || job.id !== `maintenance:${createHash('sha256').update(JSON.stringify([this.nodeId, job.actorId, key])).digest('hex')}`) throw unavailable();
    return job;
  }
}
