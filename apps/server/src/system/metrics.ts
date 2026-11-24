import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { validSystemMetrics, type SystemMetrics } from '@agentopsdeck/shared';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

export type RawMetrics = {
  scope: SystemMetrics['scope']; identity: string; clock: number; busy: number; capacity: number; cores: number | null;
  memory: SystemMetrics['memory']; volumes: SystemMetrics['volumes'];
};
export function parseMetricVolumes(value?: string): Record<string, string> {
  if (!value?.trim()) return {};
  const fail = () => new Error('Invalid metric volume allowlist');
  let v: unknown; try { v = JSON.parse(value); } catch { throw fail(); }
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length > 16) throw fail();
  for (const [id, path] of Object.entries(v)) if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id)
    || ['__proto__', 'prototype', 'constructor'].includes(id) || typeof path !== 'string'
    || path.length > 4096 || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw fail();
  return v as Record<string, string>;
}
const number = (v: string | undefined) => v && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
const read = (path: string, signal: AbortSignal) => readFile(path, { encoding: 'utf8', signal });

/** Fixed kernel files only. Unsupported/ambiguous isolation falls back to process,
 * never labels process RSS or a container's visible host memory as its limit. */
export function linuxMetricsProvider(volumes: Record<string, string> = {}, kernel = {
  read, platform: process.platform, parallelism: availableParallelism, totalMemory: totalmem, cpuCount: () => cpus().length,
}) {
  return async (signal: AbortSignal): Promise<RawMetrics> => {
    const clock = performance.now() * 1000;
    let raw: RawMetrics;
    const usage = process.cpuUsage();
    raw = { scope: 'process', identity: `process:${process.pid}`, clock, busy: usage.user + usage.system,
      capacity: clock, cores: 1, memory: { usedBytes: process.memoryUsage().rss, totalBytes: null, availableBytes: null }, volumes: [] };
    if (kernel.platform === 'linux') {
      try {
        const group = await kernel.read('/proc/self/cgroup', signal);
        const membership = group.split('\n').find(line => line.startsWith('0::'))?.slice(3);
        if (membership !== undefined) {
          if (!membership.startsWith('/') || membership.split('/').includes('..') || /[\x00-\x1f]/.test(membership)) throw Error('Unsupported cgroup');
          const root = join('/sys/fs/cgroup', membership);
          const [stat, used] = await Promise.all(['cpu.stat', 'memory.current'].map(p => kernel.read(join(root, p), signal)));
          const busy = number(stat!.match(/^usage_usec (\d+)$/m)?.[1]);
          let cores = kernel.parallelism(), totalBytes: number | null = null, availableBytes: number | null = null;
          const usedBytes = number(used!.trim());
          // Limits are hierarchical: an unlimited child may still be tightly
          // constrained by an ancestor. Bound traversal and fail closed if an
          // intermediate controller is not readable. The unified root does not
          // expose these controller files; it cannot impose a cgroup quota.
          let path = root, depth = 0;
          while (path !== '/sys/fs/cgroup') {
            if (++depth > 32) throw Error('Unsupported cgroup depth');
            const [quota, limit, current] = await Promise.all(['cpu.max', 'memory.max', 'memory.current'].map(p => kernel.read(join(path, p), signal)));
            const [q, period] = quota!.trim().split(/\s+/), quotaNumber = number(q), periodNumber = number(period);
            if (!periodNumber || q !== 'max' && !quotaNumber) throw Error('Unsupported quota');
            if (quotaNumber !== null) cores = Math.min(cores, quotaNumber / periodNumber);
            const limitNumber = limit!.trim() === 'max' ? null : number(limit!.trim()), currentNumber = number(current!.trim());
            if (currentNumber === null || limit!.trim() !== 'max' && limitNumber === null) throw Error('Unsupported memory');
            if (limitNumber !== null) {
              totalBytes = totalBytes === null ? limitNumber : Math.min(totalBytes, limitNumber);
              const remaining = Math.max(0, limitNumber - currentNumber);
              availableBytes = availableBytes === null ? remaining : Math.min(availableBytes, remaining);
            }
            path = dirname(path);
          }
          // A namespaced root hides its ancestors. We cannot infer host totals
          // from that view, so use the explicitly labelled process fallback.
          if (!depth) throw Error('Unknown cgroup ancestors');
          if (busy === null || !cores || usedBytes === null) throw Error('Unsupported cgroup');
          const unconstrainedHostCgroup = totalBytes === null && cores >= kernel.parallelism();
          let resolvedHost = false;
          if (unconstrainedHostCgroup) {
            try {
              const [hostStat, hostMem] = await Promise.all([kernel.read('/proc/stat', signal), kernel.read('/proc/meminfo', signal)]);
              const ticks = hostStat.match(/^cpu\s+([\d ]+)$/m)?.[1]?.trim().split(/\s+/).slice(0, 8).map(Number);
              const available = number(hostMem.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]);
              if (ticks && ticks.length >= 5 && available !== null) {
                const capacity = ticks.reduce((a, b) => a + b, 0);
                const hostTotalBytes = kernel.totalMemory();
                const hostAvailableBytes = Math.min(hostTotalBytes, available * 1024);
                raw = {
                  ...raw,
                  scope: 'host',
                  identity: `host:${kernel.cpuCount()}`,
                  capacity,
                  busy: capacity - ticks[3]! - ticks[4]!,
                  cores: kernel.cpuCount(),
                  memory: {
                    totalBytes: hostTotalBytes,
                    availableBytes: hostAvailableBytes,
                    usedBytes: hostTotalBytes - hostAvailableBytes,
                  },
                };
                resolvedHost = true;
              }
            } catch {
              signal.throwIfAborted();
            }
          }
          if (!resolvedHost) {
            raw = { ...raw, scope: 'cgroup', identity: `cgroup:${membership}:${cores}`, busy, capacity: clock * cores, cores,
              memory: { usedBytes, totalBytes, availableBytes } };
          }
        } else if (!group.trim()) {
          // No cgroup controllers: host accounting. Legacy/unknown controllers
          // are conservatively process-only rather than guessed to be host.
          const [stat, mem] = await Promise.all([kernel.read('/proc/stat', signal), kernel.read('/proc/meminfo', signal)]);
          const ticks = stat.match(/^cpu\s+([\d ]+)$/m)?.[1]?.trim().split(/\s+/).slice(0, 8).map(Number);
          const available = number(mem.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]);
          if (!ticks || ticks.length < 5 || available === null) throw Error('Unsupported host');
          const capacity = ticks.reduce((a, b) => a + b, 0), totalBytes = kernel.totalMemory(), availableBytes = Math.min(totalBytes, available * 1024);
          raw = { ...raw, scope: 'host', identity: `host:${kernel.cpuCount()}`, capacity,
            busy: capacity - ticks[3]! - ticks[4]!, cores: kernel.cpuCount(), memory: { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes } };
        }
      } catch { signal.throwIfAborted(); /* Explicit process scope remains usable. */ }
    }
    raw.volumes = await Promise.all(Object.entries(volumes).map(async ([id, path]) => {
      try { const s = await statfs(path); signal.throwIfAborted(); return { id, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize }; }
      catch { signal.throwIfAborted(); return { id, totalBytes: null, freeBytes: null }; }
    }));
    return raw;
  };
}

