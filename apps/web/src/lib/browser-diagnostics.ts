/** Local transport evidence, not telemetry or authority. No free-form strings,
 * URLs, bodies, exceptions, identities or receipt keys cross this boundary. */
export type DiagnosticLevel = 'off' | 'errors' | 'debug';
type DiagnosticEvent = 'request-ok' | 'request-http' | 'request-format' | 'request-failed'
  | 'request-cancelled' | 'request-timeout' | 'stream-retry' | 'stream-connected';
type Facts = { status?: number | undefined; elapsedMs?: number; attempts?: number; retryMs?: number; mutation?: boolean };
type Entry = { sequence: number; event: DiagnosticEvent; facts: Facts };
const events: readonly DiagnosticEvent[] = ['request-ok', 'request-http', 'request-format', 'request-failed',
  'request-cancelled', 'request-timeout', 'stream-retry', 'stream-connected'];

export function createBrowserDiagnostics() {
  let level: DiagnosticLevel = 'errors', sequence = 0;
  const entries: Entry[] = [], listeners = new Set<() => void>();
  return {
    level: () => level,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setLevel(next: DiagnosticLevel) {
      if (next === level || !['off', 'errors', 'debug'].includes(next)) return;
      level = next;
      // Reducing detail must not leave previously captured debug records.
      entries.length = 0;
      listeners.forEach(listener => listener());
    },
    clear() { entries.length = 0; sequence = 0; },
    record(event: DiagnosticEvent, facts: Facts = {}) {
      if (level === 'off' || !events.includes(event)
        || level === 'errors' && ['request-ok', 'request-cancelled', 'stream-connected'].includes(event)) return;
      const safe: Facts = {};
      for (const key of ['status', 'elapsedMs', 'attempts', 'retryMs'] as const) {
        const value = facts[key];
        if (typeof value === 'number' && Number.isFinite(value)) safe[key] = Math.max(0, Math.min(3_600_000, Math.round(value)));
      }
      if (typeof facts.mutation === 'boolean') safe.mutation = facts.mutation;
      entries.push({ sequence: ++sequence, event, facts: safe });
      if (entries.length > 160) entries.shift();
    },
    read: () => entries.map(entry => ({ ...entry, facts: { ...entry.facts } })),
  };
}
export const browserDiagnostics = createBrowserDiagnostics();
export function downloadBrowserDiagnostics() {
  const blob = new Blob([JSON.stringify({ version: 1, level: browserDiagnostics.level(), entries: browserDiagnostics.read() }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  try { link.href = url; link.download = 'agentopsdeck-browser-diagnostics.json'; link.click(); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
if (typeof window !== 'undefined') Object.assign(window, { __agentopsdeckBrowserDiagnostics: {
  read: browserDiagnostics.read, clear: browserDiagnostics.clear,
  setLevel: browserDiagnostics.setLevel, level: browserDiagnostics.level,
} });
