import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_COMMIT,
  UPGRADE_LANES,
  normalizeBaselineSourceText,
  parseUpgradeReport,
  resolveBaselineRepository,
  validateBaselineTree,
} from './verify-upgrade-compatibility.mjs';

const blob = 'a'.repeat(40);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('upgrade acceptance pins the actual 2.3.7 commit and all four distinct lanes', () => {
  assert.equal(BASELINE_COMMIT, '1fe624fc889f6be8b55e7ea5889d8aa6d72a92a5');
  assert.deepEqual(UPGRADE_LANES, ['startup', 'roundtrip', 'current-cookie', 'original-cookie']);
  assert.ok(Object.isFrozen(UPGRADE_LANES));
});

test('external baseline repository resolver fails closed when omitted, missing, or pointing at current repository', async t => {
  assert.throws(() => resolveBaselineRepository(''), /BASELINE_REPOSITORY_REQUIRED/);
  assert.throws(() => resolveBaselineRepository(repoRoot), /BASELINE_REPOSITORY_MUST_BE_EXTERNAL/);
  assert.throws(() => resolveBaselineRepository(join(repoRoot, 'nonexistent-external-baseline-repo')), /BASELINE_REPOSITORY_NOT_FOUND/);
  const externalDir = await mkdtemp(join(tmpdir(), 'aod-external-baseline-test-'));
  t.after(() => rm(externalDir, { recursive: true, force: true }));
  assert.equal(resolveBaselineRepository(externalDir), externalDir);
});

test('baseline source normalizer maps predecessor package, env, wire, cookie, and token contracts into isolated AOD equivalents', () => {
  const legacyBrand = ['claw', 'pool'].join('');
  const legacyUpper = legacyBrand.toUpperCase();
  const legacyTitle = ['Claw', 'pool'].join('');
  const legacyConnector = ['Claw', 'Connector'].join('');
  const legacyInput = [
    `import { ${legacyUpper}_VERSION, ${legacyUpper}_BUILD } from '@${legacyBrand}/shared';`,
    `const role = env.${legacyUpper}_SERVER_ROLE;`,
    `const gw = env.OPENCLAW_GATEWAY_WS_URL ?? env.CLAWOPSDECK_OPENCLAW_HOME;`,
    `const hdr1 = 'x-${legacyBrand}-node-id';`,
    `const hdr2 = 'X-${legacyTitle}-File-Binding';`,
    `const cookie = '${legacyBrand}_session=ok';`,
    `const fmt = '${legacyBrand}-drawing';`,
    `const prefixes = ['${['cp', 'conn', ''].join('_')}', '${['cp', 'local', ''].join('_')}', '${['cp', 'board', ''].join('_')}', '${['cp', 'note', ''].join('_')}'];`,
    `const agent = '${legacyConnector}/1.0';`,
  ].join('\n');
  const normalized = normalizeBaselineSourceText(legacyInput);
  assert.match(normalized, /import \{ AGENTOPSDECK_VERSION, AGENTOPSDECK_BUILD \} from '@agentopsdeck\/shared';/);
  assert.match(normalized, /env\.AOD_SERVER_ROLE/);
  assert.match(normalized, /env\.AOD_OPENCLAW_GATEWAY_WS_URL \?\? env\.AOD_OPENCLAW_HOME/);
  assert.match(normalized, /'x-agentopsdeck-node-id'/);
  assert.match(normalized, /'X-AgentOpsDeck-File-Binding'/);
  assert.match(normalized, /'agentopsdeck_session=ok'/);
  assert.match(normalized, /'agentopsdeck-drawing'/);
  assert.match(normalized, /\['aod_conn_', 'aod_local_', 'aod_board_', 'aod_note_'\]/);
  assert.match(normalized, /'AgentOpsDeckConnector\/1\.0'/);
  assert.equal(normalized.toLowerCase().includes(legacyBrand), false);
});

