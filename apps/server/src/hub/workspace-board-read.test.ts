import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { WorkspaceBoards } from './workspace-boards.js';
import { WorkspaceBoardCapabilities } from './workspace-board-capabilities.js';
import { validBoardAgentRead } from './workspace-board-read.js';
import { registerWorkspaceAgentRoutes } from '../routes/workspace-agent.js';
import { executeBoardTool } from '../tools/workspace-board-cli.js';

function fixture(t: { after(fn: () => void): void }, fields: ('status' | 'detail')[] = ['status', 'detail']) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const boards = new WorkspaceBoards(db); let now = Date.now();
  const caps = new WorkspaceBoardCapabilities(db, boards, () => now);
  const tasks = Array.from({ length: 65 }, (_, i) => ({ id: randomUUID(), title: `Task ${i}`, detail: 'Long detail '.repeat(40), status: (['todo', 'doing', 'done'] as const)[i % 3]! }));
  const hidden = { id: randomUUID(), title: 'Unrelated private task', detail: 'not visible', status: 'todo' as const };
  boards.save('owner', 'default', { revision: 0, mutationId: randomUUID(), title: 'Fixture', tasks: [...tasks, hidden] });
  const grant = caps.issue('owner', 'default', { taskIds: tasks.map(t => t.id), fields, expiresAt: now + 60000 })!;
  const app = new Hono(); registerWorkspaceAgentRoutes(app, caps);
  const credential = { endpoint: 'http://127.0.0.1:8791/api/workspace-agent/v1/board', token: grant.token, expiresAt: now + 60000 };
  let requests = 0;
  const fetcher: typeof fetch = async (url, init) => { requests++; return app.request(String(url), init); };
  const read = (input: unknown = {}) => executeBoardTool('read', input, credential, fetcher);
  const http = (query: string) => app.request(credential.endpoint + query, { headers: { authorization: `Bearer ${grant.token}` } });
  return { boards, caps, tasks, hidden, read, http, credential, fetcher, grant, get requests() { return requests; }, expire() { now += 60001; } };
}

test('bounded read schema rejects unknown fields, invalid selectors and unpinned pages', () => {
  for (const query of [null, [], '', { endpoint: 'elsewhere' }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { status: 'all' },
    { taskIds: [] }, { taskIds: [randomUUID(), 'bad'] }, { taskIds: Array(51).fill(randomUUID()) },
    { includeDetail: 'false' }, { offset: 1 }, { offset: -1 }, { offset: 201, revision: 1 }, { revision: 0 },
    { ifRevision: 1, revision: 1 }, { ifRevision: 1, offset: 1 }, { limit: undefined }]) assert.equal(validBoardAgentRead(query), false, JSON.stringify(query));
  for (const query of [{}, { limit: 20 }, { offset: 20, revision: 1 }, { status: 'doing', taskIds: [randomUUID()], includeDetail: true }, { ifRevision: 2 }]) assert.ok(validBoardAgentRead(query));
});

test('real Hub read projection: legacy compatibility, pages, selected detail, conditional refresh and bounded output', async t => {
  const f = fixture(t), legacy = await f.read();
  const full = legacy.board as { revision: number; tasks: unknown[] };
  assert.equal(full.tasks.length, 65); assert.ok(JSON.stringify(full).includes('Long detail'));
  const first = (await f.read({ limit: 20 })).board as any;
  assert.equal(first.tasks.length, 20); assert.deepEqual(first.page, { offset: 0, limit: 20, total: 65, nextOffset: 20 });
  assert.equal(first.tasks[0].detail, undefined); assert.equal(first.tasks[0].status, 'todo');
  const ids = first.tasks.map((t: any) => t.id);
  let page = first;
  while (page.page.nextOffset !== null) {
    page = (await f.read({ limit: 20, offset: page.page.nextOffset, revision: first.revision })).board;
    ids.push(...page.tasks.map((t: any) => t.id));
  }
  assert.deepEqual(ids, f.tasks.map(t => t.id));
  const filtered = (await f.read({ status: 'doing', limit: 50 })).board as any;
  assert.equal(filtered.page.total, f.tasks.filter(t => t.status === 'doing').length);
  assert.ok(filtered.tasks.every((t: any) => t.status === 'doing' && !('detail' in t)));
  const selected = (await f.read({ taskIds: [f.hidden.id, f.tasks[3]!.id], includeDetail: true })).board as any;
  assert.equal(selected.page.total, 1); assert.deepEqual(selected.tasks, [f.tasks[3]]);
  assert.deepEqual((await f.read({ taskIds: [f.hidden.id] })).board, { resourceId: 'default', revision: 1, tasks: [], page: { offset: 0, limit: 20, total: 0, nextOffset: null } });
  const unchanged = (await f.read({ limit: 20, ifRevision: 1 })).board as any;
  assert.deepEqual(unchanged, { resourceId: 'default', revision: 1, tasks: [], unchanged: true });
  assert.deepEqual((await f.read({ limit: 20, ifRevision: 2 })).board, first, 'changed conditional reads return the selected page');
  assert.deepEqual((await f.read({ offset: 200, revision: 1 })).board,
    { resourceId: 'default', revision: 1, tasks: [], page: { offset: 200, limit: 20, total: 65, nextOffset: null } });
  const sizes = { full: JSON.stringify(legacy).length, summaryPage: JSON.stringify({ board: first }).length, unchanged: JSON.stringify({ board: unchanged }).length };
  assert.ok(sizes.summaryPage < sizes.full / 8); assert.ok(sizes.unchanged < sizes.summaryPage / 8);
  console.log('Synthetic response characters (not token measurements):', JSON.stringify(sizes));
  assert.equal(f.boards.get('owner', 'default').revision, 1, 'reads never mutate the board');
});

