import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from '../hub/original-administrative-commands.js';
import { createHubAdministrativeServices } from '../hub/administrative-route-services.js';
import type { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { notebookHash } from '../hub/notebook-operations.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubSessionNotebookRoutes } from './hub-session-notebooks.js';

const resourceId = JSON.stringify(['hub-notebook', 1]), base = '/api/hub/v1/notebooks/default';
const move = () => ({ requestId: randomUUID(), hotRevision: 1, coldRevision: 0, direction: 'archive',
  ranges: [{ start: 0, end: 5, sha256: notebookHash('hello') }] });
for (const action of ['move', 'receipt', 'capabilities', 'issue', 'revoke'] as const)
  for (const change of ['failure', 'user', 'admin'] as const) {
    test(`private control HTTP ${action}/${change}: no sync fallback, authority rechecked and errors redacted`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'notebook-control-http-'));
      const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-control-http');
      const original = new OriginalHubAdministrativeCommands(store, new PerformanceDiagnostics(() => {}));
      const token = store.identities.issueKey('default').token;
      store.notebooks.save('default', { resourceId, revision: 0, text: 'hello world' });
      const actor = { userId: 'default', admin: true };
      let effects = 0;
      const owner = { command: async (kind: string, input: unknown) => {
        const value = await original.command(kind as never, input as never);
        if (kind === 'notebookControl') {
          effects++;
          if (change === 'failure') throw Error('PRIVATE ACK lost');
          if (change === 'user') actor.userId = 'other'; else actor.admin = false;
        }
        return value;
      } } as Pick<AsyncHubMemberOwner, 'command'>;
      const services = createHubAdministrativeServices(owner), app = new Hono();
      registerHubSessionNotebookRoutes(app, { hubStore: store, principal: () => actor, notebookControl: services.notebookControl });
      const body = move(), requestId = body.requestId;
      let localMoves = 0, localIssue = 0, localRevoke = 0;
      const oldMove = store.notebooks.move.bind(store.notebooks), oldIssue = store.notebookCapabilities.issue.bind(store.notebookCapabilities),
        oldRevoke = store.notebookCapabilities.revoke.bind(store.notebookCapabilities);
      t.mock.method(store.notebooks, 'move', (...args: Parameters<typeof oldMove>) => { localMoves++; return oldMove(...args); });
      t.mock.method(store.notebookCapabilities, 'issue', (...args: Parameters<typeof oldIssue>) => { localIssue++; return oldIssue(...args); });
      t.mock.method(store.notebookCapabilities, 'revoke', (...args: Parameters<typeof oldRevoke>) => { localRevoke++; return oldRevoke(...args); });
      try {
        const path = base + (action === 'move' ? '/moves' : action === 'receipt' ? '/moves/' + requestId
          : '/capabilities' + (action === 'revoke' ? '/' + randomUUID() : ''));
        const response = await app.request(path, { method: action === 'move' || action === 'issue' ? 'POST' : action === 'revoke' ? 'DELETE' : 'GET',
          headers: { authorization: `Bearer ${token}` }, ...(action === 'move' || action === 'issue'
            ? { body: JSON.stringify(action === 'move' ? body : { facets: ['hot:read'], expiresAt: Date.now() + 600_000 }) } : {}) });
        assert.equal(response.status, change === 'failure' ? 503 : 401); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.doesNotMatch(await response.text(), /PRIVATE|ACK lost|aod_note_/); assert.equal(effects, 1);
        assert.equal(localMoves, action === 'move' ? 1 : 0);
        assert.equal(localIssue, action === 'issue' ? 1 : 0); assert.equal(localRevoke, action === 'revoke' ? 1 : 0);
      } finally { await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }

test('private control invalid receipt/revoke IDs retain legacy 404 and never dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-control-http-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-control-http');
  const fail = async () => { throw Error('must not dispatch'); }, app = new Hono();
  registerHubSessionNotebookRoutes(app, { hubStore: store, principal: () => ({ userId: 'default', admin: true }),
    notebookControl: { move: fail, receipt: fail, capabilities: fail, issue: fail, revoke: fail } });
  try {
    assert.deepEqual(await (await app.request(base + '/moves/not-a-uuid')).json(), { error: 'Receipt not found' });
    assert.equal((await app.request(base + '/moves/not-a-uuid')).status, 404);
    assert.equal((await app.request(base + '/capabilities/not-a-uuid', { method: 'DELETE' })).status, 404);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('private duplicate move receipt still dispatches through port instead of synchronous shortcut', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-control-http-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-control-http');
  store.notebooks.save('default', { resourceId, revision: 0, text: 'hello world' });
  const body = move(); store.notebooks.move('default', resourceId, body as Parameters<typeof store.notebooks.move>[2]);
  let calls = 0;
  const fail = async () => { calls++; throw new HubMemberRequestError(503); }, app = new Hono();
  registerHubSessionNotebookRoutes(app, { hubStore: store, principal: () => ({ userId: 'default', admin: true }),
    notebookControl: { move: fail, receipt: fail, capabilities: fail, issue: fail, revoke: fail } });
  try {
    const response = await app.request(base + '/moves', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 503); assert.equal(calls, 1);
    assert.equal(store.notebooks.get('default', resourceId).revision, 2);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});
