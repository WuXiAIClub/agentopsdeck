/** Hub-private session tips; deliberately independent of Agent message limits. */
export const NOTEBOOK_MAX_CHARS = 50_000;
/** Cold text is separately fetched and never part of normal card projection. */
export const NOTEBOOK_ARCHIVE_MAX_CHARS = 100_000;
// JSON may escape each UTF-16 code unit as six ASCII bytes; include identity overhead.
export const NOTEBOOK_BODY_MAX_BYTES = NOTEBOOK_ARCHIVE_MAX_CHARS * 6 + 64 * 1024;
export type SessionNotebookDocument = { resourceId: string; text: string; revision: number; updatedAt: number | null };

export type HubNotebookLayout = { title: string; x: number; y: number; width: number; height: number; color: string; opacity: number; hidden: boolean; collapsed: boolean };
export const DEFAULT_HUB_NOTEBOOK_LAYOUT: HubNotebookLayout = { title: '', x: 64, y: 64, width: 372, height: 390, color: '#fff7cc', opacity: .94, hidden: true, collapsed: false };
export function validHubNotebookLayout(value: unknown): value is HubNotebookLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 9 && typeof v.title === 'string' && v.title.length <= 120
    && typeof v.color === 'string' && /^#[a-fA-F0-9]{6}$/.test(v.color)
    && typeof v.hidden === 'boolean' && typeof v.collapsed === 'boolean'
    && typeof v.opacity === 'number' && Number.isFinite(v.opacity) && v.opacity >= .35 && v.opacity <= 1
    && ['x', 'y'].every(key => typeof v[key] === 'number' && Number.isFinite(v[key]) && Math.abs(v[key] as number) <= 100_000)
    && typeof v.width === 'number' && Number.isFinite(v.width) && v.width >= 208 && v.width <= 1600
    && typeof v.height === 'number' && Number.isFinite(v.height) && v.height >= 160 && v.height <= 1600;
}
