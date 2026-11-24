/** Actions are separately configured operations, never URLs supplied by a client. */
export type WebsiteAction = { id: string; label: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; contentType: 'application/json' | 'text/plain' | 'application/octet-stream'; maxBytes: number; download?: { filename: string; maxBytes: number }; csrf?: boolean };
export type WebsiteActionReceipt = { state: 'ready' | 'pending' | 'completed' | 'unknown'; status?: number; text?: string; file?: { filename: string; base64: string } };
export const WEBSITE_ACTION_BYTES = 64 * 1024;
export const WEBSITE_ACTION_FILE_BYTES = 1024 * 1024;
export const WEBSITE_ACTION_ENVELOPE_BYTES = 1500 * 1024;
export const validWebsiteFilename = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}$/.test(v) && !v.endsWith('.') && !v.endsWith(' ');
export function websiteBase64Bytes(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length > Math.ceil(WEBSITE_ACTION_FILE_BYTES / 3) * 4
    || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) return;
  try { const raw = atob(value); return raw.length <= WEBSITE_ACTION_FILE_BYTES && btoa(raw) === value ? raw.length : undefined; } catch { return; }
}
export function validWebsiteActions(value: unknown): value is { actions: WebsiteAction[]; session?: boolean } {
  if (!value || typeof value !== 'object') return false;
  const actions = (value as { actions?: unknown }).actions;
  return ((value as { session?: unknown }).session === undefined || typeof (value as { session?: unknown }).session === 'boolean')
    && Array.isArray(actions) && actions.length <= 16 && new Set(actions.map(a => a?.id)).size === actions.length
    && actions.every(a => a && typeof a.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(a.id) && typeof a.label === 'string' && a.label.length > 0 && a.label.length <= 80
      && !/[\x00-\x1f\x7f]/.test(a.label) && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(a.method)
      && ['application/json', 'text/plain', 'application/octet-stream'].includes(a.contentType) && Number.isSafeInteger(a.maxBytes) && a.maxBytes >= 0 && a.maxBytes <= (a.contentType === 'application/octet-stream' ? WEBSITE_ACTION_FILE_BYTES : WEBSITE_ACTION_BYTES)
      && (a.csrf === undefined || typeof a.csrf === 'boolean')
      && (a.method !== 'GET' || a.maxBytes === 0 && a.contentType === 'text/plain' && a.download !== undefined)
      && (a.download === undefined || a.method === 'GET' && a.download && Object.keys(a.download).length === 2 && validWebsiteFilename(a.download.filename)
        && Number.isSafeInteger(a.download.maxBytes) && a.download.maxBytes > 0 && a.download.maxBytes <= WEBSITE_ACTION_FILE_BYTES));
}
export function validWebsiteActionReceipt(value: unknown): value is WebsiteActionReceipt {
  if (!value || typeof value !== 'object') return false;
  const r = value as WebsiteActionReceipt;
  if (Object.keys(r).some(k => !['state', 'status', 'text', 'file'].includes(k))) return false;
  if (r.state === 'ready' || r.state === 'pending' || r.state === 'unknown') return r.status === undefined && r.text === undefined && r.file === undefined;
  return r.state === 'completed' && Number.isInteger(r.status) && r.status! >= 200 && r.status! <= 599
    && !(r.status! >= 300 && r.status! < 400) && typeof r.text === 'string' && new TextEncoder().encode(r.text).length <= WEBSITE_ACTION_BYTES
    && (r.file === undefined || r.status! < 300 && r.file !== null && Object.keys(r.file).length === 2 && validWebsiteFilename(r.file.filename) && websiteBase64Bytes(r.file.base64) !== undefined);
}
