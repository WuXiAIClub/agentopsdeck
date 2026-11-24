import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { parseFileBrowserRoots } from '../config.js';
import { registerConnectorFileRoutes } from './files-http.js';

test('workspace roots are explicit, bounded and portable on the host', () => {
  assert.deepEqual(parseFileBrowserRoots(undefined), {});
  assert.deepEqual(parseFileBrowserRoots(JSON.stringify({ codex: join(tmpdir(), 'project') })), { codex: join(tmpdir(), 'project') });
  for (const value of ['[]', 'null', '{"__proto__":"/work"}', '{"codex":"/"}', '{"codex":"relative"}', JSON.stringify({ codex: homedir() })]) assert.throws(() => parseFileBrowserRoots(value));
});

test('unconfigured workspace is distinguished from missing scope without exposing files', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'connector-files-disabled-'));
  try {
    const tokens = new ConnectorTokenStore(join(temp, 'tokens.json'));
    const reader = tokens.createTransient(['sessions:read']);
    const app = new Hono(); registerConnectorFileRoutes(app, tokens);
    const url = '/api/connector/v1/files/agents/codex';
    assert.equal((await app.request(url)).status, 401);
    const response = await app.request(url, { headers: { authorization: `Bearer ${reader.token}` } });
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'Workspace browsing is not configured on this Connector.' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('Connector workspace reads require separate scope, hide sensitive paths and never use local fallback', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'connector-files-'));
  try {
    const root = join(temp, 'project'); await mkdir(root);
    await writeFile(join(root, '你好.md'), '# Heading\n\n**bold**');
    await writeFile(join(root, '.env'), 'never expose');
    await writeFile(join(temp, 'outside.txt'), 'outside');
    await symlink(join(temp, 'outside.txt'), join(root, 'escape.txt'));
    await symlink(join(root, '.env'), join(root, 'alias.txt'));
    await link(join(temp, 'outside.txt'), join(root, 'hard.txt'));
    const tokens = new ConnectorTokenStore(join(temp, 'tokens.json'));
    const reader = tokens.createTransient(['files:read']);
    const sessionReader = tokens.createTransient(['sessions:read', 'agents:read', 'media:read']);
    const app = new Hono(); registerConnectorFileRoutes(app, tokens, { codex: root });
    const request = (suffix: string, token = reader.token) => app.request(`/api/connector/v1/files/agents/codex${suffix}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await request('', sessionReader.token)).status, 403);
    const listing = await request(''); assert.equal(listing.status, 200);
    const body = await listing.json(); assert.deepEqual(body.entries.map((entry: any) => entry.name), ['你好.md']);
    assert.equal(body.entries[0].canRename, false); assert.equal(body.entries[0].canUpload, false);
    const preview = await request(`/preview?path=${encodeURIComponent('你好.md')}`);
    assert.equal((await preview.json()).text, '# Heading\n\n**bold**');
    for (const source of ['你好.md', join(root, '你好.md')]) {
      const directory = await request(`?sourcePath=${encodeURIComponent(source)}`);
      assert.equal(directory.status, 200); const mapped = await directory.json();
      assert.equal(mapped.path, ''); assert.equal(mapped.root, 'codex');
      assert.ok(!JSON.stringify(mapped).includes(root), 'no absolute root exposed');
    }
    for (const source of ['.env', '../outside.txt', join(temp, 'outside.txt'), 'escape.txt', 'alias.txt', 'hard.txt', 'C:\\Windows\\file'])
      assert.notEqual((await request(`?sourcePath=${encodeURIComponent(source)}`)).status, 200, source);
    assert.equal((await request(`?sourcePath=${encodeURIComponent(join(root, '你好.md'))}`, sessionReader.token)).status, 403);
    const file = await request(`/download?path=${encodeURIComponent('你好.md')}`);
    assert.equal(await file.text(), '# Heading\n\n**bold**'); assert.match(file.headers.get('content-disposition')!, /^attachment/);
    for (const name of ['.env', '../outside.txt', 'escape.txt', 'alias.txt', 'hard.txt', 'C:\\Windows\\file']) assert.notEqual((await request(`/preview?path=${encodeURIComponent(name)}`)).status, 200, name);
    assert.equal((await app.request('/api/connector/v1/files/agents/hermes', { headers: { authorization: `Bearer ${reader.token}` } })).status, 404);
    reader.dispose(); assert.equal((await request('')).status, 401);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('revocation during an admitted file read discards content and download metadata', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'connector-files-revoke-'));
  try {
    const root = join(temp, 'project'); await mkdir(root);
    await writeFile(join(root, 'report.txt'), 'private admitted content');
    const tokens = new ConnectorTokenStore(join(temp, 'tokens.json'));
    const app = new Hono(); registerConnectorFileRoutes(app, tokens, { codex: root });
    for (const suffix of ['', '?sourcePath=report.txt', '/preview?path=report.txt', '/download?path=report.txt']) {
      const reader = tokens.createTransient(['files:read']);
      // Hono enters the scope guard synchronously, then awaits real file IO.
      const pending = app.request(`/api/connector/v1/files/agents/codex${suffix}`, { headers: { authorization: `Bearer ${reader.token}` } });
      reader.dispose();
      const response = await pending;
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'File access was revoked' });
      assert.equal(response.headers.get('content-disposition'), null);
      assert.equal(response.headers.get('content-length'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
