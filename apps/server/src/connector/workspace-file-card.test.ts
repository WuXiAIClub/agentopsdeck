import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { emptyNativeDrawio, WORKSPACE_FILE_CARD_KINDS, validWorkspaceFileCard, workspaceFileCardContent, type WorkspaceFileCard } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorFileBoards, ConnectorWorkspaceFiles } from './workspace-board-files.js';
import { registerConnectorWorkspaceFiles } from './workspace-board-files-http.js';
import { parseCardFile, serializeCardFile, cardFileCodec, cardFilesContext } from './workspace-file-card-format.js';

test('notebook context prefers newest entries first without rewriting existing content', () => {
  const context = cardFilesContext(['/tmp/note/card.json']);
  assert.match(context, /kind:"notebook"/);
  assert.match(context, /beginning of content.text, newest first/);
  assert.match(context, /instead of duplicating/);
  assert.match(context, /preserve unrelated text, formatting and user edits/);
  assert.match(context, /does not apply to other card kinds/);
  assert.match(context, /Re-read immediately before saving/);
});
import { readWorkspaceFile, WorkspaceFileSource } from './workspace-board-file-source.js';

const samples: WorkspaceFileCard[] = [
  { kind: 'taskboard', content: { title: 'Tasks', tasks: [{ id: randomUUID(), title: 'Metadata', detail: 'Preserve attributes', status: 'todo', tags: ['前端'], priority: 'urgent', dueDate: '2028-02-29' }] } },
  { kind: 'statuscard', content: { title: 'Status', tasks: [{ id: randomUUID(), title: 'Metadata', detail: 'Preserve attributes', status: 'doing', tags: ['同步'], priority: 'low', dueDate: '2028-03-01' }] } },
  { kind: 'notebook', content: { title: 'Note', text: '# Hello\n- [ ] Todo' } },
  { kind: 'report', content: { title: 'Report', text: 'Verified findings' } },
  { kind: 'metric-card', content: { title: 'Build', value: 'OK', detail: '', tone: 'green', progress: 100 } },
  { kind: 'drawing', content: { format: 'agentopsdeck-drawing', version: 1, title: 'Whiteboard', nodes: [], edges: [], strokes: [] } },
  { kind: 'native-drawio', content: emptyNativeDrawio() },
  { kind: 'website', content: { title: 'App', connectionId: 'node-1', websiteId: 'preview' } },
  { kind: 'browser', content: { title: 'Docs', url: 'https://example.org/' } },
  { kind: 'research', content: { title: 'Research', query: 'cache', sources: [{ title: 'Source', url: 'https://example.org/', excerpt: 'Summary' }] } },
  { kind: 'terminal', content: { title: 'Local shell', connectionId: 'node-1', targetId: 'daily-shell' } },
  { kind: 'media', content: { title: 'Video', mediaId: 'sample' } },
  { kind: 'dashboard', content: { title: 'Overview', description: '', items: [{ label: 'Build', value: 'Ready' }] } },
];

test('small edits do not exhaust retention by charging every original at maximum card size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-card-retention-')), db = new DatabaseSync(':memory:');
  const manager = new ConnectorWorkspaceFiles(db, root, () => true, cardFileCodec()), id = randomUUID();
  try {
    const initial: WorkspaceFileCard = { kind: 'notebook', content: { title: 'Note', text: 'Small content' } };
    const { path } = await manager.install('owner', { id, sessionKey: `codex:${randomUUID()}`, content: initial });
    for (let n = 0; n < 48; n++) {
      const current = parseCardFile(await readFile(path))!;
      const content: WorkspaceFileCard = { ...initial, content: { ...initial.content, title: `Edit ${n}` } };
      assert.equal((await manager.write('owner', id, { mutationId: randomUUID(), expectedHash: current.hash, content })).state, 'saved');
    }
    assert.equal(parseCardFile(await readFile(path))?.content.content.title, 'Edit 47');
  } finally { await manager.close(); db.close(); await rm(root, { recursive: true, force: true }); }
});

test('all declared card kinds have a validated, canonical, round-trip file example', () => {
  assert.deepEqual(samples.map(s => s.kind).sort(), [...WORKSPACE_FILE_CARD_KINDS].sort());
  for (const sample of samples) {
    assert.ok(validWorkspaceFileCard(sample), sample.kind);
    const text = serializeCardFile(sample), value = parseCardFile(Buffer.from(text));
    assert.ok(value, sample.kind);
    assert.deepEqual(value.content, workspaceFileCardContent(sample));
    const shuffled = { content: Object.fromEntries(Object.entries(sample.content).reverse()), kind: sample.kind, version: 1 };
    assert.equal(parseCardFile(Buffer.from(JSON.stringify(shuffled)))?.hash, value.hash);
    assert.ok(cardFileCodec(sample.kind).parse(Buffer.from(text)));
    assert.equal(cardFileCodec(sample.kind === 'terminal' ? 'notebook' : 'terminal').parse(Buffer.from(text)), undefined);
  }
});

