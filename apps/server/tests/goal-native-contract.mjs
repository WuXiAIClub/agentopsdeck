// Opt-in real installed-binary contract check. Never loads production Codex
// config/credentials, never starts a turn, and every goal is paused with budget 1.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readCodexGoal } from '@agentopsdeck/shared';
import { goalAcknowledged, goalMutation, goalSnapshot } from '../src/codex/goal-control.ts';

const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-goal-native-contract-'));
const nativeHome = join(directory, 'codex'), workspace = join(directory, 'workspace');
await mkdir(nativeHome); await mkdir(workspace);
let providerRequests = 0, turnStarts = 0, nextId = 0;
const provider = createServer((_req, res) => { providerRequests++; res.writeHead(503); res.end(); });
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const child = spawn(process.env.AOD_TEST_CODEX ?? 'codex', ['app-server',
  '-c', 'features.goals=true',
  '-c', 'model_provider="goal_audit"', '-c', 'model="goal-audit-no-model"',
  '-c', 'model_providers.goal_audit.name="Goal audit loopback only"',
  '-c', `model_providers.goal_audit.base_url="http://127.0.0.1:${provider.address().port}/v1"`,
  '-c', 'model_providers.goal_audit.wire_api="responses"',
  '-c', 'model_providers.goal_audit.requires_openai_auth=false',
], { cwd: workspace, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', CODEX_HOME: nativeHome }, stdio: ['pipe', 'pipe', 'pipe'] });
// Do not print raw native diagnostics or RPC content. Error messages below are
// from this isolated synthetic environment only, never a production connection.
child.stderr.resume();
const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let value; try { value = JSON.parse(line); } catch { return; }
  if (value.method === 'turn/started') turnStarts++;
  if (value.id == null) return;
  const task = pending.get(value.id); if (!task) return;
  pending.delete(value.id); clearTimeout(task.timer);
  if (value.error) task.reject(new Error(`Native RPC rejected: ${task.method}, code=${value.error.code}, message=${String(value.error.message).slice(0, 300)}`));
  else task.resolve(value.result);
});
const rejectPending = () => {
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Native process ended')); }
  pending.clear();
};
child.on('error', rejectPending); child.on('exit', rejectPending);
const exited = once(child, 'exit');
function rpc(method, params) {
  assert.ok(['initialize', 'thread/start', 'thread/goal/get', 'thread/goal/set', 'thread/goal/clear'].includes(method));
  if (method === 'thread/goal/set') {
    assert.ok(params.status === undefined || params.status === 'paused', 'no native continuation authorization');
    assert.ok(params.tokenBudget === undefined || params.tokenBudget === 0 || params.tokenBudget === 1, 'bounded synthetic budget');
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer, method });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
try {
  await rpc('initialize', { clientInfo: { name: 'agentopsdeck_goal_contract', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const started = await rpc('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false,
    model: 'goal-audit-no-model', modelProvider: 'goal_audit', environments: [], baseInstructions: 'Isolated protocol check. Do not run work.' });
  const threadId = started.thread.id;
  assert.equal(readCodexGoal(await rpc('thread/goal/get', { threadId }), threadId), null);
  await assert.rejects(rpc('thread/goal/set', { threadId, objective: 'Synthetic invalid budget', status: 'paused', tokenBudget: 0 }), /goal budgets must be positive/);
  assert.equal(readCodexGoal(await rpc('thread/goal/get', { threadId }), threadId), null, 'invalid budget must not create a Goal');
  let result = await rpc('thread/goal/set', { threadId, objective: 'Synthetic paused protocol check', status: 'paused', tokenBudget: 1 });
  assert.equal(readCodexGoal(result, threadId)?.status, 'paused');
  assert.deepEqual(readCodexGoal(await rpc('thread/goal/get', { threadId }), threadId), readCodexGoal(result, threadId));
  const before = goalSnapshot(result, threadId, 'isolated');
  const control = { action: 'edit', expectedRevision: before.revision, objective: 'Synthetic edited protocol check' };
  const mutation = goalMutation(control, before, threadId);
  result = await rpc(mutation.method, mutation.params);
  assert.equal(goalAcknowledged(result, control, threadId), true);
  assert.equal(readCodexGoal(result, threadId)?.status, 'paused', 'edit does not silently resume');
  assert.equal(readCodexGoal(result, threadId)?.tokenBudget, 1);
  assert.equal(readCodexGoal(result, threadId)?.tokensUsed, 0);
  const clear = { action: 'clear', expectedRevision: goalSnapshot(result, threadId, 'isolated').revision };
  assert.equal(goalAcknowledged(await rpc('thread/goal/clear', { threadId }), clear, threadId), true);
  assert.equal(readCodexGoal(await rpc('thread/goal/get', { threadId }), threadId), null);
  assert.equal(turnStarts, 0); assert.equal(providerRequests, 0);
  console.log(JSON.stringify({ passed: true, scope: 'installed binary paused Goal CRUD only', turnStarts, providerRequests,
    isolatedCodexHome: true, directory }));
} finally {
  lines.close(); child.stdin.end(); child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 3_000);
  await exited.catch(() => {}); clearTimeout(kill); rejectPending();
  await new Promise(resolve => provider.close(resolve));
  // Keep this uniquely named, credential-free temporary evidence directory.
}
