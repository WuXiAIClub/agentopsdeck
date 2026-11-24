// Operator-invoked real model acceptance. Independent HOME/state/workspace,
// no production sessions or credentials; never replay an uncertain send.
// Uses the deployed runtime's native full-access policy: independent state is
// NOT an OS sandbox. Only run with authorization for real native file tools.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';
import { verifyAllCardLinkage } from './lib/all-card-linkage-probe.mjs';

export function hasTurnBoundFileBoardReply(messages, { turnId, marker, priorMessageIds, match = 'includes' } = {}) {
  if (!Array.isArray(messages) || typeof turnId !== 'string' || !turnId.trim() || typeof marker !== 'string' || !marker) {
    return false;
  }
  return messages.some(message => {
    if (!message || message.role !== 'assistant' || message.status === 'failed' || typeof message.text !== 'string') {
      return false;
    }
    if (typeof message.turnId === 'string' && message.turnId.trim()) {
      if (message.turnId !== turnId) return false;
    } else if (priorMessageIds instanceof Set && typeof message.id === 'string' && message.id) {
      if (priorMessageIds.has(message.id)) return false;
    } else {
      return false;
    }
    return match === 'exact' ? message.text.trim() === marker : message.text.includes(marker);
  });
}

async function main() {
const [candidateRoot, command, model, providerOrigin] = process.argv.slice(2);
const businessContent = process.argv[6] === '--file-card-content';
const fileCards = process.argv[6] === '--file-cards' || businessContent;
assert.ok(process.argv.length === (fileCards ? 7 : 6) && isAbsolute(candidateRoot) && isAbsolute(command));
assert.match(model, /^[a-zA-Z0-9._-]+$/);
const provider = new URL(providerOrigin);
assert.ok(provider.protocol === 'http:' && provider.hostname === '127.0.0.1' && provider.port
  && !provider.username && !provider.password && !provider.search && !provider.hash && provider.pathname === '/');
const candidate = await verifyCandidateRelease(candidateRoot);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-candidate-file-boards-'));
console.log('EVIDENCE', directory);
for (const name of ['home', 'native', 'state', 'workspace', 'tmp', 'workspace/panels']) {
  await mkdir(join(directory, name), { mode: 0o700 });
}
await writeFile(join(directory, 'native/config.toml'), `model = ${JSON.stringify(model)}
model_provider = "copilot_bridge"
[model_providers.copilot_bridge]
name = "copilot_bridge"
base_url = ${JSON.stringify(provider.origin)}
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
`, { mode: 0o600, flag: 'wx' });
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, { PATH: '/usr/bin:/bin', HOME: join(directory, 'home'),
  TMPDIR: join(directory, 'tmp'), CODEX_HOME: join(directory, 'native'), NODE_ENV: 'test' });
process.chdir(join(directory, 'state'));
const { loadConfig } = await import(join(candidateRoot, 'apps/server/dist/config.js'));
const { createApplication } = await import(join(candidateRoot, 'apps/server/dist/application.js'));
const { createConnectorRuntime } = await import(join(candidateRoot, 'apps/server/dist/connector/runtime.js'));
const accessKey = randomBytes(32).toString('hex'), panelRoot = join(directory, 'workspace/panels');
const config = loadConfig({ AOD_SERVER_ROLE: 'all', AOD_ACCESS_KEY: accessKey,
  AOD_HUB_VAULT_SECRET: randomBytes(32).toString('hex'), AOD_CODEX_ENABLED: 'true',
  AOD_CODEX_COMMAND: command, AOD_CODEX_HOME: join(directory, 'native'),
  AOD_CODEX_DEFAULT_CWD: join(directory, 'workspace'), AOD_CODEX_DEFAULT_MODEL: model,
  AOD_CODEX_APPROVAL_POLICY: 'never', AOD_CODEX_MODEL_PROVIDER: 'copilot_bridge',
  AOD_HUB_LOCAL_CONNECTION_ID: 'parallel-codex', AOD_LOCAL_OPENCLAW_CLI: 'false',
  AOD_CONNECTOR_UPDATE_ENABLED: 'false', AOD_MEDIA_BRIDGE_ENABLED: 'false',
  AOD_MEDIA_LIBRARY_ENABLED: 'false', AOD_ARTIFACT_RECEIVER_ENABLED: 'false',
  AOD_BOARD_FILES_ENABLED: 'true', AOD_BOARD_FILES_JSON: JSON.stringify({ root: panelRoot,
    policies: [{ owner: 'local:file-boards', runtime: 'codex' }] }) });
