import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { observedSavepoint } from './observed-savepoint.js';

function fixture(intercept: (sql: string, execute: () => void) => void = (_sql, execute) => execute()) {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE facts(value INTEGER)');
  const sql: string[] = [], rows: any[] = [];
  const proxy = new Proxy(db, { get(target, key) {
    if (key === 'exec') return (statement: string) => { sql.push(statement); intercept(statement, () => target.exec(statement)); };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { db, proxy, sql, rows, diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line))) };
}
const operations = {
  'auth-audit-initialize': 'auth_audit_initialize', 'auth-audit-append': 'auth_audit_append',
  'auth-audit-page': 'auth_audit_page', 'auth-audit-list': 'auth_audit_list',
  'native-token-snapshot': 'native_token_snapshot', 'native-token-cumulative': 'native_token_cumulative',
  'hermes-journal-change': 'hermes_journal', 'claude-transcript-append': 'claude_transcript_append',
  'copilot-transcript-append': 'copilot_transcript_append', 'sdk-transcript-counts-install': 'sdk_transcript_counts_install',
  'sdk-execution-change': 'sdk_execution_journal',
  'turn-bootstrap-body': 'turn_bootstrap_body',
  'session-file-index-rebuild': 'file_index_rebuild', 'session-file-index-change': 'optional_file_index',
  'hub-identity-change': 'hub_identity_write', 'weixin-binding-change': 'weixin',
  'role-access-change': 'role_access', 'execution-issuer-change': 'configure_execution_issuer',
  'execution-usage-migration': 'execution_usage_migration', 'execution-usage-reserve': 'execution_usage_reserve',
  'session-creation-ownership': 'session_creation_ownership',
  'session-share-change': 'session_share',
  'workspace-board-binding-change': 'workspace_board_binding',
  'workspace-board-file-change': 'workspace_board_file',
  'workspace-card-file-change': 'workspace_card_file',
  'workspace-board-capability-change': 'workspace_board_capability',
  'workspace-card-configuration-change': 'workspace_card_configuration',
  'workspace-card-change': 'workspace_card_write',
  'workspace-board-change': 'workspace_board_write',
  'workspace-drawing-change': 'workspace_drawing_write',
  'workspace-native-drawio-change': 'native_drawio_write',
  'workspace-report-change': 'workspace_report',
  'workspace-file-prepare': 'workspace_file_prepare',
  'workspace-file-write-prepare': 'workspace_file_write_prepare',
  'workspace-file-revoke': 'workspace_file_revoke',
  'workspace-file-reconcile': 'workspace_file_reconcile',
  'notebook-bound-move': 'notebook_bound_move',
  'notebook-bound-finish': 'notebook_bound_finish',
  'notebook-bound-prepare': 'notebook_bound_prepare',
  'archive-upgrade-prepare': 'archive_upgrade_prepare',
} as const;
for (const operation of Object.keys(operations) as (keyof typeof operations)[]) {
  const name = operations[operation];
  for (const nested of [false, true]) for (const executed of [false, true])
    test(`${operation}: lost SAVEPOINT ACK preserves parent and never runs work (${nested}/${executed})`, () => {
      const original = Error('private-begin'), f = fixture((sql, execute) => {
        if (sql === `SAVEPOINT ${name}`) { if (executed) execute(); throw original; }
        execute();
      });
      try {
        if (nested) f.db.exec('BEGIN; INSERT INTO facts VALUES(1)');
        assert.throws(() => observedSavepoint(f.proxy, operation, () => assert.fail('work replayed'), f.diagnostics), error => error === original);
        assert.equal(f.db.isTransaction, nested);
        assert.equal(f.db.prepare('SELECT count(*) n FROM facts').get()!.n, Number(nested));
        assert.equal(f.rows[0].unknown, 1);
        if (nested) assert.deepEqual(f.sql, [`SAVEPOINT ${name}`], 'only parent may clean up uncertain acquisition');
      } finally { f.db.close(); }
    });
  for (const nested of [false, true]) test(`${operation}: success preserves deferred savepoint and enclosing owner`, () => {
    const f = fixture(); let calls = 0;
    try {
      if (nested) f.db.exec('BEGIN; INSERT INTO facts VALUES(1)');
      assert.equal(observedSavepoint(f.proxy, operation, () => { calls++; f.db.exec('INSERT INTO facts VALUES(2)'); return 42; }, f.diagnostics), 42);
      assert.equal(calls, 1); assert.deepEqual(f.sql, [`SAVEPOINT ${name}`, `RELEASE ${name}`]);
      assert.equal(f.db.isTransaction, nested); assert.equal(f.rows[0].settled, Number(!nested));
      if (nested) { f.db.exec('ROLLBACK'); assert.equal(f.db.prepare('SELECT count(*) n FROM facts').get()!.n, 0); }
    } finally { f.db.close(); }
  });
  for (const executed of [false, true]) test(`${operation}: lost RELEASE before/after effect is unknown without replay (${executed})`, () => {
    const original = Error('private-release'), f = fixture((sql, execute) => {
      if (sql === `RELEASE ${name}`) { if (executed) execute(); throw original; } execute();
    }); let calls = 0;
    try {
      assert.throws(() => observedSavepoint(f.proxy, operation, () => { calls++; f.db.exec('INSERT INTO facts VALUES(1)'); }, f.diagnostics), error => error === original);
      assert.equal(calls, 1); assert.equal(f.db.isTransaction, false); assert.equal(f.rows[0].unknown, 1);
      assert.equal(f.db.prepare('SELECT count(*) n FROM facts').get()!.n, Number(executed));
      assert.doesNotMatch(JSON.stringify(f.rows), /private|facts|RELEASE/);
    } finally { f.db.close(); }
  });
  for (const nested of [false, true]) for (const executed of [false, true]) test(`${operation}: failed rollback never masks original (${nested}/${executed})`, () => {
    const original = Error('private-body'), rollback = nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK';
    const f = fixture((sql, execute) => { if (sql === rollback) { if (executed) execute(); throw Error('private-cleanup'); } execute(); });
    try {
      if (nested) f.db.exec('BEGIN; INSERT INTO facts VALUES(1)');
      assert.throws(() => observedSavepoint(f.proxy, operation, () => { f.db.exec('INSERT INTO facts VALUES(2)'); throw original; }, f.diagnostics), error => error === original);
      assert.equal(f.rows[0].unknown, 1); assert.equal(f.rows[0].rollbackFailed, 1);
      assert.equal(f.db.isTransaction, nested || !executed);
      if (nested && executed) assert.deepEqual(f.db.prepare('SELECT value FROM facts').all().map(row => row.value), [1]);
      assert.doesNotMatch(JSON.stringify(f.rows), /private|cleanup|facts/);
      if (f.db.isTransaction) f.db.exec('ROLLBACK');
    } finally { f.db.close(); }
  });
  test(`${operation}: failed begin and automatic SQLite rollback do not attempt extra cleanup`, () => {
    const original = Error('begin'), f = fixture(() => { throw original; });
    try {
      assert.throws(() => observedSavepoint(f.proxy, operation, () => assert.fail('work'), f.diagnostics), error => error === original);
      assert.deepEqual(f.sql, [`SAVEPOINT ${name}`]); assert.equal(f.rows[0].unknown, 1);
    } finally { f.db.close(); }
    const g = fixture();
    try {
      g.db.exec("CREATE TRIGGER reject_fact BEFORE INSERT ON facts BEGIN SELECT RAISE(ROLLBACK,'original-trigger'); END");
      assert.throws(() => observedSavepoint(g.proxy, operation, () => g.db.exec('INSERT INTO facts VALUES(1)'), g.diagnostics), /original-trigger/);
      assert.deepEqual(g.sql, [`SAVEPOINT ${name}`]); assert.equal(g.db.isTransaction, false);
    } finally { g.db.close(); }
  });
}
test('savepoint rejects untyped async work and invalid operation names', () => {
  const f = fixture();
  try {
    assert.throws(() => observedSavepoint(f.proxy, 'native-token-snapshot', (() => Promise.resolve(1)) as any, f.diagnostics), /synchronous/);
    assert.equal(f.db.isTransaction, false);
    assert.throws(() => observedSavepoint(f.proxy, 'injected SQL' as any, () => assert.fail('work'), f.diagnostics), /Unsupported/);
    assert.equal(f.rows.length, 1);
  } finally { f.db.close(); }
});

