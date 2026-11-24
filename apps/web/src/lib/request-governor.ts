export type RefreshPolicyMode = 'auto' | 'high' | 'balanced' | 'saver';
export type RequestPriorityTier = 'p0' | 'p1' | 'p2' | 'p3';
export type GovernorRegime = 'boosted' | 'normal' | 'conserving' | 'throttled';
export type ServerTimingMetrics = { appMs?: number; connectorWaitMs?: number; hydrateWaitMs?: number; sqlMs?: number };
export type RequestSampleInput = {
  path?: string | undefined; method?: string | undefined; status?: number | undefined; elapsedMs: number;
  priority?: RequestPriorityTier | undefined; cancelled?: boolean | undefined; timedOut?: boolean | undefined;
  serverTiming?: ServerTimingMetrics | string | null | undefined;
};
export type DeviceResourceProfile = { cores: number; memoryGb: number; saveData: boolean; effectiveType: string; capable: boolean; constrained: boolean };
export type RequestGovernorSnapshot = {
  policy: RefreshPolicyMode; regime: GovernorRegime; intervalMultiplier: number; effectiveConcurrency: number;
  allowBackgroundPreload: boolean; inFlight: number; requestsPerSecond: number; requestsPerMinute: number;
  avgLatencyMs: number; p95LatencyMs: number; backendAppMs: number; backendConnectorWaitMs: number; backendSqlMs: number;
  counts: { total60s: number; ok2xx: number; notModified304: number; accepted202: number; throttled429: number; error5xx: number; timeouts: number; cancelled: number; p0Critical: number; p1Active: number; p2Visible: number; p3Background: number };
  device: DeviceResourceProfile;
};
const KEY = 'agentopsdeck.refresh-policy.v1';
export function parseServerTimingHeader(header: string | null | undefined): ServerTimingMetrics {
  if (!header) return {};
  const out: ServerTimingMetrics = {};
  for (const part of header.split(',')) {
    const segs = part.trim().split(';').map(s => s.trim()), name = segs[0], durSeg = segs.find(s => s.startsWith('dur='));
    const dur = durSeg ? Number(durSeg.slice(4)) : NaN;
    if (!name || !Number.isFinite(dur) || dur < 0) continue;
    if (name === 'app') out.appMs = dur;
    else if (name === 'connectorWait') out.connectorWaitMs = dur;
    else if (name === 'hydrateWait') out.hydrateWaitMs = dur;
    else if (name === 'sql') out.sqlMs = dur;
  }
  return out;
}
export function classifyRequestPriority(path: string | undefined, method = 'GET', init?: { calibration?: boolean | undefined; conditionalHistory?: boolean | undefined }): RequestPriorityTier {
  const m = method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') {
    if (path?.startsWith('/api/hub/v1/workspace/check') || path?.includes('/completion-summary')) return 'p3';
    if (path?.startsWith('/api/hub/v1/workspace/sync')) return 'p2';
    return 'p0';
  }
  if (!path) return 'p2';
  if (init?.calibration || path.includes('/completion-summary') || path.includes('/shared-content/')) return 'p3';
  if (path.includes('/messages') || path.includes('/sessions/state') || path.includes('/me')) return 'p1';
  return 'p2';
}
export function detectDeviceResourceProfile(nav?: unknown): DeviceResourceProfile {
  const n = (nav ?? (typeof navigator !== 'undefined' ? navigator : undefined)) as any;
  const cores = n?.hardwareConcurrency > 0 ? n.hardwareConcurrency : 4, memoryGb = n?.deviceMemory > 0 ? n.deviceMemory : 4;
  const saveData = Boolean(n?.connection?.saveData), effectiveType = typeof n?.connection?.effectiveType === 'string' ? n.connection.effectiveType : '4g';
  const constrained = saveData || ['slow-2g', '2g', '3g'].includes(effectiveType) || cores <= 2 || memoryGb <= 2;
  return { cores, memoryGb, saveData, effectiveType, capable: !constrained && cores >= 4 && memoryGb >= 4, constrained };
}
export function createRequestGovernor(options: { now?: () => number; initialPolicy?: RefreshPolicyMode; deviceProfile?: () => DeviceResourceProfile } = {}) {
  const nowFn = options.now ?? Date.now, getDevice = options.deviceProfile ?? detectDeviceResourceProfile;
  let policy: RefreshPolicyMode = options.initialPolicy ?? (() => { try { const v = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null; return v === 'auto' || v === 'high' || v === 'balanced' || v === 'saver' ? v : 'auto'; } catch { return 'auto'; } })();
  let inFlight = 0;
  const samples: Array<{ at: number; status: number; elapsedMs: number; priority: RequestPriorityTier; cancelled: boolean; timedOut: boolean; appMs?: number; connectorWaitMs?: number; sqlMs?: number }> = [];
  const listeners = new Set<() => void>();
  const prune = (now: number) => { while (samples.length && samples[0]!.at < now - 60_000) samples.shift(); while (samples.length > 360) samples.shift(); };
  const snapshot = (): RequestGovernorSnapshot => {
    const now = nowFn(); prune(now);
    const device = getDevice(), cut10 = now - 10_000;
    let r10 = 0, r5xx = 0, r429 = 0, r202 = 0, rTo = 0, ok2xx = 0, notModified304 = 0, accepted202 = 0, throttled429 = 0, error5xx = 0, timeouts = 0, cancelled = 0, p0 = 0, p1 = 0, p2 = 0, p3 = 0;
    const lat: number[] = [], app: number[] = [], cw: number[] = [], sql: number[] = [];
    for (const s of samples) {
      if (s.at >= cut10) { r10++; if (s.status >= 500) r5xx++; if (s.status === 429) r429++; if (s.status === 202) r202++; if (s.timedOut) rTo++; }
      if (s.priority === 'p0') p0++; else if (s.priority === 'p1') p1++; else if (s.priority === 'p2') p2++; else p3++;
      if (s.cancelled) { cancelled++; continue; }
      if (s.timedOut) { timeouts++; continue; }
      if (s.status === 304) notModified304++; else if (s.status === 202) accepted202++; else if (s.status === 429) throttled429++; else if (s.status >= 500) error5xx++; else if (s.status >= 200 && s.status < 300) ok2xx++;
      if (s.elapsedMs >= 0) lat.push(s.elapsedMs);
      if (s.appMs !== undefined) app.push(s.appMs);
      if (s.connectorWaitMs !== undefined) cw.push(s.connectorWaitMs);
      if (s.sqlMs !== undefined) sql.push(s.sqlMs);
    }
    const avg = (a: number[]) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
    const avgLatencyMs = avg(lat), sorted = [...lat].sort((a, b) => a - b);
    const p95LatencyMs = sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!) : 0;
    const backendAppMs = avg(app.slice(-16)), backendConnectorWaitMs = avg(cw.slice(-16)), backendSqlMs = avg(sql.slice(-16));
    const requestsPerSecond = Math.round((r10 / 10) * 10) / 10;
    const severe = r5xx >= 1 || r429 >= 1 || rTo >= 1 || backendConnectorWaitMs > 1_200 || avgLatencyMs > 1_500 || requestsPerSecond > 8;
    const moderate = r202 >= 2 || backendAppMs > 350 || backendConnectorWaitMs > 500 || avgLatencyMs > 650 || requestsPerSecond > 4.5 || inFlight >= 4;
    const fast = samples.length >= 2 && !r5xx && !r429 && !r202 && !rTo && avgLatencyMs > 0 && avgLatencyMs <= 280 && backendAppMs <= 140 && backendConnectorWaitMs <= 180 && inFlight <= 2 && requestsPerSecond <= 2.5;
    let regime: GovernorRegime = 'normal', intervalMultiplier = 1.0, effectiveConcurrency = 2, allowBackgroundPreload = true;
    if (severe) { regime = 'throttled'; intervalMultiplier = 2.5; effectiveConcurrency = 1; allowBackgroundPreload = false; }
    else if (policy === 'saver' || device.constrained || moderate) { regime = 'conserving'; intervalMultiplier = policy === 'saver' ? 1.75 : 1.5; effectiveConcurrency = 1; allowBackgroundPreload = false; }
    else if (policy === 'high' || (policy === 'auto' && device.capable && fast)) { regime = 'boosted'; intervalMultiplier = policy === 'high' ? 0.65 : 0.75; effectiveConcurrency = 3; }
    return { policy, regime, intervalMultiplier, effectiveConcurrency, allowBackgroundPreload, inFlight, requestsPerSecond, requestsPerMinute: samples.length, avgLatencyMs, p95LatencyMs, backendAppMs, backendConnectorWaitMs, backendSqlMs,
      counts: { total60s: samples.length, ok2xx, notModified304, accepted202, throttled429, error5xx, timeouts, cancelled, p0Critical: p0, p1Active: p1, p2Visible: p2, p3Background: p3 }, device };
  };
  return {
    beginRequest: () => { inFlight++; let done = false; return () => { if (!done) { done = true; inFlight = Math.max(0, inFlight - 1); } }; },
    record(input: RequestSampleInput) {
      const now = nowFn(); prune(now);
      const t = typeof input.serverTiming === 'string' || input.serverTiming === null ? parseServerTimingHeader(input.serverTiming) : (input.serverTiming ?? {});
      samples.push({ at: now, status: input.status ?? 0, elapsedMs: Math.max(0, Math.round(input.elapsedMs)), priority: input.priority ?? classifyRequestPriority(input.path, input.method),
        cancelled: Boolean(input.cancelled), timedOut: Boolean(input.timedOut), ...(t.appMs !== undefined ? { appMs: t.appMs } : {}), ...(t.connectorWaitMs !== undefined ? { connectorWaitMs: t.connectorWaitMs } : {}), ...(t.sqlMs !== undefined ? { sqlMs: t.sqlMs } : {}) });
    },
    policy: () => policy,
    setPolicy(next: RefreshPolicyMode) {
      if ((next !== 'auto' && next !== 'high' && next !== 'balanced' && next !== 'saver') || policy === next) return;
      policy = next; try { if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, next); } catch {}
      listeners.forEach(fn => fn());
    },
    snapshot,
    intervalMultiplier: () => snapshot().intervalMultiplier,
    effectiveConcurrency: () => snapshot().effectiveConcurrency,
    allowBackgroundPreload: () => snapshot().allowBackgroundPreload,
    shouldAdmitPriority(p: number) { const s = snapshot(); return p <= 1 ? true : p >= 3 ? s.allowBackgroundPreload : !(s.regime === 'throttled' && s.inFlight >= 2); },
    clear() { samples.length = 0; listeners.forEach(fn => fn()); },
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
export const requestGovernor = createRequestGovernor();
