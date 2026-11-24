import type { GatewayWsClient } from '../gateway/ws-client.js';
import type { DeckStore } from '../projection/deck-store.js';
import { readOpenClawSessionDiskUsageAsync } from '../openclaw/session-usage.js';
import { stableGatewayRowsRevision } from '../refresh/signature.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

export type ConnectorSessionDiscoveryOptions = {
  gateway: Pick<GatewayWsClient, 'connectionId' | 'requestWithConnection'>;
  projection: Pick<DeckStore, 'replaceSessions' | 'applySessionUsage'>;
  local: boolean;
  configured: boolean;
  readLocal(): Promise<any[]>;
  refreshDirectories(settings?: { maxAgeMs?: number }): void | Promise<void>;
  readDiskUsage?: typeof readOpenClawSessionDiskUsageAsync;
  diagnostics?: PerformanceDiagnostics;
};

/** Original directory reads, shared by production and sole-worker bindings.
 * This is display freshness, NOT execution authority or native Goal idleness.
 * The root retains its maintenance barrier and closes sources after this drain. */
export function createConnectorSessionDiscovery(options: ConnectorSessionDiscoveryOptions) {
  let last = 0, generation = 0, closed = false;
  let revision: string | undefined, inflight: Promise<void> | undefined, closing: Promise<void> | undefined;
  let physical: Promise<void> | undefined;
  const diagnostics = options.diagnostics ?? performanceDiagnostics;
  const checkGeneration = (current: number, connection?: string) => {
    if (current !== generation || connection !== undefined && connection !== options.gateway.connectionId())
      throw new Error('Gateway WS connection changed');
  };
  const read = async (current: number, settings?: { maxAgeMs?: number }) => {
    const trace = guardedTrace(diagnostics, 'connector-session-discovery');
    let failed = false;
    try {
      await options.refreshDirectories(settings);
      if (!options.configured) { checkGeneration(current); trace.add('step', 1); return; }
      let rows: any[] | undefined, connection: string | undefined;
      if (options.local) {
        const local = await options.readLocal().catch(() => []);
        if (local.length) { rows = local; trace.add('step', 2); }
      }
      if (!rows) {
        const reply = await options.gateway.requestWithConnection<any>('sessions.list', {
          includeGlobal: true, includeUnknown: true, includeDerivedTitles: true, limit: 100,
        });
        connection = reply.connectionId;
        checkGeneration(current, connection);
        const result = reply.payload;
        const value = Array.isArray(result) ? result
          : result && typeof result === 'object' && 'sessions' in result ? result.sessions : result?.rows;
        if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object' || Array.isArray(row)
          || typeof (row.key ?? row.sessionKey ?? row.id) !== 'string' || !(row.key ?? row.sessionKey ?? row.id).trim()))
          throw new Error('Invalid Gateway session list');
        rows = value; trace.add('step', 3);
      }
      const usage = await (options.readDiskUsage ?? readOpenClawSessionDiskUsageAsync)(rows);
      checkGeneration(current, connection);
      const nextRevision = stableGatewayRowsRevision(rows);
      if (nextRevision !== revision) {
        options.projection.replaceSessions(rows);
        revision = nextRevision;
      }
      if (usage.size) options.projection.applySessionUsage(usage);
      // A synchronous projection observer may itself invalidate the discovery.
      checkGeneration(current, connection);
      trace.add('records', rows.length);
    } catch (error) { failed = true; throw error; }
    finally { trace.finish(failed); }
  };
  const refresh = (settings: { maxAgeMs?: number } = {}): Promise<void> => {
    if (closed) return Promise.reject(new Error('Connector runtime is closing'));
    if (inflight) return inflight;
    if (last && (settings.maxAgeMs ?? 0) > 0 && Date.now() - last < settings.maxAgeMs!) return Promise.resolve();
    const current = generation;
    last = 0;
    // Publish physical ownership before invoking original/injectable sources.
    const work = Promise.resolve().then(() => read(current, settings)).then(() => {
      checkGeneration(current); last = Date.now();
    });
    inflight = work;
    const done = () => { if (inflight === work) { inflight = undefined; physical = undefined; } };
    physical = work.then(done, done);
    return work;
  };
  return {
    refresh,
    invalidate() { generation++; last = 0; },
    get lastCompletedAt() { return last; },
    get refreshing() { return inflight !== undefined; },
    get current() { return !closed && last > 0 && !inflight; },
    close(): Promise<void> {
      closed = true;
      // Accepted original reads settle normally, as in the production drain.
      // No source may be closed until this physical flight has settled.
      return closing ??= (physical ?? Promise.resolve()).then(() => {});
    },
  };
}
