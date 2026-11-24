// Installed-native contract only: private Codex home, deterministic loopback
// provider, one synthetic original turn. Never uses production homes or keys.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { once } from 'node:events';

const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-owned-load-native-'));
const nativeHome = join(directory, 'codex'), workspace = join(directory, 'workspace');
await mkdir(nativeHome); await mkdir(workspace);
let requests = 0;
const failures = [], processes = [];
const provider = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/responses');
    let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes < 2_000_000); }
    assert.equal(++requests, 1, 'no replay or resume-induced model request');
    const item = { id: 'msg-1', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Synthetic contract reply.', annotations: [] }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    event('response.created', { response: { id: 'contract-1', object: 'response', status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { id: 'contract-1', object: 'response', status: 'completed', output: [item],
      usage: { input_tokens: 60, output_tokens: 10, total_tokens: 70 } } });
    res.end();
  } catch (error) { failures.push(String(error)); res.writeHead(500); res.end(); }
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const args = ['app-server', '-c', 'features.goals=true', '-c', 'model_provider="owned_load_audit"',
  '-c', 'model="owned-load-audit-no-model"', '-c', 'model_providers.owned_load_audit.name="Owned load loopback only"',
  '-c', `model_providers.owned_load_audit.base_url="http://127.0.0.1:${provider.address().port}/v1"`,
  '-c', 'model_providers.owned_load_audit.wire_api="responses"', '-c', 'model_providers.owned_load_audit.requires_openai_auth=false',
  '-c', 'model_providers.owned_load_audit.request_max_retries=0', '-c', 'model_providers.owned_load_audit.stream_max_retries=0'];
