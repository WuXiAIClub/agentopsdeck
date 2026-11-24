import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';

// This manifest contains paths and public settings only. Credentials are read
// by the existing private worker, never passed on argv or returned in evidence.
export function litellmProbeEnvironment(settings, data) {
  assert.ok(settings && typeof settings === 'object');
  const fields = ['baseUrl', 'model', 'apiKeyFile', 'claudeSdkDirectory', 'copilotSdkDirectory', 'allowHttp', 'copilotWireApi'];
  assert.ok(Object.keys(settings).every(key => fields.includes(key)), 'Unknown setting; do not put secrets in the manifest');
  for (const key of ['apiKeyFile', 'claudeSdkDirectory', 'copilotSdkDirectory']) {
    assert.ok(typeof settings[key] === 'string' && isAbsolute(settings[key]) && !/[\x00-\x1f]/.test(settings[key]), 'Absolute paths required');
  }
  assert.ok(typeof settings.model === 'string' && settings.model.length > 0 && settings.model.length <= 256 && !/\s/.test(settings.model), 'Model required');
  const url = new URL(settings.baseUrl);
  assert.ok(!url.username && !url.password && !url.search && !url.hash, 'Endpoint must not contain credentials');
  assert.ok(url.pathname === '/' || url.pathname === '', 'LiteLLM origin required, without /v1');
  assert.ok(url.protocol === 'https:' || url.protocol === 'http:' && settings.allowHttp === true, 'Explicit trusted HTTP opt-in required');
  const wireApi = settings.copilotWireApi ?? 'completions';
  assert.ok(['completions', 'responses'].includes(wireApi), 'Explicit supported Copilot wire API required');
  const base = url.origin;
  return {
    AOD_CLAUDE_ENABLED: 'true', AOD_CLAUDE_DEDICATED: 'true',
    AOD_CLAUDE_SDK_DIR: settings.claudeSdkDirectory,
    AOD_CLAUDE_HOME: join(data, 'claude-home'), AOD_CLAUDE_WORKSPACE: join(data, 'workspace'),
    AOD_CLAUDE_API_KEY_FILE: settings.apiKeyFile, AOD_CLAUDE_BASE_URL: base,
    AOD_CLAUDE_ALLOW_HTTP: String(settings.allowHttp === true), AOD_CLAUDE_MODEL: settings.model,
    AOD_CLAUDE_TOOL_POLICY: 'workspace-read',
    AOD_COPILOT_ENABLED: 'true', AOD_COPILOT_DEDICATED: 'true',
    AOD_COPILOT_SDK_DIR: settings.copilotSdkDirectory,
    AOD_COPILOT_HOME: join(data, 'copilot-home'), AOD_COPILOT_WORKSPACE: join(data, 'workspace'),
    AOD_COPILOT_API_KEY_FILE: settings.apiKeyFile, AOD_COPILOT_BASE_URL: `${base}/v1`,
    AOD_COPILOT_ALLOW_HTTP: String(settings.allowHttp === true), AOD_COPILOT_MODEL: settings.model,
    AOD_COPILOT_TOOL_POLICY: 'workspace-read', AOD_COPILOT_AUTH_MODE: 'provider',
    AOD_COPILOT_PROVIDER_TYPE: 'openai', AOD_COPILOT_WIRE_API: wireApi,
  };
}