test('baseline inventory retains regular files, spaces, and original blob identities', () => {
  const rows = validateBaselineTree(`100644 blob ${blob}\tdirectory/file name.ts\0` + `100755 blob ${blob}\tbin/tool\0`);
  assert.deepEqual(rows, [{ path: 'directory/file name.ts', blob }, { path: 'bin/tool', blob }]);
});

for (const [label, tree] of [
  ['empty', '\0'], ['truncated', `100644 blob ${blob}\tfile`],
  ['symlink', `120000 blob ${blob}\tlink\0`], ['submodule', `160000 commit ${blob}\tsubmodule\0`],
  ['absolute', `100644 blob ${blob}\t/absolute\0`], ['drive', `100644 blob ${blob}\tC:/absolute\0`],
  ['parent', `100644 blob ${blob}\ta/../escape\0`], ['dot', `100644 blob ${blob}\t./file\0`],
  ['backslash', `100644 blob ${blob}\ta\\escape\0`], ['newline', `100644 blob ${blob}\ta\nfile\0`],
  ['duplicate', `100644 blob ${blob}\tfile\0`.repeat(2)],
]) test(`baseline archive refuses ${label} before extraction`, () => assert.throws(() => validateBaselineTree(tree)));

test('upgrade report parser accepts one complete successful report amid diagnostic lines', () => {
  const report = { version: 1, passed: true, cases: [{ retained: true }] };
  assert.deepEqual(parseUpgradeReport('diagnostic\n' + JSON.stringify(report, null, 2) + '\n'), report);
});

for (const [label, text] of [
  ['missing', 'nothing'], ['truncated', '{\n  "version": 1,\n  "passed": true'],
  ['failure', JSON.stringify({ version: 1, passed: false }, null, 2)],
  ['nonboolean', JSON.stringify({ version: 1, passed: 'true' }, null, 2)],
  ['duplicate', (JSON.stringify({ version: 1, passed: true }, null, 2) + '\n').repeat(2)],
]) test(`upgrade report refuses ${label} instead of manufacturing success`, () => assert.throws(() => parseUpgradeReport(text)));

test('upgrade fixtures use parameterized isolated artifacts rather than a historical host path', async () => {
  for (const lane of UPGRADE_LANES) {
    const source = await readFile(new URL(`./upgrade-compatibility/${lane}.mjs`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\/tmp\/|\/home\//);
    assert.match(source, /process\.argv\[2\]/);
    assert.match(source, /mkdtemp\(/);
    assert.match(source, /native(?:AgentEnabled|SessionStarted): false/);
    assert.doesNotMatch(source, /listen\(/);
  }
});

test('candidate application lanes await the actual production root while original cookies come from 2.3.7', async () => {
  for (const lane of ['startup', 'current-cookie', 'original-cookie']) {
    const source = await readFile(new URL(`./upgrade-compatibility/${lane}.mjs`, import.meta.url), 'utf8');
    assert.match(source, /application-process\.js/);
    assert.match(source, /await (?:candidate\.)?createProcessApplication\(/);
    assert.doesNotMatch(source, /candidate\.createApplication\(/);
  }
  const source = await readFile(new URL('./upgrade-compatibility/original-cookie.mjs', import.meta.url), 'utf8');
  assert.match(source, /original\.createApplication\(originalConfig\.loadConfig\(settings\)\)/);
  const application = await readFile(new URL('./verify-original-application-upgrade.mjs', import.meta.url), 'utf8');
  assert.match(application, /application-process\.js/);
  assert.match(application, /await current\.createProcessApplication\(next\)/);
  assert.doesNotMatch(application, /current\.createApplication\(/);
  assert.doesNotMatch(application, /\/tmp\//);
  assert.doesNotMatch(application, /apply_patch/);
  const fetchFenceIndex = application.indexOf('globalThis.fetch = async');
  const oldCreateIndex = application.indexOf('old.createApplication(previous)');
  assert.ok(fetchFenceIndex > 0 && oldCreateIndex > fetchFenceIndex, 'fetch fence must precede old.createApplication(previous)');
});
