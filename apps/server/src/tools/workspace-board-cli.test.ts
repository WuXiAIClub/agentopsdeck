import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WorkspaceBoards } from '../hub/workspace-boards.js';
import { WorkspaceBoardCapabilities } from '../hub/workspace-board-capabilities.js';
import { registerWorkspaceAgentRoutes } from '../routes/workspace-agent.js';
import { executeBoardTool, validBoardToolCredential } from './workspace-board-cli.js';

test('private task tool validates exact destination and never retries or reflects secrets', async () => {
  const credential = { endpoint: 'http://127.0.0.1:8791/api/workspace-agent/v1/board', token: 'aod_board_' + 'a'.repeat(43), expiresAt: Date.now() + 60000 };
  assert.ok(validBoardToolCredential(credential));
  for (const endpoint of ['http://example.com/api/workspace-agent/v1/board', 'https://example.com/api/hub/v1/users', credential.endpoint + '?key=secret', 'https://user:secret@example.com/api/workspace-agent/v1/board', credential.endpoint + '#fragment']) assert.equal(validBoardToolCredential({ ...credential, endpoint }), false);
  assert.equal(validBoardToolCredential({ ...credential, expiresAt: Date.now() - 1 }), false);
  const input = { revision: 1, mutationId: randomUUID(), tasks: [{ id: randomUUID(), status: 'done' }] };
  let calls = 0;
  const result = await executeBoardTool('update', input, credential, async (_url, init) => {
    calls++; assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit'); throw Error(credential.token);
  });
  assert.equal(calls, 1); assert.equal(result.uncertain, true); assert.equal(result.mutationId, input.mutationId);
  assert.ok(!JSON.stringify(result).includes(credential.token));
  for (const response of [new Response(credential.token, { status: 500 }), Response.json({ status: 'saved', mutationId: credential.token, revision: 2 }), new Response('x'.repeat(100000), { headers: { 'content-type': 'application/json' } })]) {
    const value = await executeBoardTool('update', input, credential, async () => response);
    assert.equal(value.uncertain, true); assert.ok(!JSON.stringify(value).includes(credential.token));
  }
});

test('private fd tool process → real Hub HTTP: read, saved mutation, retry, conflict, rejection and revoke', async () => {
  const db = new DatabaseSync(':memory:'), boards = new WorkspaceBoards(db), caps = new WorkspaceBoardCapabilities(db, boards);
  const task = randomUUID(), hidden = randomUUID();
  boards.save('fixture', 'default', { title: 'Isolated tool test', revision: 0, mutationId: randomUUID(), tasks: [
    { id: task, title: 'Permitted', detail: 'Not granted', status: 'todo' }, { id: hidden, title: 'Hidden', detail: '', status: 'todo' },
  ] });
  const issued = caps.issue('fixture', 'default', { taskIds: [task], fields: ['status'], expiresAt: Date.now() + 900000 })!;
  const app = new Hono(); registerWorkspaceAgentRoutes(app, caps);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const credential = { endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/workspace-agent/v1/board`, token: issued.token, expiresAt: issued.capability.expiresAt };
  const run = async (command: string, input?: unknown) => {
    const child = spawn(process.execPath, [...(import.meta.url.endsWith('.ts') ? ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))] : []), fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './workspace-board-cli.ts' : './workspace-board-cli.js', import.meta.url)), command], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' },
    });
    let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; }); child.stderr!.on('data', chunk => { stderr += chunk; });
    const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    (child.stdio[3] as Writable).end(JSON.stringify(credential)); child.stdin!.end(input ? JSON.stringify(input) : '');
    const code = await done;
    assert.ok(!stdout.includes(issued.token)); assert.ok(!stderr.includes(issued.token)); assert.equal(stderr, '');
    return { code, value: JSON.parse(stdout) };
  };
  try {
    const initial = await run('read'); assert.equal(initial.code, 0); assert.equal(initial.value.board.tasks.length, 1);
    assert.equal(initial.value.board.tasks[0].detail, undefined);
    const page = await run('read', { status: 'todo', limit: 1, includeDetail: false });
    assert.equal(page.code, 0); assert.equal(page.value.board.page.total, 1); assert.equal(page.value.board.tasks[0].id, task);
    assert.equal((await run('read', { ifRevision: 1, limit: 1 })).value.board.unchanged, true);
    assert.equal((await run('read', { offset: 1 })).code, 1);
    const input = { revision: 1, mutationId: randomUUID(), tasks: [{ id: task, status: 'done' }] };
    const saved = await run('update', input); assert.equal(saved.code, 0); assert.equal(saved.value.revision, 2);
    assert.deepEqual(await run('update', input), saved, 'same mutation returns original durable receipt');
    assert.equal((await run('update', { ...input, mutationId: randomUUID() })).value.status, 409);
    assert.equal((await run('update', { ...input, revision: 2, mutationId: randomUUID(), tasks: [{ id: hidden, status: 'done' }] })).value.status, 403);
    assert.equal((await run('update', { ...input, revision: 2, mutationId: randomUUID(), tasks: [{ id: task, detail: 'not allowed' }] })).value.status, 403);
    caps.revoke('fixture', 'default', issued.capability.id);
    assert.equal((await run('read')).value.status, 401);
    assert.equal(boards.get('fixture', 'default').revision, 2); assert.equal(boards.get('fixture', 'default').tasks[0]!.status, 'done');
  } finally { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
});