/** Shared per-node single flight and five-second cache; a timeout never starts
 * another provider until the first actually settles (bounded stuck I/O). */
export class MetricsSampler {
  private previous?: RawMetrics;
  private value?: SystemMetrics;
  private cachedAt = -Infinity;
  private flight: Promise<SystemMetrics> | undefined;
  private original: Promise<SystemMetrics> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private closing: Promise<void> | undefined;
  constructor(private source: SystemMetrics['source'], private provider = linuxMetricsProvider(),
    private now = Date.now, private timeoutMs = 5000, private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw Error('Invalid metrics timeout');
  }
  sample(): Promise<SystemMetrics> {
    if (this.stopped) return Promise.reject(Error('Metrics closed'));
    if (this.flight) return this.flight;
    if (this.value && this.now() - this.cachedAt >= 0 && this.now() - this.cachedAt < 5000) return Promise.resolve(this.value);
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    let timedOut = false;
    const work = Promise.resolve().then(async () => {
      // Published original ownership precedes provider reentry into close().
      const trace = guardedTrace(this.diagnostics, 'system-read-wait'); trace.add('step', 4);
      const warning = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000); warning.unref(); let failed = true;
      try {
        if (this.stopped) throw Error('Metrics closed');
        trace.add('admitted', 1);
        if (this.stopped) throw Error('Metrics closed');
        const raw = await this.provider(abort.signal); failed = false; return raw;
      } finally { clearTimeout(warning); trace.add('settled', 1); trace.finish(failed); }
    }).then(raw => {
      if (timedOut || this.stopped) throw Error(timedOut ? 'Metrics timed out' : 'Metrics closed');
      const old = this.previous, busy = old ? raw.busy - old.busy : -1, capacity = old ? raw.capacity - old.capacity : -1;
      const percent = old?.identity === raw.identity && raw.clock > old.clock && busy >= 0 && capacity > 0 ? Math.min(100, 100 * busy / capacity) : null;
      const value: SystemMetrics = { version: 1, source: this.source, sampledAt: this.now(), scope: raw.scope,
        cpu: { percent, cores: raw.cores }, memory: raw.memory, volumes: raw.volumes };
      if (![raw.busy, raw.capacity, raw.clock].every(n => Number.isFinite(n) && n >= 0) || !validSystemMetrics(value)) throw Error('Invalid metrics');
      this.previous = raw; this.cachedAt = value.sampledAt;
      return this.value = value;
    });
    this.original = work; this.controller = abort;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; abort.abort(); reject(Error('Metrics timed out')); }, this.timeoutMs); });
    const flight = Promise.race([work, timeout]); this.flight = flight;
    const settled = () => {
      clearTimeout(timer);
      if (this.flight === flight) this.flight = undefined;
      if (this.original === work) { this.original = undefined; this.controller = undefined; }
    };
    void work.then(settled, settled);
    return flight;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    // Ending the shared HTTP race is not an original provider completion.
    const original = this.original;
    this.closing = Promise.resolve().then(async () => {
      const trace = guardedTrace(this.diagnostics, 'system-read-wait'); trace.add('step', 5); trace.add('pending', original ? 1 : 0);
      const warning = setTimeout(() => trace.reportPending({ pending: this.original ? 1 : 0 }), 30_000); warning.unref(); let failed = false;
      try { await original; } catch { failed = true; }
      finally { clearTimeout(warning); trace.add('settled', original ? 1 : 0); trace.finish(failed); }
    });
    this.controller?.abort();
    return this.closing;
  }
}
