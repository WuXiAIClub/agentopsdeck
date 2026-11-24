export type SessionRailPreference = { version: 1; width?: number; collapsed?: boolean; navigationCollapsed?: boolean };
export const defaultSessionRailWidth = (viewport: number) => viewport >= 1280 ? 290 : viewport >= 768 ? 201 : 190;
export const navigationRailWidth = (viewport: number) => viewport >= 1280 ? 64 : viewport >= 768 ? 56 : 52;
export const maxSessionRailWidth = (viewport: number) => Math.max(160, Math.min(480, viewport - navigationRailWidth(viewport) - 360));
export function sessionRailWidth(width: number | undefined, viewport: number) {
  return Math.round(Math.max(160, Math.min(maxSessionRailWidth(viewport), Number.isFinite(width) ? width! : defaultSessionRailWidth(viewport))));
}
export function parseSessionRailPreference(raw: string | null): SessionRailPreference {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (!value || value.version !== 1) return { version: 1 };
    return { version: 1,
      ...(typeof value.width === 'number' && Number.isFinite(value.width) ? { width: Math.round(Math.max(160, Math.min(480, value.width))) } : {}),
      ...(typeof value.collapsed === 'boolean' ? { collapsed: value.collapsed } : {}),
      ...(typeof value.navigationCollapsed === 'boolean' ? { navigationCollapsed: value.navigationCollapsed } : {}) };
  } catch { return { version: 1 }; }
}
