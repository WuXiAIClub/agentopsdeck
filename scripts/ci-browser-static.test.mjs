import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('static fixture serves the built JS/CSS and rejects non-assets and writes', async () => {
  const { serveFixture } = await import('../apps/web/tests/fixtures/static-assets.mjs');
  const output = [
    { type: 'chunk', fileName: 'binding-fixture.js', isEntry: true, code: 'window.fixture = true;' },
    { type: 'asset', fileName: 'assets/style.css', source: 'body { color: red; }' },
  ];
  const server = await serveFixture(output);
  try {
    const html = await (await fetch(`${server.origin}/fixture`)).text();
    assert.match(html, /src="\/binding-fixture.js"/);
    assert.match(html, /href="\/assets\/style.css"/);
    assert.doesNotMatch(html, /@vite\/client|react-refresh/);
    for (const [path, type, body] of [
      ['/binding-fixture.js', 'text/javascript', output[0].code],
      ['/assets/style.css', 'text/css', output[1].source],
    ]) {
      const response = await fetch(server.origin + path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), new RegExp(type));
      assert.equal(await response.text(), body);
    }
    for (const path of ['/@vite/client', '/api/unrelated', '/not-built', '/%2e%2e/package.json']) {
      assert.equal((await fetch(server.origin + path)).status, 404);
    }
    assert.equal((await fetch(`${server.origin}/binding-fixture.js`, { method: 'POST' })).status, 405);
  } finally { await server.close(); }
});

test('binding fixture uses build output, not the Vite dev/HMR client', async () => {
  const text = await readFile(new URL('../apps/web/tests/workspace-binding-lines.browser.mjs', import.meta.url), 'utf8');
  assert.match(text, /await build\(/);
  assert.match(text, /await serveFixture\(.*\.output\)/);
  assert.doesNotMatch(text, /createServer|transformIndexHtml/);
  assert.match(text, /await verifyFence\(page, denied\)/);
});
