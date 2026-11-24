// Actual installed Codex → formal Connector host bridge → real Hub capability.
// Only synthetic loopback Responses, isolated HOME/CODEX_HOME and SQLite are used.
// No existing credentials, native sessions, downstream installation or service writes.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { CodexAppServer } from '../apps/server/src/codex/app-server.ts';
import { CodexExecutions } from '../apps/server/src/codex/executions.ts';
import { TurnQueue } from '../apps/server/src/commands/turn-queue.ts';
import { DeckStore } from '../apps/server/src/projection/deck-store.ts';
import { WorkspaceBoards } from '../apps/server/src/hub/workspace-boards.ts';
import { WorkspaceBoardCapabilities } from '../apps/server/src/hub/workspace-board-capabilities.ts';
import { registerWorkspaceAgentRoutes } from '../apps/server/src/routes/workspace-agent.ts';
import { ConnectorBoardBindings } from '../apps/server/src/connector/board-bindings.ts';

const requireServer = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { serve } = requireServer('@hono/node-server'), { Hono } = requireServer('hono');

const command = process.argv[2]; assert.ok(command && isAbsolute(command), 'Pass the installed absolute Codex executable');
const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-codex-board-native-'));
const project = join(root, 'project'), home = join(root, 'native'), grants = join(root, 'grants');
await Promise.all([project, home, grants].map(path => mkdir(path, { mode: 0o700 })));
// Dedicated test process environment; no parent provider credentials or proxies.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: home });
console.warn = () => {}; // Native diagnostic text is never evidence or model output.
const db = new DatabaseSync(join(root, 'state.sqlite')), boards = new WorkspaceBoards(db), caps = new WorkspaceBoardCapabilities(db, boards);
const taskId = randomUUID();
boards.save('fixture', 'default', { title: 'Native board', revision: 0, mutationId: randomUUID(), tasks: [
  { id: taskId, title: 'Native bridge works', status: 'todo', detail: '' },
] });
const issued = caps.issue('fixture', 'default', { taskIds: [taskId], fields: ['status'], expiresAt: Date.now() + 120000 });
const hub = new Hono(); registerWorkspaceAgentRoutes(hub, caps);
const hubServer = serve({ fetch: hub.fetch, hostname: '127.0.0.1', port: 0 });
if (!hubServer.listening) await new Promise(resolve => hubServer.once('listening', resolve));
const endpoint = `http://127.0.0.1:${hubServer.address().port}/api/workspace-agent/v1/board`;
const bindings = new ConnectorBoardBindings({ codex: grants }, [{ owner: 'fixture', runtime: 'codex', endpoint }], actor => actor === 'fixture');
await bindings.reconcile();
let modelCalls = 0, readSeen = false, writeSeen = false, resumedReadSeen = false, secretLeak = false, providerFailure;
const mutationId = randomUUID();
const model = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/responses');
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 256000); chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString(); secretLeak ||= text.includes(issued.token) || text.includes(grants) || text.includes(endpoint);
    const body = JSON.parse(text); modelCalls++; assert.ok(modelCalls <= 5, 'no automatic model/tool replay');
    const names = body.tools.flatMap(tool => tool.tools?.map(t => t.name) ?? [tool.name]);
    assert.ok(names.includes('agentopsdeck_board_read')); assert.ok(names.includes('agentopsdeck_board_update'));
    const outputText = JSON.stringify(body.input);
    if (modelCalls === 2) { readSeen = outputText.includes('Native bridge works'); assert.ok(readSeen); }
    if (modelCalls === 3) { writeSeen = outputText.includes('saved') && outputText.includes(mutationId); assert.ok(writeSeen); }
    if (modelCalls === 5) { resumedReadSeen = outputText.includes('Native bridge works') && outputText.includes('done'); assert.ok(resumedReadSeen); }
    const readCall = modelCalls === 1 || modelCalls === 4;
    const item = modelCalls < 3 || modelCalls === 4 ? { type: 'function_call', id: `fc_${modelCalls}`, call_id: `call_${modelCalls}`, status: 'completed',
      name: readCall ? 'agentopsdeck_board_read' : 'agentopsdeck_board_update',
      arguments: JSON.stringify(readCall ? {} : { revision: 1, mutationId, tasks: [{ id: taskId, status: 'done' }] }) }
      : { type: 'message', id: `msg_final_${modelCalls}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Native board accepted.', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let seq = 0;
    const event = value => res.write(`data: ${JSON.stringify({ ...value, sequence_number: ++seq })}\n\n`);
    const response = { id: `resp_${modelCalls}`, object: 'response', created_at: 1, model: 'agentopsdeck-fixture', output: [item],
      usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    event({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
    event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } });
    event({ type: 'response.output_item.done', output_index: 0, item });
    event({ type: 'response.completed', response: { ...response, status: 'completed' } }); res.end();
  } catch (error) { providerFailure = error; res.writeHead(500); res.end(); }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await writeFile(join(home, 'config.toml'), `model = "agentopsdeck-fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:${model.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
const store = new DeckStore(), executions = new CodexExecutions(db), turnQueue = new TurnQueue(db);
const createHost = () => new CodexAppServer({ enabled: true, command, homeDirectory: home, defaultCwd: project, defaultModel: 'agentopsdeck-fixture',
  modelProvider: 'fixture', approvalPolicy: 'never', store, executions, turnQueue, authorizeTurn: () => true, boardToolsDirectory: grants });
let codex = createHost();
try {
  const created = await codex.createSession({ title: 'Isolated task bridge' }, () => {}, () => {});
  assert.equal(codex.hasBoardTools(created.key), true);
  const threadId = created.key.slice(6);
  const bindingId = randomUUID();
  await bindings.install('fixture', { id: bindingId, runtime: 'codex', sessionId: threadId,
    credential: { endpoint, token: issued.token, expiresAt: issued.capability.expiresAt } });
  codex.startQueueWorker(); await codex.send(created.key, 'Use the task tools to read and complete the granted task. No shell commands.');
  const deadline = Date.now() + 45000;
  while (executions.get(created.key)?.phase !== 'completed' && Date.now() < deadline && !providerFailure) await delay(40);
  if (providerFailure) throw providerFailure;
  assert.equal(executions.get(created.key)?.phase, 'completed', 'real native turn must finish');
  assert.equal(boards.get('fixture', 'default').tasks[0].status, 'done');
  assert.equal(boards.get('fixture', 'default').revision, 2);
  assert.equal(modelCalls, 3); assert.equal(readSeen, true); assert.equal(writeSeen, true); assert.equal(secretLeak, false);
  await codex.refreshSession(created.key, { fresh: true });
  assert.equal(codex.isSessionHistoryReady(created.key), true);
  assert.ok(store.getMessages(created.key).some(message => message.role === 'assistant' && message.text.includes('Native board accepted.')));
  // Restart the actual native child and Connector host, then resume the same
  // enrolled thread. No second thread/start or automatic message replay.
  await codex.close(); codex = createHost();
  assert.equal(codex.hasBoardTools(created.key), true);
  codex.startQueueWorker(); await codex.send(created.key, 'Read the granted task again after restart. Do not update it.');
  const resumedDeadline = Date.now() + 45000;
  while ((modelCalls < 5 || executions.get(created.key)?.phase !== 'completed') && Date.now() < resumedDeadline && !providerFailure) await delay(40);
  if (providerFailure) throw providerFailure;
  assert.equal(executions.get(created.key)?.phase, 'completed'); assert.equal(modelCalls, 5);
  assert.equal(resumedReadSeen, true); assert.equal(secretLeak, false);
  assert.equal(boards.get('fixture', 'default').revision, 2, 'resume must not repeat the previous write');
  await codex.refreshSession(created.key, { fresh: true });
  assert.equal(codex.isSessionHistoryReady(created.key), true);
  assert.equal(store.getMessages(created.key).filter(message => message.role === 'user').length, 2);
  caps.revoke('fixture', 'default', issued.capability.id);
  await bindings.remove('fixture', 'codex', threadId, bindingId);
  assert.equal(await bindings.get('fixture', 'codex', threadId), undefined);
  const result = { passed: true, realNativeCodex: true, formalHostBridge: true, realHub: true, syntheticProvider: true,
    modelCalls, readSeen, writeSeen, resumedReadSeen, managedBinding: true, nativeRestartWithoutReplay: true, historyVerified: true, credentialNeverInModel: !secretLeak, root };
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally {
  await codex.close();
  model.closeAllConnections(); hubServer.closeAllConnections();
  await Promise.all([new Promise(resolve => model.close(resolve)), new Promise(resolve => hubServer.close(resolve))]); db.close();
}
