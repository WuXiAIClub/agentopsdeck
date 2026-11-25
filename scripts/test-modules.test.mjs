import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TEST_TAXONOMY,
  buildInventory,
  classifyScriptTest,
  classifyServerTest,
  classifyWebTest,
  resolveModuleFiles,
} from './test-modules.mjs';

test('every discovered server, web, and script test belongs to exactly one subcategory in the 5-major-category taxonomy', async () => {
  const { serverFiles, webFiles, scriptFiles, counts } = await buildInventory();
  assert.ok(serverFiles.length >= 1100);
  assert.ok(webFiles.length >= 140);
  assert.ok(scriptFiles.length >= 50);

  assert.equal(TEST_TAXONOMY.length, 5, 'must have exactly 5 major categories');
  assert.deepEqual(
    TEST_TAXONOMY.map(category => category.id),
    ['agent', 'core', 'api', 'storage', 'web'],
  );

  const serverSum = ['agent', 'core', 'api', 'storage'].reduce((sum, id) => sum + (counts[id] ?? 0), 0);
  assert.equal(serverSum, serverFiles.length, 'server major categories must partition all server tests');

  for (const category of TEST_TAXONOMY) {
    const subSum = category.subcategories.reduce((sum, sub) => sum + (counts[sub.id] ?? 0), 0);
    assert.equal(subSum, counts[category.id], `subcategories of ${category.id} must sum to its major total`);
    for (const sub of category.subcategories) {
      assert.ok((counts[sub.id] ?? 0) > 0, `subcategory ${sub.id} must not be empty`);
    }
  }
});

test('module selector resolves major categories, subcategories, and exact file paths while rejecting unknown selectors', async () => {
  assert.equal(classifyServerTest('execution/private-environment.test.ts'), 'agent:gateway');
  assert.equal(classifyServerTest('antigravity/owned-execution.test.ts'), 'agent:antigravity');
  assert.equal(classifyServerTest('antigravity/acp-client.test.ts'), 'agent:antigravity');
  assert.equal(classifyServerTest('antigravity/config.test.ts'), 'agent:antigravity');
  const { serverFiles, webFiles, scriptFiles } = await buildInventory();

  const codexOnly = resolveModuleFiles('server', serverFiles, ['agent:codex']);
  assert.ok(codexOnly.length > 0 && codexOnly.every(file => file.startsWith('codex/')));

  const allAgents = resolveModuleFiles('server', serverFiles, ['agent']);
  assert.ok(allAgents.length > codexOnly.length);
  assert.ok(allAgents.every(file => classifyServerTest(file).startsWith('agent:')));

  const antigravityOnly = resolveModuleFiles('server', serverFiles, ['agent:antigravity']);
  assert.ok(antigravityOnly.length >= 5 && antigravityOnly.every(file => file.startsWith('antigravity/')));
  assert.ok(antigravityOnly.includes('antigravity/owned-execution.test.ts'));

  const mixedServer = resolveModuleFiles('server', serverFiles, ['agent:copilot', 'web-bundle.test.ts']);
  assert.ok(mixedServer.includes('web-bundle.test.ts'));
  assert.ok(mixedServer.some(file => file.startsWith('copilot/')));

  const webWorkspace = resolveModuleFiles('web', webFiles, ['web:workspace']);
  assert.ok(webWorkspace.length > 0 && webWorkspace.every(file => classifyWebTest(file) === 'web:workspace'));

  const scriptCi = resolveModuleFiles('scripts', scriptFiles, ['scripts:ci']);
  assert.ok(scriptCi.length > 0 && scriptCi.every(file => classifyScriptTest(file) === 'scripts:ci'));

  assert.throws(() => resolveModuleFiles('server', serverFiles, ['web:workspace']), /Unknown module selector/);
  assert.throws(() => resolveModuleFiles('web', webFiles, ['agent:codex']), /Unknown module selector/);
  assert.throws(() => resolveModuleFiles('server', serverFiles, ['nonexistent.test.ts']), /Unknown module selector/);
});
