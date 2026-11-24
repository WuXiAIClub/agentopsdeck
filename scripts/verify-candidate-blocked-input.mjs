// Shipped Connector + installed native Codex; only loopback synthetic inference
// and a fresh private HOME are used. Never opens production sessions or keys.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';

const [directory, command] = process.argv.slice(2);
assert.ok(process.argv.length === 4 && isAbsolute(directory) && isAbsolute(command),
  'Usage: node scripts/verify-candidate-blocked-input.mjs /candidate /installed/codex');
const candidate = await verifyCandidateRelease(directory);
const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-candidate-blocked-input-'));
const home = join(root, 'native'), project = join(root, 'project');
await Promise.all([home, project].map(path => mkdir(path, { mode: 0o700 })));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: home, NODE_ENV: 'test' });
console.warn = () => {}; // Native diagnostics are not evidence and can contain model content.
const evidence = { passed: false, root, candidate, syntheticProvider: true, productionDataTouched: false };
console.log('EVIDENCE', root);
let calls = 0, failure, phase = 'seed', native, nativeClosed, codex, users, sequence = 0;
const pending = new Map(), notifications = [], methods = [];
const provider = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/responses');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.stringify(JSON.parse(Buffer.concat(chunks).toString()).input);
    calls++;
    if (phase === 'continuation') {
      assert.equal(calls, 3, 'Two original queued messages must execute once together');
      assert.ok(input.includes('CONTINUATION_FIRST') && input.includes('CONTINUATION_SECOND'));
    } else assert.ok(calls <= 2, 'Seed must not autonomously continue its blocked goal');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const text = phase === 'seed' ? 'ISOLATED_SEED_COMPLETE' : 'QUEUED_CONTINUATION_VERIFIED';
    const item = { type: 'message', id: `msg_${calls}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text }] };
    const response = { id: `resp_${calls}`, object: 'response', created_at: 1, model: 'fixture', output: [item],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    let seq = 0;
    const event = value => res.write(`data: ${JSON.stringify({ ...value, sequence_number: ++seq })}\n\n`);
    event({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
    event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } });
    event({ type: 'response.output_item.done', output_index: 0, item });
    event({ type: 'response.completed', response: { ...response, status: 'completed' } });
    res.end();
  } catch (error) { failure = error; res.writeHead(500); res.end(); }
});

async function until(check, label) {
  const deadline = Date.now() + 60000;
  while (!check()) {
    if (failure) throw failure;
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await delay(100);
  }
  if (failure) throw failure;
}
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native RPC timeout: ${method}`)); }, 15000);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    native.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
async function stopNative() {
  if (!native || native.exitCode !== null || native.signalCode !== null) return;
  native.stdin.end();
  const timer = setTimeout(() => native.kill('SIGTERM'), 3000);
  const killTimer = setTimeout(() => native.kill('SIGKILL'), 6000);
  try { await nativeClosed; } finally { clearTimeout(timer); clearTimeout(killTimer); }
}

