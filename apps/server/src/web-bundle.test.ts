import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { registerWebBundle } from './web-bundle.js';

test('prebuilt bundle gets the configured public resource origin at runtime on every entry route', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-web-origin-'));
  try {
    const html = '<!doctype html><html><head><title>fixture</title></head><body></body></html>';
    writeFileSync(join(directory, 'index.html'), html);
    const app = new Hono();
    registerWebBundle(app, directory, { publicBaseUrl: 'https://deck.example.com/service/' });
    for (const host of ['http://192.168.1.10:8790', 'https://deck.example.com']) {
      for (const path of ['/', '/index.html', '/remote', '/nested/view']) {
        for (const method of ['GET', 'HEAD']) {
          const response = await app.request(host + path, { method, headers: { 'x-forwarded-host': 'untrusted.example' } });
          assert.equal(response.status, 200);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          assert.match(response.headers.get('content-type')!, /text\/html/);
          assert.equal(await response.text(), method === 'HEAD' ? '' : html.replace('</head>',
            '<meta name="agentopsdeck-resource-origin" content="https://deck.example.com"></head>'));
        }
      }
    }
    for (const publicBaseUrl of [undefined, 'invalid', 'file:///tmp', 'https://user:secret@example.com',
      'https://example.com?token=secret', 'https://example.com/#fragment']) {
      const invalid = new Hono();
      registerWebBundle(invalid, directory, { publicBaseUrl });
      assert.equal(await (await invalid.request('/')).text(), html);
    }
    writeFileSync(join(directory, 'index.html'), html.replace('fixture', 'upgraded'));
    assert.match(await (await app.request('/')).text(), /upgraded/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production bundle: lazy chunks never fall back to HTML; entry pages are not cached', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-web-bundle-'));
  try {
    const app = new Hono();
    assert.equal(registerWebBundle(app, directory), false);
    mkdirSync(join(directory, 'assets'));
    const html = '<!doctype html><title>fixture</title>';
    writeFileSync(join(directory, 'index.html'), html);
    writeFileSync(join(directory, 'assets', 'remote-current.js'), 'export const ready = true;');
    app.get('/api/health', c => c.json({ ok: true }));
    assert.equal(registerWebBundle(app, directory), true);
    for (const path of ['/', '/index.html', '/remote', '/nested/view']) {
      const response = await app.request(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
      assert.equal(await response.text(), html);
    }
    for (const method of ['GET', 'HEAD']) {
      for (const path of ['/assets/WorkspaceRemote-old.js', '/assets/missing', '/missing.js', '/missing.css', '/src/view.tsx', '/api/missing']) {
        const response = await app.request(path, { method });
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.ok(!response.headers.get('content-type')?.includes('text/html'));
      }
    }
    const script = await app.request('/assets/remote-current.js');
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type')!, /javascript/);
    assert.equal(await script.text(), 'export const ready = true;');
    assert.deepEqual(await (await app.request('/api/health')).json(), { ok: true });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production bundle: immutable caching is limited to successful hashed JS/CSS', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-web-bundle-'));
  try {
    mkdirSync(join(directory, 'assets'));
    writeFileSync(join(directory, 'index.html'), '<!doctype html><title>fixture</title>');
    const files = {
      'assets/index-BO5u4aS9.js': 'export const ready = true;',
      'assets/workspace-core-Ab_12-XY.js': 'export {};',
      'assets/index-4ISROJiJ.css': 'body { color: black; }',
      'assets/private-12345678.js': 'export {};',
      'assets/plain.js': 'export {};',
      'assets/index-short.js': 'export {};',
      'assets/index-123456789.js': 'export {};',
      'assets/index-BO5u4aS9.js.map': '{}',
      'outside-BO5u4aS9.js': 'export {};',
      'manifest.webmanifest': '{}',
    };
    for (const [path, body] of Object.entries(files)) writeFileSync(join(directory, path), body);
    const app = new Hono();
    app.use('/assets/private-12345678.js', async (c, next) => {
      c.header('Cache-Control', 'private, no-store');
      await next();
    });
    app.get('/api/example-12345678.js', c => c.text('private API data'));
    registerWebBundle(app, directory);
    for (const method of ['GET', 'HEAD']) {
      for (const path of Object.keys(files)) {
        const response = await app.request(`/${path}`, { method });
        assert.equal(response.status, 200, `${method} ${path}`);
        const expected = path.includes('private-') ? 'private, no-store'
          : ['assets/index-BO5u4aS9.js', 'assets/workspace-core-Ab_12-XY.js', 'assets/index-4ISROJiJ.css'].includes(path)
            ? 'public, max-age=31536000, immutable' : null;
        assert.equal(response.headers.get('cache-control'), expected, `${method} ${path}`);
        if (method === 'GET') assert.equal(await response.text(), files[path as keyof typeof files]);
        else assert.equal(await response.text(), '');
      }
      const missing = await app.request('/assets/missing-12345678.js', { method });
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get('cache-control'), 'no-store');
      const api = await app.request('/api/example-12345678.js', { method });
      assert.equal(api.status, 200);
      assert.equal(api.headers.get('cache-control'), null);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production bundle: serves previous-release immutable hashed assets from sibling releases without falling back on unknown chunks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-web-releases-'));
  try {
    const previousDist = join(root, 'releases', '20261022-release-r19', 'apps', 'web', 'dist');
    const currentDist = join(root, 'releases', '20261022-release-r20', 'apps', 'web', 'dist');
    mkdirSync(join(previousDist, 'assets'), { recursive: true });
    mkdirSync(join(currentDist, 'assets'), { recursive: true });
    writeFileSync(join(previousDist, 'index.html'), '<!doctype html><title>r19</title>');
    writeFileSync(join(currentDist, 'index.html'), '<!doctype html><title>r20</title>');
    writeFileSync(join(previousDist, 'assets', 'WorkspaceGitTree-DIhjBzJO.js'), 'export const gitTree = "r19";');
    writeFileSync(join(previousDist, 'assets', 'workspace-core-DomiT2I4.js'), 'export const core = "r19";');
    writeFileSync(join(previousDist, 'assets', 'index-9cpyXr00.css'), '.git-tree { display: block; }');
    writeFileSync(join(currentDist, 'assets', 'WorkspaceGitTree-F1PYpbjS.js'), 'export const gitTree = "r20";');

    const app = new Hono();
    assert.equal(registerWebBundle(app, currentDist), true);

    for (const method of ['GET', 'HEAD']) {
      const legacyJs = await app.request('/assets/WorkspaceGitTree-DIhjBzJO.js', { method });
      assert.equal(legacyJs.status, 200, `${method} legacy JS`);
      assert.equal(legacyJs.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal(legacyJs.headers.get('x-content-type-options'), 'nosniff');
      assert.match(legacyJs.headers.get('content-type') ?? '', /javascript/);
      assert.equal(await legacyJs.text(), method === 'GET' ? 'export const gitTree = "r19";' : '');

      const legacyCss = await app.request('/assets/index-9cpyXr00.css', { method });
      assert.equal(legacyCss.status, 200, `${method} legacy CSS`);
      assert.equal(legacyCss.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.match(legacyCss.headers.get('content-type') ?? '', /text\/css/);
      assert.equal(await legacyCss.text(), method === 'GET' ? '.git-tree { display: block; }' : '');

      const missing = await app.request('/assets/WorkspaceGitTree-00000000.js', { method });
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get('cache-control'), 'no-store');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
