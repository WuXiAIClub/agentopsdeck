import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';
import { connectionRecoverySnapshot, recoverableConnection, StorageConnectionUnavailable } from './connection-recovery.js';
import { HubBoardBindings } from '../hub/workspace-board-bindings.js';
import { WorkspaceBoardFiles } from '../hub/workspace-board-files.js';
import { WorkspaceCardFiles } from '../hub/workspace-card-files.js';
import { WorkspaceBoardCapabilities } from '../hub/workspace-board-capabilities.js';
import { ContentProposalStore } from '../hub/content-proposal-store.js';
import { SessionNotebooks, moveInput } from '../hub/session-notebooks.js';
import type { NotebookMove } from '../hub/notebook-operations.js';

function fixture() {
  const raw = new DatabaseSync(':memory:'), rows: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  const db = recoverableConnection(raw, diagnostics), start = performanceDiagnostics.start;
  performanceDiagnostics.start = diagnostics.start.bind(diagnostics);
  db.exec('CREATE TABLE facts(value INTEGER)');
  return { raw, db, rows, close() { performanceDiagnostics.start = start; db.close(); } };
}

// Exercise the real owner boundary with injected work, independently of its
// unrelated credential/projection dependencies. Public happy paths also run
// in the corresponding store and connector integration suites.
const owners = [
  ['workspace-board-binding-change', 'workspace_board_binding', HubBoardBindings.prototype, 'atomic'],
  ['workspace-board-file-change', 'workspace_board_file', WorkspaceBoardFiles.prototype, 'atomic'],
  ['workspace-card-file-change', 'workspace_card_file', WorkspaceCardFiles.prototype, 'atomic'],
  ['workspace-board-capability-change', 'workspace_board_capability', WorkspaceBoardCapabilities.prototype, 'atomic'],
  ['content-proposal-change', undefined, ContentProposalStore.prototype, 'transaction'],
] as const;

for (const [operation, name, prototype, method] of owners) {
  const invoke = (db: DatabaseSync, work: () => unknown) =>
    Reflect.apply(Reflect.get(prototype, method), Object.assign(Object.create(prototype), { db }), [work]);
  for (const acquired of [false, true]) test(`${operation}: failed acquisition runs no work and records uncertainty (${acquired})`, () => {
    const f = fixture(), original = Error('private acquire detail'), exec = f.db.exec.bind(f.db);
    const begin = name ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE'; let calls = 0;
    f.db.exec = sql => { if (sql === begin) { if (acquired) exec(sql); throw original; } exec(sql); };
    try {
      assert.throws(() => invoke(f.db, () => { calls++; }), error => error === original);
      assert.equal(calls, 0); assert.equal(f.raw.isTransaction, false);
      assert.equal(f.rows.find(row => row.operation === operation)?.unknown, 1);
      assert.doesNotMatch(JSON.stringify(f.rows), /private|SAVEPOINT|BEGIN IMMEDIATE/);
    } finally { f.close(); }
  });
  for (const nested of name ? [false, true] : [false]) test(`${operation}: cleanup fault preserves original and protects SQL (${nested})`, () => {
    const f = fixture(), original = Error('private body detail'), exec = f.db.exec.bind(f.db);
    const insert = f.db.prepare('INSERT INTO facts VALUES(?)'); let broken = true, calls = 0;
    try {
      if (nested) f.db.exec('BEGIN; INSERT INTO facts VALUES(1)');
      f.db.exec = sql => { if (broken && sql.startsWith('ROLLBACK')) throw Error('private cleanup detail'); exec(sql); };
      assert.throws(() => invoke(f.db, () => { calls++; insert.run(2); throw original; }), error => error === original);
      assert.equal(connectionRecoverySnapshot(f.db).state, nested ? 'parent-rollback-required' : 'owner-rollback-required');
      assert.throws(() => insert.run(3), StorageConnectionUnavailable);
      const log = f.rows.find(row => row.operation === operation);
      assert.equal(log?.rollbackFailed, 1); assert.equal(log?.unknown, 1);
      assert.doesNotMatch(JSON.stringify(f.rows), /private|facts/);
      broken = false; f.db.exec('ROLLBACK');
      assert.equal(connectionRecoverySnapshot(f.db).state, 'ready');
      assert.deepEqual(f.db.prepare('SELECT value FROM facts').all(), []);
      assert.equal(calls, 1, 'recovery must never replay the failed callback');
    } finally { f.close(); }
  });
  for (const committed of [false, true]) test(`${operation}: lost settlement ACK keeps durable facts without replay (${committed})`, () => {
    const f = fixture(), original = Error('private settlement detail'), exec = f.db.exec.bind(f.db);
    const settle = name ? `RELEASE ${name}` : 'COMMIT'; let calls = 0;
    f.db.exec = sql => { if (sql === settle) { if (committed) exec(sql); throw original; } exec(sql); };
    try {
      assert.throws(() => invoke(f.db, () => { calls++; f.db.exec('INSERT INTO facts VALUES(1)'); }), error => error === original);
      assert.equal(calls, 1); assert.equal(f.raw.isTransaction, false);
      assert.equal(f.raw.prepare('SELECT count(*) n FROM facts').get()!.n, Number(committed));
      assert.equal(f.rows.find(row => row.operation === operation)?.unknown, 1);
    } finally { f.close(); }
  });
}

