// Drafts stay in memory, never in saved layouts. Block destructive host changes.
const guards = new Map<string, () => boolean>();
export function registerFileEditorGuard(id: string, ready: () => boolean) {
  guards.set(id, ready);
  return () => { if (guards.get(id) === ready) guards.delete(id); };
}
export function fileEditorsReady(id?: string) {
  return id ? (guards.get(id)?.() ?? true) : [...guards.values()].every(ready => ready());
}
