import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WorkspaceBoards } from '../hub/workspace-boards.js';
import { WorkspaceBoardCapabilities } from '../hub/workspace-board-capabilities.js';
import { registerWorkspaceAgentRoutes } from '../routes/workspace-agent.js';
import { BOARD_READ_TOOL, BOARD_UPDATE_TOOL, boardToolNames, boardToolsDirectory, loadWorkerBoardTools } from './workspace-board-worker.js';
import { copilotBoardTools } from '../copilot/board-tools.js';
import { copilotToolPolicy } from '../copilot/tool-policy.js';
import { claudeToolPolicy } from '../claude/tool-policy.js';
import { claudeBoardToolName, claudeBoardServer, type BoardMcpSdk } from '../claude/board-tools.js';
import type { ClaudeConfig } from '../claude/config.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-board-worker-')), directory = join(root, 'grants');
  await mkdir(directory, { mode: 0o700 });
  const sessionId = randomUUID(), runtime = 'ghcp' as const;
  const credential = { endpoint: 'http://127.0.0.1:8791/api/workspace-agent/v1/board', token: 'aod_board_' + 'a'.repeat(43), expiresAt: Date.now() + 60000 };
  const path = join(directory, `${runtime}-${sessionId}.json`);
  const save = (value = credential) => writeFile(path, JSON.stringify({ runtime, sessionId, credential: value }), { mode: 0o600 });
  await save();
  return { root, directory, sessionId, runtime, credential, path, save, close: () => rm(root, { recursive: true, force: true }) };
}

test('board worker default-off, private path separation and exact per-session binding', async () => {
  const f = await fixture();
  try {
    assert.equal(await loadWorkerBoardTools(undefined, 'ghcp', f.sessionId, () => true), undefined);
    assert.equal(await loadWorkerBoardTools(f.directory, 'claude-code', f.sessionId, () => true), undefined);
    assert.equal(await loadWorkerBoardTools(f.directory, 'ghcp', randomUUID(), () => true), undefined);
    for (const value of ['', '/', 'relative', '/private/../grants', f.root, f.directory + '/nested']) assert.throws(() => boardToolsDirectory(value, [f.directory]));
    assert.equal(boardToolsDirectory(f.directory, [join(f.root, 'workspace')]), f.directory);
    await assert.rejects(loadWorkerBoardTools(f.directory, 'ghcp', '../outside', () => true));
    await writeFile(f.path, JSON.stringify({ runtime: 'claude-code', sessionId: f.sessionId, credential: f.credential }));
    await assert.rejects(loadWorkerBoardTools(f.directory, 'ghcp', f.sessionId, () => true));
    await f.save(); await chmod(f.path, 0o644);
    await assert.rejects(loadWorkerBoardTools(f.directory, 'ghcp', f.sessionId, () => true));
    await chmod(f.path, 0o600); await link(f.path, join(f.root, 'alias'));
    await assert.rejects(loadWorkerBoardTools(f.directory, 'ghcp', f.sessionId, () => true));
    await rm(join(f.root, 'alias')); await rename(f.path, join(f.root, 'actual')); await symlink(join(f.root, 'actual'), f.path);
    await assert.rejects(loadWorkerBoardTools(f.directory, 'ghcp', f.sessionId, () => true));
    await rm(f.path); await f.save(); await chmod(f.directory, 0o755);
    await assert.rejects(loadWorkerBoardTools(f.directory, 'ghcp', f.sessionId, () => true));
  } finally { await f.close(); }
});

