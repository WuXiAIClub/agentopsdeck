// Real installed Codex orchestration, deterministic loopback Responses provider.
// No real model, production credentials/session, or Hub/Connector process used.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readCodexGoal } from '@agentopsdeck/shared';

const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-goal-lifecycle-'));
const nativeHome = join(directory, 'codex'), workspace = join(directory, 'workspace');
await mkdir(nativeHome); await mkdir(workspace);
let requests = 0, holdNext = false, held = false, quotaNext = null;
const failures = [];
const provider = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/responses');
    let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes < 2_000_000); }
    requests++;
    assert.ok(requests <= 12, 'bounded native continuation');
    if (holdNext) { holdNext = false; held = true; return; }
    if (quotaNext) {
      const type = quotaNext; quotaNext = null;
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type, message: 'Synthetic isolated quota exhaustion' } }));
      return;
    }
    const id = `audit-${requests}`;
    const item = { id: `msg-${requests}`, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Synthetic progress; goal remains active.', annotations: [] }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    event('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { id, object: 'response', status: 'completed', output: [item],
      usage: { input_tokens: 60, output_tokens: 40, total_tokens: 100 } } });
    res.end();
  } catch (error) { failures.push(String(error)); res.writeHead(500); res.end(); }
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const args = ['app-server', '-c', 'features.goals=true', '-c', 'model_provider="goal_audit"',
  '-c', 'model="goal-audit-no-model"', '-c', 'model_providers.goal_audit.name="Goal audit loopback only"',
  '-c', `model_providers.goal_audit.base_url="http://127.0.0.1:${provider.address().port}/v1"`,
  '-c', 'model_providers.goal_audit.wire_api="responses"', '-c', 'model_providers.goal_audit.requires_openai_auth=false',
  '-c', 'model_providers.goal_audit.request_max_retries=0', '-c', 'model_providers.goal_audit.stream_max_retries=0'];
