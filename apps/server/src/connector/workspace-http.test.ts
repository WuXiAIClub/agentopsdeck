import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { registerAsyncConnectorWorkspaceHttp } from './workspace-http.js';

const tick = () => new Promise<void>(yes => setImmediate(yes));
function gate() { let release!: () => void; const promise = new Promise<void>(yes => { release = yes; }); return { promise, release }; }
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-root-')), directory = join(root, 'files');
  await mkdir(directory, { mode: 0o700 });
  const tokenFile = join(root, 'tokens.json'), tokens = new ConnectorTokenStore(tokenFile);
  const token = tokens.create({ label: 'workspace', scopes: ['boards:files', 'messages:send'] });
  const boardFiles = { root: directory, policies: [{ owner: token.record.id, runtime: 'codex' as const }] };
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile, boardFiles }, new PerformanceDiagnostics(() => {}));
  await owner.open();
  const calls: string[] = [];
  const hooks: { command?: (kind: string) => Promise<void> } = {};
  const port: Pick<AsyncConnectorOwner, 'command' | 'authorityChanges'> = {
    authorityChanges: owner.authorityChanges,
    command: async (kind, input) => { calls.push(kind); await hooks.command?.(kind); return owner.command(kind, input); },
  };
  let sessionReady = true;
  const key = `codex:${randomUUID()}`, app = new Hono();
  const workspace = registerAsyncConnectorWorkspaceHttp(app, { owner: port, config: { boardFiles }, available: () => true,
    session: async sessionKey => ({ exists: sessionKey === key, ready: sessionReady }) });
  t.after(async () => { await workspace.close(); await owner.close(); await rm(root, { recursive: true, force: true }); });
  const request = (path: string, method = 'GET', body?: unknown, credential = token.token) => app.request(`/api/connector/v1/workspace/${path}`,
    { method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { owner, workspace, request, calls, hooks, key, token, directory, offline: () => { sessionReady = false; } };
}

test('workspace construction and unstarted shutdown do not reconcile or write', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.calls, []);
  for (const path of ['board-files', 'card-files', 'content-replicas']) assert.equal((await f.request(path)).status, 503);
  const closing = f.workspace.close(); assert.equal(f.workspace.close(), closing); await closing;
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.workspace.start());
  assert.ok(await f.owner.command('nodeIdentity', {}), 'borrowed owner must remain open');
});

test('one startup recovers both journals; original board/card formats and offline receipts are retained', async t => {
  const f = await fixture(t), startup = f.workspace.start();
  assert.equal(f.workspace.start(), startup); await startup;
  assert.equal(f.calls.filter(kind => kind === 'workspaceFileReconcile').length, 4);
  for (const path of ['board-files', 'card-files', 'content-replicas']) assert.equal((await f.request(path)).status, 200);
  const denied = await f.owner.command('tokenCreate', { label: 'session-only', scopes: ['sessions:read'] });
  assert.equal((await f.request('board-files', 'GET', undefined, denied.token)).status, 403);
  const id = randomUUID(), content = { kind: 'notebook', content: { title: 'Original', text: 'hot', archive: 'cold archive preserved' } };
  const installed = await f.request(`card-files/${id}`, 'PUT', { sessionKey: f.key, content });
  assert.equal(installed.status, 200);
  const bytes = await readFile(join(f.directory, id, 'card.json'), 'utf8');
  assert.match(bytes, /cold archive preserved/);
  const snapshot = (await (await f.request(`card-files/${id}/snapshot`)).json()).snapshot;
  const mutationId = randomUUID();
  const write = await f.request(`card-files/${id}/writes`, 'POST', { mutationId, expectedHash: snapshot.value.hash, content });
  assert.equal(write.status, 200);
  f.offline();
  assert.equal((await f.request(`card-files/${id}/writes/${mutationId}`)).status, 200);
  assert.equal((await f.request(`card-files/${id}/snapshot`)).status, 200);
  // Retry of the original installation is read-only even while native is offline.
  assert.equal((await f.request(`card-files/${id}`, 'PUT', { sessionKey: f.key, content })).status, 200);
  assert.equal(await readFile(join(f.directory, id, 'card.json'), 'utf8'), bytes);
  assert.equal((await f.request(`board-files/${randomUUID()}`, 'PUT', { sessionKey: f.key, content: { title: 'New', tasks: [] } })).status, 503);
  await f.owner.command('tokenRevoke', { tokenId: f.token.record.id });
  assert.equal((await f.request(`card-files/${id}/snapshot`)).status, 401);
  assert.match(await readFile(join(f.directory, id, 'card.json'), 'utf8'), /cold archive preserved/);
});

for (const path of ['content-replicas', 'card-files', 'board-files']) test(`${path}: workspace close retains authentication already accepted and blocks later effects`, async t => {
  const f = await fixture(t); await f.workspace.start();
  const entered = gate(), held = gate();
  f.hooks.command = async kind => { if (kind === 'tokenAuthenticate') { entered.release(); await held.promise; } };
  const reading = f.request(path); await entered.promise;
  let settled = false; const closing = f.workspace.close().then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  assert.equal((await f.request('card-files')).status, 503);
  held.release(); assert.equal((await reading).status, 503); await closing;
  assert.equal(f.owner.authorityChanges.waiting, 0);
  assert.ok(await f.owner.command('nodeIdentity', {}));
});

test('startup failure drains peer recovery and never publishes partial workspace readiness', async t => {
  const f = await fixture(t), entered = gate(), held = gate();
  let recovers = 0;
  f.hooks.command = async kind => {
    if (kind !== 'workspaceFileReconcile') return;
    if (++recovers === 1) throw Error('PRIVATE configuration/path');
    entered.release(); await held.promise;
  };
  const starting = f.workspace.start(); void starting.catch(() => {});
  await entered.promise;
  let settled = false; void starting.finally(() => { settled = true; }).catch(() => {});
  await tick(); assert.equal(settled, false);
  assert.equal((await f.request('card-files')).status, 503);
  held.release(); await assert.rejects(starting, error => error instanceof Error && !error.message.includes('PRIVATE'));
  assert.equal(f.workspace.state, 'closed');
  assert.equal(f.owner.authorityChanges.waiting, 0);
  assert.ok(await f.owner.command('nodeIdentity', {}));
});

test('shutdown during journal recovery waits physical recovery and prevents ready', async t => {
  const f = await fixture(t), entered = gate(), held = gate();
  f.hooks.command = async kind => { if (kind === 'workspaceFileReconcile') { entered.release(); await held.promise; } };
  const starting = f.workspace.start(); void starting.catch(() => {}); await entered.promise;
  let settled = false; const closing = f.workspace.close().then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  held.release(); await assert.rejects(starting); await closing;
  assert.equal(f.workspace.state, 'closed');
  assert.equal((await f.request('content-replicas')).status, 503);
});
