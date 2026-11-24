/** In-memory, bounded UI diagnostics. Never store messages, titles, paths or
 * provider/session IDs, and never send telemetry or create polling traffic. */
type Fact = string | number | boolean | undefined;
type Entry = { at: string; pane: number; stage: string; facts: Record<string, Fact> };
export function createCompletionDiagnostics(limit = 160) {
  const entries: Entry[] = [], aliases = new Map<string, number>();
  let nextAlias = 0;
  return {
    record(key: string, stage: string, facts: Record<string, Fact> = {}) {
      if (!aliases.has(key)) {
        if (aliases.size >= 128) aliases.delete(aliases.keys().next().value!);
        aliases.set(key, ++nextAlias);
      }
      const entry = { at: new Date().toISOString(), pane: aliases.get(key)!, stage, facts: { ...facts } };
      entries.push(entry); if (entries.length > limit) entries.shift();
      return entry;
    },
    read: () => entries.map(entry => ({ ...entry, facts: { ...entry.facts } })),
    clear() { entries.length = 0; aliases.clear(); nextAlias = 0; },
  };
}
const diagnostics = createCompletionDiagnostics();
let consoleEnabled = false;
export function recordCompletionDiagnostic(key: string, stage: string, facts: Record<string, Fact> = {}) {
  const entry = diagnostics.record(key, stage, facts);
  if (consoleEnabled) console.debug('[agentopsdeck:completion]', entry);
}
export const clearCompletionDiagnostics = () => { diagnostics.clear(); consoleEnabled = false; };
export const readCompletionDiagnostics = diagnostics.read;
export function downloadCompletionDiagnostics() {
  const blob = new Blob([JSON.stringify({ version: 1, entries: diagnostics.read() }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = 'agentopsdeck-completion-diagnostics.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
if (typeof window !== 'undefined') {
  Object.assign(window, { __agentopsdeckCompletionDiagnostics: {
    read: diagnostics.read, clear: clearCompletionDiagnostics,
    setConsole: (enabled: boolean) => { consoleEnabled = enabled === true; },
  } });
}
