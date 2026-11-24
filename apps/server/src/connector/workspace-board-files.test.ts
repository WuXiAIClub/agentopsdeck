import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorFileBoards, FileBoardError } from './workspace-board-files.js';
import { serializeBoardFile } from './workspace-board-file-format.js';
import { WorkspaceBoards } from '../hub/workspace-boards.js';
import { WorkspaceBoardFiles } from '../hub/workspace-board-files.js';

const content = () => ({ title: 'Panel', tasks: [] });
const intent = () => ({ id: randomUUID(), sessionKey: `codex:${randomUUID()}`, content: content() });
const failure = (status: number) => (error: unknown) => error instanceof FileBoardError && error.status === status;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-file-panel-test-'));
  const db = new DatabaseSync(':memory:'); let allowed = true;
  const policy = (owner: string) => allowed && owner === 'connector-token';
  const manager = new ConnectorFileBoards(db, root, policy);
  return { root, db, manager, policy, deny: () => { allowed = false; }, allow: () => { allowed = true; },
    close: async () => { await manager.close(); db.close(); await rm(root, { recursive: true, force: true }); } };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'file event did not converge');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

test('exclusive installation preserves Agent edits on lost-response retry and across restart', async () => {
  const f = await fixture();
  try {
    const input = intent(), installed = await f.manager.install('connector-token', input);
    assert.equal(installed.state, 'installed'); assert.ok(installed.context.includes(installed.path));
    const changed = serializeBoardFile({ title: 'Agent edited', tasks: [] });
    await writeFile(installed.path, changed);
    assert.deepEqual(await f.manager.install('connector-token', input), installed);
    assert.equal(await readFile(installed.path, 'utf8'), changed);
    assert.match(f.manager.contextForSession('connector-token', input.sessionKey), /tasks.json/);
    assert.throws(() => f.manager.get('another-owner', input.id), failure(404));
    await assert.rejects(f.manager.install('connector-token', { ...input, content: { title: 'other', tasks: [] } }), failure(409));
    await f.manager.close();
    const restarted = new ConnectorFileBoards(f.db, f.root, f.policy);
    try {
      assert.equal(restarted.get('connector-token', input.id).state, 'installed');
      assert.equal((await restarted.install('connector-token', input)).state, 'installed');
      assert.equal(await readFile(installed.path, 'utf8'), changed);
      await restarted.revoke('connector-token', input.id);
      assert.equal((await restarted.install('connector-token', input)).state, 'revoked');
      assert.equal(restarted.contextForSession('connector-token', input.sessionKey), '');
      assert.equal(await readFile(installed.path, 'utf8'), changed);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});
test('two original file managers racing the same installation perform only one physical effect', async () => {
  const f = await fixture(), other = new ConnectorFileBoards(f.db, f.root, f.policy);
  try {
    const input = intent();
    const views = await Promise.all([f.manager.install('connector-token', input), other.install('connector-token', input)]);
    assert.ok(views.some(view => view.state === 'installed'));
    assert.ok(views.every(view => view.state === 'prepared' || view.state === 'installed'));
    const view = f.manager.get('connector-token', input.id);
    assert.equal(view.state, 'installed');
    assert.equal(await readFile(view.path, 'utf8'), serializeBoardFile(input.content));
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM connector_workspace_board_files').get() as { n: number }).n, 1);
  } finally { await other.close(); await f.close(); }
});

test('pre-existing directories and interrupted installation are never adopted or overwritten', async () => {
  const f = await fixture();
  try {
    const input = intent(), path = join(f.root, input.id, 'tasks.json');
    await mkdir(join(f.root, input.id)); await writeFile(path, 'existing artifact');
    await assert.rejects(f.manager.install('connector-token', input));
    assert.equal(f.manager.get('connector-token', input.id).state, 'prepared');
    assert.equal((await f.manager.install('connector-token', input)).state, 'prepared');
    assert.equal(await readFile(path, 'utf8'), 'existing artifact');
    assert.equal(f.manager.contextForSession('connector-token', input.sessionKey), '');
    await assert.rejects(f.manager.subscribe('connector-token', input.id, () => {}), failure(409));
    await f.manager.revoke('connector-token', input.id);
  } finally { await f.close(); }
});

test('subscriptions are bounded, released snapshots are fenced, and revoke works after permission loss', async () => {
  const f = await fixture();
  try {
    const input = intent(); await f.manager.install('connector-token', input);
    const subscriptions = await Promise.all(Array.from({ length: 4 }, () => f.manager.subscribe('connector-token', input.id, () => {})));
    await assert.rejects(f.manager.subscribe('connector-token', input.id, () => {}), failure(429));
    await subscriptions[0]!.release(); assert.throws(() => subscriptions[0]!.current(), failure(409));
    const extra = await f.manager.subscribe('connector-token', input.id, () => {});
    f.deny(); await f.manager.revoke('connector-token', input.id); f.allow();
    for (const subscription of [...subscriptions.slice(1), extra]) {
      assert.throws(() => subscription.current(), failure(409)); await subscription.release(); await subscription.release();
    }
    assert.equal((await f.manager.install('connector-token', input)).state, 'revoked');
  } finally { await f.close(); }
});

test('policy reconciliation stops sources permanently; restoring permission does not restore delegation', async () => {
  const f = await fixture();
  try {
    const input = intent(); await f.manager.install('connector-token', input);
    const subscription = await f.manager.subscribe('connector-token', input.id, () => {});
    f.deny(); await f.manager.reconcile(); f.allow();
    assert.equal(f.manager.get('connector-token', input.id).state, 'revoked');
    assert.throws(() => subscription.current(), failure(409));
    await subscription.release();
  } finally { await f.close(); }
});

test('isolated file → Connector watch → Hub projection covers empty board, atomic edits and last-good recovery', async () => {
  const f = await fixture(), hubDb = new DatabaseSync(':memory:');
  const boards = new WorkspaceBoards(hubDb), files = new WorkspaceBoardFiles(hubDb, boards, () => true);
  let subscription: Awaited<ReturnType<ConnectorFileBoards['subscribe']>> | undefined;
  try {
    const input = intent(), binding = { bindingId: input.id, userId: 'alice', resourceId: 'default',
      sessionId: input.sessionKey, connectionId: 'remote-fixture', authority: 1 };
    assert.ok(files.prepare(binding, 0));
    const installed = await f.manager.install('connector-token', input);
    assert.ok(files.activate('alice', input.id));
    subscription = await f.manager.subscribe('connector-token', input.id, snapshot => files.apply('alice', input.id, snapshot));
    assert.equal(boards.get('alice', 'default').title, 'Panel');
    const task = { id: randomUUID(), title: 'New task from ordinary file', detail: '', status: 'doing' as const };
    const temporary = installed.path + '.tmp';
    await writeFile(temporary, serializeBoardFile({ title: 'Progress', tasks: [task] })); await rename(temporary, installed.path);
    await until(() => boards.get('alice', 'default').tasks.length === 1);
    const revision = boards.get('alice', 'default').revision;
    await writeFile(installed.path, '{"version":');
    await until(() => files.current('alice', 'default')?.problem === 'invalid');
    assert.equal(boards.get('alice', 'default').revision, revision);
    await writeFile(temporary, serializeBoardFile({ title: 'Progress', tasks: [{ ...task, status: 'done' }] })); await rename(temporary, installed.path);
    await until(() => boards.get('alice', 'default').tasks[0]?.status === 'done');
    assert.equal(files.current('alice', 'default')?.problem, null);
    assert.equal(boards.get('bob', 'default').tasks.length, 0);
    assert.ok(files.revoke('alice', input.id));
    assert.equal(files.apply('alice', input.id, subscription.current()), 'denied');
  } finally { await subscription?.release(); hubDb.close(); await f.close(); }
});
