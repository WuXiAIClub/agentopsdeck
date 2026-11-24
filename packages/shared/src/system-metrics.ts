/** Deliberately excludes paths, process lists, environment and credentials. */
export type SystemMetrics = {
  version: 1;
  source: { kind: 'hub' | 'connector'; id: string };
  sampledAt: number;
  scope: 'host' | 'cgroup' | 'process';
  cpu: { percent: number | null; cores: number | null };
  memory: { usedBytes: number | null; totalBytes: number | null; availableBytes: number | null };
  volumes: { id: string; totalBytes: number | null; freeBytes: number | null }[];
};

export function validSystemMetrics(v: unknown): v is SystemMetrics {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const m = v as SystemMetrics;
  const n = (v: unknown) => v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0;
  return m.version === 1 && !!m.source && ['hub', 'connector'].includes(m.source.kind)
    && typeof m.source.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(m.source.id)
    && Number.isSafeInteger(m.sampledAt) && m.sampledAt > 0 && ['host', 'cgroup', 'process'].includes(m.scope)
    && !!m.cpu && n(m.cpu.percent) && (m.cpu.percent === null || m.cpu.percent <= 100) && n(m.cpu.cores)
    && !!m.memory && [m.memory.usedBytes, m.memory.totalBytes, m.memory.availableBytes].every(n)
    && Array.isArray(m.volumes) && m.volumes.length <= 16
    && m.volumes.every(v => !!v && typeof v.id === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(v.id) && n(v.totalBytes) && n(v.freeBytes))
    && new Set(m.volumes.map(v => v.id)).size === m.volumes.length;
}

/** Pick known fields, never forward arbitrary provider properties. */
export function publicSystemMetrics(m: SystemMetrics): SystemMetrics {
  return { version: 1, source: { kind: m.source.kind, id: m.source.id }, sampledAt: m.sampledAt, scope: m.scope,
    cpu: { percent: m.cpu.percent, cores: m.cpu.cores }, memory: { usedBytes: m.memory.usedBytes,
      totalBytes: m.memory.totalBytes, availableBytes: m.memory.availableBytes },
    volumes: m.volumes.map(v => ({ id: v.id, totalBytes: v.totalBytes, freeBytes: v.freeBytes })) };
}
