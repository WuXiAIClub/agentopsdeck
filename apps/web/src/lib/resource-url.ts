declare const __AGENTOPSDECK_RESOURCE_ORIGINS__: readonly string[];

export const configuredResourceOrigins: readonly string[] = normalizeResourceOrigins([
  ...(typeof __AGENTOPSDECK_RESOURCE_ORIGINS__ === 'undefined' ? [] : __AGENTOPSDECK_RESOURCE_ORIGINS__),
  ...(typeof document === 'undefined' ? [] : [document.querySelector('meta[name="agentopsdeck-resource-origin"]')?.getAttribute('content') ?? '']),
]);

export function normalizeResourceOrigins(values: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const value of values) {
    try {
      const url = new URL(value.trim());
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) origins.add(url.origin);
    } catch {}
  }
  return [...origins];
}

export function routeResourceUrl(value: string, targetBase: string, trustedOrigins: readonly string[]): string {
  if (!/^(?:https?:\/\/|\/\/)/i.test(value)) return value;
  try {
    const target = new URL(targetBase);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) return value;
    if (/[\\\u0000-\u0020\u007f]/.test(value)) return value;
    const rawPath = value.replace(/^(?:https?:)?\/\/[^/]+/i, '').split(/[?#]/, 1)[0]!;
    if (/%(?:2e|2f|5c|25)/i.test(rawPath) || rawPath.split('/').some(part => part === '.' || part === '..')) return value;
    const source = new URL(value, target);
    if (source.username || source.password || ![target.origin, ...trustedOrigins].includes(source.origin)) return value;
    const path = source.pathname;
    const allowed = /^\/api\/media\/inbound\/[A-Za-z0-9_.-]+$/.test(path)
      || /^\/api\/artifacts\/[a-f0-9]+$/i.test(path)
      || /^\/api\/media-library\/stream$/.test(path)
      || /^\/api\/files\/(?:gateway|agents\/[^/?#]+)\/download$/.test(path)
      || /^\/api\/hub\/v1\/connections\/[^/?#]+\/files\/agents\/[^/?#]+\/download$/.test(path)
      || /^\/api\/hub\/v1\/(?:sessions\/[^/?#]+|shared\/[^/?#]+\/sessions\/[^/?#]+)\/messages\/[^/?#]+\/media\/[a-f0-9]{64}$/.test(path);
    if (!allowed) return value;
    const prefix = target.pathname.replace(/\/+$/, '');
    const routedPath = prefix.endsWith('/api') ? path.slice('/api'.length) : path;
    return target.origin + prefix + routedPath + source.search + source.hash;
  } catch { return value; }
}
