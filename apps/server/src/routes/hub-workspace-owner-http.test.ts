import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubStore } from '../hub/hub-store.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { AsyncHubWorkspacePreferences } from '../hub/async-workspace-preferences.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubWorkspacePreferences, type HubWorkspacePreferencesPort } from './hub-workspace-preferences.js';
import type { HubPrincipal } from '../hub/identity.js';

const quiet = new PerformanceDiagnostics(() => {}), path = '/api/hub/v1/workspace/preferences';
const input = () => ({ revision: 0, groups: [{ id: 'old', name: 'Existing group' }],
  sessions: { 'node:old-session': { groupId: 'old', tags: ['原会话'], order: 12, color: '#112233' } } });
function appFor(port: HubWorkspacePreferencesPort, principal: (request: Request) => HubPrincipal | Promise<HubPrincipal>) {
  const app = new Hono(); registerHubWorkspacePreferences(app, { port, principal: c => principal(c.req.raw) }); return app;
}
const call = (app: Hono, token: string, value?: unknown) => app.request(path, { headers: {
  cookie: 'agentopsdeck_session=' + token, 'content-type': 'application/json',
}, ...(value === undefined ? {} : { method: 'PUT', body: JSON.stringify(value) }) });
const response = async (r: Response) => ({ status: r.status, body: await r.json(), cache: r.headers.get('cache-control') });

test('workspace async HTTP preserves original frontend JSON, no-store, 400, 409 and saved member cookie', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-workspace-http-r44-')), file = join(root, 'hub.sqlite');
  const original = new HubStore(file, 'workspace-http-fixture'); let owner: AsyncHubMemberOwner | undefined;
  try {
    const member = original.createUser('Existing member'), key = original.identities.issueKey(member.id);
    const token = original.identities.createSession(key.token)!;
    const old = appFor({ get: (_r, id) => original.workspace.get(id), save: (_r, id, value) => original.workspace.save(id, value) }, request => {
      const actor = original.identities.requestPrincipal(request, () => false); if (!actor) throw new HTTPException(401); return actor;
    });
    const expected = [await response(await call(old, token)), await response(await call(old, token, { ...input(), userId: 'foreign' }))];
    // Seed once with the original store; subsequent HTTP comparison reads and
    // conflicts cannot accidentally mutate the baseline before owner takeover.
    const saved = original.workspace.save(member.id, input())!;
    expected.push(await response(await call(old, token)), await response(await call(old, token, input())));
    await original.close(); owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'workspace-http-fixture' }, quiet); await owner.open();
    const service = new AsyncHubWorkspacePreferences(owner, quiet), app = appFor(service, service.principal);
    // Empty default uses another pre-existing member rather than resetting data.
    assert.equal(expected[0]!.status, 200); assert.deepEqual(expected[0]!.body, { revision: 0, groups: [], sessions: {} });
    assert.deepEqual(await response(await call(app, token, { ...input(), userId: 'foreign' })), expected[1]);
    assert.deepEqual(await response(await call(app, token)), expected[2]);
    assert.deepEqual(await response(await call(app, token, input())), expected[3]);
    const updated = await call(app, token, { ...saved, ungroupedCollapsed: true });
    assert.deepEqual(await response(updated), { status: 200, body: { ...saved, ungroupedCollapsed: true, revision: 2 }, cache: 'no-store' });
    assert.equal(updated.headers.get('set-cookie'), null, 'read/save cannot recreate or replace an existing cookie');
    assert.equal((await call(app, 'hub_session_' + 'z'.repeat(43))).status, 401);
    assert.equal(service.pending, 0); assert.equal(owner.snapshot().unavailable, false);
  } finally { await owner?.close(); await original.close(); rmSync(root, { recursive: true, force: true }); }
});

test('workspace async body-read revocation denies CAS without original-message resend or extra writer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-workspace-revoke-r44-')), file = join(root, 'hub.sqlite');
  const original = new HubStore(file, 'workspace-http-fixture'); let owner: AsyncHubMemberOwner | undefined;
  try {
    const member = original.createUser('Existing member'), key = original.identities.issueKey(member.id), token = original.identities.createSession(key.token)!;
    await original.close(); owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'workspace-http-fixture' }, quiet); await owner.open();
    const service = new AsyncHubWorkspacePreferences(owner, quiet), app = appFor(service, service.principal);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const pending = app.fetch(new Request('http://localhost' + path, { method: 'PUT', headers: {
      cookie: 'agentopsdeck_session=' + token, 'content-type': 'application/json',
    }, body, duplex: 'half' } as RequestInit));
    await owner.command('memberSessionDelete', { token });
    controller.enqueue(new TextEncoder().encode(JSON.stringify(input()))); controller.close();
    assert.equal((await pending).status, 401);
    await owner.close(); owner = undefined;
    const reopened = new HubStore(file, 'workspace-http-fixture');
    try { assert.equal(reopened.workspace.get(member.id).revision, 0); }
    finally { await reopened.close(); }
  } finally { await owner?.close(); await original.close(); rmSync(root, { recursive: true, force: true }); }
});

test('workspace cancellation and unavailable boundaries retain JSON classification, never framework 500', async () => {
  for (const code of [400, 401, 403, 404, 409, 499, 503] as const) for (const asynchronous of [false, true]) {
    let reads = 0, writes = 0;
    const refuse = () => { reads++; throw new HubMemberRequestError(code); };
    const app = appFor({ get: asynchronous ? async () => refuse() : refuse,
      save: () => { writes++; return undefined; } }, () => ({ userId: 'member', admin: false }));
    const r = await call(app, 'fixture'); assert.equal(r.status, code); assert.equal(r.headers.get('cache-control'), 'no-store');
    if (code === 499) assert.deepEqual(await r.json(), { error: 'request_cancelled' });
    else assert.doesNotMatch(await r.text(), /hub_member_request_unavailable|stack|fixture/);
    assert.equal(reads, 1); assert.equal(writes, 0);
  }
});