for (const phase of [1, 2, 3] as const) test(`savepoint failure phase ${phase} preserves safe SQL evidence and original error`, () => {
  const original = Object.assign(Error('private-sql-secret'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  const f = fixture((sql, execute) => {
    if (phase === 1 && sql.startsWith('SAVEPOINT') || phase === 3 && sql.startsWith('RELEASE')) throw original;
    execute();
  });
  let calls = 0;
  try {
    assert.throws(() => observedSavepoint(f.proxy, 'native-token-snapshot', () => {
      calls++; if (phase === 2) throw original;
    }, f.diagnostics), error => error === original);
    assert.equal(calls, phase === 1 ? 0 : 1);
    assert.equal(f.rows[0].step, phase); assert.equal(f.rows[0].sqlErrorCode, 5);
    assert.doesNotMatch(JSON.stringify(f.rows), /private-sql|secret|SAVEPOINT|RELEASE/);
  } finally { f.db.close(); }
});

test('savepoint rollback code is separate from the original SQL rejection', () => {
  const original = Object.assign(Error('original-secret'), { code: 'ERR_SQLITE_ERROR', errcode: 19 });
  const rollback = Object.assign(Error('rollback-secret'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
  const f = fixture((sql, execute) => { if (sql.startsWith('ROLLBACK')) throw rollback; execute(); });
  try {
    assert.throws(() => observedSavepoint(f.proxy, 'native-token-snapshot', () => { throw original; }, f.diagnostics), error => error === original);
    assert.equal(f.rows[0].step, 2); assert.equal(f.rows[0].sqlErrorCode, 19);
    assert.equal(f.rows[0].rollbackErrorCode, 10); assert.equal(f.rows[0].unknown, 1);
    assert.equal(f.db.isTransaction, true);
    assert.doesNotMatch(JSON.stringify(f.rows), /original-secret|rollback-secret/);
  } finally { f.db.close(); }
});