test('card files reject executable extensions, credentials, type swaps and malformed data', () => {
  for (const sample of samples) {
    assert.equal(validWorkspaceFileCard({ ...sample, revision: 2 }), false);
    assert.equal(validWorkspaceFileCard({ ...sample, content: { ...sample.content, command: 'echo should-not-run' } }), false);
  }
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.org', 'data:text/html,x'])
    assert.equal(validWorkspaceFileCard({ kind: 'browser', content: { title: 'No', url } }), false);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.equal(validWorkspaceFileCard({ kind: 'dashboard', content: cyclic }), false);
  assert.equal(parseCardFile(Buffer.from([0xc3, 0x28])), undefined);
  assert.equal(parseCardFile(Buffer.from('{"version":2,"kind":"notebook","content":{"title":"a","text":"b"}}')), undefined);
  assert.equal(parseCardFile(Buffer.from(JSON.stringify({ version: 1, ...samples[0], path: '/arbitrary' }))), undefined);
  assert.throws(() => cardFilesContext(['/tmp/name\ninjected']));
  assert.equal(cardFilesContext([]), '');
});

for (const sample of samples) test(`${sample.kind}: install → watched Agent edit → user write → duplicate inspection → revoke`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-card-roundtrip-'));
  const db = new DatabaseSync(':memory:'); let allowed = true;
  const codec = cardFileCodec(sample.kind);
  const manager = new ConnectorWorkspaceFiles(db, root, owner => allowed && owner === 'owner', codec);
  const id = randomUUID(), sessionKey = `codex:${randomUUID()}`;
  try {
    const installed = await manager.install('owner', { id, sessionKey, content: sample });
    assert.match(installed.path, /card\.json$/);
    const initial = await readWorkspaceFile(root, id, codec); assert.equal(initial.state, 'ready');
    const events: string[] = [];
    const subscription = await manager.subscribe('owner', id, snapshot => { if (snapshot.value) events.push(snapshot.value.hash); });
    const agent = structuredClone(sample); agent.content.title = 'Agent updated';
    await writeFile(join(root, id, 'agent.tmp'), serializeCardFile(agent));
    await rename(join(root, id, 'agent.tmp'), installed.path);
    const hash = parseCardFile(Buffer.from(serializeCardFile(agent)))!.hash;
    const deadline = Date.now() + 3000;
    while (!events.includes(hash)) {
      assert.ok(Date.now() < deadline, 'file watcher did not converge');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    const user = structuredClone(sample); user.content.title = 'User updated';
    const input = { mutationId: randomUUID(), expectedHash: hash, content: user };
    assert.equal((await manager.write('owner', id, input)).state, 'saved');
    assert.equal(parseCardFile(await readFile(installed.path))?.content.content.title, 'User updated');
    await writeFile(installed.path, serializeCardFile(agent));
    assert.equal((await manager.write('owner', id, input)).state, 'saved');
    assert.equal(parseCardFile(await readFile(installed.path))?.content.content.title, 'Agent updated');
    allowed = false; await manager.reconcile();
    assert.throws(() => subscription.current());
    await assert.rejects(manager.write('owner', id, { ...input, mutationId: randomUUID() }));
    await subscription.release();
    assert.equal(parseCardFile(await readFile(installed.path))?.content.content.title, 'Agent updated');
  } finally { await manager.close(); db.close(); await rm(root, { recursive: true, force: true }); }
});

test('card HTTP has separate metadata/paths, validates bodies and never borrows another owner binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-card-http-'));
  const db = new DatabaseSync(':memory:');
  await mkdir(join(root, 'cards'), { mode: 0o700 }); await mkdir(join(root, 'boards'), { mode: 0o700 });
  const tokens = new ConnectorTokenStore(join(root, 'tokens'));
  const owner = tokens.createTransient(['boards:files'], 'owner');
  const other = tokens.createTransient(['boards:files'], 'other');
  const codec = cardFileCodec(), cards = new ConnectorWorkspaceFiles(db, join(root, 'cards'), o => tokens.hasScope(o, 'boards:files'), codec);
  const boards = new ConnectorFileBoards(db, join(root, 'boards'), () => true);
  const app = new Hono(), service = registerConnectorWorkspaceFiles(app, { boards: cards, tokens, session: () => ({ exists: true, ready: true }) });
  const id = randomUUID(), sessionKey = `codex:${randomUUID()}`;
  const request = (method: string, suffix: string, body?: unknown, token = owner.token) => app.request('/api/connector/v1/workspace/card-files' + suffix,
    { method, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    await service.ready;
    assert.equal((await request('GET', '')).status, 200);
    assert.equal((await request('PUT', '/' + id, { sessionKey, content: samples[2] })).status, 200);
    await boards.install('owner', { id, sessionKey, content: { title: 'Separate tasks', tasks: [] } });
    assert.equal((await request('GET', '/' + id, undefined, other.token)).status, 404);
    assert.equal((await request('GET', '/' + id + '/snapshot', undefined, other.token)).status, 404);
    assert.equal((await request('GET', '/' + id + '/snapshot')).status, 200);
    assert.equal((await request('POST', '/' + id + '/writes', { mutationId: randomUUID(), expectedHash: 'a'.repeat(64), content: { ...samples[2], command: 'no' } })).status, 400);
    const original = parseCardFile(await readFile(cards.get('owner', id).path))!;
    const input = { mutationId: randomUUID(), expectedHash: original.hash, content: { kind: 'notebook', content: { title: 'Web', text: 'Saved' } } };
    const saved = await request('POST', '/' + id + '/writes', input);
    assert.equal(saved.status, 200); assert.equal((await saved.json()).receipt.state, 'saved');
    assert.equal((await request('GET', '/' + id + '/writes/' + input.mutationId)).status, 200);
    assert.equal(JSON.parse(await readFile(boards.get('owner', id).path, 'utf8')).title, 'Separate tasks');
    await request('DELETE', '/' + id);
    assert.equal((await request('GET', '/' + id + '/snapshot')).status, 409);
  } finally { await service.close(); await boards.close(); db.close(); await rm(root, { recursive: true, force: true }); }
});

