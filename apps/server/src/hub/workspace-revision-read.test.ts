import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { readWorkspaceRevisions } from './workspace-revision-read.js';
import { validWorkspaceRevisionRead, validWorkspaceRevisions, WORKSPACE_REVISION_TYPES,
  WORKSPACE_REVISION_ROW_LIMIT, type WorkspaceRevisions } from './delivery-reader-protocol.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const tables = ['hub_workspace_boards', 'hub_workspace_board_file_versions', 'hub_workspace_drawings',
  'hub_workspace_native_drawio', 'hub_workspace_cards', 'hub_workspace_card_file_versions',
  'hub_workspace_card_configurations', 'hub_workspace_reports'];
const empty = (): WorkspaceRevisions => ({ taskboard: [], 'taskboard-binding': [], drawing: [], 'native-drawio': [],
  'metric-card': [], 'card-file-binding': [], 'card-configuration': [], report: [] });
function fixture(t: test.TestContext, file = ':memory:') {
  const db = new DatabaseSync(file);
  for (const table of tables) db.exec(`CREATE TABLE ${table}(user_id TEXT, resource_id TEXT, kind TEXT, revision INTEGER)`);
  t.after(() => db.close());
  const insert = (index: number, id: string | Uint8Array, revision: number | string = 1, owner = 'default', kind = 'service') =>
    db.prepare(`INSERT INTO ${tables[index]} VALUES(?,CAST(? AS TEXT),?,?)`).run(owner, id, kind, revision);
  return { db, insert };
}

test('file-backed workspace revision poll uses the existing readonly owner, never synchronous store facades', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-revision-read-'));
  const store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic');
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.boards.revisions = () => { throw Error('main-thread SQL must not run'); };
  const result = await store.workspaceRevisionsAsync('default');
  assert.deepEqual(result, { taskboard: [], 'taskboard-binding': [], drawing: [], 'native-drawio': [],
    'metric-card': [], 'card-file-binding': [], 'card-configuration': [], report: [] });
});

test('real owner sees committed versions and isolates accounts without changing old wire format', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-revision-compat-'));
  const store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic');
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.boards.save('alice', 'default', { revision: 0, mutationId: randomUUID(), title: 'private body', tasks: [] });
  store.boards.save('bob', 'default', { revision: 0, mutationId: randomUUID(), title: 'other private body', tasks: [] });
  const expected = { ...empty(), taskboard: store.boards.revisions('alice') };
  assert.deepEqual(await store.workspaceRevisionsAsync('alice'), expected);
  assert.deepEqual(await store.workspaceRevisionsAsync('nobody'), empty());
  store.boards.save('alice', 'default', { revision: 1, mutationId: randomUUID(), title: 'changed', tasks: [] });
  assert.equal((await store.workspaceRevisionsAsync('alice')).taskboard[0]!.revision, 2);
  assert.doesNotMatch(JSON.stringify(expected), /private|body|title/);
});

test('many same-owner browser subscribers join one immutable original read, without caching future versions', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-revision-tabs-'));
  const store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic');
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  const results = await Promise.all(Array.from({ length: 12 }, () => store.workspaceRevisionsAsync('default')));
  assert.ok(results.every(result => result === results[0]));
  assert.ok(Object.isFrozen(results[0]) && Object.isFrozen(results[0]!.taskboard));
  assert.throws(() => { results[0]!.taskboard.push({ resourceId: 'forged', revision: 99 }); });
  store.boards.save('default', 'default', { revision: 0, mutationId: randomUUID(), title: 'new', tasks: [] });
  const next = await store.workspaceRevisionsAsync('default');
  assert.notEqual(next, results[0]); assert.equal(next.taskboard[0]!.revision, 1);
  assert.ok(Object.isFrozen(next.taskboard[0]));
});

test('closed or invalid owner cannot enter revision coalescing or revive a retired read', async () => {
  const store = new HubStore(':memory:', 'synthetic');
  await assert.rejects(store.workspaceRevisionsAsync(''));
  await store.close(); await assert.rejects(store.workspaceRevisionsAsync('default'));
});