function preparedNotebook(db: DatabaseSync) {
  const notes = new SessionNotebooks(db);
  const input: NotebookMove = { requestId: 'move', direction: 'archive', hotRevision: 1, coldRevision: 0, ranges: [] };
  db.prepare('INSERT INTO hub_notebook_bound_moves VALUES(?,?,?,?,?,?,?,?)')
    .run('owner', 'resource', input.requestId, 'binding', 'file', moveInput(input), '{}', 'pending');
  return (work: () => unknown) => notes.admitBoundMove('owner', 'resource', input, 'binding', 'file', work as any);
}

function preparedArchive(db: DatabaseSync) {
  db.exec(`CREATE TABLE hub_workspace_card_file_writes(user_id TEXT,binding_id TEXT,state TEXT);
    CREATE TABLE hub_workspace_card_file_archive_upgrades(user_id TEXT,binding_id TEXT,mutation_id TEXT,input TEXT,PRIMARY KEY(user_id,binding_id));`);
  const input = { kind: 'notebook', revision: 1, mutationId: 'upgrade' };
  const owner = Object.assign(Object.create(WorkspaceCardFiles.prototype), { db,
    get: () => ({ state: 'active', resourceId: 'resource' }), authorized: () => true,
    moveLocks: { permitsWrite: () => true }, archiveUpgradePlan: () => input,
    projection: { archiveUpgrade: () => ({ revision: 1 }) },
  }) as WorkspaceCardFiles;
  return (work: () => unknown) => owner.admitArchiveUpgrade('owner', 'binding', input as any, work as any);
}

for (const [label, prepare] of [['notebook', preparedNotebook], ['archive upgrade', preparedArchive]] as const) {
  for (const fresh of [false, true]) test(`${label}: async prepare cannot escape through fresh validation (${fresh})`, async () => {
    const f = fixture(), invoke = prepare(f.db), insert = f.db.prepare('INSERT INTO facts VALUES(1)');
    let release!: () => void, late!: Promise<unknown>;
    const held = new Promise<void>(resolve => { release = resolve; });
    try {
      assert.throws(() => invoke(() => {
        late = (async () => { await held; insert.run(); return { fresh: true }; })();
        if (fresh) Object.assign(late, { fresh: true });
        return late;
      }), /must be synchronous/);
      assert.equal(connectionRecoverySnapshot(f.db).state, 'close-required');
      assert.throws(() => insert.run(), StorageConnectionUnavailable);
      const failure = assert.rejects(late, StorageConnectionUnavailable); release(); await failure;
      assert.deepEqual(f.raw.prepare('SELECT value FROM facts').all(), []);
      assert.equal(f.rows.some(row => row.unknown === 1), true);
    } finally { release(); await late?.catch(() => {}); f.close(); }
  });
  test(`${label}: throwing then getter preserves error and retires owner`, () => {
    const f = fixture(), invoke = prepare(f.db), original = Error('private then detail');
    try {
      assert.throws(() => invoke(() => ({ fresh: true, get then() { throw original; } })), error => error === original);
      assert.equal(connectionRecoverySnapshot(f.db).state, 'close-required');
      assert.doesNotMatch(JSON.stringify(f.rows), /private then detail/);
    } finally { f.close(); }
  });
}
