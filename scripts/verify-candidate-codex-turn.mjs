import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';

const [candidateRoot, command, model, providerOrigin, scenario] = process.argv.slice(2);
const resumeProvider = scenario === '--resume-provider-switch';
const switchModel = scenario?.startsWith('--switch-model=') ? scenario.slice('--switch-model='.length) : undefined;
assert.ok((process.argv.length === 6 || process.argv.length === 7 && (resumeProvider || switchModel))
  && isAbsolute(candidateRoot) && isAbsolute(command));
assert.match(model, /^[a-zA-Z0-9._-]+$/);
if (switchModel) { assert.match(switchModel, /^[a-zA-Z0-9._/-]{1,200}$/); assert.notEqual(switchModel, model); }
const provider = new URL(providerOrigin);
assert.ok(provider.protocol === 'http:' && provider.hostname === '127.0.0.1' && provider.port
  && !provider.username && !provider.password && !provider.search && !provider.hash && provider.pathname === '/');
const candidate = await verifyCandidateRelease(candidateRoot);
const directory = await mkdtemp('/tmp/agentopsdeck-candidate-codex-turn-');
console.log('EVIDENCE', directory);
for (const name of ['home', 'native', 'state', 'workspace', 'tmp']) await mkdir(join(directory, name));
const providerConfig = `model = ${JSON.stringify(model)}
model_provider = "copilot_bridge"
[model_providers.copilot_bridge]
name = "copilot_bridge"
base_url = ${JSON.stringify(provider.origin)}
wire_api = "responses"
requires_openai_auth = false
`;
await writeFile(join(directory, 'native/config.toml'), resumeProvider ? `model = ${JSON.stringify(model)}
model_provider = "disconnected_acceptance"
[model_providers.disconnected_acceptance]
name = "disconnected_acceptance"
base_url = "http://127.0.0.1:1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
` : providerConfig, { mode: 0o600 });
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, { PATH: '/usr/bin:/bin', HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'),
  CODEX_HOME: join(directory, 'native'), NODE_ENV: 'test' });
process.chdir(join(directory, 'state'));
const { loadConfig } = await import(join(candidateRoot, 'apps/server/dist/config.js'));
const { createApplication } = await import(join(candidateRoot, 'apps/server/dist/application.js'));
const { createConnectorRuntime } = await import(join(candidateRoot, 'apps/server/dist/connector/runtime.js'));
const accessKey = randomBytes(32).toString('hex');
const config = loadConfig({ AOD_SERVER_ROLE: 'all', AOD_ACCESS_KEY: accessKey,
  AOD_HUB_VAULT_SECRET: randomBytes(32).toString('hex'), AOD_CODEX_ENABLED: 'true',
  AOD_CODEX_COMMAND: command, AOD_CODEX_HOME: join(directory, 'native'), AOD_CODEX_DEFAULT_CWD: join(directory, 'workspace'),
  AOD_CODEX_DEFAULT_MODEL: model, AOD_CODEX_APPROVAL_POLICY: 'on-request',
  ...(!resumeProvider ? { AOD_CODEX_MODEL_PROVIDER: 'copilot_bridge' } : {}),
  AOD_HUB_LOCAL_CONNECTION_ID: 'parallel-codex', AOD_LOCAL_OPENCLAW_CLI: 'false',
  AOD_CONNECTOR_UPDATE_ENABLED: 'false', AOD_MEDIA_BRIDGE_ENABLED: 'false',
  AOD_MEDIA_LIBRARY_ENABLED: 'false', AOD_ARTIFACT_RECEIVER_ENABLED: 'false' });
const evidence = { passed: false, candidate, model, provider: 'copilot_bridge', protocol: [], modelRequests: 0,
  scenario: scenario ?? 'fresh-session', turnModels: [], toolItems: 0, replyMatched: false, nativeClosed: false, userInstanceTouched: false, errors: [] };
