import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../config.js';

test('Codex private board directory is opt-in and outside child HOME, CODEX_HOME and project', () => {
  const env = { HOME: '/synthetic/native-home', AOD_CODEX_HOME: '/synthetic/codex-home', AOD_CODEX_DEFAULT_CWD: '/synthetic/project' };
  assert.equal(loadConfig(env).codex.boardToolsDirectory, undefined);
  assert.equal(loadConfig({ ...env, AOD_CODEX_BOARD_TOOLS_DIR: '/synthetic/private-grants' }).codex.boardToolsDirectory, '/synthetic/private-grants');
  for (const path of ['/synthetic', '/synthetic/native-home', '/synthetic/native-home/grants', '/synthetic/codex-home/grants', '/synthetic/project/grants', '/', 'relative']) {
    assert.throws(() => loadConfig({ ...env, AOD_CODEX_BOARD_TOOLS_DIR: path }), /Private task tool binding unavailable/, path);
  }
});

test('Codex private board directory rejects native HOME even with disjoint AOD state', () => {
  for (const home of [{ HOME: '/synthetic/native-home' }, { USERPROFILE: '/synthetic/native-home' }]) {
    const env = { ...home, AOD_DATA_DIR: '/synthetic/state', AOD_CODEX_HOME: '/synthetic/codex-home',
      AOD_CODEX_DEFAULT_CWD: '/synthetic/project' };
    assert.equal(loadConfig({ ...env, AOD_CODEX_BOARD_TOOLS_DIR: '/synthetic/private-grants' }).codex.boardToolsDirectory,
      '/synthetic/private-grants');
    for (const path of ['/synthetic/native-home', '/synthetic/native-home/grants']) {
      assert.throws(() => loadConfig({ ...env, AOD_CODEX_BOARD_TOOLS_DIR: path }), /Private task tool binding unavailable/, path);
    }
  }
});
