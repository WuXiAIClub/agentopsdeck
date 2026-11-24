import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { normalizeResourceOrigins, routeResourceUrl } from './resource-url.js';

const publicOrigin = 'https://deck.example.com';
const syntheticUserinfoOrigin = (host: string) => ['https://', 'user:password', '@', host].join('');
const lanOrigin = 'http://192.168.1.10:8790';
const otherLanOrigin = 'http://192.168.1.11:8790';
const trusted = [publicOrigin, lanOrigin, otherLanOrigin];
const hash = 'a'.repeat(64);
const paths = [
  '/api/media/inbound/video.mp4', '/api/artifacts/012345abcdef', '/api/media-library/stream',
  '/api/files/gateway/download', '/api/files/agents/agent-1/download',
  '/api/hub/v1/connections/connection-1/files/agents/agent-1/download',
  `/api/hub/v1/sessions/hub%3Adefault/messages/msg-1/media/${hash}`,
  `/api/hub/v1/shared/grant-1/sessions/session-1/messages/msg-1/media/${hash}`,
];

test('prebuilt frontend reads the runtime public origin without build-time aliases', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    querySelector(selector: string) {
      assert.equal(selector, 'meta[name="agentopsdeck-resource-origin"]');
      return { getAttribute(name: string) { assert.equal(name, 'content'); return publicOrigin + '/'; } };
    },
  } });
  try {
    const runtime = await import(new URL('./resource-url.js?runtime-origin', import.meta.url).href);
    assert.deepEqual(runtime.configuredResourceOrigins, [publicOrigin]);
    for (const path of paths) {
      const suffix = '?signature=abc%2Bdef&expires=123#preview';
      assert.equal(runtime.routeResourceUrl(publicOrigin + path + suffix, lanOrigin, runtime.configuredResourceOrigins), lanOrigin + path + suffix);
      assert.equal(runtime.routeResourceUrl(publicOrigin + path + suffix, publicOrigin, runtime.configuredResourceOrigins), publicOrigin + path + suffix);
      assert.equal(runtime.routeResourceUrl('https://third-party.example' + path, lanOrigin, runtime.configuredResourceOrigins), 'https://third-party.example' + path);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('every approved download and playback path follows LAN or public access', () => {
  for (const path of paths) {
    const suffix = '?path=a%2Fb&signature=abc%2Bdef&expires=123#preview';
    for (const target of trusted) for (const source of trusted) {
      assert.equal(routeResourceUrl(source + path + suffix, target, trusted), target + path + suffix);
    }
  }
});

test('same-origin resources work without configured aliases and routing is idempotent', () => {
  const url = lanOrigin + paths[0];
  assert.equal(routeResourceUrl(url, lanOrigin, []), url);
  assert.equal(routeResourceUrl(routeResourceUrl(publicOrigin + paths[0], lanOrigin, trusted), lanOrigin, trusted), url);
});

test('API base prefixes and protocol-relative links remain compatible', () => {
  assert.equal(routeResourceUrl(publicOrigin + paths[0], lanOrigin + '/api/', trusted), lanOrigin + paths[0]);
  assert.equal(routeResourceUrl(publicOrigin + paths[0], lanOrigin + '/deck', trusted), lanOrigin + '/deck' + paths[0]);
  assert.equal(routeResourceUrl('//deck.example.com' + paths[0], publicOrigin, trusted), publicOrigin + paths[0]);
});

test('external origins, unrelated API operations and non-network URLs are not rewritten', () => {
  for (const url of ['https://third-party.example' + paths[0], 'http://192.168.1.99:8790' + paths[0],
    publicOrigin + '/api/auth/login', publicOrigin + '/api/media/publish', publicOrigin + '/other.mp4',
    publicOrigin + '/api/hub/v1/sessions/session-1/messages/msg-1/media/' + hash + '/approval',
    '/api/media/inbound/video.mp4', 'blob:https://deck.example.com/id', 'data:video/mp4;base64,AA==', 'mailto:hello@example.com']) {
    assert.equal(routeResourceUrl(url, lanOrigin, trusted), url);
  }
});

test('userinfo, traversal, encoded separators and malformed URLs are not rewritten', () => {
  for (const url of [syntheticUserinfoOrigin('deck.example.com') + paths[0],
    publicOrigin + '/api/media/inbound/../inbound/video.mp4', publicOrigin + '/api/media/inbound/%2e%2e/video.mp4',
    publicOrigin + '/api/media/inbound/%252e%252e', publicOrigin + '/api/files/agents/a%2Fb/download',
    publicOrigin + '/api/files/agents/a%5Cb/download', publicOrigin + '/api/media/inbound/\\video.mp4',
    publicOrigin + '/api/media/inbound/video.mp4\n', 'https://[bad']) {
    assert.equal(routeResourceUrl(url, lanOrigin, trusted), url);
  }
});

test('invalid targets are not used and configuration only retains public HTTP origins', () => {
  for (const target of ['file:///tmp', syntheticUserinfoOrigin('deck.example.com'), 'https://deck.example.com?key=secret', 'invalid']) {
    assert.equal(routeResourceUrl(publicOrigin + paths[0], target, trusted), publicOrigin + paths[0]);
  }
  assert.deepEqual(normalizeResourceOrigins([publicOrigin + '/custom/', ' ' + publicOrigin + ' ', lanOrigin,
    'file:///tmp', syntheticUserinfoOrigin('example.com'), 'https://example.com?key=secret', 'invalid']), [publicOrigin, lanOrigin]);
});

test('download, markdown, PDF, player and build entry points share resource routing', () => {
  const read = (path: string) => readFileSync(new URL(path, `file://${process.cwd()}/`), 'utf8');
  const api = read('src/api.ts');
  assert.match(api, /routeResourceUrl\(path, base \|\| window.location.origin/);
  assert.match(api, /const routed = mediaUrl\(url\)/);
  assert.ok(api.includes("if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;"));
  assert.match(api, /credentials: requestInit.credentials \?\? 'include'/);
  assert.match(api, /serviceOrigin \? 'include' : 'omit'/);
  assert.match(read('src/components/messages.tsx'), /href=\{href \? mediaUrl\(href\) : href\}/);
  assert.match(read('src/components/FileBrowser.tsx'), /api\.downloadFile\(scope, preview\.path, controller\.signal\)/);
  assert.match(read('src/components/FileBrowser.tsx'), /verifiedPdfBlob\(blob\)/);
  assert.match(read('src/components/FileBrowser.tsx'), /src=\{pdf\.url\}/);
  assert.match(read('src/components/VideoPlayer.tsx'), /const src = mediaUrl\(originalSrc\)/);
  assert.match(read('vite.config.ts'), /env.AOD_PUBLIC_BASE_URL/);
  assert.match(read('vite.config.ts'), /env.AOD_WEB_RESOURCE_ORIGINS/);
});