const evidence = { passed: false, candidate, model, startedAt: new Date().toISOString(),
  step: 'startup', modelRequests: 0, toolItems: 0, checkpoints: [], nativeClosed: false,
  productionSessionsTouched: false, syntheticAgent: false, sandboxOverride: false,
  connectorCalls: [], errors: [] };
let application, runtime, cookie;
const children = [], origin = 'http://localhost';
const boardPath = '/api/hub/v1/workspace/boards/default';
const save = () => writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
async function request(path, body, method = body === undefined ? 'GET' : 'POST', allowed = [200]) {
  const response = await application.app.request(path, { method, headers: {
    origin, ...(cookie ? { cookie } : {}), 'content-type': 'application/json',
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  assert.ok(allowed.includes(response.status), `${method} ${path}: HTTP ${response.status}`);
  if (path === '/api/auth/login') cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  return response.json();
}
async function start() {
  application = createApplication(config, (...args) => {
    runtime = createConnectorRuntime(...args);
    const fetch = runtime.app.fetch.bind(runtime.app);
    runtime.app.fetch = async (...input) => {
      const response = await fetch(...input);
      const req = input[0];
      if (new URL(req.url).pathname.includes('/workspace/board-files')) {
        evidence.connectorCalls.push({ method: req.method, status: response.status });
      }
      return response;
    };
    const write = runtime.codex.write.bind(runtime.codex);
    runtime.codex.write = message => {
      if (message.method === 'turn/start') {
        assert.ok(++evidence.modelRequests <= 2, 'No hidden or repeated test turn');
      }
      return write(message);
    };
    const notify = runtime.codex.handleNotification.bind(runtime.codex);
    runtime.codex.handleNotification = (method, params) => {
      if (method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall'].includes(params?.item?.type)) evidence.toolItems++;
      return notify(method, params);
    };
    return runtime;
  });
  await request('/api/auth/login', { accessKey });
}
async function close() {
  if (!application) return;
  if (runtime.codex.child) children.push(runtime.codex.child);
  await application.close(); application = undefined;
}
async function checkpoint(name) { evidence.checkpoints.push(name); await save(); }
async function until(probe, description, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Deadline: ' + description);
}
try {
  await start();
  await request('/api/hub/v1/connections/parallel-codex/verify', {});
  if (fileCards) {
    const sessions = new Map();
    await verifyAllCardLinkage({
      businessContent,
      json: (path, method = 'GET', body, status = 200) => request(path, body, method, [status, ...(status === 200 ? [202] : [])]),
      wait: until, start, stop: close, sessions, runtimes: ['codex'], connectionId: 'parallel-codex', panelRoot,
      state: async () => (await request('/api/hub/v1/sessions/state')).groups.flatMap(g => g.sessions).find(s => s.sessionKey === sessions.get('codex')),
      result: evidence, checkpoint: async label => { evidence.step = label; await checkpoint(label); },
    });
    assert.equal(evidence.modelRequests, 2); assert.ok(evidence.toolItems > 0);
  } else {
  const creation = await request('/api/hub/v1/connections/parallel-codex/agents/codex/sessions',
    { title: 'Isolated file board acceptance', idempotencyKey: 'fileboard.create' }, 'POST', [201]);
  const sessionPath = `/api/hub/v1/sessions/${encodeURIComponent(creation.key)}`;
  const board = await request(boardPath, { title: 'File acceptance', tasks: [], revision: 0, mutationId: randomUUID() }, 'PUT');
  const bindingId = randomUUID();
  await request(`${boardPath}/file-binding`, { requestId: bindingId, revision: board.revision, sessionId: creation.key }, 'POST', [200, 202]);
  await until(async () => (await request(`${boardPath}/file-binding/${bindingId}`)).binding.state === 'active', 'binding', 15_000);
  assert.equal(evidence.modelRequests, 0);
  await checkpoint('empty-board-linked-without-run');
  const sentTexts = [];
  async function turn(message, id, expectedTitles, expectedMarker) {
    evidence.step = id; await save(); sentTexts.push(message);
    const beforeState = await request('/api/hub/v1/sessions/state');
    const beforeSession = beforeState.groups.flatMap(group => group.sessions).find(item => item.sessionKey === creation.key);
    const previousTurnId = beforeSession?.runtime?.turnId;
    const priorMessages = await request(`${sessionPath}/messages?limit=50`);
    const priorMessageIds = new Set((priorMessages.messages ?? []).map(item => item.id).filter(Boolean));
    await request(`${sessionPath}/messages`, { message, deliveryMode: 'web-only', media: [], idempotencyKey: id });
    const expectedStarts = sentTexts.length;
    let completedTurnId;
    await until(async () => {
      const state = await request('/api/hub/v1/sessions/state');
      const session = state.groups.flatMap(group => group.sessions).find(item => item.sessionKey === creation.key);
      evidence.lastRuntime = session?.runtime;
      assert.notEqual(session?.runtime?.phase, 'failed', 'Native model failed');
      const value = await request(boardPath);
      const ready = evidence.modelRequests === expectedStarts
        && Boolean(session?.runtime?.turnId) && session.runtime.turnId !== previousTurnId
        && session?.runtime?.phase === 'completed'
        && session.runtime.sync === 'current' && !session.hasActiveRun
        && expectedTitles.every(title => value.tasks.some(task => task.title === title && task.status === 'done'));
      if (ready) completedTurnId = session.runtime.turnId;
      return ready;
    }, id);
    const messages = await request(`${sessionPath}/messages?limit=50`);
    for (const text of sentTexts) assert.ok(messages.messages.some(m => m.role === 'user' && m.text === text), 'Original user message retained');
    assert.ok(hasTurnBoundFileBoardReply(messages.messages, {
      turnId: completedTurnId,
      marker: expectedMarker,
      priorMessageIds,
    }), 'Actual turn-bound model final reply');
    const file = JSON.parse(await readFile(join(panelRoot, bindingId, 'tasks.json'), 'utf8'));
    assert.ok(expectedTitles.every(title => file.tasks.some(task => task.title === title && task.status === 'done')));
    await checkpoint(id);
  }
  await turn('This is an isolated acceptance test. Use the task progress file convention supplied with this turn. '
    + 'Read that file, add one task titled FIRST_NATIVE_TASK with a valid UUID and status done, and write valid JSON. '
    + 'Only modify that progress file within this isolated workspace; do not inspect other files, use network, or spawn agents. '
    + 'Use ordinary file tools, not a task-board API. Then reply FILE_BOARD_FIRST_OK.',
    'fileboard.first', ['FIRST_NATIVE_TASK'], 'FILE_BOARD_FIRST_OK');
  const prior = await request(boardPath);
  evidence.step = 'restart'; await close(); await start();
  // Application construction is not native business readiness. Wait for the
  // existing thread's ordinary read-side recovery before sending once.
  await until(async () => {
    const state = await request('/api/hub/v1/sessions/state');
    const session = state.groups.flatMap(group => group.sessions).find(item => item.sessionKey === creation.key);
    return session?.runtime?.phase === 'completed' && session.runtime.sync === 'current' && !session.hasActiveRun;
  }, 'native-restart-readiness');
  await request(`${sessionPath}/messages?limit=50`);
  assert.deepEqual((await request(boardPath)).tasks, prior.tasks);
  await checkpoint('restart-preserves-binding-and-projection');
  await turn('Continue the isolated acceptance test using the supplied task progress file convention. '
    + 'Preserve the existing task and add a second task titled SECOND_NATIVE_TASK with a new valid UUID and status done. '
    + 'Only modify that progress file; do not inspect other files, use network, or spawn agents. '
    + 'Use ordinary file tools, not a task-board API. Then reply FILE_BOARD_SECOND_OK.',
    'fileboard.second', ['FIRST_NATIVE_TASK', 'SECOND_NATIVE_TASK'], 'FILE_BOARD_SECOND_OK');
  const finalBoard = await request(boardPath);
  await request(`${boardPath}/file-binding/${bindingId}`, undefined, 'DELETE');
  const filePath = join(panelRoot, bindingId, 'tasks.json');
  const file = JSON.parse(await readFile(filePath, 'utf8'));
  file.tasks.push({ id: randomUUID(), title: 'AFTER_UNLINK', detail: '', status: 'todo' });
  await writeFile(filePath, JSON.stringify(file), { mode: 0o600 });
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.deepEqual((await request(boardPath)).tasks, finalBoard.tasks);
  assert.equal(evidence.modelRequests, 2); assert.ok(evidence.toolItems > 0);
  await checkpoint('unlink-retains-file-and-freezes-projection');
  }
  assert.deepEqual(await verifyCandidateRelease(candidateRoot), candidate);
  evidence.passed = true;
} catch (error) {
  // Do not dump provider/native errors, prompts or authentication material.
  evidence.errors.push(error instanceof assert.AssertionError ? error.message : 'Acceptance failed at ' + evidence.step);
  process.exitCode = 1;
} finally {
  await close();
  evidence.nativeClosed = children.every(child => child.exitCode !== null || child.signalCode !== null);
  if (!evidence.nativeClosed) { evidence.passed = false; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString(); await save(); console.log(JSON.stringify(evidence));
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