test('revision subscriber capacity is reserved before dispatch and restored only after settlement', async t => {
  const store = new HubStore(':memory:', 'synthetic');
  t.after(() => store.close());
  // All waiters enter before the original read's first microtask. Overflow is
  // admission backpressure, not a failed owner or a cached empty snapshot.
  const accepted = Array.from({ length: 256 }, () => store.workspaceRevisionsAsync('default'));
  const overflow = assert.rejects(store.workspaceRevisionsAsync('default'));
  const rows = await Promise.all(accepted); await overflow;
  assert.ok(rows.every(row => row === rows[0]));
  const next = await store.workspaceRevisionsAsync('default');
  assert.deepEqual(next, empty()); assert.notEqual(next, rows[0]);
});

test('rejected shared display metadata affects every joined tab but not chat, and a fresh read recovers without replaying writes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-revision-recovery-'));
  const file = join(dir, 'hub.sqlite'), store = new HubStore(file, 'synthetic');
  let writer: DatabaseSync | undefined;
  t.after(async () => { writer?.close(); await store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.boards.save('default', 'default', { revision: 0, mutationId: randomUUID(), title: 'retained', tasks: [] });
  writer = new DatabaseSync(file);
  writer.prepare('UPDATE hub_workspace_boards SET revision=-1 WHERE user_id=?').run('default');
  const failed = await Promise.allSettled(Array.from({ length: 12 }, () => store.workspaceRevisionsAsync('default')));
  assert.ok(failed.every(result => result.status === 'rejected'));
  assert.deepEqual(await store.deliveryPageAsync(undefined, new Map(), 'default'), { reset: false, cursor: undefined, events: [] });
  // Repair only this isolated fixture. Production recovery never edits or
  // replays a board write. A bounded display rejection leaves the reader live;
  // SQL/identity/worker failures still need proven physical exit to recover.
  writer.prepare('UPDATE hub_workspace_boards SET revision=1 WHERE user_id=?').run('default');
  writer.close(); writer = undefined;
  const recovered = await store.workspaceRevisionsAsync('default');
  assert.deepEqual(recovered.taskboard, [{ resourceId: 'default', revision: 1 }]);
  assert.equal(store.boards.get('default', 'default').title, 'retained');
});

test('eight domains have canonical ordered IDs, configuration kind prefix, and no bodies', t => {
  const h = fixture(t), expected = empty();
  for (let i = 0; i < tables.length; i++) {
    h.insert(i, 'z', 3); h.insert(i, 'a', 2); h.insert(i, 'hidden', 8, 'other');
    expected[WORKSPACE_REVISION_TYPES[i]!] = ['a', 'z'].map(id => ({ resourceId: i === 6 ? JSON.stringify(['service', id]) : id,
      revision: id === 'a' ? 2 : 3 }));
  }
  const schema = h.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
  assert.deepEqual(readWorkspaceRevisions(h.db, 'default'), expected);
  assert.deepEqual(readWorkspaceRevisions(h.db, 'missing'), empty());
  assert.deepEqual(h.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(), schema);
  assert.equal(h.db.isTransaction, false);
});

test('single readonly statement keeps versions consistent through concurrent WAL commit', t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-revision-snapshot-'));
  const file = join(dir, 'snapshot.sqlite'), h = fixture(t, file);
  h.db.exec('PRAGMA journal_mode=WAL'); h.insert(0, 'board'); h.insert(7, 'report');
  const writer = new DatabaseSync(file); t.after(() => writer.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let statements = 0;
  const instrumented = { prepare(sql: string) {
    statements++;
    const original = h.db.prepare(sql);
    return { *iterate(...args: (string | number)[]) {
      for (const row of original.iterate(...args)) {
        yield row;
        writer.exec('UPDATE hub_workspace_reports SET revision=2');
      }
    } };
  } } as unknown as DatabaseSync;
  const result = readWorkspaceRevisions(instrumented, 'default');
  assert.equal(statements, 1); assert.equal(result.report[0]!.revision, 1);
  assert.equal(readWorkspaceRevisions(h.db, 'default').report[0]!.revision, 2);
  assert.equal(h.db.isTransaction, false);
});

