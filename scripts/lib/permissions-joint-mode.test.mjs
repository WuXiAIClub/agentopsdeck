import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateJointModule, jointModelMessage, permissionsJointMode } from './permissions-joint-mode.mjs';

test('legacy source acceptance remains synthetic and uses no provider', () => {
  assert.deepEqual(permissionsJointMode(['/installed/codex']), { command: '/installed/codex', candidateRoot: undefined,
    model: undefined, providerOrigin: undefined, realModel: false });
});
test('sealed synthetic and explicit real-provider acceptance remain distinct', () => {
  assert.equal(permissionsJointMode(['/installed/codex', '/isolated/candidate']).realModel, false);
  assert.deepEqual(permissionsJointMode(['/installed/codex', '/isolated/candidate', 'gpt-5.6-sol', 'http://127.0.0.1:1234/']),
    { command: '/installed/codex', candidateRoot: '/isolated/candidate', model: 'gpt-5.6-sol', providerOrigin: 'http://127.0.0.1:1234', realModel: true });
});
test('incomplete, relative, credential-bearing and non-loopback provider arguments fail closed', () => {
  for (const args of [[], ['codex'], ['/codex', 'candidate'], ['/codex', '/candidate', 'model'],
    ['/codex', '/candidate', 'bad model', 'http://127.0.0.1:1234'],
    ...['https://127.0.0.1:1234', 'http://localhost:1234', 'http://example.invalid:1234',
      'http://user:secret@127.0.0.1:1234', 'http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/?x=1',
      'http://127.0.0.1:1234/#x', 'http://127.0.0.1'].map(origin => ['/codex', '/candidate', 'model', origin])]) {
    assert.throws(() => permissionsJointMode(args));
  }
});
test('built candidate imports resolve only canonical server production modules', () => {
  assert.equal(candidateJointModule('/candidate', '../apps/server/src/hub/hub-store.ts'), 'file:///candidate/apps/server/dist/hub/hub-store.js');
  for (const input of ['../../secrets.ts', '../apps/server/src/../../private.ts', '../apps/server/src/index.js', 'file:///etc/passwd']) {
    assert.throws(() => candidateJointModule('/candidate', input));
  }
});
test('real native messages request bounded markers; synthetic mode remains unchanged', () => {
  assert.match(jointModelMessage(4, true), /exactly JOINT_REPLY_4/);
  assert.equal(jointModelMessage(1, false), 'Report isolated progress. Do not use tools or access files.');
  for (const value of [0, -1, 7, NaN, 1.5]) assert.throws(() => jointModelMessage(value, true));
});
test('browser runtime is explicit, candidate-only and independent of real-model opt-in', () => {
  const flags = ['--browser-module=/tools/playwright.mjs', '--browser-executable=/tools/chrome'];
  assert.deepEqual(permissionsJointMode(['/codex', '/candidate', ...flags]).browser,
    { module: '/tools/playwright.mjs', executable: '/tools/chrome' });
  assert.equal(permissionsJointMode(['/codex', '/candidate', ...flags]).realModel, false);
  for (const args of [['/codex', ...flags], ['/codex', '/candidate', flags[0]],
    ['/codex', '/candidate', flags[0], flags[0]],
    ['/codex', '/candidate', flags[0], '--browser-executable=relative'],
    ['/codex', '/candidate', '--browser-other=/x', flags[1]]]) assert.throws(() => permissionsJointMode(args));
});
test('external loopback fixture exercises forwarding without claiming real-model acceptance', () => {
  const mode = permissionsJointMode(['/codex', '/candidate', 'local-fixture', 'http://127.0.0.1:1234', '--provider-fixture']);
  assert.equal(mode.providerFixture, true);
  assert.equal(mode.realModel, false);
  assert.equal(mode.providerOrigin, 'http://127.0.0.1:1234');
});
test('external fixture flag requires one explicit sealed-candidate provider tuple', () => {
  for (const args of [['/codex', '--provider-fixture'], ['/codex', '/candidate', '--provider-fixture'],
    ['/codex', '/candidate', 'model', 'http://127.0.0.1:1234', '--provider-fixture', '--provider-fixture']]) {
    assert.throws(() => permissionsJointMode(args));
  }
});
