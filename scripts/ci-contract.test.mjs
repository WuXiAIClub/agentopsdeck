import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { smokeTests } from './verify-ui-smoke.mjs';

// JSON-compatible YAML avoids adding a second parser dependency. These are
// repository contract checks, NOT a substitute for GitLab's remote CI lint.
const config = JSON.parse(await readFile(new URL('./fixtures/gitlab-ci.json', import.meta.url), 'utf8'));
test('CI builds and tests only, retaining exact full-source coverage and budget gates', () => {
  assert.deepEqual(config.stages, ['source', 'prepare', 'tests', 'validation', 'browser', 'install']);
  assert.match(config.default.image, /@sha256:[a-f0-9]{64}$/);
  assert.ok(config.validation.before_script.some(command => command.includes('install --frozen-lockfile')));
  assert.ok(config.validation.script.includes('pnpm --filter @agentopsdeck/web test'));
  assert.ok(config.validation.script.includes('pnpm --workspace-concurrency=1 -r build'));
  assert.ok(config.validation.script.includes('pnpm --workspace-concurrency=1 -r typecheck'));
  assert.equal(config['server-source-tests'].parallel, 36);
  assert.ok(config['server-source-tests'].script.includes(
    'node scripts/ci-source-shards.mjs run .ci-evidence/server-$CI_NODE_INDEX --shard "$CI_NODE_INDEX" "$CI_NODE_TOTAL" --prepared .ci-prepared/prepared.json --commit "$CI_COMMIT_SHA" --pipeline "$CI_PIPELINE_ID"'));
  assert.ok(config.validation.script[0].includes('ci-source-shards.mjs aggregate'));
  assert.deepEqual(config['server-source-tests'].dependencies, ['source-prepare']);
  assert.deepEqual(config.validation.dependencies, ['source-prepare', 'server-source-tests']);
  for (const name of ['source-checks', 'source-prepare', 'server-source-tests', 'validation', 'windows-exe', 'browser-fixtures', 'install-lifecycle']) {
    assert.ok(config[name].timeout);
    assert.equal(config[name].allow_failure, undefined);
    assert.equal(config[name].environment, undefined);
    assert.ok(config[name].script.every(command => !/\b(?:deploy|restart|push|curl|ssh|systemctl)\b/.test(command)));
  }
});
test('CI retains upstream sequential browser gate; separate smoke helper is not a full suite', async () => {
  assert.deepEqual(config.validation.artifacts, {
    paths: ['.ci-artifacts/candidate.tar', '.ci-artifacts/identity.json'],
    when: 'on_success', expire_in: '1 day', access: 'developer',
  }, 'candidate handoff remains bounded');
  assert.deepEqual(config['source-prepare'].artifacts, {
    paths: ['.ci-prepared/prepared.json', 'packages/shared/src/build-info.generated.ts', 'packages/shared/dist/'],
    when: 'on_success', expire_in: '1 day', access: 'developer',
  });
  assert.deepEqual(config['server-source-tests'].artifacts, {
    paths: ['.ci-evidence/server-$CI_NODE_INDEX/result.json'],
    when: 'always', expire_in: '1 day', access: 'developer',
  });
  assert.equal(config['browser-fixtures'].artifacts, undefined);
  assert.equal(config['windows-exe'].artifacts, undefined);
  assert.deepEqual(config['browser-fixtures'].dependencies, []);
  assert.deepEqual(config['install-lifecycle'].dependencies, ['validation']);
  assert.ok(config.stages.indexOf(config['install-lifecycle'].stage) > config.stages.indexOf(config['browser-fixtures'].stage));
  assert.ok(config.stages.indexOf(config['browser-fixtures'].stage) > config.stages.indexOf(config.validation.stage));
  assert.ok(config.stages.indexOf(config['server-source-tests'].stage) < config.stages.indexOf(config.validation.stage));
  assert.ok(config['browser-fixtures'].script.includes('node scripts/ci-browser.mjs'));
  assert.equal(new Set(smokeTests).size, smokeTests.length);
  for (const file of smokeTests) assert.ok((await readFile(new URL(`../apps/web/tests/${file}`, import.meta.url))).length);
});
