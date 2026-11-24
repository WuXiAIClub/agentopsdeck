export const WEBSITE_MAX_BYTES = 512 * 1024;
export type ConnectorWebsite = { id: string; label: string };
export type WebsiteSnapshot = { serviceId: string; label: string; content: string; format: 'html' | 'text'; fetchedAt: number };
export const validWebsiteId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
export function validWebsiteCatalog(value: unknown): value is { services: ConnectorWebsite[] } {
  if (!value || typeof value !== 'object') return false;
  const services = (value as { services?: unknown }).services;
  return Array.isArray(services) && services.length <= 16 && new Set(services.map(s => s?.id)).size === services.length
    && services.every(s => s && validWebsiteId(s.id) && typeof s.label === 'string' && s.label.length > 0 && s.label.length <= 80);
}
export function validWebsiteSnapshot(value: unknown, id: string): value is WebsiteSnapshot {
  if (!value || typeof value !== 'object') return false;
  const s = value as WebsiteSnapshot;
  return s.serviceId === id && validWebsiteId(s.serviceId) && typeof s.label === 'string' && s.label.length > 0 && s.label.length <= 80
    && (s.format === 'html' || s.format === 'text') && typeof s.content === 'string' && new TextEncoder().encode(s.content).length <= WEBSITE_MAX_BYTES
    && Number.isSafeInteger(s.fetchedAt) && s.fetchedAt > 0;
}
