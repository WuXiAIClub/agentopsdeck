import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { saveWorkspaceText } from '../routes/files.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { workerConnectorFileAuthority, registerFileRequestOwnership, type ConnectorFileAuthority } from './file-authority.js';
import { registerConnectorFileRoutes } from './files-http.js';
import { GitTreeReader } from './git-tree-reader.js';
import { GitSnapshot } from './git-snapshot.js';

const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
const scope = { type: 'agent' as const, agentId: 'codex', rootLabel: 'codex' };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

test('original file HTTP reads, CAS edits and Git previews run with the sole real worker token owner', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'worker-file-http-'));
  const root = join(temp, 'workspace'); await mkdir(root); await writeFile(join(root, 'readme.txt'), 'old');
  const owner = new AsyncConnectorOwner({ file: join(temp, 'connector.sqlite'), tokenFile: join(temp, 'tokens.json') }, quiet);
  const app = new Hono(), authority = workerConnectorFileAuthority(owner);
  const routes = registerConnectorFileRoutes(app, authority, { codex: root });
  try {
    await owner.open();
    const reader = await owner.command('tokenCreate', { label: 'reader', scopes: ['files:read'] });
    const writer = await owner.command('tokenCreate', { label: 'writer', scopes: ['files:read', 'files:write'] });
    const request = (path: string, token = reader.token, input?: unknown) => app.request(`/api/connector/v1/files${path}`, {
      headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}),
    });
    assert.equal((await request('/roots', '')).status, 401);
    assert.equal((await (await request('/roots')).json()).roots[0].readOnly, true);
    const preview = await (await request('/agents/codex/preview?path=readme.txt', writer.token)).json();
    assert.equal(preview.canEdit, true); assert.equal(preview.text, 'old');
    const input = { path: 'readme.txt', text: 'new', revision: preview.revision };
    assert.equal((await request('/agents/codex/text', reader.token, input)).status, 403);
    assert.equal((await request('/agents/codex/text', writer.token, input)).status, 200);
    assert.equal(await readFile(join(root, 'readme.txt'), 'utf8'), 'new');
    assert.equal((await request('/agents/codex/text', writer.token, input)).status, 409);
    if (process.platform === 'linux') {
      const page = await (await request('/git/codex/tree')).json();
      const token = page.entries.find((entry: { name: string }) => entry.name === 'readme.txt').pathToken;
      const result = await (await request(`/git/codex/preview?pathToken=${token}`)).json();
      assert.equal(result.text, 'new'); assert.ok(!JSON.stringify(result).includes(root));
    }
    // Same Request object must retain its original evidence across awaits.
    const original = new Request('http://local/', { headers: { authorization: `Bearer ${reader.token}` } });
    assert.equal((await authority.authenticate(original))?.tokenId, reader.record.id);
    original.headers.set('authorization', `Bearer ${writer.token}`);
    await owner.command('tokenRevoke', { tokenId: reader.record.id });
    assert.equal(await authority.requireScope(original, 'files:read'), undefined);
    assert.equal(await authority.hasScope(reader.record.id, 'files:read'), false);
    assert.equal((await request('/agents/codex/download?path=readme.txt')).status, 401);
    assert.equal((await readdir(root)).filter(name => name.startsWith('.agentopsdeck-edit-')).length, 0);
    assert.doesNotMatch(JSON.stringify(quiet.snapshot()), /Bearer|readme\.txt|workspace/);
  } finally { await routes.close(); await owner.close(); await rm(temp, { recursive: true, force: true }); }
});

