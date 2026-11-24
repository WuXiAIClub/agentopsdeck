import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const runner = new URL('./ci-browser.mjs', import.meta.url);
test('bounded browser runner exists', () => assert.ok(existsSync(runner), 'browser runner missing'));
test('runner rejects false greens and kills timed-out children with isolated HOME', async () => {
  const { runFixture } = await import(runner);
  const root = await mkdtemp(join(tmpdir(), 'browser-runner-test-'));
  try {
    const file = join(root, 'fixture.mjs');
    const receipt = join(root, 'receipt.json');
    await writeFile(file, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({home:process.env.HOME,secret:process.env.AOD_TEST_SECRET,proxy:process.env.HTTPS_PROXY})); console.log('ACCEPTED');`);
    process.env.AOD_TEST_SECRET = 'synthetic-forbidden';
    try { await runFixture({ file, marker: 'ACCEPTED', timeout: 5000 }); }
    finally { delete process.env.AOD_TEST_SECRET; }
    const value = JSON.parse(await readFile(receipt, 'utf8'));
    assert.deepEqual(Object.keys(value), ['home']); assert.equal(existsSync(value.home), false);
    await writeFile(file, "console.log('ACCEPTED'); process.exitCode=7;");
    await assert.rejects(runFixture({ file, marker: 'ACCEPTED', timeout: 5000 }), /exit=7/);
    await writeFile(file, "console.log('no acceptance');");
    await assert.rejects(runFixture({ file, marker: 'ACCEPTED', timeout: 5000 }), /Missing acceptance marker/);
    await writeFile(file, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({pid:process.pid,home:process.env.HOME})); setInterval(()=>{},100);`);
    await assert.rejects(runFixture({ file, marker: 'ACCEPTED', timeout: 1000 }), /timed out/);
    const timed = JSON.parse(await readFile(receipt, 'utf8'));
    assert.throws(() => process.kill(timed.pid, 0), /ESRCH/);
    assert.equal(existsSync(timed.home), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Playwright resolution uses its ESM import export, not the CJS require entry', async () => {
  const { playwrightImportEntry } = await import(runner);
  assert.equal(typeof playwrightImportEntry, 'function', 'ESM package resolution is required');
  const directory = await mkdtemp(join(tmpdir(), 'playwright-entry-test-'));
  try {
    const packageFile = join(directory, 'package.json');
    await writeFile(packageFile, JSON.stringify({ version: '1.63.0', exports: { '.': { import: './index.mjs', require: './index.js' } } }));
    await writeFile(join(directory, 'index.js'), "const api = {chromium: {}}; module.exports = api;");
    await writeFile(join(directory, 'index.mjs'), "export const chromium = {launch() {}};");
    const { chromium: cjsChromium } = await import(pathToFileURL(join(directory, 'index.js')).href);
    assert.equal(cjsChromium, undefined, 'reproduces named export lost through CJS absolute import');
    const entry = await playwrightImportEntry(packageFile);
    assert.equal(entry, join(directory, 'index.mjs'));
    assert.equal(typeof (await import(pathToFileURL(entry).href)).chromium.launch, 'function');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('browser inventory is exact and selected fixtures are an explicit subset', async () => {
  const { verifyInventory } = await import(runner);
  const inventory = await verifyInventory();
  assert.equal(inventory.length, 152);
  for (const path of [
    'apps/web/tests/candidate-app-recovery.browser.mjs',
    'apps/web/tests/event-stream-recovery.browser.mjs',
    'apps/web/tests/assistant-output.browser.mjs',
    'apps/web/tests/session-recovery-visibility.browser.mjs',
  ]) {
    assert.equal(inventory.find(row => row.path === path)?.category, 'isolated-runtime');
  }
  for (const path of [
    'apps/web/tests/account-lifecycle.browser.mjs',
    'apps/web/tests/startup-auth-recovery.browser.mjs',
    'apps/web/tests/connection-control-recovery.browser.mjs',
    'apps/web/tests/session-goal-continuous.browser.mjs',
    'apps/web/tests/session-goal-waiting.browser.mjs',
  ]) {
    assert.equal(inventory.find(row => row.path === path)?.category, 'fixture-candidate');
  }
  assert.deepEqual(inventory.filter(row => row.category === 'ci-selected').map(row => row.path), [
    'apps/web/tests/desktop-history-controller.browser.mjs',
    'apps/web/tests/history-anchor-index.browser.mjs',
    'apps/web/tests/workspace-binding-lines.browser.mjs',
  ]);
});

test('browser inventory rejects missing, additional and duplicate entries', async () => {
  const { verifyInventory } = await import(runner);
  const root = await mkdtemp(join(tmpdir(), 'browser-inventory-test-'));
  try {
    await mkdir(join(root, 'apps'));
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'apps', 'example.browser.mjs'), '');
    const row = { path: 'apps/example.browser.mjs', category: 'fixture-candidate', reason: 'Synthetic isolated inventory fixture.' };
    const save = rows => writeFile(join(root, 'docs', 'browser-inventory.json'), JSON.stringify(rows));
    await save([row]);
    assert.deepEqual(await verifyInventory(root), [row]);
    for (const rows of [[], [row, { ...row, path: 'apps/missing.browser.mjs' }], [row, row]]) {
      await save(rows);
      await assert.rejects(verifyInventory(root), /Browser inventory drift/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
