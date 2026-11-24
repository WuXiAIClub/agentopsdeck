import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const file = new URL('./fixtures/gitlab-ci.json', import.meta.url);
const image = 'mirror.gcr.io/library/node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7';
const source = ['node --test --test-concurrency=1 scripts/ci-policy.test.mjs scripts/ci-contract.test.mjs scripts/ci-source-shards.test.mjs scripts/ci-validation.test.mjs scripts/ci-bootstrap-pnpm.test.mjs scripts/ci-bootstrap-windows-tools.test.mjs scripts/run-source-tests.test.mjs scripts/verify-full-source-batches.test.mjs scripts/ci-browser.test.mjs scripts/ci-browser-network.test.mjs scripts/ci-browser-static.test.mjs scripts/ci-install.test.mjs'];
const validation = [
  'node scripts/ci-source-shards.mjs aggregate .ci-prepared .ci-evidence "$CI_COMMIT_SHA" "$CI_PIPELINE_ID"',
  'node scripts/ci-validation.mjs poc',
  'pnpm --workspace-concurrency=1 -r typecheck',
  'pnpm --filter @agentopsdeck/web test',
  'pnpm --workspace-concurrency=1 -r build',
  'node scripts/ci-validation.mjs package .ci-artifacts',
];
const windowsBuild = {
  stage: 'validation', tags: ['build'], dependencies: [], timeout: '20 minutes',
  before_script: [
    'mkdir -p .ci-tools',
    'node scripts/ci-bootstrap-windows-tools.mjs',
    'test "$(.ci-tools/zig-x86_64-linux-0.14.1/zig version)" = \'0.14.1\'',
    'test "$(.ci-tools/esbuild/node_modules/@esbuild/linux-x64/bin/esbuild --version)" = \'0.28.2\'',
  ],
  script: [
    'python3 -m unittest discover -s native/windows -p test_build_launcher.py -v',
    'python3 native/windows/build-launcher.py --zig .ci-tools/zig-x86_64-linux-0.14.1/zig --esbuild .ci-tools/esbuild/node_modules/@esbuild/linux-x64/bin/esbuild',
    'python3 native/windows/verify_build.py native/windows/launcher/shipping',
    '.ci-tools/zig-x86_64-linux-0.14.1/zig cc -std=c11 -Wall -Wextra -Werror -Wno-unused-function native/windows/launcher/test_policy.c -o .ci-tools/test-policy && .ci-tools/test-policy',
    '.ci-tools/zig-x86_64-linux-0.14.1/zig cc -std=c11 -Wall -Wextra -Werror -Wno-unused-function native/windows/launcher/test_ui.c -o .ci-tools/test-ui && .ci-tools/test-ui',
  ],
};
const before = [
  'export npm_config_proxy="$HTTP_PROXY" npm_config_https_proxy="$HTTPS_PROXY" npm_config_nodedir=/usr/local',
  'node scripts/ci-bootstrap-pnpm.mjs',
  'test "$(pnpm --version)" = "9.15.0"',
  'pnpm --filter agentopsdeck --filter @agentopsdeck/server... --filter @agentopsdeck/web... install --frozen-lockfile --prod=false --network-concurrency=4 --child-concurrency=1',
];
function readConfig() {
  assert.ok(existsSync(file), 'validation-only GitLab CI configuration must exist');
  // JSON is a YAML subset: parse the actual CI document without another dependency.
  return JSON.parse(readFileSync(file, 'utf8'));
}
function assertPolicy(config) {
  assert.deepEqual(Object.keys(config).sort(), ['default', 'workflow', 'stages', 'variables', 'source-checks', 'source-prepare', 'server-source-tests', 'validation', 'windows-exe', 'browser-fixtures', 'install-lifecycle'].sort());
  assert.deepEqual(config.default, { image, interruptible: true,
    hooks: { pre_get_sources_script: ['git config --global http.version HTTP/1.1'] } });
  assert.deepEqual(config.stages, ['source', 'prepare', 'tests', 'validation', 'browser', 'install']);
  assert.deepEqual(config['source-prepare'], { stage: 'prepare', tags: ['build'], dependencies: [],
    timeout: '30 minutes', before_script: before, script: [
      'pnpm check:i18n', 'pnpm --filter @agentopsdeck/shared build', 'node scripts/ci-validation.mjs scripts',
      'node scripts/ci-source-shards.mjs prepare .ci-prepared "$CI_COMMIT_SHA" "$CI_PIPELINE_ID"',
    ], artifacts: { paths: ['.ci-prepared/prepared.json', 'packages/shared/src/build-info.generated.ts', 'packages/shared/dist/'],
      when: 'on_success', expire_in: '1 day', access: 'developer' } });
  assert.deepEqual(config['server-source-tests'], { stage: 'tests', tags: ['build'], parallel: 36,
    dependencies: ['source-prepare'],
    timeout: '30 minutes', before_script: before, script: [
      'node scripts/ci-source-shards.mjs run .ci-evidence/server-$CI_NODE_INDEX --shard "$CI_NODE_INDEX" "$CI_NODE_TOTAL" --prepared .ci-prepared/prepared.json --commit "$CI_COMMIT_SHA" --pipeline "$CI_PIPELINE_ID"',
    ], artifacts: { paths: ['.ci-evidence/server-$CI_NODE_INDEX/result.json'], when: 'always', expire_in: '1 day', access: 'developer' } });
  assert.deepEqual(config['windows-exe'], windowsBuild);
  assert.deepEqual(config['install-lifecycle'], { stage: 'install', tags: ['build'], timeout: '5 minutes',
    dependencies: ['validation'], script: ['node scripts/ci-install.mjs'] });
  assert.deepEqual(config['browser-fixtures'], {
  "stage": "browser",
  "dependencies": [],
  "image": "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27",
  "tags": [
    "build"
  ],
  "timeout": "15 minutes",
  "before_script": [
    "export npm_config_proxy=\"$HTTP_PROXY\" npm_config_https_proxy=\"$HTTPS_PROXY\" PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
    "node scripts/ci-bootstrap-pnpm.mjs",
    "test \"$(pnpm --version)\" = \"9.15.0\"",
    "pnpm --filter agentopsdeck --filter @agentopsdeck/server... --filter @agentopsdeck/web... install --frozen-lockfile --prod=false --ignore-scripts --network-concurrency=4 --child-concurrency=1"
  ],
  "script": [
    "pnpm --filter @agentopsdeck/shared build",
    "node scripts/ci-browser.mjs"
  ]
});
  assert.deepEqual(config.variables, { CI: 'true', GIT_STRATEGY: 'clone', GIT_DEPTH: '1', GET_SOURCES_ATTEMPTS: '3',
    GIT_CLEAN_FLAGS: '-ffdx', FF_ENABLE_JOB_CLEANUP: 'true', GOMAXPROCS: '2' });
  assert.deepEqual(config['source-checks'], { stage: 'source', tags: ['standard'], timeout: '5 minutes', script: source });
  assert.deepEqual(config.validation, { stage: 'validation', dependencies: ['source-prepare', 'server-source-tests'], tags: ['build'], timeout: '30 minutes', before_script: before, script: validation,
    artifacts: { paths: ['.ci-artifacts/candidate.tar', '.ci-artifacts/identity.json'], when: 'on_success', expire_in: '1 day', access: 'developer' } });
  assert.deepEqual(Object.keys(config.workflow), ['rules']);
  for (const rule of config.workflow.rules) assert.ok(Object.keys(rule).every(key => ['if', 'when'].includes(key)));
}
// Only the deliberately small rule grammar used here; reject unfamiliar syntax.
function matches(expression, env) {
  return expression.split(' && ').every(term => {
    const match = term.match(/^\$(CI_[A-Z_]+)(?: (==|!=) (?:"([a-z_]+)"|\$(CI_[A-Z_]+)))?$/);
    assert.ok(match, `Unsupported rule expression: ${term}`);
    const [, key, op, literal, variable] = match;
    if (!op) return Boolean(env[key]);
    const right = variable ? env[variable] : literal;
    return op === '==' ? env[key] === right : env[key] !== right;
  });
}
function admitted(config, env) {
  const rule = config.workflow.rules.find(rule => !rule.if || matches(rule.if, env));
  return Boolean(rule) && rule.when !== 'never';
}

