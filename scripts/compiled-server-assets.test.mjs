import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

// Asset installation must work in the ordinary Node CI image, without agent CLIs.
test('asset installation needs no external executable on PATH', context => {
  const { source, output } = fixture(context);
  const entry = new URL('./compiled-server-assets.mjs', import.meta.url).href;
  const code = `import { inventoryCompiledServerAssets, installCompiledServerAssets } from ${JSON.stringify(entry)};
    const source = ${JSON.stringify(source)}, output = ${JSON.stringify(output)};
    installCompiledServerAssets(source, output, inventoryCompiledServerAssets(source));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  for (const asset of inventoryCompiledServerAssets(source)) {
    assert.deepEqual(readFileSync(join(output, asset.path)), readFileSync(join(source, asset.path)));
  }
});
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryCompiledServerAssets, installCompiledServerAssets } from './compiled-server-assets.mjs';

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'compiled-server-assets-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'src'), output = join(root, 'emit');
  mkdirSync(source); mkdirSync(output); mkdirSync(join(source, 'fixtures'));
  writeFileSync(join(source, 'test.ts'), 'export {};\n');
  writeFileSync(join(source, 'fixtures', 'row.json'), '{"original":true}\n\n');
  writeFileSync(join(source, 'worker.mjs'), 'export default "原始";\n');
  return { root, source, output };
}
test('fresh emit receives all pinned JSON and worker assets byte-for-byte', context => {
  const { source, output } = fixture(context), pinned = inventoryCompiledServerAssets(source);
  assert.deepEqual(pinned.map(asset => asset.path), ['fixtures/row.json', 'worker.mjs']);
  installCompiledServerAssets(source, output, pinned);
  for (const asset of pinned) assert.deepEqual(readFileSync(join(output, asset.path)), readFileSync(join(source, asset.path)));
  assert.equal(readdirSync(output).includes('test.ts'), false);
  assert.throws(() => installCompiledServerAssets(source, output, pinned), /destination exists/);
});
test('source drift fails before touching any emitted asset', context => {
  const { source, output } = fixture(context), pinned = inventoryCompiledServerAssets(source);
  writeFileSync(join(source, 'worker.mjs'), 'export default "changed";\n');
  assert.throws(() => installCompiledServerAssets(source, output, pinned), /Assets changed/);
  assert.deepEqual(readdirSync(output), []);
});
test('source aliases, unsupported assets, invalid UTF-8 and missing final newline fail closed', context => {
  const { source, output } = fixture(context);
  symlinkSync(output, join(source, 'alias'), 'dir');
  assert.throws(() => inventoryCompiledServerAssets(source), /symbolic links/);
  rmSync(join(source, 'alias'));
  for (const [name, bytes, expected] of [['unexpected.txt', 'text\n', /Unreviewed/], ['binary.json', Buffer.from([255, 10]), /UTF-8/], ['row.json', '{}', /final newline/]]) {
    writeFileSync(join(source, name), bytes);
    assert.throws(() => inventoryCompiledServerAssets(source), expected);
    rmSync(join(source, name));
  }
});
test('destination aliases and existing assets refuse the entire batch before writes', context => {
  const { source, output, root } = fixture(context), pinned = inventoryCompiledServerAssets(source);
  const outside = join(root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(output, 'fixtures'), 'dir');
  assert.throws(() => installCompiledServerAssets(source, output, pinned), /aliases/);
  assert.deepEqual(readdirSync(outside), []);
  rmSync(join(output, 'fixtures'));
  writeFileSync(join(output, 'worker.mjs'), 'existing\n');
  assert.throws(() => installCompiledServerAssets(source, output, pinned), /destination exists/);
  assert.deepEqual(readdirSync(output), ['worker.mjs']);
});
test('source directories cannot be used as emit destinations', context => {
  const { source } = fixture(context), pinned = inventoryCompiledServerAssets(source);
  assert.throws(() => installCompiledServerAssets(source, source, pinned), /separate directories/);
  const child = join(source, 'nested'); mkdirSync(child);
  assert.throws(() => installCompiledServerAssets(source, child, pinned), /separate directories/);
});
