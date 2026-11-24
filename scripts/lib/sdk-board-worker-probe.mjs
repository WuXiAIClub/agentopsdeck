// Real pinned native worker + synthetic inference provider + isolated real Hub.
// No production credentials, model, session, environment or Agent configuration.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sdkSourceImport } from './sdk-source-import.mjs';

export async function verifySdkBoardWorker({ root, runtime, config, launch, Worker, beginTools, inferenceCount }) {
  assert.equal(process.env.AOD_SDK_PROBE_WORKER, root);
  const { Hono } = await import('../../apps/server/node_modules/hono/dist/index.js');
  const { serve } = await import('../../apps/server/node_modules/@hono/node-server/dist/index.mjs');
  const { WorkspaceBoards } = await sdkSourceImport('../../apps/server/src/hub/workspace-boards.ts', import.meta.url);
  const { WorkspaceBoardCapabilities } = await sdkSourceImport('../../apps/server/src/hub/workspace-board-capabilities.ts', import.meta.url);
  const { registerWorkspaceAgentRoutes } = await sdkSourceImport('../../apps/server/src/routes/workspace-agent.ts', import.meta.url);
  const db = new DatabaseSync(':memory:'), boards = new WorkspaceBoards(db), capabilities = new WorkspaceBoardCapabilities(db, boards);
  const task = randomUUID(), nativeSessionId = randomUUID();
  boards.save('fixture', 'default', { title: 'Native worker task fixture', revision: 0, mutationId: randomUUID(),
    tasks: [{ id: task, title: 'Read then finish', status: 'todo', detail: 'Not granted' }] });
  const grant = capabilities.issue('fixture', 'default', { taskIds: [task], fields: ['status'], expiresAt: Date.now() + 60000 });
  const app = new Hono(); registerWorkspaceAgentRoutes(app, capabilities);
  let boardRequests = 0;
  const server = serve({ fetch: request => { boardRequests++; return app.fetch(request); }, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const boardToolsDirectory = join(root, `${runtime}-board-grants`); await mkdir(boardToolsDirectory, { mode: 0o700 });
  const file = join(boardToolsDirectory, `${runtime}-${nativeSessionId}.json`);
  await writeFile(file, JSON.stringify({ runtime, sessionId: nativeSessionId, credential: {
    endpoint: `http://127.0.0.1:${server.address().port}/api/workspace-agent/v1/board`, token: grant.token, expiresAt: grant.capability.expiresAt,
  } }), { mode: 0o600 });
  const toolName = name => runtime === 'claude-code' ? `mcp__agentopsdeck_board__${name}` : name;
  const before = inferenceCount();
  beginTools([{ name: toolName('agentopsdeck_board_read'), input: {} }, { name: toolName('agentopsdeck_board_update'),
    input: { revision: 1, mutationId: randomUUID(), tasks: [{ id: task, status: 'done' }] } }]);
  const execution = { id: randomUUID(), key: `${runtime}:${nativeSessionId}`, nativeSessionId, epoch: randomUUID(), nativeMode: 'create',
    members: ['board-fixture'], phase: 'dispatching', stopRequested: false, createdAt: 0, updatedAt: 0 };
  let worker;
  try {
    worker = new Worker({ kind: 'start', config: { ...config, boardToolsDirectory, toolPolicy: 'none' }, text: 'Fixture: read granted task, then finish it.', execution }, launch);
    let frames = 0;
    for await (const event of worker) {
      assert.ok(!JSON.stringify(event).includes(grant.token), 'Private grant must never appear in IPC'); frames++;
    }
    assert.ok(frames > 0); assert.equal(await worker.inspectQuiescence(), true);
    assert.equal(boards.get('fixture', 'default').revision, 2, 'Real native custom tool must save the Hub task');
    assert.equal(boards.get('fixture', 'default').tasks[0].status, 'done');
    assert.equal(boardRequests, 2, 'Exactly one native read and one native update, no replay');
    assert.equal(inferenceCount() - before, 3, 'Read → update → final, no inference retry');
    console.log(runtime, 'formal native board tools: registered, invoked, persisted, private IPC and worker drain passed');
    return 3;
  } finally {
    worker?.close(); if (worker) await worker.finished;
    capabilities.revoke('fixture', 'default', grant.capability.id); await unlink(file);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); beginTools([]);
  }
}
