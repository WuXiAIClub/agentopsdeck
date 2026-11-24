import assert from 'node:assert/strict';
import test from 'node:test';
import { litellmProbeEnvironment } from './sdk-litellm-settings.mjs';
const valid = { baseUrl: 'https://models.example.test', model: 'authorized-model', apiKeyFile: '/private/key',
  claudeSdkDirectory: '/deps/claude', copilotSdkDirectory: '/deps/copilot' };
test('LiteLLM maps each native protocol explicitly without GitHub credentials', () => {
  const env = litellmProbeEnvironment(valid, '/fixture');
  assert.equal(env.AOD_CLAUDE_BASE_URL, valid.baseUrl);
  assert.equal(env.AOD_COPILOT_BASE_URL, `${valid.baseUrl}/v1`);
  assert.equal(env.AOD_COPILOT_AUTH_MODE, 'provider');
  assert.equal(env.AOD_COPILOT_WIRE_API, 'completions');
  assert.notEqual(env.AOD_CLAUDE_HOME, env.AOD_COPILOT_HOME);
  assert.equal(env.AOD_COPILOT_GITHUB_TOKEN_FILE, undefined);
});
test('LiteLLM private HTTP requires opt-in and responses stays explicit', () => {
  assert.throws(() => litellmProbeEnvironment({ ...valid, baseUrl: 'http://models.example.test' }, '/fixture'));
  const env = litellmProbeEnvironment({ ...valid, baseUrl: 'http://models.example.test', allowHttp: true, copilotWireApi: 'responses' }, '/fixture');
  assert.equal(env.AOD_COPILOT_WIRE_API, 'responses');
});
test('LiteLLM rejects inline secrets, URL credentials, ambiguous paths and unsafe fields', () => {
  for (const patch of [{ apiKey: 'not-a-real-secret' }, { apiKeyFile: 'relative/key' }, { model: 'has space' },
    { baseUrl: 'https://user:pass@example.test' }, { baseUrl: 'https://models.example.test/v1' },
    { baseUrl: 'https://models.example.test?key=secret' }, { copilotWireApi: 'automatic' }]) {
    assert.throws(() => litellmProbeEnvironment({ ...valid, ...patch }, '/fixture'));
  }
});
