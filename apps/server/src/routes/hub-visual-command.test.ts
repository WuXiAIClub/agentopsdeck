import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { emptyDrawing, emptyNativeDrawio } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from '../hub/original-administrative-commands.js';
import { createHubAdministrativeServices } from '../hub/administrative-route-services.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { WorkspaceNativeFileLocks } from '../hub/workspace-native-file-locks.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubWorkspaceCards } from './hub-workspace-cards.js';
import { registerHubWorkspaceDrawingRoutes } from './hub-workspace-drawings.js';

import { registerHubNativeDrawioRoutes } from './hub-workspace-native-drawio.js';

const quiet = new PerformanceDiagnostics(() => {});
for (const kind of ['card', 'drawing', 'native-drawio'] as const) {
  const register = kind === 'card' ? registerHubWorkspaceCards : kind === 'drawing' ? registerHubWorkspaceDrawingRoutes : registerHubNativeDrawioRoutes;
  const document = () => kind === 'card' ? { title: 'Metric', value: '42', detail: '', tone: 'blue' as const, progress: null, revision: 0, mutationId: randomUUID() }
    : { ...(kind === 'drawing' ? emptyDrawing() : emptyNativeDrawio()), revision: 0, mutationId: randomUUID() };
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-visual-http-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-visual-vault'), app = new Hono();
    const resourceId = randomUUID(), base = `/api/hub/v1/workspace/${kind === 'card' ? 'cards' : kind === 'drawing' ? 'drawings' : 'native-drawio'}`, path = base + '/' + resourceId;
    const end = async () => { await store.close(); rmSync(root, { recursive: true, force: true }); };
    return { root, store, app, resourceId, base, path, end };
  };
  for (const failure of [401, 499, 503] as const) test(`${kind} ${failure}: awaited port failure never falls back to sync list/get/save`, async () => {
    const f = setup(); let calls = 0;
    const fail = async () => { calls++; throw new HubMemberRequestError(failure); };
    const visuals = { listCards: fail, getCard: fail, saveCard: fail, listDrawings: fail, getDrawing: fail, saveDrawing: fail, listNativeDrawio: fail, getNativeDrawio: fail, saveNativeDrawio: fail };
    register(f.app, { hubStore: f.store, principal: () => ({ userId: 'default', admin: true }), visuals });
    try {
      for (const [path, init] of [[f.base, {}], [f.path, {}], [f.path, { method: 'PUT', body: JSON.stringify(document()) }]] as const) {
        const response = await f.app.request(path, init); assert.equal(response.status, failure);
        assert.equal(response.headers.get('cache-control'), 'no-store'); assert.doesNotMatch(await response.text(), /PRIVATE|sqlite|token/);
      }
      assert.equal(calls, 3); assert.equal(f.store.cards.list('default').length, 0); assert.equal(f.store.drawings.list('default').length, 0); assert.equal(f.store.nativeDrawio.list('default').length, 0);
    } finally { await f.end(); }
  });
  for (const changed of ['userId', 'admin'] as const) for (const phase of ['body', 'final'] as const)
    test(`${kind} ${changed}/${phase}: snapshot actor cannot drift across awaited boundaries`, async () => {
      const f = setup(), actor = { userId: 'default', admin: true }; let calls = 0;
      const change = () => { if (changed === 'userId') actor.userId = 'other'; else actor.admin = false; };
      const save = async () => { calls++; change(); return { status: 'saved', document: { ...document(), resourceId: f.resourceId, revision: 1, updatedAt: 1 } }; };
      register(f.app, { hubStore: f.store, principal: () => actor, visuals: { saveCard: save, saveDrawing: save, saveNativeDrawio: save } as never });
      try {
        const body = phase === 'body' ? new ReadableStream<Uint8Array>({ pull(controller) { change(); controller.enqueue(new TextEncoder().encode(JSON.stringify(document()))); controller.close(); } }, { highWaterMark: 0 }) : JSON.stringify(document());
        const response = await f.app.request(f.path, { method: 'PUT', body, ...(phase === 'body' ? { duplex: 'half' } : {}) } as RequestInit);
        assert.equal(response.status, 401); assert.equal(calls, phase === 'body' ? 0 : 1);
      } finally { await f.end(); }
    });
  test(`${kind}: oversized body refuses before any asynchronous save or native file effect`, async () => {
    const f = setup(); let calls = 0;
    const save = async () => { calls++; assert.fail('oversized body cannot reach original effect'); };
    register(f.app, { hubStore: f.store, principal: () => ({ userId: 'default', admin: true }),
      visuals: { saveCard: save, saveDrawing: save, saveNativeDrawio: save } as never });
    try {
      const response = await f.app.request(f.path, { method: 'PUT', body: ' '.repeat(2 * 1024 * 1024 + 1) });
      assert.equal(response.status, 413); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(calls, 0);
    } finally { await f.end(); }
  });
  test(`${kind}: native-file lock claimed after coordinator precheck blocks original asynchronous save`, async t => {
    const f = setup(), original = new OriginalHubAdministrativeCommands(f.store, quiet), services = createHubAdministrativeServices(original, quiet);
    const key = f.store.identities.issueKey('default'), locks = new WorkspaceNativeFileLocks((f.store as unknown as { db: DatabaseSync }).db);
    t.mock.method(f.store.cardFiles, 'current', () => { assert.equal(locks.claim('default', randomUUID(), [{ kind: kind === 'card' ? 'metric-card' : kind, id: f.resourceId }]), true); return undefined; });
    register(f.app, { hubStore: f.store, principal: () => ({ userId: 'default', admin: true }), visuals: services.visuals });
    try {
      const response = await f.app.request(f.path, { method: 'PUT', headers: { authorization: `Bearer ${key.token}` }, body: JSON.stringify(document()) });
      assert.equal(response.status, 409); assert.equal((await response.json()).error, 'file-managed');
      assert.equal(f.store.cards.list('default').length, 0); assert.equal(f.store.drawings.list('default').length, 0); assert.equal(f.store.nativeDrawio.list('default').length, 0);
    } finally { await services.close(); await original.close(); await f.end(); }
  });
  test(`${kind}: native file write/refresh precedes async projection and never calls local save`, async t => {
    const f = setup(), order: string[] = [];
    t.mock.method(f.store.cardFiles, 'current', () => ({ bindingId: 'fixture-binding' }) as never);
    const fileCards = { write: async () => { order.push('write'); return { state: 'saved' }; }, refresh: async () => { order.push('refresh'); } } as never;
    const get = async () => { order.push('projection'); return { ...document(), resourceId: f.resourceId, revision: 1, updatedAt: 1 }; };
    const save = async () => { assert.fail('native write cannot fall through to ordinary save'); };
    register(f.app, { hubStore: f.store, principal: () => ({ userId: 'default', admin: true }), fileCards,
      visuals: { getCard: get, getDrawing: get, getNativeDrawio: get, saveCard: save, saveDrawing: save, saveNativeDrawio: save } as never });
    try { assert.equal((await f.app.request(f.path, { method: 'PUT', body: JSON.stringify(document()) })).status, 200); assert.deepEqual(order, ['write', 'refresh', 'projection']); }
    finally { await f.end(); }
  });
}
