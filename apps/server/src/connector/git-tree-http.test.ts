import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { registerConnectorFileRoutes } from './files-http.js';

async function fixture(run: (app: Hono, tokens: ConnectorTokenStore, root: string) => Promise<void>) {
  const temp = await mkdtemp(join(tmpdir(), 'git-tree-http-'));
  try {
    const root = join(temp, 'root'); await mkdir(root); await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'example.ts'), 'PRIVATE_FILE_CONTENT');
    await symlink(temp, join(root, 'outside'));
    const tokens = new ConnectorTokenStore(join(temp, 'tokens.json'));
    const app = new Hono(); registerConnectorFileRoutes(app, tokens, { project: root });
    await run(app, tokens, root);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
const get = (app: Hono, token: string, suffix = '/project/tree') => app.request(`/api/connector/v1/files/git${suffix}`, { headers: { authorization: `Bearer ${token}` } });

test('git routes require independent file authority and never disclose registered paths or bodies', async () => fixture(async (app, tokens, root) => {
  const reader = tokens.createTransient(['files:read']), session = tokens.createTransient(['sessions:read']);
  assert.equal((await get(app, '')).status, 401); assert.equal((await get(app, session.token)).status, 403);
  const roots = await get(app, reader.token, '/roots'); assert.equal(roots.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await roots.json(), { roots: [{ repositoryRef: 'project', label: 'root' }], readOnly: true });
  const response = await get(app, reader.token); assert.equal(response.status, 200); const page = await response.json();
  const nested = await get(app, reader.token, `/project/tree?pathToken=${page.entries.find((e: any) => e.name === 'src').pathToken}`);
  const text = await nested.text(); assert.match(text, /example.ts/); assert.ok(!text.includes(root)); assert.ok(!text.includes('PRIVATE_FILE_CONTENT'));
  const link = page.entries.find((e: any) => e.name === 'outside'); assert.equal(link.kind, 'symlink');
  assert.equal((await get(app, reader.token, `/project/tree?pathToken=${link.pathToken}`)).status, 409);
}));
test('cross-token path, cursor, malformed queries and replaced roots fail closed', async () => fixture(async (app, tokens, root) => {
  const a = tokens.createTransient(['files:read']), b = tokens.createTransient(['files:read']);
  await Promise.all(Array.from({ length: 201 }, (_, i) => writeFile(join(root, `f${i}`), '')));
  const page = await (await get(app, a.token)).json(); assert.equal(page.entries.length, 200); assert.ok(page.nextCursor);
  assert.equal((await get(app, b.token, `/project/tree?cursor=${page.nextCursor}`)).status, 409);
  const page2 = await (await get(app, a.token, `/project/tree?cursor=${page.nextCursor}`)).json();
  assert.equal(page2.entries.length, 3); assert.equal(page2.nextCursor, null);
  const directory = [...page.entries, ...page2.entries].find((e: any) => e.name === 'src');
  assert.equal((await get(app, b.token, `/project/tree?pathToken=${directory.pathToken}`)).status, 409);
  for (const query of ['path=../', 'pathToken=bad', `cursor=${page.nextCursor}&cursor=${page.nextCursor}`, 'unknown=x']) {
    assert.equal((await get(app, a.token, `/project/tree?${query}`)).status, 400);
  }
  assert.equal((await get(app, a.token, '/missing/tree')).status, 404);
  await rename(root, `${root}-old`); await mkdir(root);
  const replaced = await get(app, a.token); assert.equal(replaced.status, 409); assert.ok(!(await replaced.text()).includes(root));
}));
test('revocation while directory IO is admitted discards data, and retired tokens do not exhaust registrations', async () => fixture(async (app, tokens) => {
  const a = tokens.createTransient(['files:read']);
  const pending = get(app, a.token); a.dispose();
  const revoked = await pending; assert.equal(revoked.status, 403); assert.deepEqual(await revoked.json(), { error: 'File access was revoked' });
  for (let i = 0; i < 70; i++) {
    const reader = tokens.createTransient(['files:read']); assert.equal((await get(app, reader.token)).status, 200); reader.dispose();
  }
}));
test('concurrent reads are bounded per identity without preventing later explicit refresh', async () => fixture(async (app, tokens) => {
  const a = tokens.createTransient(['files:read']);
  const [one, two] = await Promise.all([get(app, a.token), get(app, a.token)]);
  assert.deepEqual([one.status, two.status].sort(), [200, 429]); assert.equal((await get(app, a.token)).status, 200);
}));
test('explicit file previews share authority, strict query and revocation fences', async () => fixture(async (app, tokens, root) => {
  const a = tokens.createTransient(['files:read']), b = tokens.createTransient(['files:read']);
  const page = await (await get(app, a.token)).json();
  const src = page.entries.find((e: any) => e.name === 'src');
  const nested = await (await get(app, a.token, `/project/tree?pathToken=${src.pathToken}`)).json();
  const token = nested.entries[0].pathToken, suffix = `/project/preview?pathToken=${token}`;
  const preview = await get(app, a.token, suffix); assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('cache-control'), 'no-store');
  const body = await preview.text(); assert.ok(body.includes('PRIVATE_FILE_CONTENT')); assert.ok(!body.includes(root));
  assert.equal((await get(app, b.token, suffix)).status, 409);
  for (const path of ['/project/preview', `${suffix}&cursor=${token}`, `${suffix}&pathToken=${token}`, `${suffix}&extra=1`]) {
    assert.equal((await get(app, a.token, path)).status, 400);
  }
  const pending = get(app, a.token, suffix); a.dispose(); assert.equal((await pending).status, 403);
}));
