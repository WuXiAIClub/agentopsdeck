export const fontScales = [80, 90, 100, 110] as const;
export type FontScale = number;
export const fontScaleMin = 70;
export const fontScaleMax = 140;
export function fontScaleMinimum(area: FontArea): number { return area === 'notebooks' ? 70 : 75; }
/** Small magnetic stops while dragging; keyboard arrows remain continuous. */
export function snapFontScale(value: number, area: FontArea = 'notebooks'): number {
  const bounded = Math.max(fontScaleMinimum(area), Math.min(fontScaleMax, Math.round(value)));
  return fontScales.find(preset => Math.abs(preset - bounded) <= 1) ?? bounded;
}
export type FontArea = 'sessions' | 'chat' | 'notebooks';
export type FontPreferences = { version: 1 } & Record<FontArea, FontScale>;
export const defaultFontPreferences = (): FontPreferences => ({ version: 1, sessions: 100, chat: 100, notebooks: 100 });
export function isFontScale(value: unknown): value is FontScale {
  return typeof value === 'number' && Number.isInteger(value) && value >= fontScaleMin && value <= fontScaleMax;
}
export function parseFontPreferences(raw: string | null): FontPreferences {
  const result = defaultFontPreferences();
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return result;
    const record = value as Record<string, unknown>;
    for (const area of ['sessions', 'chat', 'notebooks'] as const) {
      if (isFontScale(record[area])) result[area] = Math.max(fontScaleMinimum(area), record[area]);
    }
  } catch { /* Corrupt/blocked browser storage never blocks the workspace. */ }
  return result;
}
export function fontPreferenceKey(scope: string | undefined): string | undefined {
  return scope ? `agentopsdeck.font-preferences.v1:${scope}` : undefined;
}
