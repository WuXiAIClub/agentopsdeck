import assert from 'node:assert/strict';
import test from 'node:test';
import { mainBuildEnvironment, mainCandidateConfiguration } from './prepare-connector-main.mjs';

const config = { format: 1, repository: 'https://git.example.test/team/agentopsdeck.git',
  buildsDirectory: '/synthetic/builds', releasesDirectory: '/synthetic/releases',
  git: '/usr/bin/git', node: '/usr/bin/node', pnpm: '/synthetic/bin/pnpm' };

test('main preparation includes build dependencies even under a production supervisor', () => {
  const inherited = { NODE_ENV: 'production', npm_config_production: 'true', NPM_CONFIG_PRODUCTION: 'true',
    HOME: '/synthetic/helper-home', GIT_TERMINAL_PROMPT: '1',
    OPENAI_API_KEY: 'synthetic-provider-secret', AOD_ACCESS_KEY: 'synthetic-access-secret',
    NPM_TOKEN: 'synthetic-npm-secret', npm_config__authToken: 'synthetic-npm-auth',
    NODE_OPTIONS: '--require /synthetic/hook.cjs' };
  const environment = mainBuildEnvironment(config, inherited);
  assert.equal(environment.NODE_ENV, 'production');
  assert.equal(environment.npm_config_production, 'false');
  assert.equal(environment.NPM_CONFIG_PRODUCTION, 'false');
  assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
  assert.equal(environment.HOME, inherited.HOME, 'retain existing configured Git helper context');
  assert.equal(environment.OPENAI_API_KEY, undefined, 'strip ambient provider credentials');
  assert.equal(environment.AOD_ACCESS_KEY, undefined, 'strip ambient service access keys');
  assert.equal(environment.NPM_TOKEN, undefined, 'strip ambient npm tokens');
  assert.equal(environment.npm_config__authToken, undefined, 'strip ambient npm auth config');
  assert.equal(environment.NODE_OPTIONS, undefined, 'strip ambient NODE_OPTIONS');
  assert.equal(inherited.NODE_ENV, 'production', 'never mutate the service environment');
});

test('candidate assets remain production builds even from a development shell', () => {
  const environment = mainBuildEnvironment(config, { NODE_ENV: 'development' });
  assert.equal(environment.NODE_ENV, 'production');
  assert.equal(environment.npm_config_production, 'false', 'build dependencies remain available');
  assert.equal(environment.NPM_CONFIG_PRODUCTION, 'false');
});

test('candidate builder has fixed main semantics and rejects credential URLs, paths and command overrides', () => {
  assert.deepEqual(mainCandidateConfiguration(config), config);
  for (const patch of [{ repository: 'https://user:secret@git.example.test/repo' },
    { repository: 'https://git.example.test/repo?token=secret' }, { repository: 'file:///repo' },
    { repository: 'http://git.example.test/repo' }, { branch: 'other' }, { command: 'shell' },
    { buildsDirectory: '/' }, { pnpm: 'pnpm' }, { releasesDirectory: '/synthetic/builds/releases' }]) {
    assert.throws(() => mainCandidateConfiguration({ ...config, ...patch }));
  }
});