test('real browser acceptance is a required sequential gate', () => {
  const config = readConfig();
  assert.ok(config['browser-fixtures'], 'browser-fixtures gate must exist');
  assert.equal(config['browser-fixtures'].stage, 'browser');
  assert.equal(config['browser-fixtures'].allow_failure, undefined);
});
test('Windows cross-build is required but cannot publish executable artifacts', () => {
  const config = readConfig();
  assert.equal(config['windows-exe'].stage, 'validation');
  assert.equal(config['windows-exe'].artifacts, undefined);
  assert.equal(config['windows-exe'].allow_failure, undefined);
});
test('CI has only pinned, bounded validation jobs with exact reviewed commands', () => assertPolicy(readConfig()));
test('actual workflow admits MR/main/manual branches, suppresses only duplicate non-main pushes', () => {
  const config = readConfig();
  for (const [source, branch, open, expected] of [
    ['merge_request_event', '', '1', true], ['push', 'main', '1', true],
    ['push', 'main', '', true], ['web', 'main', '1', true],
    ['push', 'topic', '1', false], ['push', 'topic', '', true], ['web', 'topic', '1', true],
    ['push', '', '', false], ['schedule', 'main', '', false], ['api', 'main', '', false],
    ['parent_pipeline', 'main', '', false], ['web', '', '', false],
  ]) {
    assert.equal(admitted(config, { CI_PIPELINE_SOURCE: source, CI_COMMIT_BRANCH: branch,
      CI_DEFAULT_BRANCH: 'main', CI_OPEN_MERGE_REQUESTS: open }), expected, `${source}/${branch}/${open}`);
  }
});
test('policy negative controls reject publishing, artifacts, extra jobs and weakened gates', () => {
  for (const mutate of [
    c => c.validation.script.push('pnpm publish'),
    c => { c['install-lifecycle'].allow_failure = true; },
    c => { c['install-lifecycle'].script = ['true']; },
    c => { c['install-lifecycle'].services = ['docker:dind']; },
    c => { c.validation.artifacts.paths.push('.env'); },
    c => { c.validation.artifacts.access = 'all'; },
    c => { c.validation.artifacts.expire_in = 'never'; },
    c => { c['browser-fixtures'].allow_failure = true; },
    c => { c['browser-fixtures'].script.pop(); },
    c => { c['browser-fixtures'].image = 'mcr.microsoft.com/playwright:latest'; },
    c => { c['browser-fixtures'].services = ['docker:dind']; },
    c => c.validation.script.splice(2, 1),
    c => { c.validation.artifacts = { paths: ['apps/web/dist'] }; },
    c => { c.validation.environment = 'production'; },
    c => { c.validation.allow_failure = true; },
    c => { c.validation.services = ['docker:dind']; },
    c => { c.validation.tags = ['ci-light']; },
    c => { c['server-source-tests'].parallel = 3; },
    c => { c['server-source-tests'].script.pop(); },
    c => { c['server-source-tests'].allow_failure = true; },
    c => { c['server-source-tests'].dependencies = []; },
    c => { c['server-source-tests'].artifacts.paths.push('.ci-evidence/'); },
    c => { c['server-source-tests'].artifacts.when = 'on_success'; },
    c => { c['server-source-tests'].artifacts.access = 'all'; },
    c => { c['source-prepare'].script.pop(); },
    c => { c['source-prepare'].artifacts.paths.push('node_modules/'); },
    c => { c.validation.dependencies.pop(); },
    c => { c.validation.script.shift(); },
    c => { c.validation.needs = ['source-checks']; },
    c => { c['windows-exe'].artifacts = { paths: ['native/windows/launcher/shipping'] }; },
    c => { c['windows-exe'].allow_failure = true; },
    c => { c['windows-exe'].before_script.splice(2, 1); },
    c => { c.deploy = { script: ['systemctl restart agentopsdeck'] }; },
    c => { c.variables.PROVIDER_API_KEY = 'synthetic-not-a-real-key'; },
    c => { c.variables.GIT_SSL_NO_VERIFY = 'true'; },
    c => { c.default.hooks.pre_get_sources_script = ['git config --global http.sslVerify false']; },
  ]) {
    const config = readConfig(); mutate(config); assert.throws(() => assertPolicy(config));
  }
});
