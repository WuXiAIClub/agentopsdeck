// Isolated real-backend acceptance, with a synthetic loopback model (no keys,
// installed agent, production service or external provider is used).
// node --import ./apps/server/node_modules/tsx/dist/esm/index.mjs scripts/verify-hermes-native.mjs SOURCE PYTHON
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { HermesRuntime } from '../apps/server/src/hermes/runtime.ts';
import { HermesProcess } from '../apps/server/src/hermes/process.ts';
import { HermesJournal } from '../apps/server/src/hermes/journal.ts';
import { TurnQueue } from '../apps/server/src/commands/turn-queue.ts';
import { DeckStore } from '../apps/server/src/projection/deck-store.ts';

if (!process.argv[2] || !process.argv[3]) throw new Error('Expected pinned source and isolated Python executable');
const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-hermes-native-acceptance-'));
const home = join(root, 'hermes'), workspace = join(root, 'workspace');
mkdirSync(home); mkdirSync(workspace);
let modelRequests = 0;
let toolRequests = 0, toolResultSeen = false, toolEvents = 0;
let releaseModel;
const modelGate = new Promise(resolve => { releaseModel = resolve; });
const model = createServer(async (req, res) => {
  if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'agentopsdeck-fixture', object: 'model', context_length: 128000 }] })); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  modelRequests++;
  await modelGate;
  const text = 'Hermes native loopback verified';
  const last = body.messages?.at(-1);
  const wantsTool = last?.role === 'user' && typeof last.content === 'string' && last.content.includes('native-tool-acceptance');
  if (last?.role === 'tool' && JSON.stringify(last.content).includes('hermes-tool-verified')) toolResultSeen = true;
  const toolCalls = wantsTool ? [{ id: 'native-test-terminal', type: 'function', function: {
    name: 'terminal', arguments: JSON.stringify({ command: '/usr/bin/printf hermes-tool-verified' }),
  } }] : undefined;
  if (toolCalls) toolRequests++;
  const message = toolCalls ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content: text };
  const finish = toolCalls ? 'tool_calls' : 'stop';
  if (body.stream) {
    res.setHeader('content-type', 'text/event-stream');
    const deltaMessage = toolCalls ? { role: 'assistant', tool_calls: toolCalls.map((call, index) => ({ ...call, index })) } : message;
    for (const [delta, finish_reason] of [[deltaMessage, null], [{}, finish]]) {
      res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'agentopsdeck-fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  } else {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'agentopsdeck-fixture', choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${model.address().port}/v1`;
writeFileSync(join(home, 'config.yaml'), `model:\n  default: agentopsdeck-fixture\n  provider: custom\n  base_url: ${url}\n  api_key: fixture-not-a-secret\ndesktop:\n  auto_continue:\n    enabled: false\nterminal:\n  backend: local\nplatform_toolsets:\n  cli: [terminal]\n  tui: [terminal]\n`, { mode: 0o600 });
// The entire test process and its native child use only these test values.
process.env = { PATH: '/usr/bin:/bin', HOME: root, HERMES_HOME: home, OPENAI_API_KEY: 'fixture-not-a-secret', OPENAI_BASE_URL: url,
  NO_PROXY: '*', PYTHONDONTWRITEBYTECODE: '1', HERMES_SKIP_UPDATE_CHECK: '1' };
const db = new DatabaseSync(join(root, 'connector.sqlite'));
const journal = new HermesJournal(db), turns = new TurnQueue(db), store = new DeckStore();
const config = { enabled: true, executable: resolve(process.argv[3]), sourceDirectory: resolve(process.argv[2]), homeDirectory: home, workspace, startupTimeoutMs: 30000 };
let transport, latestLive;
const factory = (event, lost) => {
  const native = new HermesProcess(config, e => { if (e.type === 'tool.complete') toolEvents++; console.log(JSON.stringify({ event: e.type, seq: e.seq, status: e.payload?.status })); event(e); }, lost);
  transport = native;
  const request = native.request.bind(native);
  native.request = async (method, params) => {
    try { const result = await request(method, params); if (['session.create', 'session.resume'].includes(method)) latestLive = result?.session_id;
      console.log(JSON.stringify({ method, status: result?.status, running: result?.running, hasInflight: !!result?.inflight, rows: result?.messages?.map(r => ({ role: r.role, row_id: r.row_id })) })); return result; }
    catch (e) { console.log(JSON.stringify({ failedMethod: method })); throw e; }
  };
  return native;
};
let runtime = new HermesRuntime({ config, journal, turns, store, authorize: () => true }, factory);
const until = async predicate => { const end = Date.now() + 60000; while (!await predicate()) { if (Date.now() > end) throw new Error('Native acceptance timed out'); await new Promise(resolve => setTimeout(resolve, 25)); } };
try {
  await runtime.start();
  const competitor = new HermesProcess(config, () => {}, () => {});
  try { await assert.rejects(competitor.start(), /readiness/); }
  finally { await competitor.close(); }
  assert.equal(runtime.ready, true, 'second owner must not disturb the running backend');
  const { key } = await runtime.createSession('Isolated native acceptance', () => {}, () => {});
  await runtime.send(key, 'Reply briefly. Do not use tools.', { actorId: 'fixture', accept: () => () => {} });
  await until(() => journal.current(key)?.phase === 'running');
  const second = await runtime.send(key, 'Queued second input.', { actorId: 'fixture', accept: () => () => {} });
  const third = await runtime.send(key, 'Queued third input.', { actorId: 'fixture', accept: () => () => {} });
  assert.equal(second.queueDisposition, 'waiting'); assert.equal(third.queueDisposition, 'waiting');
  assert.equal(journal.executions(key).length, 1);
  assert.equal(turns.list('hermes', key).length, 2);
  releaseModel();
  await until(() => journal.executions(key).length === 2 && ['completed', 'failed', 'unknown'].includes(journal.current(key)?.phase));
  assert.equal(journal.current(key).phase, 'completed');
  assert.deepEqual(journal.current(key).members, [second.idempotencyKey, third.idempotencyKey]);
  assert.ok(store.getMessages(key).some(m => m.id === second.idempotencyKey && m.text === 'Queued second input.'));
  assert.ok(store.getMessages(key).some(m => m.id === third.idempotencyKey && m.text === 'Queued third input.'));
  assert.ok(store.getMessages(key).some(m => m.role === 'assistant' && m.text.includes('Hermes native loopback verified')));
  await runtime.send(key, 'native-tool-acceptance', { actorId: 'fixture', accept: () => () => {} });
  await until(() => journal.executions(key).length === 3 && ['completed', 'failed', 'unknown'].includes(journal.current(key)?.phase));
  assert.equal(journal.current(key).phase, 'completed');
  assert.equal(toolRequests, 1); assert.equal(toolResultSeen, true); assert.equal(toolEvents, 1);
  const toolChain = store.getMessages(key).filter(m => m.role === 'tool');
  assert.equal(toolChain.length, 2);
  assert.deepEqual(toolChain.map(m => m.toolPhase), ['call', 'result']);
  assert.equal(toolChain[0].toolCallId, toolChain[1].toolCallId);
  assert.equal(toolChain[0].toolName, 'terminal');
  await runtime.close();
  runtime = new HermesRuntime({ config, journal, turns, store, authorize: () => true }, factory);
  await runtime.start(); await runtime.refreshSession(key);
  assert.ok(store.getMessages(key).some(m => m.text.includes('Hermes native loopback verified')));
  assert.deepEqual(store.getMessages(key).filter(m => m.role === 'tool'), toolChain, 'tool chain survives native refresh and restart');
  await runtime.send(key, 'Post-restart turn. Reply briefly.', { actorId: 'fixture', accept: () => () => {} });
  await until(() => journal.executions(key).length === 4 && ['completed', 'failed', 'unknown'].includes(journal.current(key)?.phase));
  assert.equal(journal.current(key).phase, 'completed');
  const stored = journal.session(key).stored;
  await runtime.remove(key, () => {}, () => {});
  assert.equal(journal.session(key), undefined); assert.equal(store.getSession(key), undefined);
  const empty = await runtime.createSession('Empty deletion acceptance', () => {}, () => {});
  // Creation can finish before native background hydration. Readiness polling
  // is read-only; do not retry a deletion mutation to get through that window.
  let idleSince;
  await until(async () => {
    const state = await transport.request('session.activate', { session_id: latestLive, omit_messages: true });
    const idle = state.status === 'idle' && state.running === false && !state.hydrating && !state.inflight;
    idleSince = idle ? idleSince ?? Date.now() : undefined;
    return idleSince !== undefined && Date.now() - idleSince >= 500;
  });
  await runtime.remove(empty.key, () => {}, () => {});
  await runtime.close();
  const nativeDb = new DatabaseSync(join(home, 'state.db'), { readOnly: true });
  try { assert.equal(nativeDb.prepare('SELECT id FROM sessions WHERE id = ?').get(stored), undefined); }
  finally { nativeDb.close(); }
  runtime = new HermesRuntime({ config, journal, turns, store, authorize: () => true });
  await runtime.start();
  assert.equal(store.getSession(key), undefined); assert.equal(store.getSession(empty.key), undefined);
  assert.equal(journal.sessions().length, 0);
  console.log(JSON.stringify({ realBackend: true, syntheticModel: true, create: true, send: true, history: true, queueBatch: true, tool: true, exclusiveHome: true, restartResume: true, deleteStoredAndEmpty: true, deletionSurvivesRestart: true, modelRequests, evidence: root }));
} finally { releaseModel(); await runtime.close(); db.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
