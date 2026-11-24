/** Display bindings are device/account-local, never part of a synced layout. */
export type DisplayProfile = { width: number; height: number; label?: string; left?: number; top?: number; internal?: boolean };
export type DisplayBindings = { version: 1; enabled: boolean; bindings: { layoutId: string; display: DisplayProfile }[] };
export const emptyDisplayBindings = (): DisplayBindings => ({ version: 1, enabled: true, bindings: [] });
export function validDisplay(value: unknown): value is DisplayProfile {
  if (!value || typeof value !== 'object') return false;
  const v = value as DisplayProfile;
  return [v.width, v.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 65536)
    && (v.label === undefined || typeof v.label === 'string' && v.label.length <= 256)
    && [v.left, v.top].every(n => n === undefined || Number.isSafeInteger(n) && Math.abs(n) <= 1_000_000)
    && (v.internal === undefined || typeof v.internal === 'boolean');
}
export function displayKey(display: DisplayProfile): string {
  return JSON.stringify([display.width, display.height, display.label ?? null, display.left ?? null, display.top ?? null, display.internal ?? null]);
}
export function parseDisplayBindings(text: string | null): DisplayBindings {
  try {
    if (!text || text.length > 65536) return emptyDisplayBindings();
    const v = JSON.parse(text) as DisplayBindings;
    if (v.version !== 1 || typeof v.enabled !== 'boolean' || !Array.isArray(v.bindings) || v.bindings.length > 50) return emptyDisplayBindings();
    const ids = new Set<string>(), displays = new Set<string>();
    for (const item of v.bindings) {
      if (!item || typeof item.layoutId !== 'string' || !item.layoutId || item.layoutId.length > 4096 || !validDisplay(item.display)) return emptyDisplayBindings();
      const key = displayKey(item.display);
      if (ids.has(item.layoutId) || displays.has(key)) return emptyDisplayBindings();
      ids.add(item.layoutId); displays.add(key);
    }
    return v;
  } catch { return emptyDisplayBindings(); }
}
export function bindDisplay(state: DisplayBindings, layoutId: string, display: DisplayProfile): DisplayBindings {
  return { ...state, bindings: [...state.bindings.filter(b => b.layoutId !== layoutId && displayKey(b.display) !== displayKey(display)), { layoutId, display }] };
}
export function matchingDisplayLayout(state: DisplayBindings, display: DisplayProfile, ids: ReadonlySet<string>): string | undefined {
  if (!state.enabled) return;
  const candidates = state.bindings.filter(b => ids.has(b.layoutId));
  const exact = candidates.find(b => displayKey(b.display) === displayKey(display));
  if (exact) return exact.layoutId;
  // A dimensions-only binding may still work after permission is granted.
  // Never downgrade a detailed binding when permission is lost, or guess among
  // identical monitors: that could load another monitor's layout unexpectedly.
  return candidates.find(b => b.display.label === undefined && b.display.left === undefined && b.display.top === undefined && b.display.internal === undefined
    && b.display.width === display.width && b.display.height === display.height)?.layoutId;
}