let application, runtime, nativeChild;
const nativeChildren = [];
function startApplication() {
  return createApplication(config, (...args) => {
    runtime = createConnectorRuntime(...args);
    const nativeRequest = runtime.codex.request.bind(runtime.codex);
    runtime.codex.request = async (...requestArgs) => {
      let response;
      try { response = await nativeRequest(...requestArgs); }
      catch (error) {
        evidence.lastRequestError = { method: requestArgs[0], unknownProvider: /provider.*not (found|supported)|unknown.*provider/i.test(String(error)) };
        throw error;
      }
      if (requestArgs[0] === 'thread/resume') evidence.lastResume = {
        status: response?.thread?.status?.type, modelProvider: response?.thread?.modelProvider,
        selectedModelProvider: response?.modelProvider,
        lastTurnStatus: response?.thread?.turns?.at(-1)?.status, lastTurnId: response?.thread?.turns?.at(-1)?.id,
      };
      if (requestArgs[0] === 'thread/read') evidence.lastNativeRead = {
        status: response?.thread?.status?.type,
        modelProvider: response?.thread?.modelProvider,
        lastTurnStatus: response?.thread?.turns?.at(-1)?.status,
        lastTurnId: response?.thread?.turns?.at(-1)?.id,
      };
      return response;
    };
    const write = runtime.codex.write.bind(runtime.codex);
    runtime.codex.write = message => {
      evidence.protocol.push(message.method);
      if (message.method === 'turn/start') {
        assert.ok(++evidence.modelRequests <= (scenario ? 2 : 1), 'Never replay a test turn');
        evidence.turnModels.push(message.params.model);
        message.params.sandboxPolicy = { type: 'readOnly' };
      }
      if (['thread/start', 'thread/resume'].includes(message.method)) message.params.sandbox = 'read-only';
      return write(message);
    };
    const notify = runtime.codex.handleNotification.bind(runtime.codex);
    runtime.codex.handleNotification = (method, params) => {
      if (method === 'item/started' && ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange'].includes(params?.item?.type)) evidence.toolItems++;
      return notify(method, params);
    };
    return runtime;
  });
}
try {
  application = startApplication();
  const origin = 'http://localhost';
  const login = await application.app.request('/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ accessKey }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const headers = { cookie, origin, 'content-type': 'application/json' };
  const request = async (path, body, expected = 200) => {
    const response = await application.app.request(path, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, expected, `Unexpected HTTP status for ${path}`);
    return response.json();
  };
  await request('/api/hub/v1/connections/parallel-codex/verify', {});
  const creation = await request('/api/hub/v1/connections/parallel-codex/agents/codex/sessions',
    { title: 'Isolated model acceptance', idempotencyKey: 'acceptance.create' }, 201);
  const path = `/api/hub/v1/sessions/${encodeURIComponent(creation.key)}`;
  if (resumeProvider) {
    nativeChildren.push(runtime.codex.child);
    evidence.step = 'seed-terminal-provider-failure';
    await request(`${path}/messages`, { message: 'Isolated disconnected-provider test. Do not use tools.',
      deliveryMode: 'web-only', media: [], idempotencyKey: 'acceptance.disconnected' });
    const seedDeadline = Date.now() + 30_000;
    while (Date.now() < seedDeadline) {
      const before = await request('/api/hub/v1/sessions/state');
      const session = before.groups.flatMap(group => group.sessions).find(item => item.sessionKey === creation.key);
      evidence.seedRuntime = session?.runtime;
      if (session?.runtime?.phase === 'failed') {
        assert.equal(evidence.lastNativeRead?.modelProvider, 'disconnected_acceptance');
        evidence.seedFailed = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(evidence.seedFailed, true);
    await application.close();
    evidence.step = 'restart-with-working-provider';
    await writeFile(join(directory, 'native/config.toml'), providerConfig, { mode: 0o600 });
    config.codex.modelProvider = 'copilot_bridge';
    application = startApplication();
    const relogin = await application.app.request('/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ accessKey }) });
    assert.equal(relogin.status, 200);
    headers.cookie = relogin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const after = await request('/api/hub/v1/sessions/state');
    assert.ok(after.groups.flatMap(group => group.sessions).some(session => session.sessionKey === creation.key));
    evidence.existingSessionPreserved = true;
  }
  evidence.step = 'working-provider-greeting';
  const startedAt = Date.now();
  const sent = await request(`${path}/messages`, { message: 'Reply with exactly AOD_V2_OK. Do not use tools, read or write files, or execute commands.',
    deliveryMode: 'web-only', media: [], idempotencyKey: 'acceptance.greeting' });
  evidence.admission = sent.status;
  nativeChild = runtime.codex.child;
  nativeChildren.push(nativeChild);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const sessions = await request('/api/hub/v1/sessions/state');
    const session = sessions.groups.flatMap(group => group.sessions).find(item => item.sessionKey === creation.key);
    evidence.lastRuntime = session?.runtime;
    if (session?.runtime?.phase === 'failed' && session.runtime.turnId !== evidence.seedRuntime?.turnId) throw new Error('Native model turn failed');
    if (session?.runtime?.phase === 'completed' && session.runtime.sync === 'current' && !session.hasActiveRun) {
      const messages = await request(`${path}/messages?limit=10`);
      evidence.messageCount = messages.messages.length;
      evidence.replyMatched = messages.messages.some(message => message.role === 'assistant' && message.text.trim() === 'AOD_V2_OK');
      assert.equal(evidence.replyMatched, true);
      evidence.elapsedMs = Date.now() - startedAt;
      evidence.finalRuntime = session.runtime;
      evidence.sessionModel = session.model;
      evidence.sessionProvider = session.modelProvider;
      assert.equal(evidence.sessionProvider, 'copilot_bridge');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(evidence.replyMatched, true, 'Model reply deadline exceeded');
  if (switchModel) {
    evidence.step = 'apply-model-and-execute-next-turn';
    const response = await application.app.request(`/api/sessions/${encodeURIComponent(creation.key)}`, {
      method: 'PATCH', headers, body: JSON.stringify({ model: switchModel, idempotencyKey: 'acceptance.switch-model' }),
    });
    assert.equal(response.status, 200, 'Model settings must be accepted before sending');
    const changed = await response.json();
    assert.equal(changed.command?.state, 'accepted');
    const previousTurn = evidence.finalRuntime.turnId;
    await request(`${path}/messages`, { message: 'Reply with exactly AOD_MODEL_SWITCH_OK. Do not use tools, read or write files, or execute commands.',
      deliveryMode: 'web-only', media: [], idempotencyKey: 'acceptance.switched-greeting' });
    const switchDeadline = Date.now() + 180_000;
    while (Date.now() < switchDeadline) {
      const state = await request('/api/hub/v1/sessions/state');
      const session = state.groups.flatMap(group => group.sessions).find(item => item.sessionKey === creation.key);
      if (session?.runtime?.turnId !== previousTurn && session?.runtime?.phase === 'failed') throw new Error('Switched model turn failed');
      if (session?.runtime?.turnId !== previousTurn && session?.runtime?.phase === 'completed' && session.runtime.sync === 'current' && !session.hasActiveRun) {
        const history = await request(`${path}/messages?limit=20`);
        assert.equal(history.messages.filter(message => message.role === 'user').length, 2);
        assert.equal(history.messages.filter(message => message.role === 'assistant' && message.text.trim() === 'AOD_MODEL_SWITCH_OK').length, 1);
        assert.equal(session.model, switchModel);
        assert.equal(session.modelProvider, 'copilot_bridge');
        assert.deepEqual(evidence.turnModels, [model, switchModel]);
        evidence.modelSwitchVerified = true;
        evidence.switchedRuntime = session.runtime;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(evidence.modelSwitchVerified, true, 'Switched model reply deadline exceeded');
  }
  assert.equal(evidence.toolItems, 0);
  assert.equal(evidence.modelRequests, scenario ? 2 : 1);
  if (resumeProvider) {
    evidence.step = 'completed-history-restart-without-replay';
    await application.close();
    application = startApplication();
    const relogin = await application.app.request('/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ accessKey }) });
    assert.equal(relogin.status, 200);
    headers.cookie = relogin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const restoreDeadline = Date.now() + 20_000;
    while (Date.now() < restoreDeadline) {
      const state = await request('/api/hub/v1/sessions/state');
      const session = state.groups.flatMap(group => group.sessions).find(item => item.sessionKey === creation.key);
      if (session?.runtime?.phase === 'completed' && session.runtime.sync === 'current' && !session.hasActiveRun) {
        assert.equal(evidence.lastResume.selectedModelProvider, 'copilot_bridge');
        assert.equal(session.runtime.turnId, evidence.finalRuntime.turnId);
        const messages = await request(`${path}/messages?limit=10`);
        assert.equal(messages.messages.filter(message => message.role === 'user').length, 2);
        assert.equal(messages.messages.filter(message => message.role === 'assistant' && message.text.trim() === 'AOD_V2_OK').length, 1);
        evidence.completedHistoryRestored = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    nativeChildren.push(runtime.codex.child);
    assert.equal(evidence.completedHistoryRestored, true);
    assert.equal(evidence.modelRequests, 2);
  }
  assert.deepEqual(await verifyCandidateRelease(candidateRoot), candidate);
  evidence.passed = true;
} catch {
  evidence.errors.push('Model acceptance failed; credential-bearing exception details suppressed');
  process.exitCode = 1;
} finally {
  if (application) await application.close();
  evidence.nativeClosed = [...nativeChildren, runtime?.codex.child].every(child => !child || child.exitCode !== null || child.signalCode !== null);
  if (!evidence.nativeClosed) { evidence.passed = false; process.exitCode = 1; }
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
}
