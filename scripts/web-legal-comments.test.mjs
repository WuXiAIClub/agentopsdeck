import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile, transformWithEsbuild } from '../apps/web/node_modules/vite/dist/node/index.js';

test('production build deduplicates legal notices without removing licenses or changing code', async () => {
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' },
    fileURLToPath(new URL('../apps/web/vite.config.ts', import.meta.url)));
  assert.ok(loaded);
  assert.equal(loaded.config.esbuild?.legalComments, 'eof');
  const first = '/** @license repeated dependency - ISC */';
  const second = '/** @license other dependency - MIT */';
  const source = `${first}\nfunction left() { return 2; }\n${first}\nfunction right() { return 3; }\n${second}\nexport const result = left() + right();`;
  const output = await transformWithEsbuild(source, 'license-fixture.js',
    { minify: true, format: 'esm', legalComments: loaded.config.esbuild.legalComments });
  assert.equal(output.code.split(first).length, 2, 'Keep the original notice exactly once');
  assert.equal(output.code.split(second).length, 2, 'Preserve distinct dependency notices');
  assert.ok(output.code.indexOf(first) > output.code.indexOf('export'));
  assert.equal((await import('data:text/javascript,' + encodeURIComponent(output.code))).result, 5);
});