test('revision changes, deletion/reorder and revoked/expired grants cannot yield mixed pages', async t => {
  const f = fixture(t);
  const first = (await f.read({ limit: 10 })).board as any;
  f.boards.save('owner', 'default', { revision: 1, mutationId: randomUUID(), title: 'Changed', tasks: [...f.tasks.slice(1).reverse(), f.hidden] });
  const stale = await f.read({ offset: first.page.nextOffset, revision: first.revision, limit: 10 });
  assert.equal(stale.status, 409); assert.equal(stale.board, undefined);
  const changed = (await f.read({ ifRevision: 1, limit: 10 })).board as any;
  assert.equal(changed.revision, 2); assert.equal(changed.unchanged, undefined); assert.equal(changed.page.total, 64);
  f.caps.revoke('owner', 'default', f.grant.capability.id);
  assert.equal((await f.read({ ifRevision: 2 })).status, 401);
  const expired = fixture(t); expired.expire(); assert.equal((await expired.read({ limit: 1 })).status, 401);
});

test('status selectors never reveal ungranted fields and conditional reads still authorize selectors', async t => {
  const f = fixture(t, ['detail']);
  const page = (await f.read({ includeDetail: true, limit: 1 })).board as any;
  assert.equal(page.tasks[0].status, undefined); assert.ok(page.tasks[0].detail);
  for (const query of [{ status: 'todo' }, { status: 'done', ifRevision: 1 }]) {
    const result = await f.read(query); assert.equal(result.status, 400); assert.equal(result.board, undefined);
  }
  const summariesOnly = fixture(t, ['status']);
  const selected = (await summariesOnly.read({ taskIds: [summariesOnly.tasks[0]!.id], includeDetail: true })).board as any;
  assert.equal(selected.tasks.length, 1); assert.equal(selected.tasks[0].detail, undefined, 'includeDetail never grants detail access');
});

test('malformed/oversized query and duplicates fail closed; invalid native input makes no request', async t => {
  const f = fixture(t);
  for (const suffix of ['?read=%7B', '?read={}&read={}', '?endpoint=other', '?read=' + 'a'.repeat(4097), '?read=null', '?read=%7B%22offset%22:1%7D']) {
    const response = await f.http(suffix); assert.equal(response.status, 400); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const calls = f.requests;
  for (const input of [{ offset: 2 }, { limit: 99 }, { token: 'bad' }]) assert.ok((await f.read(input)).error);
  assert.equal(f.requests, calls);
});

test('host rejects ignored query on older Hub and inconsistent or overbroad responses without replay', async t => {
  const f = fixture(t), base = f.caps.read(f.grant.token)!;
  const responses = [base, { ...base, tasks: [base.tasks[0]], page: { offset: 0, limit: 1, total: 65, nextOffset: 1 } },
    { resourceId: 'default', revision: 1, tasks: [], unchanged: true },
    { ...base, tasks: [], page: { offset: 0, limit: 1, total: 65, nextOffset: null } }];
  for (const response of responses) {
    let calls = 0;
    const result = await executeBoardTool('read', { limit: 1 }, f.credential, async () => { calls++; return Response.json(response); });
    assert.ok(result.error); assert.equal(result.board, undefined); assert.equal(calls, 1);
  }
});