test('formal tool permissions remain exact, managed-policy-aware, session-bound and stop-revocable', async () => {
  let active = true;
  const id = randomUUID(), policy = copilotToolPolicy({ workspace: '/unused', toolPolicy: 'none' }, () => active, id);
  assert.deepEqual(policy.availableTools, boardToolNames); assert.ok(policy.excludedTools.includes('builtin:*'));
  assert.ok(copilotToolPolicy({ workspace: '/unused' }).excludedTools.includes('custom:*'));
  const args = { revision: 1, mutationId: randomUUID(), tasks: [{ id: randomUUID(), status: 'done' }] };
  for (const name of boardToolNames) {
    const input = name === BOARD_READ_TOOL ? {} : args;
    assert.equal((await policy.onPreToolUse({ toolName: name, toolArgs: input, sessionId: id }, { sessionId: id })).permissionDecision, 'ask');
    for (const kind of ['hook', 'custom-tool']) {
      const request = { kind, toolName: name, toolArgs: input, args: input };
      assert.equal((await policy.onPermissionRequest(request, { sessionId: id })).kind, 'approve-once');
      for (const invocation of [{ sessionId: randomUUID() }, { sessionId: id, managedSettingsEnabled: true }]) assert.equal((await policy.onPermissionRequest(request, invocation)).kind, 'reject');
      assert.equal((await policy.onPermissionRequest({ ...request, managedApprovalRequired: true }, { sessionId: id })).kind, 'reject');
    }
  }
  assert.equal((await policy.onPreToolUse({ toolName: BOARD_READ_TOOL, toolArgs: {}, sessionId: id }, { sessionId: randomUUID() })).permissionDecision, 'deny');
  assert.equal((await policy.onPreToolUse({ toolName: 'custom_arbitrary', toolArgs: {}, sessionId: id }, { sessionId: id })).permissionDecision, 'deny');
  assert.equal((await policy.onPermissionRequest({ kind: 'custom-tool', toolName: BOARD_READ_TOOL, args: { endpoint: 'other' } }, { sessionId: id })).kind, 'reject');
  const config = { workspace: '/unused', toolPolicy: 'none' } as ClaudeConfig;
  const claude = claudeToolPolicy(config, () => active, true), name = claudeBoardToolName(BOARD_READ_TOOL);
  assert.deepEqual(claude.tools, []); assert.ok(claude.permissions.ask.includes(name));
  assert.equal((await claude.canUseTool(name, {})).behavior, 'allow');
  const filtered = { status: 'todo', limit: 20, includeDetail: false };
  assert.equal((await claude.canUseTool(name, filtered)).behavior, 'allow');
  assert.equal((await claude.canUseTool(name, { offset: 20 })).behavior, 'deny');
  assert.equal((await policy.onPermissionRequest({ kind: 'custom-tool', toolName: BOARD_READ_TOOL, args: filtered }, { sessionId: id })).kind, 'approve-once');
  assert.equal((await claudeToolPolicy(config).canUseTool(name, {})).behavior, 'deny');
  for (const other of [BOARD_READ_TOOL, name + '_extra', 'mcp__other__read', 'Bash']) assert.equal((await claude.canUseTool(other, {})).behavior, 'deny');
  active = false;
  assert.equal((await claude.canUseTool(name, {})).behavior, 'deny');
  assert.equal((await policy.onPermissionRequest({ kind: 'custom-tool', toolName: BOARD_READ_TOOL, args: {} }, { sessionId: id })).kind, 'reject');
});