for (const [index, sample] of samples.entries()) test(`${sample.kind}: cross-file kind swap retains last good content and recovers after correction`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-card-kind-')), id = randomUUID();
  await mkdir(join(root, id), { mode: 0o700 });
  const path = join(root, id, 'card.json'), source = new WorkspaceFileSource(root, id, cardFileCodec(sample.kind));
  try {
    await writeFile(path, serializeCardFile(sample)); await source.start();
    assert.equal(source.current().state, 'ready');
    const original = source.current().value;
    await writeFile(path, serializeCardFile(samples[(index + 1) % samples.length]!)); await source.refresh();
    assert.equal(source.current().state, 'invalid'); assert.deepEqual(source.current().value, original);
    const corrected = structuredClone(sample); corrected.content.title = 'Corrected at original path';
    await writeFile(path, serializeCardFile(corrected)); await source.refresh();
    assert.equal(source.current().state, 'ready');
    assert.deepEqual(source.current().value?.content, workspaceFileCardContent(corrected));
  } finally { await source.close(); await rm(root, { recursive: true, force: true }); }
});

test('mixed-card manager durably pins each kind across restart and rejects type-swapping writes before intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-card-durable-kind-'));
  const db = new DatabaseSync(':memory:'), id = randomUUID(), sessionKey = `codex:${randomUUID()}`;
  let manager = new ConnectorWorkspaceFiles(db, root, () => true, cardFileCodec());
  try {
    const installed = await manager.install('owner', { id, sessionKey, content: samples[2]! });
    const original = await readFile(installed.path);
    await manager.close();
    manager = new ConnectorWorkspaceFiles(db, root, () => true, cardFileCodec());
    const subscription = await manager.subscribe('owner', id, () => {});
    try {
      const input = { mutationId: randomUUID(), expectedHash: parseCardFile(original)!.hash, content: samples[10]! };
      await assert.rejects(manager.write('owner', id, input), { status: 409 });
      assert.throws(() => manager.receipt('owner', id, input.mutationId), { status: 404 });
      assert.deepEqual(await readFile(installed.path), original);
      await writeFile(installed.path, serializeCardFile(samples[10]!));
      const deadline = Date.now() + 3000;
      while (subscription.current().state !== 'invalid') {
        assert.ok(Date.now() < deadline, 'type swap was not rejected by watcher');
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.equal(subscription.current().value?.content.kind, 'notebook');
    } finally { await subscription.release(); }
  } finally { await manager.close(); db.close(); await rm(root, { recursive: true, force: true }); }
});

test('concurrent board/card admission shares the 64-file budget without truncating grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-card-shared-quota-'));
  const db = new DatabaseSync(':memory:'), sessionKey = `codex:${randomUUID()}`;
  const boards = new ConnectorFileBoards(db, root, () => true);
  const cards = new ConnectorWorkspaceFiles(db, root, () => true, cardFileCodec());
  try {
    // Prepared reservations count: a crash must not release their capacity.
    const seed = db.prepare('INSERT INTO connector_workspace_board_files VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 63; i++) seed.run(randomUUID(), 'owner', sessionKey, 'reserved', 'prepared');
    const results = await Promise.allSettled([
      boards.install('owner', { id: randomUUID(), sessionKey, content: { title: 'Tasks', tasks: [] } }),
      cards.install('owner', { id: randomUUID(), sessionKey, content: samples[2]! }),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(failed.reason.status, 429);
  } finally { await boards.close(); await cards.close(); db.close(); await rm(root, { recursive: true, force: true }); }
});
