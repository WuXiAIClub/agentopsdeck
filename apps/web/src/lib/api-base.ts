export function resolveApiBaseUrl(location: { hostname: string; protocol: string }, runtimeOverride?: string | null, globalOverride?: unknown) {
  const host = location.hostname;
  const isLocalHost = host === 'localhost' || host === '127.0.0.1';
  const isPrivateLan = host.startsWith('10.') || host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  for (const override of [runtimeOverride, globalOverride]) {
    if (typeof override !== 'string' || !override.trim()) continue;
    try {
      const url = new URL(override.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) continue;
      if (location.protocol === 'https:' && !isLocalHost && !isPrivateLan && url.protocol !== 'https:') continue;
      return override.trim().replace(/\/+$/, '');
    } catch { /* Invalid or stale configuration falls back to same-origin. */ }
  }
  return '';
}
