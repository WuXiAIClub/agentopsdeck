import { AsyncLocalStorage } from 'node:async_hooks';
import type { MiddlewareHandler } from 'hono';

const stages = ['sql', 'json', 'hydrateWait', 'page', 'encode', 'connectorWait', 'wrap'] as const;
type Stage = typeof stages[number];
type Timing = { calls: number; ms: number; maxMs: number; failures: number };
type Trace = { closed: boolean; stages: Record<Stage, Timing> };
const context = new AsyncLocalStorage<Trace>();
/** Shared work may serve multiple waiters. Measure each wait, not the shared
 * job's nested SQL/JSON against whichever request happened to start it. */
export function withoutHistoryDiagnostics<T>(read: () => T): T { return context.exit(read); }
const empty = (): Timing => ({ calls: 0, ms: 0, maxMs: 0, failures: 0 });
const stageCounters = () => Object.fromEntries(stages.map(stage => [stage, empty()])) as Record<Stage, Timing>;
const statuses = ['200', '202', '304', '400', '401', '403', '404', '409', '429', '499', '500', '502', '503', '504', 'other'] as const;
// Fixed finite histogram. Percentiles are upper bounds, not fabricated exact
// samples; overflow remains explicitly unbounded. No request-sized storage.
const latencyUpperBoundsMs = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000] as const;
const histogram = () => Array<number>(latencyUpperBoundsMs.length + 1).fill(0);
const grouped = () => ({ total: empty(), stages: stageCounters(), latency: histogram() });
const add = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const merge = (target: Timing, source: Timing) => {
  target.calls = add(target.calls, source.calls); target.ms = add(target.ms, source.ms);
  target.maxMs = Math.max(target.maxMs, source.maxMs); target.failures = add(target.failures, source.failures);
};

/** Only the current HTTP continuation, never a global-before/after subtraction.
 * Closed traces ignore detached hydration which outlives its first waiter. */
export function observeHistoryStage(stage: Stage, ms: number, failed = false) {
  const trace = context.getStore();
  if (!trace || trace.closed || !Number.isFinite(ms) || ms < 0) return;
  merge(trace.stages[stage], { calls: 1, ms, maxMs: ms, failures: Number(failed) });
}
export function timeHistorySync<T>(stage: Stage, read: () => T): T {
  const start = performance.now(); let failed = true;
  try { const result = read(); failed = false; return result; }
  finally { observeHistoryStage(stage, performance.now() - start, failed); }
}
export async function timeHistoryAsync<T>(stage: Stage, read: () => Promise<T>): Promise<T> {
  const start = performance.now(); let failed = true;
  try { const result = await read(); failed = false; return result; }
  finally { observeHistoryStage(stage, performance.now() - start, failed); }
}

/** Fixed-size, process-local numbers only. No session IDs, paths, exception
 * messages, SQL or samples. Nested stages overlap; they must NOT be summed.
 * Headers measure application handling, not socket flush or remote rendering. */
export class HistoryDiagnostics {
  private readonly total = empty();
  private readonly measured = stageCounters();
  private readonly statuses: Record<string, number> = Object.fromEntries(statuses.map(s => [s, 0]));
  private readonly byStatus = Object.fromEntries(statuses.map(status => [status, grouped()]));
  constructor(private readonly clock: () => number = () => performance.now()) {}
  private now(): number | undefined {
    try { const value = this.clock(); return Number.isFinite(value) ? value : undefined; }
    catch { return undefined; }
  }
  middleware(): MiddlewareHandler {
    return async (c, next) => {
      if (c.req.method !== 'GET') return next();
      const trace: Trace = { closed: false, stages: stageCounters() }, start = this.now();
      let failed = true;
      try { await context.run(trace, next); failed = false; }
      finally {
        trace.closed = true;
        const end = this.now();
        const duration = start === undefined || end === undefined ? 0 : end - start;
        const elapsed = Number.isFinite(duration) ? Math.max(0, duration) : 0;
        const status = c.req.raw.signal.aborted ? '499' : failed ? '500' : String(c.res.status);
        const key = Object.hasOwn(this.statuses, status) ? status : 'other';
        this.statuses[key] = add(this.statuses[key]!, 1);
        const sample = { calls: 1, ms: elapsed, maxMs: elapsed, failures: Number(failed || Number(status) >= 500) };
        merge(this.total, sample);
        const group = this.byStatus[key]!;
        merge(group.total, sample);
        const index = latencyUpperBoundsMs.findIndex(bound => elapsed <= bound);
        const bin = index < 0 ? latencyUpperBoundsMs.length : index;
        group.latency[bin] = add(group.latency[bin]!, 1);
        for (const stage of stages) {
          merge(this.measured[stage], trace.stages[stage]);
          merge(group.stages[stage], trace.stages[stage]);
        }
        // Do not expose internal timing on authentication/authorization failure.
        if (status !== '401' && status !== '403') {
          const values = [`app;dur=${elapsed.toFixed(1)}`, ...stages.filter(stage => trace.stages[stage].calls)
            .map(stage => `${stage};dur=${trace.stages[stage].ms.toFixed(1)}`)];
          c.header('Server-Timing', values.join(', '), { append: true });
        }
      }
    };
  }
  snapshot() {
    return { version: 1, scope: 'process-history-requests', overlappingStages: true,
      total: { ...this.total }, statuses: { ...this.statuses },
      // Number of requests, not cumulative histogram buckets; the final slot
      // is >60s. Grouping establishes correlation, never proof of root cause.
      latencyUpperBoundsMs: [...latencyUpperBoundsMs, null],
      byStatus: Object.fromEntries(statuses.map(status => {
        const group = this.byStatus[status]!;
        return [status, { total: { ...group.total }, latency: [...group.latency],
          stages: Object.fromEntries(stages.map(stage => [stage, { ...group.stages[stage] }])) }];
      })),
      stages: Object.fromEntries(stages.map(stage => [stage, { ...this.measured[stage] }])) as Record<Stage, Timing> };
  }
}
