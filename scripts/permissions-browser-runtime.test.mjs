import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { permissionsBrowserRuntime, permissionsBrowserWorkingDirectory, selectPermissionsBrowsers } from './permissions-browser-runtime.mjs';

test('English selectors run independently of the desktop service locale and private environment', () => {
  const runtime = permissionsBrowserRuntime({ repository: '/repo', temp: '/evidence/tmp',
    playwright: '/tools/playwright.mjs', chromium: '/tools/chrome',
    environment: { PATH: '/bin', HOME: '/private', LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8',
      NODE_OPTIONS: '--max-old-space-size=16', HTTPS_PROXY: 'private', AOD_ACCESS_KEY: 'private' } });
  assert.equal(runtime.env.LANG, 'C.UTF-8');
  assert.equal(runtime.env.LC_ALL, 'C.UTF-8');
  assert.equal(runtime.env.HOME, '/evidence/tmp/home');
  assert.equal(runtime.env.AOD_TEST_CHROMIUM, '/tools/chrome');
  assert.equal(runtime.env.AOD_TEST_PLAYWRIGHT, '/tools/playwright.mjs');
  for (const key of ['NODE_OPTIONS', 'HTTPS_PROXY', 'AOD_ACCESS_KEY']) assert.equal(runtime.env[key], undefined);
  assert.deepEqual(runtime.prefix, ['--import', '/repo/apps/server/node_modules/tsx/dist/loader.mjs']);
});

test('matrix selection is exact and cannot silently omit unknown fixtures', () => {
  assert.equal(selectPermissionsBrowsers().length, 18);
  assert.deepEqual(selectPermissionsBrowsers(['shared-scope', 'shared-scope']), ['shared-scope']);
  assert.throws(() => selectPermissionsBrowsers(['shared-scop']), /Unknown/);
});

test('research serves the sealed release assets without requiring a mutable source dist', () => {
  assert.equal(permissionsBrowserWorkingDirectory({ fixture: 'workspace-research', repository: '/source', candidate: '/sealed' }), '/sealed');
  assert.throws(() => permissionsBrowserWorkingDirectory({ fixture: 'workspace-research', repository: '/source' }), /sealed candidate/);
  assert.equal(permissionsBrowserWorkingDirectory({ fixture: 'dashboard-users', repository: '/source', candidate: '/sealed' }), '/source');
});

test('fixtures with previously ignored Chromium paths honor the installed executable', async () => {
  for (const name of ['dashboard-users', 'shared-content', 'board-delegation']) {
    const text = await readFile(new URL(`../apps/web/tests/${name}.browser.mjs`, import.meta.url), 'utf8');
    assert.match(text, /executablePath:\s*process\.env\.AOD_TEST_CHROMIUM/);
  }
});