const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', CODEX_HOME: nativeHome };
const binary = process.env.AOD_TEST_CODEX ?? 'codex';
async function start() {
  const child = spawn(binary, args, { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const pending = new Map(), events = []; let nextId = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    if (value.method) {
      events.push(value);
      if (value.id != null) child.stdin.write(JSON.stringify({ id: value.id,
        error: { code: -32601, message: 'No tools allowed in isolated contract' } }) + '\n');
    }
    const task = pending.get(value.id); if (!task) return;
    pending.delete(value.id); clearTimeout(task.timer);
    if (value.error) task.reject(Error(`Native ${task.method}: ${String(value.error.message).slice(0, 300)}`));
    else task.resolve(value.result);
  });
  const ended = new Promise(resolve => {
    const finish = () => {
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Error('Native ended')); }
      pending.clear(); resolve();
    };
    child.once('error', finish); child.once('exit', finish);
  });
  const runtime = { events, rpc, async stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await ended; clearTimeout(timer); lines.close();
  } };
  processes.push(runtime);
  function rpc(method, params) {
    assert.ok(['initialize', 'thread/start', 'thread/read', 'thread/resume', 'thread/goal/get',
      'thread/backgroundTerminals/list', 'turn/start'].includes(method));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`RPC timeout ${method}`)); }, 15_000);
      pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  await rpc('initialize', { clientInfo: { name: 'agentopsdeck_owned_load_contract', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  return runtime;
}
async function until(check) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    assert.deepEqual(failures, []);
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Timed out waiting for synthetic turn completion');
}
const options = { cwd: workspace, model: 'owned-load-audit-no-model', modelProvider: 'owned_load_audit',
  approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: 'Synthetic isolated contract. Never execute tools or access files.' };
try {
  console.log(JSON.stringify({ nativeVersion: execFileSync(binary, ['--version'], { cwd: workspace, env,
    timeout: 10_000, encoding: 'utf8' }).trim(), isolated: true, directory }));
  if (process.argv.includes('--historical-stopped-copy')) {
    // Exact verified stopped archive only. Never accepts a live home/path and
    // never extracts auth/config/database files or runs a historical turn.
    const backup = '/srv/test-data/aod-recovery/backup';
    const manifest = JSON.parse(await readFile(backup + '/manifest.json', 'utf8'));
    assert.equal(manifest.passed, true);
    const archive = manifest.archives[1];
    assert.equal(archive.archive, backup + '/1.tar.gz'); assert.equal(archive.restored, true);
    const hash = createHash('sha256'); for await (const chunk of createReadStream(archive.archive)) hash.update(chunk);
    assert.equal(hash.digest('hex'), archive.sha256);
    const threadId = '01a19f30-7de9-7dd3-b8de-6c1269ed5aa0';
    const member = 'codex-home/sessions/2026/11/03/rollout-2026-11-03T10-15-17-' + threadId + '.jsonl';
    execFileSync('/usr/bin/tar', ['-xzpf', archive.archive, '-C', nativeHome, '--strip-components=1', '--', member], { timeout: 120_000 });
    const isolated = await start();
    const cold = (await isolated.rpc('thread/read', { threadId, includeTurns: true })).thread;
    // Only the rollout was restored. The production Goal database was NOT:
    // this query proves private-home protocol compatibility, not production
    // Goal absence. Production admission must query its actual Goal state.
    const goal = await isolated.rpc('thread/goal/get', { threadId });
    assert.equal(cold.status.type, 'notLoaded'); assert.equal(goal.goal, null);
    const turns = cold.turns.map(t => ({ status: t.status, commands: t.items.filter(i => i.type === 'commandExecution').map(i => i.status),
      children: t.items.filter(i => ['subAgentActivity', 'collabAgentToolCall', 'collabToolCall'].includes(i.type)).length }));
    assert.ok(turns.every(t => ['completed', 'failed', 'interrupted'].includes(t.status)));
    const warm = (await isolated.rpc('thread/resume', { ...options, threadId })).thread;
    const read = (await isolated.rpc('thread/read', { threadId, includeTurns: true })).thread;
    assert.equal(warm.id, threadId); assert.equal(read.status.type, 'idle'); assert.equal(read.canAcceptDirectInput, true);
    assert.deepEqual(read.turns, cold.turns, 'loading cannot alter original history');
    const terminals = await isolated.rpc('thread/backgroundTerminals/list', { threadId });
    assert.deepEqual(terminals, { data: [], nextCursor: null }); assert.equal(requests, 0); assert.deepEqual(failures, []);
    console.log(JSON.stringify({ passed: true, historicalStoppedCopyOnly: true, archiveSha256: archive.sha256,
      turns, unchangedHistory: true, reconstructedHomeGoalAbsent: true, productionGoalVerified: false,
      loadedIdle: true, backgroundEmpty: true,
      requests, productionMutated: false, noHistoricalTurnStart: true }));
  } else {
  const first = await start();
  const threadId = (await first.rpc('thread/start', { ...options, ephemeral: false, environments: [] })).thread.id;
  await first.rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Synthetic contract prompt.', text_elements: [] }], environments: [] });
  await until(() => first.events.some(e => e.method === 'turn/completed' && e.params.threadId === threadId));
  await first.stop();
  const second = await start();
  const cold = (await second.rpc('thread/read', { threadId, includeTurns: true })).thread;
  assert.equal(cold.status.type, 'notLoaded'); assert.equal(cold.turns.length, 1);
  const goal = await second.rpc('thread/goal/get', { threadId }); assert.equal(goal.goal, null);
  // This native version reports a loaded-registry miss as "thread not found";
  // that error is NOT durable absence evidence. The persisted read above is.
  await assert.rejects(second.rpc('thread/backgroundTerminals/list', { threadId }), /thread not found|not loaded/i);
  const resumed = (await second.rpc('thread/resume', { ...options, threadId })).thread;
  const warm = (await second.rpc('thread/read', { threadId, includeTurns: true })).thread;
  assert.equal(resumed.id, threadId); assert.equal(warm.status.type, 'idle');
  assert.equal(warm.turns.length, 1); assert.equal(warm.turns[0].id, cold.turns[0].id);
  const terminals = await second.rpc('thread/backgroundTerminals/list', { threadId });
  assert.deepEqual(terminals, { data: [], nextCursor: null });
  assert.equal(requests, 1); assert.deepEqual(failures, []);
  console.log(JSON.stringify({ passed: true, coldStatus: cold.status.type, goalReadBeforeLoad: true,
    coldTerminalListRejected: true, loadedStatus: warm.status.type, canAcceptDirectInput: warm.canAcceptDirectInput,
    loadedTerminalList: terminals, requests, noReplay: true }));
  }
} finally {
  for (const runtime of processes) await runtime.stop();
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}