try {
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  await writeFile(join(home, 'config.toml'), `model="fixture"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`, { mode: 0o600 });
  native = spawn(command, ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never', 'app-server'],
    { cwd: project, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  nativeClosed = new Promise(resolve => native.once('close', resolve));
  native.on('error', error => { failure = error; });
  native.stderr.resume();
  createInterface({ input: native.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined) {
      const waiting = pending.get(message.id);
      if (waiting) {
        pending.delete(message.id);
        message.error ? waiting.reject(new Error('Native fixture RPC rejected')) : waiting.resolve(message.result);
      }
    } else notifications.push(message);
  });
  await rpc('initialize', { clientInfo: { name: 'isolated_candidate_probe', version: '1' }, capabilities: { experimentalApi: true } });
  native.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const { thread } = await rpc('thread/start', { cwd: project, model: 'fixture', modelProvider: 'fixture',
    approvalPolicy: 'never', sandbox: 'danger-full-access' });
  const threadId = thread.id, key = `codex:${threadId}`;
  for (let index = 0; index < 2; index++) {
    notifications.length = 0;
    await rpc('turn/start', { threadId, input: [{ type: 'text', text: `Return fixture seed ${index}.` }] });
    await until(() => notifications.some(event => event.method === 'turn/completed'), 'native seed completion');
    if (!index) await rpc('thread/goal/set', { threadId, objective: 'Preserve isolated blocked objective', status: 'blocked' });
  }
  assert.equal(calls, 2);
  const goalBefore = await rpc('thread/goal/get', { threadId });
  assert.equal(goalBefore.goal.status, 'blocked');
  await stopNative();

  const load = name => import(pathToFileURL(join(directory, 'apps/server/dist', name)).href);
  const { CodexAppServer } = await load('codex/app-server.js');
  const { ConnectorUserStore } = await load('connector/connector-user-store.js');
  const { DeckStore } = await load('projection/deck-store.js');
  users = new ConnectorUserStore(':memory:');
  const store = new DeckStore();
  phase = 'continuation';
  codex = new CodexAppServer({ enabled: true, command, homeDirectory: home, defaultCwd: project,
    defaultModel: 'fixture', modelProvider: 'fixture', approvalPolicy: 'never', store,
    executions: users.codexExecutions, turnQueue: users.turns, authorizeTurn: () => true });
  const write = codex.write.bind(codex);
  codex.write = message => {
    methods.push(message.method);
    assert.ok(!['thread/goal/set', 'thread/goal/clear', 'thread/compact/start', 'thread/rollback', 'turn/interrupt'].includes(message.method),
      'Continuation must not mutate the goal, compact, roll back or interrupt');
    return write(message);
  };
  await codex.ensureStarted();
  const cold = (await codex.request('thread/read', { threadId, includeTurns: true })).thread;
  assert.equal(cold.status.type, 'notLoaded');
  assert.equal(cold.turns.length, 2);
  const ownedTurn = cold.turns[0].id;
  users.codexExecutions.begin(key, 'previous-command', 'old-connection');
  users.codexExecutions.acknowledge(key, 'previous-command', 'old-connection', ownedTurn, () => {});
  users.codexExecutions.observe(key, 'old-connection', ownedTurn, 'completed');
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Isolated blocked goal', status: 'idle',
    runtime: { turnId: ownedTurn, phase: 'completed', connection: 'connected', sync: 'syncing', lastEventAt: 1 } });
  codex.reconcileCompletedTurn(key, threadId, 1, ownedTurn, 'completed');
  await codex.refreshSession(key, { readOnly: true });
  const ids = ['preserved-first', 'preserved-second'];
  for (const [index, text] of ['CONTINUATION_FIRST', 'CONTINUATION_SECOND'].entries()) {
    users.turns.enqueue('codex', { id: ids[index], sessionKey: key, createdAt: Date.now(), payload: { text, images: [] } });
  }
  assert.equal(users.codexExecutions.get(key).nativeHistory.reason, 'goal-blocked');
  assert.equal(users.codexExecutions.canStart(key), false);
  await codex.recoverMaintenanceHistory(key, () => {});
  assert.equal(methods.includes('thread/resume'), false);
  assert.equal(calls, 2, 'Maintenance recovery must not execute queued input');
  codex.threadRefreshResult.clear();
  codex.startQueueWorker();
  await until(() => {
    const fact = users.codexExecutions.get(key);
    return calls === 3 && fact.phase === 'completed' && fact.sync === 'current';
  }, 'one queued batch and synchronized history');
  assert.equal(users.turns.list('codex', key).length, 0);
  await codex.refreshSession(key, { readOnly: true });
  assert.equal(codex.isSessionHistoryReady(key), true);
  assert.ok(store.getMessages(key).some(message => message.text.includes('QUEUED_CONTINUATION_VERIFIED')));
  assert.deepEqual(await codex.request('thread/goal/get', { threadId }), goalBefore);
  assert.equal(methods.filter(method => method === 'turn/start').length, 1);
  assert.deepEqual(await verifyCandidateRelease(directory), candidate, 'Candidate changed during native verification');
  Object.assign(evidence, { passed: true, goalUnchanged: true, queueDrainedOnce: true, historyCurrent: true,
    originalMessages: ids, modelCalls: calls, continuationCalls: calls - 2, methods });
} finally {
  await stopNative();
  if (codex) await codex.close();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  users?.close();
  for (const waiting of pending.values()) waiting.reject(new Error('Native fixture closed'));
  pending.clear();
  await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
}
console.log(JSON.stringify(evidence));