for (const outcome of ['deny', 'replace', 'local-close', 'reject'] as const) test(`save retains CAS and temp cleanup across awaited final authority: ${outcome}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'await-file-cas-')), entered = gate(), held = gate();
  let stopped = false;
  await writeFile(join(root, 'file.txt'), 'old');
  const work = saveWorkspaceText(scope, { path: 'file.txt', text: 'new', revision: hash('old') }, root,
    async () => { entered.release(); await held.promise; if (outcome === 'reject') throw Error('unavailable'); return outcome !== 'deny'; },
    () => { if (stopped) throw Object.assign(Error('closed'), { status: 503 }); });
  const observed = work.then(() => undefined, error => error);
  try {
    await entered.promise;
    assert.equal((await readdir(root)).filter(name => name.startsWith('.agentopsdeck-edit-')).length, 1);
    if (outcome === 'replace') await writeFile(join(root, 'file.txt'), 'external edit');
    if (outcome === 'local-close') stopped = true;
    held.release();
    const error = await observed;
    assert.ok(error instanceof Error);
    if (outcome !== 'reject') {
      assert.ok('status' in error);
      assert.equal(error.status, outcome === 'deny' ? 403 : outcome === 'replace' ? 409 : 503);
    }
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), outcome === 'replace' ? 'external edit' : 'old');
    assert.equal((await readdir(root)).filter(name => name.startsWith('.agentopsdeck-edit-')).length, 0);
  } finally { held.release(); await observed; await rm(root, { recursive: true, force: true }); }
});

for (const mode of ['close', 'abort'] as const) test(`file route ${mode} retains physical work, rejects late delivery and cleans download headers`, async () => {
  const app = new Hono(), entered = gate(), held = gate(), controller = new AbortController();
  const routes = registerFileRequestOwnership(app, '/files', quiet);
  app.get('/files/download', async c => {
    entered.release(); await held.promise;
    c.header('Content-Disposition', 'attachment; filename=private.txt'); c.header('Content-Length', '7');
    return c.text('PRIVATE');
  });
  const work = app.request('/files/download', { signal: controller.signal });
  let closed = false;
  let drain: Promise<void> | undefined;
  try {
    await entered.promise;
    if (mode === 'abort') controller.abort();
    drain = routes.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    assert.equal((await app.request('/files/download')).status, 503);
    held.release(); const result = await work; await drain;
    assert.equal(closed, true); assert.equal(result.status, 503);
    assert.equal(result.headers.get('content-length'), null); assert.equal(result.headers.get('content-disposition'), null);
    assert.ok(!(await result.text()).includes('PRIVATE'));
  } finally { held.release(); await work; await routes.close(); }
});

test('closing original HTTP during final async write authority drains temporary cleanup and never renames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'close-file-edit-')), entered = gate(), held = gate();
  const actor = { tokenId: 'one', label: 'one', scopes: ['files:read', 'files:write'] as ('files:read' | 'files:write')[] };
  let writes = 0;
  const authority: ConnectorFileAuthority = {
    authenticate: async () => actor,
    async requireScope(_request, scope) {
      if (scope === 'files:write' && ++writes === 2) { entered.release(); await held.promise; }
      return actor;
    }, hasScope: async () => true,
  };
  const app = new Hono(), routes = registerConnectorFileRoutes(app, authority, { codex: root });
  await writeFile(join(root, 'file.txt'), 'old');
  const work = app.request('/api/connector/v1/files/agents/codex/text', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'file.txt', text: 'new', revision: hash('old') }) });
  try {
    await entered.promise; let closed = false;
    const drain = routes.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    held.release(); assert.equal((await work).status, 503); await drain;
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'old');
    assert.equal((await readdir(root)).filter(name => name.startsWith('.agentopsdeck-edit-')).length, 0);
  } finally { held.release(); await work; await routes.close(); await rm(root, { recursive: true, force: true }); }
});

test('Git registration and list await denied authority instead of treating a Promise as permission', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'await-git-authority-'));
  let epoch: string | undefined = 'one';
  const reader = new GitTreeReader(async () => epoch);
  try {
    await reader.register('owner', 'repo', 'one', root);
    await writeFile(join(root, 'file.txt'), 'private');
    const page = await reader.list('owner', 'repo');
    epoch = undefined;
    await assert.rejects(reader.list('owner', 'repo'), /forbidden/);
    await assert.rejects(reader.preview('owner', 'repo', page.entries[0]!.pathToken), /forbidden/);
    await reader.pruneRevoked(); epoch = 'one';
    await assert.rejects(reader.list('owner', 'repo'), /forbidden/);
    epoch = undefined; await assert.rejects(reader.register('owner', 'repo', 'one', root), /forbidden/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('GitSnapshot separates synchronous local guard from asynchronous current authority', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-await-guard-')), entered = gate(), held = gate();
  const handle = await open(root, 'r'); let calls = 0;
  const work = GitSnapshot.read(handle, () => true, async () => { calls++; entered.release(); await held.promise; return false; });
  try {
    await entered.promise; let complete = false; void work.then(() => { complete = true; });
    await tick(); assert.equal(complete, false);
    held.release(); const snapshot = await work;
    assert.equal(snapshot.supported, false); assert.equal(await snapshot.valid(), false);
    assert.equal(calls, 2); await snapshot.close();
  } finally { held.release(); await work; await handle.close(); await rm(root, { recursive: true, force: true }); }
});
