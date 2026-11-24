const CACHE_NAME = 'agentopsdeck-shell-v6';
const STATIC_ASSET_RE = /\.(?:js|css|png|svg|webmanifest|ico|woff2?)$/i;
const ownedCache = name => /^agentopsdeck-shell-v\d+$/.test(name);
const clearOwnedCaches = () => caches.keys().then(keys => Promise.all(keys.filter(ownedCache).map(key => caches.delete(key))));
// This page contains no account state and is never a cached authenticated shell.
// Navigation is explicit: reconnecting must not replay a command or discard a draft.
const OFFLINE_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>AgentOpsDeck · Offline</title><style>body{margin:0;font:16px system-ui;background:#101827;color:#e2e8f0;min-height:100dvh;display:grid;place-items:center}main{box-sizing:border-box;width:min(100%,34rem);padding:2rem;overflow-wrap:anywhere}a{display:inline-block;padding:.8rem 1.2rem;border-radius:.6rem;background:#22c55e;color:#052e16;font-weight:700;min-height:24px}p{line-height:1.6}</style><main><h1>AgentOpsDeck 暂时离线</h1><p>无法连接服务。请检查网络或稍后重试。</p><p>此页面不展示缓存会话，也不会排队或重发任何操作。已保存的本地草稿不会被此页面修改。</p><p lang="en">Unable to connect. No commands are queued or replayed. Saved local drafts are unchanged.</p><a href="/">重新连接 / Retry</a></main></html>`;

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
    const client = windows.find(window => new URL(window.url).origin === self.location.origin);
    if (client) return client.focus();
    return self.clients.openWindow('/');
  }));
});

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).catch(() => undefined));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    // Do not delete another application's caches on a shared origin.
    clearOwnedCaches(),
  ]));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'CLEAR_CACHES') {
    event.waitUntil(clearOwnedCaches());
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/api.ts' ||
    url.pathname === '/sw.js' ||
    url.pathname.startsWith('/events')
  ) return;

  if (request.mode === 'navigate') {
    // Always go to network for HTML. A cached app shell is worse than a transient
    // offline miss for this internal control deck because stale /src imports can
    // white-screen the PWA.
    event.respondWith(fetch(request, { cache: 'no-store' }).catch(() => new Response(OFFLINE_PAGE, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" },
    })));
    return;
  }

  if (STATIC_ASSET_RE.test(url.pathname)) {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const clone = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => undefined));
      }
      return response;
    }).catch(async () => (await (await caches.open(CACHE_NAME)).match(request)) || Response.error()));
  }
});
