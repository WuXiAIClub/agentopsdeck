import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { workerConnectorMachineAuthority } from './machine-authority.js';
import { registerConnectorBoardBindings } from './board-bindings-http.js';
import { ConnectorBoardBindings } from './board-bindings.js';
import { loadWorkerBoardTools } from '../tools/workspace-board-worker.js';

const tick = () => new Promise<void>(yes => setImmediate(yes));
function gate() { let release!: () => void; const promise = new Promise<void>(yes => { release = yes; }); return { promise, release }; }
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'async-binding-http-')), directory = join(root, 'private');
  await mkdir(directory, { mode: 0o700 });
  const tokenFile = join(root, 'tokens.json'), tokens = new ConnectorTokenStore(tokenFile);
  const token = tokens.create({ label: 'binding', scopes: ['boards:bind'] });
  const endpoint = 'http://127.0.0.1:8791/api/workspace-agent/v1/board', sessionId = randomUUID();
  const policies = [{ owner: token.record.id, runtime: 'ghcp' as const, endpoint }];
  const files = new ConnectorBoardBindings({ ghcp: directory }, policies, () => true);
  const grant = { id: randomUUID(), credential: { endpoint, token: 'aod_board_' + 'a'.repeat(43), expiresAt: Date.now() + 60_000 } };
  await files.install(token.record.id, { ...grant, runtime: 'ghcp', sessionId });
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile }, new PerformanceDiagnostics(() => {}));
  await owner.open();
  const calls: string[] = [], hooks: { command?: (kind: string) => Promise<void>; session?: () => Promise<void> } = {};
  const authority = workerConnectorMachineAuthority({ authorityChanges: owner.authorityChanges,
    command: async (kind, input) => { calls.push(kind); await hooks.command?.(kind); return owner.command(kind, input); } });
  const app = new Hono();
  const service = registerConnectorBoardBindings(app, { tokens: authority, directories: { ghcp: directory }, policies,
    deferredStart: true, resolveSession: async key => {
      await hooks.session?.(); return key === 'ghcp:public-key' ? { runtime: 'ghcp', sessionId, ready: true } : undefined;
    } });
  t.after(async () => { delete hooks.command; delete hooks.session;
    await service.close(); await owner.close(); await rm(root, { recursive: true, force: true }); });
  const request = (method = 'GET', body?: unknown, credential = token.token) => app.request('/api/connector/v1/sessions/ghcp%3Apublic-key/board-binding',
    { method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { owner, service, request, directory, sessionId, calls, hooks, token, grant };
}

test('deferred private bindings: construction and unstarted close preserve original files without SQL or watchers', async t => {
  const f = await fixture(t), before = await readdir(f.directory);
  assert.equal((await f.request()).status, 503); assert.deepEqual(f.calls, []);
  const closing = f.service.close(); assert.equal(f.service.close(), closing); await closing;
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(f.directory), before);
  await assert.rejects(f.service.start()); assert.equal(f.owner.authorityChanges.waiting, 0);
  assert.ok(await f.owner.command('nodeIdentity', {}));
});

test('private binding uses sole worker scope and original native ID; final revocation cleanup drains before owner release', async t => {
  const f = await fixture(t), starting = f.service.start(); assert.equal(f.service.start(), starting); await starting;
  const response = await f.request(); assert.equal(response.status, 200);
  const view = await response.json(); assert.equal(view.sessionId, f.sessionId); assert.equal(view.binding.id, f.grant.id);
  assert.ok(await loadWorkerBoardTools(f.directory, 'ghcp', f.sessionId, () => true));
  const low = await f.owner.command('tokenCreate', { label: 'session-only', scopes: ['sessions:read'] });
  assert.equal((await f.request('GET', undefined, low.token)).status, 403);
  await f.owner.command('tokenRevoke', { tokenId: f.token.record.id });
  await f.service.close();
  assert.equal(await loadWorkerBoardTools(f.directory, 'ghcp', f.sessionId, () => true), undefined);
  assert.equal(f.owner.authorityChanges.waiting, 0); assert.ok(await f.owner.command('nodeIdentity', {}));
});

test('private binding startup failure is redacted, never ready and does not bypass cleanup', async t => {
  const f = await fixture(t);
  f.hooks.command = async kind => { if (kind === 'tokenHasScope') throw Error('PRIVATE recovery error'); };
  await assert.rejects(f.service.start(), error => error instanceof Error && !error.message.includes('PRIVATE'));
  assert.equal((await f.request()).status, 503);
  delete f.hooks.command; await f.service.close(); assert.equal(f.owner.authorityChanges.waiting, 0);
});

for (const stage of ['recovery', 'authenticate', 'session'] as const) test(`private binding close retains physical ${stage} and prevents late admission`, async t => {
  const f = await fixture(t), entered = gate(), held = gate();
  const hold = async () => { entered.release(); await held.promise; };
  if (stage === 'recovery') f.hooks.command = async kind => { if (kind === 'tokenHasScope') await hold(); };
  const startup = f.service.start();
  const rejected = stage === 'recovery' ? assert.rejects(startup) : undefined;
  let request: Promise<Response> | undefined;
  if (stage !== 'recovery') {
    await startup;
    if (stage === 'authenticate') f.hooks.command = async kind => { if (kind === 'tokenAuthenticate') await hold(); };
    else f.hooks.session = hold;
    request = Promise.resolve(f.request('PUT', { ...f.grant, id: randomUUID() }));
  }
  await entered.promise;
  let closed = false; const closing = f.service.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.equal((await f.request()).status, 503);
  held.release(); await rejected; if (request) assert.equal((await request).status, 503);
  await closing;
  assert.equal(f.owner.authorityChanges.waiting, 0);
  assert.ok(await loadWorkerBoardTools(f.directory, 'ghcp', f.sessionId, () => true), 'original grant must not be replaced by late PUT');
  assert.ok(await f.owner.command('nodeIdentity', {}));
});
