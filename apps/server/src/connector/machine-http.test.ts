import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { registerConnectorMachineHttp } from './machine-http.js';
import { workerConnectorMachineAuthority } from './machine-authority.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const config = { fileBrowserRoots: {}, issueSources: [], websiteServices: [], terminalTargets: [] };
function gate() { let release!: () => void; const promise = new Promise<void>(yes => { release = yes; }); return { promise, release }; }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'machine-http-'));
  const owner = new AsyncConnectorOwner({ file: join(root, 'users.sqlite'), tokenFile: join(root, 'tokens.json'),
    bootstrapToken: 'machine-http-fixture', codexBoardTools: false }, new PerformanceDiagnostics(() => {}));
  await owner.open();
  return { owner, authority: workerConnectorMachineAuthority(owner),
    async close() { await owner.close(); await rm(root, { recursive: true, force: true }); } };
}

test('all original opt-in machine routes share current worker scopes and freeze together', async () => {
  const f = await fixture(), app = new Hono();
  // Exercise opt-in authority with an explicitly configured catalog. An empty
  // website list deliberately returns 409 before evaluating websites:read.
  const routes = registerConnectorMachineHttp(app, f.authority, { ...config,
    websiteServices: [{ id: 'local', label: 'Local fixture', url: 'http://127.0.0.1:39117/' }] });
  const request = (path: string, token = 'machine-http-fixture', method = 'GET') => app.request(`/api/connector/v1${path}`,
    { method, headers: { authorization: `Bearer ${token}` } });
  try {
    await routes.ready;
    assert.equal((await request('/files/roots')).status, 409);
    const reader = await f.owner.command('tokenCreate', { label: 'session reader', scopes: ['sessions:read'] });
    const machine = await f.owner.command('tokenCreate', { label: 'explicit machine reader',
      scopes: ['issues:read', 'websites:read', 'terminals:use'] });
    for (const path of ['/issues/sources', '/websites/catalog', '/terminals/targets']) {
      assert.equal((await request(path, reader.token)).status, 403, path);
      assert.equal((await request(path)).status, 403, 'bootstrap must not acquire opt-in machine authority');
      assert.equal((await request(path, machine.token)).status, 200, path);
    }
    const closing = routes.close(); assert.equal(routes.close(), closing); await closing;
    for (const [path, method] of [['/files/roots', 'GET'], ['/issues/sources', 'GET'], ['/websites/catalog', 'GET'],
      ['/website-access', 'POST'], ['/website-actions', 'POST'], ['/terminals/targets', 'GET']]) {
      assert.equal((await request(path!, 'machine-http-fixture', method)).status, 503, path);
    }
    assert.ok(await f.owner.command('nodeIdentity', {}));
    assert.equal(f.owner.authorityChanges.waiting, 0);
  } finally { await routes.close(); await f.close(); }
});

test('close retains the accepted original machine handler across awaited authority', async () => {
  const f = await fixture(), app = new Hono(), entered = gate(), held = gate();
  const routes = registerConnectorMachineHttp(app, { ...f.authority, authenticate: async request => {
    const principal = await f.authority.authenticate(request); entered.release(); await held.promise; return principal;
  } }, config);
  const reading = app.request('/api/connector/v1/files/roots', { headers: { authorization: 'Bearer machine-http-fixture' } });
  try {
    await entered.promise;
    let settled = false; const closing = routes.close().then(() => { settled = true; });
    await new Promise<void>(yes => setImmediate(yes)); assert.equal(settled, false);
    held.release(); assert.equal((await reading).status, 503); await closing;
    assert.ok(await f.owner.command('nodeIdentity', {}));
  } finally { held.release(); await routes.close(); await f.close(); }
});

test('partial machine construction rejects readiness after retaining all constructed services', async () => {
  const f = await fixture(), app = new Hono();
  const broken = { ...config, get websiteServices(): never { throw Error('PRIVATE configuration'); } };
  const routes = registerConnectorMachineHttp(app, f.authority, broken);
  try {
    await assert.rejects(routes.ready, error => error instanceof Error && !error.message.includes('PRIVATE'));
    await routes.close();
    assert.equal((await app.request('/api/connector/v1/files/roots')).status, 503);
    assert.ok(await f.owner.command('nodeIdentity', {}));
  } finally { await routes.close(); await f.close(); }
});
