import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCandidateCodexProcess } from './candidate-codex-process-policy.mjs';

const identity = { command: '/private/existing/codex', home: '/private/home', nativeHome: '/private/alice/native' };
const options = () => ({ env: { HOME: identity.home, CODEX_HOME: identity.nativeHome },
  shell: false, timeout: 3000, maxBuffer: 64 * 1024 });
const probe = (method = 'execFile', args = ['features', 'list'], config = options(), target = identity.command) =>
  assertCandidateCodexProcess(method, [target, args, config], identity);

test('isolated candidate permits only the bounded installed CLI metadata probe', () => {
  assert.doesNotThrow(() => probe());
  for (const args of [['features', 'enable', 'anything'], ['exec', 'message'], ['features', 'list', '--extra'], []]) {
    assert.throws(() => probe('execFile', args));
  }
  for (const override of [{ timeout: 0 }, { timeout: 3001 }, { maxBuffer: 128 * 1024 }]) {
    assert.throws(() => probe('execFile', ['features', 'list'], { ...options(), ...override }));
  }
});
test('isolated candidate rejects ambient identity, shell and alternate executable', () => {
  assert.throws(() => probe('execFile', ['features', 'list'], { ...options(), shell: true }));
  assert.throws(() => probe('execFile', ['features', 'list'], { ...options(), env: { HOME: identity.home, CODEX_HOME: '/production/native' } }));
  assert.throws(() => probe('execFile', ['features', 'list'], { ...options(), env: { HOME: '/production/home', CODEX_HOME: identity.nativeHome } }));
  assert.throws(() => probe('execFile', ['features', 'list'], options(), '/other/codex'));
  assert.throws(() => probe('execFile', ['features', 'list'], null));
});

test('isolated candidate retains the app-server-only spawn restriction', () => {
  assert.doesNotThrow(() => probe('spawn', ['--sandbox', 'danger-full-access', 'app-server']));
  assert.throws(() => probe('spawn', ['exec', 'message']));
  for (const method of ['spawnSync', 'exec', 'execSync', 'execFileSync', 'fork']) {
    assert.throws(() => probe(method, ['app-server']));
  }
});
