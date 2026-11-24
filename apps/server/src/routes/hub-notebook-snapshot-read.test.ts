import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HubStore } from '../hub/hub-store.js';
import { registerHubSessionNotebookRoutes } from './hub-session-notebooks.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT } from '@agentopsdeck/shared';
import { DEFAULT_NOTEBOOK_LAYOUT_RESOURCE, type NotebookSnapshotRead, type NotebookSnapshot } from '../hub/notebook-snapshot-read.js';
const tick = () => new Promise<void>(done => setImmediate(done));
const resourceId = JSON.stringify(['hub-notebook', 1]);
const doc = { resourceId, revision: 1, updatedAt: 1, text: 'PRIVATE 文😀\0' };
const reply = (read: NotebookSnapshotRead): NotebookSnapshot => {
  if (read.mode === 'search') return { documents: [], defaultDocument: null, versions: [{ resourceId: read.resourceId!, area: 'hot', revision: 1, updatedAt: 1 }],
    search: { hotRevision: 1, coldRevision: null, results: [] } };
  if (read.mode === 'layouts') return { documents: [], defaultDocument: { resourceId: DEFAULT_NOTEBOOK_LAYOUT_RESOURCE, text: '', revision: 0, updatedAt: null },
    search: null, versions: [{ resourceId: DEFAULT_NOTEBOOK_LAYOUT_RESOURCE, area: 'hot', revision: 0, updatedAt: null }] };
  const d = { ...doc, resourceId: read.resourceId! };
  return { documents: [d], defaultDocument: null, search: null, versions: [{ resourceId: d.resourceId, area: read.mode === 'cold' ? 'cold' : 'hot', revision: 1, updatedAt: 1 }] };
};
function fixture(work: (r: NotebookSnapshotRead) => Promise<NotebookSnapshot>, timeout = 1000) {
  let actor = { userId: 'alice', admin: false }, revoked = false, calls = 0;
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => { lines.push(line); });
  const persistence = new AuthRoutePersistence(diagnostics), readWait = new AuthRouteReadWait(persistence, diagnostics, timeout), app = new Hono();
  const store = { notebookSnapshotAsync: (r: NotebookSnapshotRead) => { calls++; return work(r); }, notebooks: new Proxy({}, { get: () => () => { throw Error('sync read/write'); } }) } as unknown as HubStore;
  registerHubSessionNotebookRoutes(app, { hubStore: store, readWait, diagnostics, principal: () => {
    if (revoked) throw new HTTPException(401); return actor;
  } });
  app.onError((e, c) => e instanceof HTTPException ? c.json({ error: 'refused' }, e.status) : c.json({ error: 'unexpected' }, 500));
  return { app, lines, persistence, calls: () => calls, revoke: () => { revoked = true; },
    mutate: () => { actor.userId = 'bob'; }, downgrade: () => { actor = { ...actor, admin: false }; }, elevate: () => { actor = { ...actor, admin: true }; } };
}
for (const path of ['/api/hub/v1/notebook', '/api/hub/v1/notebooks/default', '/api/hub/v1/notebooks/default/archive',
  '/api/hub/v1/notebooks/default/layout', '/api/hub/v1/notebooks', '/api/hub/v1/notebooks/default/search?q=old']) {
  test(`${path} preserves legacy wire without synchronous body access`, async () => {
    let scope!: NotebookSnapshotRead; const f = fixture(async r => { scope = r; return reply(r); });
    const response = await f.app.request(path); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const value = await response.json(); assert.equal(scope.owner, 'alice');
    if (scope.mode === 'search') assert.deepEqual(value, reply(scope).search);
    else if (scope.mode === 'layouts') assert.deepEqual(value, { items: [{ ...reply(scope).defaultDocument, text: JSON.stringify(DEFAULT_HUB_NOTEBOOK_LAYOUT) }], nextCursor: null });
    else assert.deepEqual(value, reply(scope).documents[0]);
    assert.equal(f.calls(), 1); assert.doesNotMatch(f.lines.join('\n'), /PRIVATE|alice|bob|文/);
  });
  for (const action of ['revoke', 'mutate', 'downgrade'] as const) test(`${path} ${action} during awaited read refuses disclosure`, async () => {
    let release!: () => void; const f = fixture(r => new Promise(done => { release = () => done(reply(r)); }));
    if (action === 'downgrade') f.elevate();
    const response = f.app.request(path); await tick(); f[action](); release(); assert.equal((await response).status, 401);
    assert.equal(f.calls(), 1); assert.ok(f.lines.some(l => l.includes('hub-notebook-snapshot-read'))); assert.doesNotMatch(f.lines.join('\n'), /PRIVATE|alice|bob/);
  });
  test(`${path} abort ends HTTP wait only; original admission and no replay retained`, async () => {
    let release!: () => void; const f = fixture(r => new Promise(done => { release = () => done(reply(r)); }));
    const abort = new AbortController(), response = f.app.request(new Request('http://localhost' + path, { signal: abort.signal }));
    await tick(); abort.abort(); assert.equal((await response).status, 499); assert.equal(f.persistence.pending, 1);
    release(); await tick(); assert.equal(f.persistence.pending, 0); assert.equal(f.calls(), 1);
  });
}
test('read timeout retains original admission and late rejection without replay or body disclosure', async () => {
  let reject!: (error: Error) => void; const f = fixture(() => new Promise((_, no) => { reject = no; }), 10);
  const response = await f.app.request('/api/hub/v1/notebook'); assert.equal(response.status, 503); assert.equal(f.persistence.pending, 1);
  reject(Error('PRIVATE late outcome')); await tick(); assert.equal(f.persistence.pending, 0); assert.equal(f.calls(), 1);
  assert.doesNotMatch(f.lines.join('\n'), /PRIVATE/);
});
test('malformed scope and malformed owner reply are refused before disclosure', async () => {
  const f = fixture(async r => ({ ...reply(r), versions: [] }));
  assert.equal((await f.app.request('/api/hub/v1/notebooks/invalid')).status, 404);
  assert.equal((await f.app.request('/api/hub/v1/notebooks?after=invalid')).status, 400);
  assert.equal((await f.app.request('/api/hub/v1/notebooks/default/search?q=')).status, 400);
  assert.equal(f.calls(), 0);
  assert.equal((await f.app.request('/api/hub/v1/notebook')).status, 503); assert.equal(f.calls(), 1);
});
