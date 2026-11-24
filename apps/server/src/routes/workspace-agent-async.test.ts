import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWorkspaceAgentRoutes, type WorkspaceBoardMachinePort } from './workspace-agent.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubStore } from '../hub/hub-store.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { AsyncHubWorkspaceBoardMachine } from '../hub/async-workspace-board-machine.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const path = '/api/workspace-agent/v1/board', token = 'aod_board_' + 'a'.repeat(43);
const document = () => ({ revision: 1, mutationId: randomUUID(), tasks: [{ id: randomUUID(), status: 'done' as const }] });
const fixture = (overrides: Partial<WorkspaceBoardMachinePort> = {}) => {
  const app = new Hono(); registerWorkspaceAgentRoutes(app, { authorized: async () => true,
    read: async () => ({ resourceId: 'default', revision: 1, tasks: [] }), update: async () => ({ status: 'denied' }), ...overrides });
  const request = (body?: unknown, credential = token) => app.request(path, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${credential}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, request };
};
function deferred<T>() { let resolve!: (v: T) => void;
  const promise = new Promise<T>(a => { resolve = a; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('existing machine HTTP route awaits false authorization and never dispatches read or update', async () => {
  let reads = 0, writes = 0;
  const f = fixture({ authorized: async () => false, read: async () => { reads++; return null; }, update: async () => { writes++; return { status: 'denied' }; } });
  assert.equal((await f.request()).status, 401); assert.equal((await f.request(document())).status, 401);
  assert.equal(reads, 0); assert.equal(writes, 0);
});
test('machine HTTP never acknowledges a pending async write or replays its mutation', async () => {
  const wait = deferred<{ status: 'saved'; revision: number; mutationId: string }>(), input = document(); let writes = 0, settled = false;
  const f = fixture({ update: async (_, value) => { writes++; assert.deepEqual(value, input); return wait.promise; } });
  const pending = Promise.resolve(f.request(input)).then(v => { settled = true; return v; }); await tick();
  assert.equal(writes, 1); assert.equal(settled, false); wait.resolve({ status: 'saved', revision: 2, mutationId: input.mutationId });
  const response = await pending; assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'saved', revision: 2, mutationId: input.mutationId });
  assert.equal(writes, 1); assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('authority revoked during async body consumption is checked before machine mutation', async () => {
  let live = true, checks = 0, writes = 0; const input = document();
  const f = fixture({ authorized: async () => { checks++; return live; }, update: async () => { writes++; return { status: 'denied' }; } });
  const body = new ReadableStream<Uint8Array>({ pull(c) { live = false; c.enqueue(new TextEncoder().encode(JSON.stringify(input))); c.close(); } }, { highWaterMark: 0 });
  const response = await f.app.request(path, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body, duplex: 'half' } as RequestInit);
  assert.equal(response.status, 401); assert.equal(checks, 2); assert.equal(writes, 0);
});
test('storage failure and cancelled read map to bounded safe errors with no payload leak or retry', async () => {
  for (const code of [499, 503] as const) {
    let calls = 0; const f = fixture({ read: async () => { calls++; throw new HubMemberRequestError(code); } });
    const response = await f.request(); assert.equal(response.status, code); assert.equal(calls, 1);
    assert.equal((await response.text()).includes(token), false);
  }
  let writes = 0; const f = fixture({ update: async () => { writes++; throw new HubMemberRequestError(503); } });
  assert.equal((await f.request(document())).status, 503); assert.equal(writes, 1);
});
test('awaited route preserves revision conflicts, original error status, projection and query validation', async () => {
  const f = fixture({ read: async (_, query) => { assert.deepEqual(query, { revision: 1 }); return { error: 'revision_changed' }; } });
  const headers = { authorization: `Bearer ${token}` };
  assert.equal((await f.app.request(path + '?read=' + encodeURIComponent(JSON.stringify({ revision: 1 })), { headers })).status, 409);
  assert.equal((await f.app.request(path + '?read={bad', { headers })).status, 400);
  assert.equal((await f.app.request(path + '?user=other', { headers })).status, 400);
  for (const [status, code] of [['denied', 403], ['invalid', 400], ['conflict', 409], ['mutation-reused', 409], ['limit', 429]] as const) {
    const write = fixture({ update: async () => ({ status }) }); assert.equal((await write.request(document())).status, code);
  }
});
test('machine auth wait errors cannot be treated as a successful or false principal', async () => {
  let reads = 0; const f = fixture({ authorized: async () => { throw new HubMemberRequestError(503); },
    read: async () => { reads++; return null; } });
  assert.equal((await f.request()).status, 503); assert.equal(reads, 0);
});
test('real sole-owner worker HTTP preserves old bearer, single durable mutation and legacy fields after reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'board-machine-http-r255-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'synthetic'), member = store.createUser('Member'), task = { id: randomUUID(), title: 'Task',
    detail: 'private detail', status: 'todo' as const, tags: ['original'], priority: 'high' as const, dueDate: '2026-10-14' };
  let owner: AsyncHubMemberOwner | undefined;
  try {
    assert.equal(store.boards.save(member.id, 'default', { title: 'Board', tasks: [task], revision: 0, mutationId: randomUUID() }).status, 'saved');
    const grant = store.boardCapabilities.issue(member.id, 'default', { taskIds: [task.id], fields: ['status'], expiresAt: Date.now() + 600_000 })!;
    await store.close(); owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic' }, new PerformanceDiagnostics(() => {})); await owner.open();
    const app = new Hono(); registerWorkspaceAgentRoutes(app, new AsyncHubWorkspaceBoardMachine(owner, new PerformanceDiagnostics(() => {})));
    const headers = { authorization: `Bearer ${grant.token}` }, input = { revision: 1, mutationId: randomUUID(), tasks: [{ id: task.id, status: 'done' }] };
    for (let i = 0; i < 2; i++) {
      const response = await app.request(path, { method: 'POST', headers, body: JSON.stringify(input) });
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'saved', revision: 2, mutationId: input.mutationId });
    }
    const read = await app.request(path, { headers }); assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { resourceId: 'default', revision: 2, tasks: [{ id: task.id, title: 'Task', status: 'done' }] });
    await owner.close(); owner = undefined;
    const reopened = new HubStore(file, 'synthetic');
    try { assert.deepEqual(reopened.boards.get(member.id, 'default').tasks[0], { ...task, status: 'done' });
      assert.equal(reopened.boardCapabilities.events(member.id, 'default').filter(e => e.event === 'updated').length, 1);
    } finally { await reopened.close(); }
  } finally { try { await owner?.close(); await store.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
});