const processes = [];
async function start() {
  const child = spawn(process.env.AOD_TEST_CODEX ?? 'codex', args, { cwd: workspace,
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8', CODEX_HOME: nativeHome }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const pending = new Map(), events = [];
  let nextId = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    if (value.method) {
      events.push(value);
      // A synthetic provider must never request an executable tool/approval.
      if (value.id != null) child.stdin.write(JSON.stringify({ id: value.id, error: { code: -32601, message: 'Unsupported in isolated audit' } }) + '\n');
    }
    const task = pending.get(value.id); if (!task) return;
    pending.delete(value.id); clearTimeout(task.timer);
    if (value.error) task.reject(Error(`Native ${task.method}: ${String(value.error.message).slice(0, 300)}`));
    else task.resolve(value.result);
  });
  const ended = new Promise(resolve => {
    const finish = () => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Error('Native ended')); } pending.clear(); resolve(); };
    child.once('error', finish); child.once('exit', finish);
  });
  const runtime = { events, rpc, async stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await ended; clearTimeout(timer); lines.close();
  } };
  processes.push(runtime);
  function rpc(method, params) {
    assert.ok(['initialize', 'thread/start', 'thread/resume', 'thread/goal/get', 'thread/goal/set', 'turn/start'].includes(method));
    if (method === 'thread/goal/set') assert.ok(params.tokenBudget > 0 && params.tokenBudget <= 300);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`RPC timeout ${method}`)); }, 10_000);
      pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  await rpc('initialize', { clientInfo: { name: 'agentopsdeck_goal_lifecycle', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  return runtime;
}
async function until(check, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    assert.deepEqual(failures, []);
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(`Timed out: ${label}; providerRequests=${requests}`);
}
const options = { cwd: workspace, model: 'goal-audit-no-model', modelProvider: 'goal_audit',
  approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: 'Isolated test. Never execute tools or access files.' };
async function goal(runtime, threadId) { return readCodexGoal(await runtime.rpc('thread/goal/get', { threadId }), threadId); }
async function activate(runtime, tokenBudget) {
  const threadId = (await runtime.rpc('thread/start', { ...options, ephemeral: false, environments: [] })).thread.id;
  await runtime.rpc('thread/goal/set', { threadId, objective: 'Synthetic bounded native continuation audit', status: 'active', tokenBudget });
  await runtime.rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Report synthetic progress.', text_elements: [] }], environments: [] });
  return threadId;
}
try {
  console.log(JSON.stringify({ nativeVersion: execFileSync(process.env.AOD_TEST_CODEX ?? 'codex', ['--version'],
    { cwd: workspace, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', CODEX_HOME: nativeHome }, timeout: 10_000, encoding: 'utf8' }).trim(),
    syntheticProvider: true, isolatedCodexHome: true }));
  const first = await start();
  const threadId = await activate(first, 250);
  await until(async () => (await goal(first, threadId))?.status === 'budgetLimited', 'native continuation exhausts budget');
  const limited = await goal(first, threadId);
  const starts = first.events.filter(e => e.method === 'turn/started' && e.params.threadId === threadId).length;
  assert.ok(starts >= 2, 'native engine must automatically start another turn');
  assert.ok(limited.tokensUsed >= 250);
  assert.ok(requests >= 3 && requests <= 4);
  console.log(JSON.stringify({ scenario: 'automatic continuation and budget exhaustion', passed: true, starts, requests, tokensUsed: limited.tokensUsed }));

  holdNext = true;
  const running = await activate(first, 150);
  await until(() => held, 'provider stream in flight before restart');
  const before = await goal(first, running); assert.equal(before.status, 'active');
  await first.stop(); provider.closeAllConnections();
  const second = await start();
  // Metadata-only read must not launch a model turn after process replacement.
  const requestBoundary = requests;
  const persisted = await goal(second, running);
  assert.deepEqual(persisted, before);
  assert.equal(requests, requestBoundary);
  await second.rpc('thread/resume', { ...options, threadId: running });
  await until(async () => (await goal(second, running))?.status === 'budgetLimited', 'resumed native goal consumes remaining budget');
  const after = await goal(second, running);
  assert.equal(after.objective, before.objective); assert.equal(after.tokenBudget, before.tokenBudget);
  assert.equal(after.createdAt, before.createdAt); assert.ok(after.tokensUsed >= 150);
  assert.equal((await goal(second, threadId)).status, 'budgetLimited', 'other thread remains limited');
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ scenario: 'running native process restart and explicit resume', passed: true,
    requests, tokensUsed: after.tokensUsed, isolatedCodexHome: true, syntheticProvider: true, directory }));
  quotaNext = 'usage_limit_reached';
  const quotaThread = await activate(second, 150);
  await until(() => second.events.some(e => e.method === 'turn/completed' && e.params.threadId === quotaThread), 'quota turn completes');
  assert.equal((await goal(second, quotaThread))?.status, 'usageLimited');
  console.log(JSON.stringify({ scenario: 'synthetic provider quota exhaustion', passed: true, requests }));
  // A generic third-party 429 is not proof of the native usageLimited state.
  // Observe native state, do not infer completion/absence or automatically retry.
  quotaNext = 'insufficient_quota';
  const genericThread = await activate(second, 150);
  await until(() => second.events.some(e => e.method === 'turn/completed' && e.params.threadId === genericThread), 'generic provider error terminates turn');
  const generic = await goal(second, genericThread);
  assert.ok(generic); assert.equal(generic.status, 'blocked');
  assert.equal(generic.tokenBudget, 150);
  assert.equal(second.events.filter(e => e.method === 'turn/started' && e.params.threadId === genericThread).length, 1);
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ scenario: 'generic provider quota error retains native Goal evidence', passed: true, nativeStatus: generic.status, requests }));
} finally {
  for (const runtime of processes) await runtime.stop();
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}
