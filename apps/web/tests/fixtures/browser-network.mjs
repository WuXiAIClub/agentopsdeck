import assert from 'node:assert/strict';

export function permittedRequest(url, method, origin) {
  if (!origin || method !== 'GET') return false;
  const parsed = new URL(url);
  return parsed.origin === origin && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
    && !parsed.username && !parsed.password;
}

// Install before any page exists. No page-level routes may override this fence.
// Without an origin even loopback is forbidden (DOM-only controller fixtures).
export async function fenceContext(context, { origin, api, apiWrites = [] } = {}) {
  const denied = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const syntheticWrite = origin && url.origin === origin && url.hostname === '127.0.0.1'
      && !url.username && !url.password && url.protocol === 'http:' && url.pathname.startsWith('/api/')
      && !url.search && apiWrites.some(write => write.method === request.method() && write.path === url.pathname);
    if (!permittedRequest(url.href, request.method(), origin) && !syntheticWrite) {
      denied.push(url.href); return route.abort('blockedbyclient');
    }
    if (url.pathname.startsWith('/api/')) {
      if (api) return api(route);
      denied.push(url.href); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => { denied.push(socket.url()); socket.close(); });
  return denied;
}

export async function verifyFence(page, denied) {
  assert.deepEqual(denied, [], 'Unexpected fixture traffic');
  // Reserved .invalid names; both attempts must be intercepted, never sent.
  await page.evaluate(async () => {
    await fetch('https://ci-denied.invalid/').then(() => { throw Error('fetch escaped fence'); }, () => {});
    await new Promise(resolve => {
      const socket = new WebSocket('wss://ci-denied.invalid/socket');
      socket.onclose = resolve; socket.onerror = resolve;
    });
  });
  assert.deepEqual(denied, ['https://ci-denied.invalid/', 'wss://ci-denied.invalid/socket']);
  console.log('NETWORK FENCE PASS: HTTP and WebSocket blocked');
}
