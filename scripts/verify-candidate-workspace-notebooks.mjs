// Real candidate HTTP/auth/storage boundary; isolated synthetic accounts only.
// No production credentials, native Agent, remote connection or model requests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';

const candidateRoot = process.argv[2];
assert.ok(process.argv.length === 3 && isAbsolute(candidateRoot));
const candidate = await verifyCandidateRelease(candidateRoot);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-candidate-notebooks-'));
console.log('EVIDENCE', directory);
const home = join(directory, 'isolated');
await mkdir(home);
const guard = join(directory, 'forbid-native.mjs');
await writeFile(guard, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[method] = () => { throw new Error('Native subprocess forbidden in notebook acceptance'); };
}
syncBuiltinESMExports();
`, { mode: 0o600 });
const adminKey = randomBytes(32).toString('hex'), vault = randomBytes(32).toString('hex');
const evidence = { candidate, directory, passed: false, nativeEnabled: false, modelRequests: 0,
  productionDataTouched: false, checks: [], requests: [], startedAt: new Date().toISOString() };
let child, closed, origin, generation = 0;
async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Candidate process deadline')), 20000);
  })]); } finally { clearTimeout(timer); }
}
async function start() {
  generation++;
  origin = undefined;
  child = spawn(process.execPath, ['--import', guard, join(candidateRoot, candidate.entrypoint)], {
    cwd: home, stdio: ['ignore', 'pipe', 'pipe'],
    env: { HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin', NODE_ENV: 'production', PORT: '0',
      AOD_LISTEN_HOST: '127.0.0.1', AOD_SERVER_ROLE: 'hub',
      AOD_ACCESS_KEY: adminKey, AOD_HUB_VAULT_SECRET: vault,
      AOD_CODEX_ENABLED: 'false', AOD_CLAUDE_ENABLED: 'false', AOD_COPILOT_ENABLED: 'false',
      AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_CONNECTOR_UPDATE_ENABLED: 'false',
      AOD_MEDIA_BRIDGE_ENABLED: 'false', AOD_ARTIFACT_RECEIVER_ENABLED: 'false' },
  });
  let output = '', errorOutput = '';
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      output += chunk;
      const found = output.match(/AgentOpsDeck server listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (found) resolve(found[1]);
    });
    child.stderr.on('data', chunk => { errorOutput += chunk; });
    void closed.then(() => reject(new Error('Candidate exited before readiness')));
  });
  try { origin = await within(ready); }
  finally {
    // Retain only sanitized diagnostics: server output may contain synthetic login material.
    evidence.processes ??= [];
    evidence.processes.push({ generation, ready: Boolean(origin), stdoutBytes: output.length, stderrBytes: errorOutput.length });
  }
}
async function stop() {
  if (!child) return;
  child.kill('SIGTERM');
  try { assert.deepEqual(await within(closed), { code: 0, signal: null }); }
  catch (error) { child.kill('SIGKILL'); await closed; throw error; }
  finally { child = undefined; }
}
async function request(cookie, path, method = 'GET', body, expected = 200) {
  const response = await fetch(origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { origin, cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  evidence.requests.push({ path, method, status: response.status });
  assert.equal(response.status, expected, `${method} ${path}`);
  const json = response.headers.get('content-type')?.includes('application/json') ? await response.json() : undefined;
  return { response, json };
}
async function login(key) {
  const { response } = await request('', '/api/auth/login', 'POST', { accessKey: key });
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie); return cookie;
}
async function machineRequest(token, path = '/api/workspace-agent/v1/board', method = 'GET', body, expected = 200) {
  const response = await fetch(origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  // Never record request headers/body or the one-time capability secret.
  evidence.requests.push({ path, method, status: response.status, machineCapability: true });
  assert.equal(response.status, expected, `${method} ${path}`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return await response.json();
}
const notePath = '/api/hub/v1/notebooks/00000000-0000-4000-8000-000000000230';
const boardPath = '/api/hub/v1/workspace/boards/default';
try {
  await start();
  await request('', notePath, 'GET', undefined, 401);
  let admin = await login(adminKey);
  const accounts = [];
  for (const label of ['Workspace Alice', 'Workspace Bob']) {
    const { json: { user } } = await request(admin, '/api/hub/v1/users', 'POST', { label }, 201);
    const { json: credential } = await request(admin, `/api/hub/v1/users/${user.id}/login-keys`, 'POST', {}, 201);
    accounts.push({ id: user.id, key: credential.token, cookie: await login(credential.token) });
  }
  const [alice, bob] = accounts;
  const capacityPath = '/api/hub/v1/notebooks/' + randomUUID();
  const archivePath = capacityPath + '/archive';
  const { json: emptyHot } = await request(alice.cookie, capacityPath);
  const { json: emptyCold } = await request(alice.cookie, archivePath);
  const hotWrite = { resourceId: emptyHot.resourceId, revision: 0, text: '文'.repeat(50_000) };
  const coldWrite = { resourceId: emptyCold.resourceId, revision: 0, text: '冷'.repeat(100_000) };
  await request('', archivePath, 'GET', undefined, 401);
  await request('', archivePath, 'PUT', coldWrite, 401);
  const { json: hotSaved } = await request(alice.cookie, capacityPath, 'PUT', hotWrite);
  const { json: coldSaved, response: coldResponse } = await request(alice.cookie, archivePath, 'PUT', coldWrite);
  assert.equal(coldResponse.headers.get('cache-control'), 'no-store');
  assert.equal(hotSaved.text.length, 50_000); assert.equal(coldSaved.text.length, 100_000);
  await request(alice.cookie, capacityPath, 'PUT', { ...hotWrite, revision: 1, text: hotWrite.text + '超' }, 400);
  await request(alice.cookie, archivePath, 'PUT', { ...coldWrite, revision: 1, text: coldWrite.text + '超' }, 400);
  await request(alice.cookie, archivePath, 'PUT', { ...coldWrite, text: 'stale' }, 409);
  assert.deepEqual((await request(alice.cookie, capacityPath)).json, hotSaved);
  for (const cookie of [bob.cookie, admin]) assert.equal((await request(cookie, archivePath)).json.text, '');
  const preferencesPath = '/api/hub/v1/workspace/preferences';
  const tagsWrite = { revision: 0, groups: [{ id: 'work', name: 'Work' }], sessions: { 'synthetic:thread': { groupId: 'work', tags: ['前端', 'release'] } } };
  const { json: tagsSaved } = await request(alice.cookie, preferencesPath, 'PUT', tagsWrite);
  await request(alice.cookie, preferencesPath, 'PUT', { ...tagsWrite, revision: 1, sessions: { 'synthetic:thread': { tags: ['x', 'x'] } } }, 400);
  for (const cookie of [bob.cookie, admin]) assert.deepEqual((await request(cookie, preferencesPath)).json.sessions, {});
  evidence.checks.push('Frozen HTTP: exact 50k/100k limits, independent revisions, CAS, no-store, account isolation and tags validation');
  const layoutPath = '/api/hub/v1/workspace/layouts/current';
  const layoutContent = JSON.stringify({ id: 'current', name: 'Current', workspace: {
    version: 2, panes: [], floating: [], dock: null, active: null }, collapsedKeys: [] });
  const layoutWrite = { revision: 0, content: layoutContent };
  await request('', layoutPath, 'GET', undefined, 401);
  await request('', layoutPath, 'PUT', layoutWrite, 401);
  const { json: layoutSaved, response: layoutResponse } = await request(alice.cookie, layoutPath, 'PUT', layoutWrite);
  assert.equal(layoutResponse.headers.get('cache-control'), 'no-store');
  assert.equal(layoutSaved.revision, 1);
  assert.deepEqual((await request(alice.cookie, layoutPath, 'PUT', layoutWrite)).json, layoutSaved);
  await request(alice.cookie, layoutPath, 'PUT', { ...layoutWrite, content: layoutContent.replace('"active":null', '"active":"changed"') }, 409);
  await request(alice.cookie, layoutPath.replace('/current', '/saved'), 'PUT', { revision: 0, content: '[]' });
  for (const cookie of [bob.cookie, admin]) assert.equal((await request(cookie, layoutPath)).json.content, null);
  evidence.checks.push('Account layouts: real-cookie private isolation, no-store, CAS conflict and idempotent replay');
  await request('', boardPath, 'GET', undefined, 401);
  const boardWrite = { title: 'Candidate release plan', tasks: [{ id: randomUUID(), title: 'Verify boundaries', detail: 'Synthetic task', status: 'doing' }], revision: 0, mutationId: randomUUID() };
  const { json: boardSaved, response: boardResponse } = await request(alice.cookie, boardPath, 'PUT', boardWrite);
  assert.equal(boardResponse.headers.get('cache-control'), 'no-store');
  assert.equal(boardSaved.revision, 1);
  assert.deepEqual((await request(alice.cookie, boardPath, 'PUT', boardWrite)).json, boardSaved);
  await request(alice.cookie, boardPath, 'PUT', { ...boardWrite, mutationId: randomUUID() }, 409);
  for (const cookie of [bob.cookie, admin]) assert.equal((await request(cookie, boardPath)).json.revision, 0);
  evidence.checks.push('Task boards: real-cookie private isolation, no-store, revision conflict and idempotent replay');
  const catalogPath = '/api/hub/v1/workspace/boards', secondBoardPath = `${catalogPath}/${randomUUID()}`;
  const { json: secondBoard } = await request(alice.cookie, secondBoardPath, 'PUT', { ...boardWrite, title: 'Independent board', mutationId: randomUUID() });
  for (const path of [catalogPath, secondBoardPath + '/summary']) {
    await request('', path, 'GET', undefined, 401);
    const { json, response } = await request(alice.cookie, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(json).includes('Synthetic task'), 'summary/catalog must not leak task bodies');
  }
  assert.equal((await request(alice.cookie, catalogPath)).json.boards.length, 2);
  for (const cookie of [bob.cookie, admin]) {
    assert.equal((await request(cookie, catalogPath)).json.boards.length, 1);
    assert.equal((await request(cookie, secondBoardPath + '/summary')).json.revision, 0);
  }
  const { json: initial, response } = await request(alice.cookie, notePath);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(initial.text, '');
  const text = '# Candidate tips\n\n- [ ] Pending\n- [x] Finished\n';
  const body = { resourceId: initial.resourceId, revision: initial.revision, text };
  const { json: saved } = await request(alice.cookie, notePath, 'PUT', body);
  assert.equal(saved.text, text); assert.equal(saved.revision, initial.revision + 1);
  await request(alice.cookie, notePath, 'PUT', body, 409);
  assert.equal((await request(bob.cookie, notePath)).json.text, '');
  assert.equal((await request(admin, notePath)).json.text, '');
  const { json: layout } = await request(alice.cookie, notePath + '/layout');
  const { DEFAULT_HUB_NOTEBOOK_LAYOUT } = await import(join(candidateRoot, 'apps/server/node_modules/@agentopsdeck/shared/dist/index.js'));
  await request(alice.cookie, notePath + '/layout', 'PUT', { resourceId: layout.resourceId, revision: layout.revision,
    text: JSON.stringify({ ...DEFAULT_HUB_NOTEBOOK_LAYOUT, title: '2.3.0 Acceptance tips', hidden: false }) });
  evidence.checks.push('Real login cookies: anonymous denied, Alice/Bob/admin private notes isolated, Markdown/TODO and layout CAS preserved');
  const oldCookie = alice.cookie;
  await request(alice.cookie, '/api/auth/logout', 'POST', {});
  await request(oldCookie, notePath, 'GET', undefined, 401);
  await request(oldCookie, archivePath, 'GET', undefined, 401);
  await request(oldCookie, archivePath, 'PUT', coldWrite, 401);
  await request(oldCookie, boardPath, 'GET', undefined, 401);
  await request(oldCookie, boardPath, 'PUT', boardWrite, 401);
  await request(oldCookie, catalogPath, 'GET', undefined, 401);
  await request(oldCookie, secondBoardPath + '/summary', 'GET', undefined, 401);
  await request(oldCookie, notePath, 'PUT', { ...body, revision: saved.revision, text: 'must not save' }, 401);
  alice.cookie = await login(alice.key);
  assert.equal((await request(alice.cookie, notePath)).json.text, text);
  evidence.checks.push('Logout invalidates old-cookie reads and writes; re-login preserves original note');
  await stop(); await start();
  admin = await login(adminKey); alice.cookie = await login(alice.key); bob.cookie = await login(bob.key);
  assert.deepEqual((await request(alice.cookie, capacityPath)).json, hotSaved);
  assert.deepEqual((await request(alice.cookie, archivePath)).json, coldSaved);
  assert.deepEqual((await request(alice.cookie, preferencesPath)).json, tagsSaved);
  evidence.checks.push('Frozen actual process restart preserves hot50k, cold100k and group/tag preferences');
  assert.deepEqual((await request(alice.cookie, boardPath)).json, boardSaved);
  assert.deepEqual((await request(alice.cookie, boardPath, 'PUT', boardWrite)).json, boardSaved);
  assert.equal((await request(bob.cookie, boardPath)).json.revision, 0);
  evidence.checks.push('Task board document and idempotency receipt survive actual process restart');
  assert.deepEqual((await request(alice.cookie, secondBoardPath)).json, secondBoard);
  assert.equal((await request(alice.cookie, catalogPath)).json.boards.length, 2);
  assert.equal((await request(alice.cookie, secondBoardPath + '/summary')).json.counts.doing, 1);
  evidence.checks.push('Multi-board catalog and independent summary survive restart with no task bodies or cross-user access');
  assert.equal((await request(alice.cookie, notePath)).json.text, text);
  assert.equal((await request(alice.cookie, notePath)).json.revision, saved.revision);
  assert.equal(JSON.parse((await request(alice.cookie, notePath + '/layout')).json.text).title, '2.3.0 Acceptance tips');
  assert.equal((await request(bob.cookie, notePath)).json.text, '');
  const machineBoardPath = `${catalogPath}/${randomUUID()}`, taskId = randomUUID(), hiddenId = randomUUID();
  await request(alice.cookie, machineBoardPath, 'PUT', { title: 'Machine boundary fixture', revision: 0, mutationId: randomUUID(), tasks: [
    { id: taskId, title: 'Allowed task', detail: 'Private detail not granted', status: 'todo' },
    { id: hiddenId, title: 'Hidden task', detail: 'Hidden body', status: 'todo' },
  ] });
  const { json: issued } = await request(alice.cookie, `${machineBoardPath}/capabilities`, 'POST', {
    taskIds: [taskId], fields: ['status'], expiresAt: Date.now() + 300_000,
  }, 201);
  for (const cookie of [bob.cookie, admin]) {
    assert.deepEqual((await request(cookie, `${machineBoardPath}/capabilities`)).json.capabilities, []);
    await request(cookie, `${machineBoardPath}/capabilities/${issued.capability.id}`, 'DELETE', undefined, 404);
  }
  const snapshot = await machineRequest(issued.token);
  assert.deepEqual(snapshot.tasks, [{ id: taskId, title: 'Allowed task', status: 'todo' }]);
  const machineWrite = { revision: 1, mutationId: randomUUID(), tasks: [{ id: taskId, status: 'done' }] };
  await machineRequest(issued.token, undefined, 'POST', { ...machineWrite, tasks: [{ id: hiddenId, status: 'done' }] }, 403);
  await machineRequest(issued.token, undefined, 'POST', { ...machineWrite, tasks: [{ id: taskId, detail: 'not allowed' }] }, 403);
  const machineSaved = await machineRequest(issued.token, undefined, 'POST', machineWrite);
  assert.deepEqual(machineSaved, { status: 'saved', revision: 2, mutationId: machineWrite.mutationId });
  assert.deepEqual(await machineRequest(issued.token, undefined, 'POST', machineWrite), machineSaved);
  await stop(); await start();
  admin = await login(adminKey); alice.cookie = await login(alice.key); bob.cookie = await login(bob.key);
  assert.deepEqual(await machineRequest(issued.token, undefined, 'POST', machineWrite), machineSaved);
  const { json: machineBoard } = await request(alice.cookie, machineBoardPath);
  assert.equal(machineBoard.revision, 2); assert.equal(machineBoard.tasks[0].status, 'done');
  assert.equal(machineBoard.tasks[0].detail, 'Private detail not granted'); assert.equal(machineBoard.tasks[1].status, 'todo');
  const { json: audit } = await request(alice.cookie, `${machineBoardPath}/audit`);
  assert.equal(audit.events.filter(event => event.event === 'updated').length, 1);
  assert.ok(!JSON.stringify(audit).includes(issued.token)); assert.ok(!JSON.stringify(audit).includes('Private detail'));
  await request(alice.cookie, `${machineBoardPath}/capabilities/${issued.capability.id}`, 'DELETE');
  await machineRequest(issued.token, undefined, 'POST', machineWrite, 401);
  await stop(); await start();
  admin = await login(adminKey); alice.cookie = await login(alice.key); bob.cookie = await login(bob.key);
  await machineRequest(issued.token, undefined, 'POST', machineWrite, 401);
  await machineRequest(issued.token, undefined, 'GET', undefined, 401);
  assert.equal((await request(alice.cookie, machineBoardPath)).json.revision, 2);
  evidence.checks.push('Independent bearer capability: exact tasks/fields, cross-owner management denied, unchanged private detail, retry and audit exactly once; actual restart preserves receipt and revocation');
  assert.deepEqual((await request(alice.cookie, layoutPath)).json, layoutSaved);
  assert.equal((await request(alice.cookie, layoutPath.replace('/current', '/saved'))).json.content, '[]');
  for (const cookie of [bob.cookie, admin]) assert.equal((await request(cookie, layoutPath)).json.content, null);
  evidence.checks.push('Current and saved layouts survive real process restarts, preserving account isolation');
  const { json: { keys } } = await request(admin, `/api/hub/v1/users/${alice.id}/login-keys`);
  assert.equal(keys.length, 1);
  await request(admin, `/api/hub/v1/users/${alice.id}/login-keys/${keys[0].id}`, 'DELETE');
  await request(alice.cookie, notePath, 'GET', undefined, 401);
  await request(alice.cookie, layoutPath, 'GET', undefined, 401);
  await request(alice.cookie, layoutPath, 'PUT', layoutWrite, 401);
  await request(alice.cookie, boardPath, 'GET', undefined, 401);
  await request(alice.cookie, boardPath, 'PUT', boardWrite, 401);
  await request(alice.cookie, catalogPath, 'GET', undefined, 401);
  await request(alice.cookie, secondBoardPath + '/summary', 'GET', undefined, 401);
  await request(alice.cookie, notePath, 'PUT', { ...body, revision: saved.revision, text: 'revoked' }, 401);
  evidence.checks.push('Same-data actual process restart preserves note/text/revision/title/account isolation; revoked login key denies stale cookie GET/PUT');
  await stop();
  assert.deepEqual(await verifyCandidateRelease(candidateRoot), candidate);
  evidence.passed = true;
} catch (error) {
  evidence.failure = { name: error.name, message: error.message }; process.exitCode = 1;
} finally {
  try { await stop(); evidence.childrenClosed = true; }
  catch { evidence.childrenClosed = false; evidence.passed = false; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
}
console.log('Candidate workspace notebook acceptance:', evidence.passed ? 'passed' : 'failed');
