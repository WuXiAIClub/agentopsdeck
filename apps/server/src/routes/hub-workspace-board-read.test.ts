import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { summarizeBoard, type BoardDocument } from '@agentopsdeck/shared';
import { registerHubWorkspaceBoardRoutes } from './hub-workspace-boards.js';
import type { HubStore } from '../hub/hub-store.js';
import type { FileBoardBinding } from '../hub/workspace-board-files.js';
import type { WorkspaceBoardRead, WorkspaceBoardReadResult } from '../hub/workspace-board-snapshot-read.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const base = '/api/hub/v1/workspace/boards';
const actor = { userId: 'alice', admin: false };
const document: BoardDocument = { resourceId: 'default', title: 'Task board', tasks: [], revision: 0, updatedAt: null };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(get: (r: WorkspaceBoardRead) => Promise<WorkspaceBoardReadResult>, timeoutMs = 30_000) {
  const app = new Hono(), lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const persistence = new AuthRoutePersistence(diagnostics), readWait = new AuthRouteReadWait(persistence, diagnostics, timeoutMs);
  let current = { ...actor }, writes = 0, binding: FileBoardBinding | undefined, revoked = false;
  const store = { workspaceBoardAsync: get, boardFiles: { current: () => binding }, boards: {
    get() { throw Error('sync GET must not run'); }, summary() { throw Error('sync summary must not run'); }, list() { throw Error('sync list must not run'); },
    save() { writes++; return { status: 'conflict' }; },
  } } as unknown as HubStore;
  registerHubWorkspaceBoardRoutes(app, { hubStore: store, principal: () => {
    if (revoked) throw new HTTPException(401); return current;
  }, readWait, diagnostics });
  app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: 'unexpected' }, 500));
  return { app, persistence, lines, writes: () => writes, change: (next: typeof actor) => { current = next; },
    mutate: () => { current.userId = 'bob'; }, revoke: () => { revoked = true; }, bind: (value: FileBoardBinding | undefined) => { binding = value; } };
}
for (const [suffix, mode] of [['', 'list'], ['/default/summary', 'summary'], ['/default', 'document']] as const) {
  const value = mode === 'list' ? [summarizeBoard(document)] : mode === 'summary' ? summarizeBoard(document) : document;
  test(`${mode} awaited route preserves original wire shape, scope and no-store without synchronous body reads`, async () => {
    const f = setup(async read => { assert.deepEqual(read, { owner: 'alice', mode, resourceId: mode === 'list' ? null : 'default' }); return value; });
    const response = await f.app.request(base + suffix);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), mode === 'list' ? { boards: value } : value); assert.equal(f.writes(), 0);
  });
  test(`${mode} authority change during read refuses buffered result without dispatching any write`, async () => {
    let resolve!: (v: WorkspaceBoardReadResult) => void;
    const f = setup(() => new Promise(done => { resolve = done; })), response = f.app.request(base + suffix);
    await turn(); f.change({ ...actor, userId: 'bob' }); resolve(value);
    assert.equal((await response).status, 401); assert.equal(f.writes(), 0);
    assert.ok(f.lines.some(line => line.includes('hub-workspace-board-read')));
    assert.doesNotMatch(f.lines.join('\n'), /alice|bob|Task board/);
  });
  test(`${mode} admin downgrade is not the same identity proof`, async () => {
    let resolve!: (v: WorkspaceBoardReadResult) => void;
    const f = setup(() => new Promise(done => { resolve = done; })); f.change({ ...actor, admin: true });
    const response = f.app.request(base + suffix); await turn(); f.change(actor); resolve(value);
    assert.equal((await response).status, 401);
  });
  for (const action of ['revoke', 'mutate'] as const) test(`${mode} ${action} of the original principal refuses buffered snapshot with numeric diagnostics`, async () => {
    let resolve!: (v: WorkspaceBoardReadResult) => void;
    const f = setup(() => new Promise(done => { resolve = done; })), response = f.app.request(base + suffix);
    await turn(); f[action](); resolve(value);
    assert.equal((await response).status, 401); assert.equal(f.writes(), 0);
    assert.ok(f.lines.some(line => line.includes('hub-workspace-board-read')));
    assert.doesNotMatch(f.lines.join('\n'), /alice|bob|Task board/);
  });
  test(`${mode} cancellation ends only HTTP wait; original admission settles once, never writes or replays`, async () => {
    let resolve!: (v: WorkspaceBoardReadResult) => void, calls = 0;
    const f = setup(() => { calls++; return new Promise(done => { resolve = done; }); }), abort = new AbortController();
    const response = f.app.request(new Request('http://localhost' + base + suffix, { signal: abort.signal }));
    await turn(); assert.equal(f.persistence.pending, 1); abort.abort();
    assert.equal((await response).status, 499); assert.equal(f.persistence.pending, 1); assert.equal(calls, 1);
    resolve(value); await turn(); assert.equal(f.persistence.pending, 0); assert.equal(calls, 1); assert.equal(f.writes(), 0);
  });
  test(`${mode} deadline returns safe 503 but retains original SQL slot until late rejection`, async () => {
    let reject!: (e: Error) => void, calls = 0;
    const f = setup(() => { calls++; return new Promise((_done, fail) => { reject = fail; }); }, 5);
    const response = await f.app.request(base + suffix);
    assert.equal(response.status, 503); assert.equal(f.persistence.pending, 1); assert.equal(calls, 1);
    reject(Error('PRIVATE failed SQL')); await turn(); assert.equal(f.persistence.pending, 0); assert.equal(f.writes(), 0);
    assert.doesNotMatch(f.lines.join('\n'), /PRIVATE|alice|Task board/);
  });
  test(`${mode} malformed success or private storage failure cannot leak task bodies or overwrite a board`, async () => {
    for (const get of [async () => { throw Error('PRIVATE storage'); }, async () => ({ ...document, private: 'PRIVATE' })]) {
      const f = setup(get);
      const response = await f.app.request(base + suffix); assert.equal(response.status, 503);
      assert.doesNotMatch(await response.text(), /PRIVATE|"tasks"/); assert.equal(f.writes(), 0);
    }
  });
}
test('binding changes during document read cannot pair an old board with a new native projection', async () => {
  let resolve!: (v: WorkspaceBoardReadResult) => void;
  const f = setup(() => new Promise(done => { resolve = done; })), response = f.app.request(base + '/default');
  await turn(); f.bind({ bindingId: 'old-binding', userId: 'alice', resourceId: 'default', sessionId: 'session', connectionId: 'node', authority: 1,
    state: 'active', sourceHash: null, problem: null, createdAt: 1 }); resolve(document);
  assert.equal((await response).status, 503); assert.equal(f.writes(), 0);
});
test('same stable binding keeps existing public DTO but never exports original authority or owner', async () => {
  const f = setup(async () => document);
  f.bind({ bindingId: 'old-binding', userId: 'alice', resourceId: 'default', sessionId: 'session', connectionId: 'node', authority: 7,
    state: 'active', sourceHash: 'secret-hash', problem: null, createdAt: 1 });
  const response = await f.app.request(base + '/default'); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...document, fileBinding: { bindingId: 'old-binding', resourceId: 'default', sessionId: 'session', state: 'active', problem: null } });
});
for (const field of ['authority', 'sourceHash'] as const) test(`private binding ${field} change refuses mixed snapshot even when public binding is unchanged`, async () => {
  let resolve!: (v: WorkspaceBoardReadResult) => void;
  const binding: FileBoardBinding = { bindingId: 'old-binding', userId: 'alice', resourceId: 'default', sessionId: 'session', connectionId: 'node', authority: 7,
    state: 'active', sourceHash: 'private-source', problem: null, createdAt: 1 };
  const f = setup(() => new Promise(done => { resolve = done; })); f.bind(binding);
  const response = f.app.request(base + '/default'); await turn();
  f.bind({ ...binding, [field]: field === 'authority' ? 8 : 'new-private-source' }); resolve(document);
  assert.equal((await response).status, 503); assert.equal(f.writes(), 0);
  assert.ok(f.lines.some(line => line.includes('hub-workspace-board-read')));
  assert.doesNotMatch(f.lines.join('\n'), /private-source|alice|session|node|old-binding/);
});
test('invalid board and already-cancelled requests do not invoke a reader or a writer', async () => {
  let calls = 0; const f = setup(async () => { calls++; return document; });
  assert.equal((await f.app.request(base + '/bad')).status, 404);
  const abort = new AbortController(); abort.abort();
  assert.equal((await f.app.request(new Request('http://localhost' + base + '/default', { signal: abort.signal }))).status, 499);
  assert.equal(calls, 0); assert.equal(f.writes(), 0);
});
