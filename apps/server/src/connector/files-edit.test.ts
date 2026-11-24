import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { registerConnectorFileRoutes, localFileBrowserScopes } from './files-http.js';
import { previewFile, saveWorkspaceText } from '../routes/files.js';
import { loadConfig } from '../config.js';

test('project dotfiles and extensionless text preview and save without relaxing security or size checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-project-text-'));
  const scope = { type: 'agent' as const, agentId: 'codex', rootLabel: 'codex' };
  try {
    for (const path of ['.gitignore', '.gitattributes', '.gitmodules', '.dockerignore', '.editorconfig', '.npmignore', '.prettierignore', 'Makefile', 'Dockerfile', 'README', 'LICENSE']) {
      await writeFile(join(root, path), '# project\n');
      const preview = await previewFile(scope, path, root);
      assert.equal(preview.kind, 'text', path);
      assert.ok(preview.revision, path);
      await saveWorkspaceText(scope, { path, text: '# changed\n', revision: preview.revision }, root, () => true);
      assert.equal(await readFile(join(root, path), 'utf8'), '# changed\n');
    }
    await writeFile(join(root, '.gitignore'), 'x'.repeat(220 * 1024 + 1));
    assert.equal((await previewFile(scope, '.gitignore', root)).kind, 'too_large');
    await writeFile(join(root, '.gitignore'), Buffer.from([0xff]));
    assert.equal((await previewFile(scope, '.gitignore', root)).revision, undefined);
    await writeFile(join(root, '.env'), 'SECRET=test');
    await assert.rejects(previewFile(scope, '.env', root), { status: 403 });
    await writeFile(join(root, 'unknown.binary'), 'hello');
    assert.equal((await previewFile(scope, 'unknown.binary', root)).kind, 'binary');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local file writes require both roots and exact explicit opt-in', () => {
  for (const flag of [undefined, '', 'false', '1', 'TRUE', 'true']) {
    const config = loadConfig({ ...(flag === undefined ? {} : { AOD_FILE_LOCAL_WRITE: flag }) });
    assert.equal(config.fileBrowserLocalWrite, flag === 'true');
    assert.deepEqual(localFileBrowserScopes(config), []);
    assert.deepEqual(localFileBrowserScopes({ ...config, fileBrowserRoots: { codex: '/project' } }),
      flag === 'true' ? ['files:read', 'files:write'] : ['files:read']);
  }
});

test('text save needs explicit write scope, verifies bytes, retains external edits and bounds input', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'agentopsdeck-edit-'));
  try {
    const root = join(temp, 'workspace'); await mkdir(root);
    const file = join(root, '你好.md'); await writeFile(file, 'first\r\n');
    const tokens = new ConnectorTokenStore(join(temp, 'tokens.json'));
    const reader = tokens.createTransient(['files:read']), writer = tokens.createTransient(['files:read', 'files:write']);
    const app = new Hono(); registerConnectorFileRoutes(app, tokens, { codex: root });
    const base = '/api/connector/v1/files/agents/codex';
    const preview = async (token = writer.token) => (await app.request(`${base}/preview?path=${encodeURIComponent('你好.md')}`, { headers: { authorization: `Bearer ${token}` } })).json();
    const save = (body: unknown, token = writer.token) => app.request(`${base}/text`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const first = await preview(); assert.equal(first.canEdit, true); assert.match(first.revision, /^[a-f0-9]{64}$/);
    assert.equal((await preview(reader.token)).canEdit, false);
    const input = { path: '你好.md', revision: first.revision, text: '改好\r\n' };
    assert.equal((await app.request(`${base}/text`, { method: 'POST', headers: { authorization: `Bearer ${writer.token}`, 'Content-Type': 'application/json' }, body: '{broken' })).status, 400);
    assert.equal((await save(input, reader.token)).status, 403);
    const accepted = await save(input); assert.equal(accepted.status, 200);
    assert.equal(await readFile(file, 'utf8'), input.text);
    assert.equal((await save(input)).status, 409, 'no stale resubmission overwrites newer content');
    const revision = (await accepted.json()).revision;
    await writeFile(file, 'external edit');
    assert.equal((await save({ ...input, revision })).status, 409);
    assert.equal(await readFile(file, 'utf8'), 'external edit');
    for (const path of ['../outside.txt', 'C:\\work\\test.txt', '/etc/passwd', 'NUL.txt', 'foo:stream', '.env']) {
      assert.ok((await save({ ...input, path })).status >= 400, path);
    }
    assert.equal((await save({ ...input, text: 'x'.repeat(220 * 1024 + 1) })).status, 400);
    assert.equal((await save({ ...input, text: 'x'.repeat(2 * 1024 * 1024) })).status, 413);
    assert.equal((await save({ ...input, text: '\ud800' })).status, 400);
    assert.equal((await save({ ...input, text: '\0' })).status, 400);
    assert.deepEqual(await readdir(root), ['你好.md']);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('edit rejects link escapes, invalid UTF8 and revocation; concurrent writes never both win', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'agentopsdeck-edit-races-'));
  try {
    const root = join(temp, 'workspace'); await mkdir(root);
    const scope = { type: 'agent' as const, agentId: 'codex', rootLabel: 'codex' };
    const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
    await writeFile(join(temp, 'outside.txt'), 'old');
    await symlink(join(temp, 'outside.txt'), join(root, 'escape.txt'));
    await link(join(temp, 'outside.txt'), join(root, 'hard.txt'));
    const input = { path: 'file.txt', text: 'new', revision: hash('old') };
    for (const path of ['escape.txt', 'hard.txt']) await assert.rejects(saveWorkspaceText(scope, { ...input, path }, root, () => true));
    const bad = Buffer.from([0xff, 0xfe]); await writeFile(join(root, 'bad.txt'), bad);
    await assert.rejects(saveWorkspaceText(scope, { ...input, path: 'bad.txt', revision: hash(bad) }, root, () => true), { status: 415 });
    await writeFile(join(root, 'file.txt'), 'old');
    await assert.rejects(saveWorkspaceText(scope, input, root, () => false), { status: 403 });
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'old');
    const results = await Promise.allSettled([saveWorkspaceText(scope, input, root, () => true), saveWorkspaceText(scope, { ...input, text: 'other' }, root, () => true)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await readdir(root)).filter(name => name.startsWith('.agentopsdeck-edit-')).length, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