test('read neither commits nor rolls back its parent transaction', t => {
  const h = fixture(t); h.db.exec('BEGIN'); h.insert(0, 'parent');
  assert.equal(readWorkspaceRevisions(h.db, 'default').taskboard.length, 1); assert.equal(h.db.isTransaction, true);
  h.insert(7, 'bad', -1); assert.throws(() => readWorkspaceRevisions(h.db, 'default'));
  assert.equal(h.db.isTransaction, true); h.db.exec('ROLLBACK');
  assert.deepEqual(readWorkspaceRevisions(h.db, 'default'), empty());
});

for (const [label, id, revision] of [
  ['NUL', 'private\0id', 1], ['newline', 'private\nid', 1], ['empty', '', 1], ['oversized', 'x'.repeat(16_385), 1],
  ['UTF8', new Uint8Array([0xc0, 0xaf]), 1], ['negative', 'id', -1], ['unsafe', 'id', Number.MAX_SAFE_INTEGER + 1],
  ['fraction', 'id', 0.25], ['non-number', 'id', 'corrupt'],
] as const) test(`corrupt ${label} metadata fails closed, releases iterator, and does not alias a version`, t => {
  const h = fixture(t); h.insert(0, id, revision);
  assert.throws(() => readWorkspaceRevisions(h.db, 'default'));
  h.db.exec('DELETE FROM hub_workspace_boards');
  assert.deepEqual(readWorkspaceRevisions(h.db, 'default'), empty()); assert.equal(h.db.isTransaction, false);
});

test('duplicate metadata is rejected, never published as two canonical versions', t => {
  const h = fixture(t); h.insert(0, 'id'); h.insert(0, 'id', 2);
  assert.throws(() => readWorkspaceRevisions(h.db, 'default'));
});

test('aggregate row bound rejects a partial snapshot without changing facts', t => {
  const h = fixture(t);
  h.db.exec(`WITH RECURSIVE rows(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM rows WHERE n<${WORKSPACE_REVISION_ROW_LIMIT})
    INSERT INTO hub_workspace_board_file_versions SELECT 'default',CAST(n AS TEXT),NULL,1 FROM rows`);
  assert.throws(() => readWorkspaceRevisions(h.db, 'default'));
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM hub_workspace_board_file_versions').get()!.n, WORKSPACE_REVISION_ROW_LIMIT + 1);
});

test('aggregate byte bound rejects oversized snapshots before retaining unbounded rows', t => {
  const h = fixture(t);
  h.db.exec(`WITH RECURSIVE rows(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM rows WHERE n<2200)
    INSERT INTO hub_workspace_card_file_versions SELECT 'default',CAST(n AS TEXT)||printf('%04000d',0),NULL,1 FROM rows`);
  assert.throws(() => readWorkspaceRevisions(h.db, 'default')); assert.equal(h.db.isTransaction, false);
});

test('SQL failure logs only numeric classification, not owners, SQL, or paths', t => {
  const h = fixture(t), diagnostics = new PerformanceDiagnostics(() => {});
  h.db.exec('DROP TABLE hub_workspace_boards');
  assert.throws(() => readWorkspaceRevisions(h.db, 'PRIVATE-owner', diagnostics));
  const row = diagnostics.snapshot().events.find(row => row.operation === 'hub-workspace-revisions-read')!;
  assert.equal(row.sqlErrorCode, 1); assert.equal(row.step, 2); assert.equal(row.category, 'failed');
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE|SELECT|hub_workspace/);
});

test('protocol requires complete bounded domains, exact fields, unique IDs and safe versions', () => {
  assert.equal(validWorkspaceRevisionRead({ owner: 'owner' }), true);
  for (const read of [null, [], {}, { owner: '' }, { owner: 'x', sql: 'SELECT' }, { owner: 'x\0' }])
    assert.equal(validWorkspaceRevisionRead(read), false);
  assert.equal(validWorkspaceRevisions(empty()), true);
  for (const value of [null, [], {}, { ...empty(), extra: [] }, { ...empty(), report: undefined },
    { ...empty(), report: [{ resourceId: 'x', revision: NaN }] },
    { ...empty(), report: [{ resourceId: 'x', revision: 1, extra: true }] },
    { ...empty(), report: [{ resourceId: 'x', revision: 1 }, { resourceId: 'x', revision: 2 }] }])
    assert.equal(validWorkspaceRevisions(value), false);
});