test('worker handlers → real Hub: bounded grants, CAS, no replay, revocation and per-call session validation', async () => {
  const f = await fixture(), db = new DatabaseSync(':memory:'), boards = new WorkspaceBoards(db), caps = new WorkspaceBoardCapabilities(db, boards);
  const task = randomUUID(), hidden = randomUUID();
  boards.save('fixture', 'default', { title: 'Worker test', revision: 0, mutationId: randomUUID(), tasks: [
    { id: task, title: 'Granted', status: 'todo', detail: '' }, { id: hidden, title: 'Private', status: 'todo', detail: '' },
  ] });
  const issued = caps.issue('fixture', 'default', { taskIds: [task], fields: ['status'], expiresAt: Date.now() + 60000 })!;
  const app = new Hono(); registerWorkspaceAgentRoutes(app, caps);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    await f.save({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/workspace-agent/v1/board`, token: issued.token, expiresAt: issued.capability.expiresAt });
    let requests = 0;
    const board = (await loadWorkerBoardTools(f.directory, 'ghcp', f.sessionId, () => true, (...args) => { requests++; return fetch(...args); }))!;
    const tools = copilotBoardTools(board, f.sessionId);
    assert.equal(tools[0]!.skipPermission, false);
    const call = async (name: string, input: unknown, sessionId = f.sessionId) => {
      const result = await tools.find(tool => tool.name === name)!.handler(input, { sessionId, toolName: name });
      assert.ok(!JSON.stringify(result).includes(issued.token)); return JSON.parse(result.textResultForLlm);
    };
    assert.equal((await call(BOARD_READ_TOOL, {})).board.tasks.length, 1);
    assert.ok((await call(BOARD_READ_TOOL, {}, randomUUID())).error); assert.equal(requests, 1);
    const selected = await call(BOARD_READ_TOOL, { status: 'todo', limit: 1, includeDetail: false });
    assert.equal(selected.board.tasks[0].id, task); assert.equal(selected.board.page.total, 1);
    assert.equal((await call(BOARD_READ_TOOL, { ifRevision: selected.board.revision, limit: 1 })).board.unchanged, true);
    // Structural SDK/Zod fixture only: no real Claude SDK process or model.
    const zod = join(f.root, 'sdk', 'node_modules', 'zod'); await mkdir(zod, { recursive: true });
    await writeFile(join(zod, 'index.js'), `
      const schema = kind => ({kind, int(){return this}, min(){return this}, max(){return this}, uuid(){return this}, optional(){return this}, strict(){return this}});
      module.exports = Object.fromEntries(['number','string','boolean','enum','array','object'].map(kind=>[kind,()=>schema(kind)]));
    `);
    let mcp: Parameters<BoardMcpSdk['createSdkMcpServer']>[0] | undefined;
    claudeBoardServer(join(f.root, 'sdk', 'entry.cjs'), { createSdkMcpServer(options) { mcp = options; return options; } }, board);
    const claudeRead = mcp!.tools.find(tool => tool.name === BOARD_READ_TOOL)!;
    assert.deepEqual(Object.keys(claudeRead.inputSchema).sort(), Object.keys(tools[0]!.parameters.properties).sort());
    const claudePage = await claudeRead.handler({ taskIds: [task], limit: 1 });
    assert.equal(claudePage.isError, false); assert.equal(JSON.parse(claudePage.content[0]!.text).board.page.total, 1);
    assert.equal((await claudeRead.handler({ offset: 1 })).isError, true);
    const input = { revision: 1, mutationId: randomUUID(), tasks: [{ id: task, status: 'done' }] };
    assert.equal((await call(BOARD_UPDATE_TOOL, input)).status, 'saved');
    assert.equal((await call(BOARD_UPDATE_TOOL, input)).revision, 2);
    assert.equal((await call(BOARD_UPDATE_TOOL, { ...input, mutationId: randomUUID() })).status, 409);
    assert.equal((await call(BOARD_UPDATE_TOOL, { ...input, revision: 2, mutationId: randomUUID(), tasks: [{ id: hidden, status: 'done' }] })).status, 403);
    caps.revoke('fixture', 'default', issued.capability.id);
    assert.equal((await call(BOARD_READ_TOOL, {})).status, 401);
    const before = requests; board.close(); assert.ok((await call(BOARD_READ_TOOL, {})).error); assert.equal(requests, before);
    assert.equal(boards.get('fixture', 'default').revision, 2);
  } finally { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await f.close(); }
});

test('stop cancels in-flight board writes without replay; overlapping invocation and revoked files fail closed', async () => {
  const f = await fixture();
  try {
    let calls = 0, started!: () => void;
    const admitted = new Promise<void>(resolve => { started = resolve; });
    const board = (await loadWorkerBoardTools(f.directory, 'ghcp', f.sessionId, () => true, async (_url, init) => {
      calls++; started(); return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
    }))!;
    const input = { revision: 1, mutationId: randomUUID(), tasks: [{ id: randomUUID(), status: 'done' }] };
    const pending = board.invoke(BOARD_UPDATE_TOOL, input); await admitted;
    assert.equal((await board.invoke(BOARD_READ_TOOL, {})).status, 429);
    board.close(); const result = await pending;
    assert.equal(result.uncertain, true); assert.equal(result.mutationId, input.mutationId); assert.equal(calls, 1);
    const current = (await loadWorkerBoardTools(f.directory, 'ghcp', f.sessionId, () => true, async () => { calls++; return Response.json({}); }))!;
    await f.save({ ...f.credential, token: 'aod_board_' + 'b'.repeat(43) });
    assert.ok((await current.invoke(BOARD_READ_TOOL, {})).error); assert.equal(calls, 1);
    await f.save(); await rename(f.directory, join(f.root, 'original')); await mkdir(f.directory, { mode: 0o700 }); await f.save();
    assert.ok((await current.invoke(BOARD_READ_TOOL, {})).error); assert.equal(calls, 1);
  } finally { await f.close(); }
});
