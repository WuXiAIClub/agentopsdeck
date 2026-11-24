// Isolated pre-admission compatibility proof. Never opens production databases.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';

const [previousRoot, candidateRoot] = process.argv.slice(2);
const previous = await verifyCandidateRelease(previousRoot);
const candidate = await verifyCandidateRelease(candidateRoot);
const evidence = await mkdtemp(join(tmpdir(), 'agentopsdeck-file-board-schema-'));
const result = { passed: false, previous, candidate, checks: [], productionDataTouched: false };
console.log('EVIDENCE ' + evidence);
const quote = value => '"' + value.replaceAll('"', '""') + '"';
// Explicitly audited additive tables; unrelated migrations must still fail.
const additiveTables = new Set([
  'hub_workspace_board_file_bindings', 'hub_workspace_board_file_versions', 'hub_workspace_board_file_cancellations',
  'hub_workspace_native_file_locks', 'hub_workspace_file_writes',
  'hub_workspace_card_configurations', 'hub_workspace_card_configuration_receipts',
  'hub_workspace_reports', 'hub_workspace_report_receipts',
  'hub_workspace_card_file_bindings', 'hub_workspace_card_file_versions',
  'hub_workspace_card_file_cancellations', 'hub_workspace_card_file_writes',
  'connector_workspace_board_files', 'connector_workspace_file_writes',
  'connector_workspace_card_files', 'connector_workspace_card_file_writes', 'connector_workspace_card_file_kinds',
  'connector_codex_turn_contexts',
  // Native interaction state is additive. This permits only pre-admission
  // fallback with unchanged user data, never an old writer after new answers.
  'agent_interactions', 'agent_interaction_audit', 'agent_interaction_modes',
  // 2.3.5 additive, non-authoritative usage ledger and display-count cache.
  // Old writers keep count caches current through SQLite triggers.
  'native_token_baselines', 'native_token_samples',
  'sdk_transcript_counts', 'sdk_transcript_counts_bootstrap',
  // 2.3.6: Key-scoped Weixin data is additive and initially empty.
  'hub_weixin_bindings', 'hub_weixin_attempts', 'hub_weixin_receipts',
  'hub_weixin_deliveries', 'hub_weixin_targets',
  // The persistent limiter adds one explicit policy row, never rewrites users.
  'hub_login_limit_policy', 'hub_login_limit_buckets',
  // Optional file-index summary; old writers invalidate it through revision.
  'session_file_summary',
  // Bounded, reconstructible native file evidence, never read authority.
  // Constructor only adds empty tables; old writers neither read nor rewrite them.
  'session_file_projection_snapshots', 'session_file_projection_rows',
  // Independent cold notebooks: empty additive storage, no hot-note migration.
  'hub_notebook_archives',
]);
function snapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    return {
      tables: Object.fromEntries(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
        .map(({ name, sql }) => [name, { sql, rows: db.prepare('SELECT * FROM ' + quote(name)).all() }])),
      schemaObjects: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type <> 'table' ORDER BY type, name").all(),
    };
  } finally { db.close(); }
}
try {
  for (const [kind, modulePath, className] of [
    ['hub', 'hub/hub-store.js', 'HubStore'],
    ['connector', 'connector/connector-user-store.js', 'ConnectorUserStore'],
  ]) {
    const file = join(evidence, kind + '.sqlite');
    const open = async release => {
      const Store = (await import(join(release, 'apps/server/dist', modulePath)))[className];
      const store = kind === 'hub' ? new Store(file, 'synthetic-compatibility-secret') : new Store(file);
      if (kind === 'hub' && typeof store.createLoginLimiter === 'function') {
        store.createLoginLimiter({ maxFailures: 5, windowMs: 60_000, lockoutMs: 60_000, maxBuckets: 10_000 });
      }
      return store;
    };
    let store = await open(previousRoot);
    store.createUser('compatibility-fixture');
    await store.close();
    const before = snapshot(file);
    store = await open(candidateRoot); await store.close();
    if (kind === 'connector') {
      const { ConnectorFileBoards, ConnectorWorkspaceFiles } = await import(join(candidateRoot, 'apps/server/dist/connector/workspace-board-files.js'));
      const { cardFileCodec } = await import(join(candidateRoot, 'apps/server/dist/connector/workspace-file-card-format.js'));
      const db = new DatabaseSync(file);
      try {
        new ConnectorFileBoards(db, join(evidence, 'panels'), () => false);
        new ConnectorWorkspaceFiles(db, join(evidence, 'panels'), () => false, cardFileCodec());
      } finally { db.close(); }
    }
    const migrated = snapshot(file);
    for (const [name, value] of Object.entries(before.tables)) assert.deepEqual(migrated.tables[name], value, kind + ':' + name);
    const added = Object.keys(migrated.tables).filter(name => !Object.hasOwn(before.tables, name));
    // A successor may already include the feature schema. Zero new tables is
    // valid, but never accept a candidate that omitted file-board storage.
    assert.ok(Object.keys(migrated.tables).some(name => /workspace_board_file/.test(name)));
    assert.ok(added.every(name => additiveTables.has(name)), 'Unaudited additive tables: ' + added.filter(name => !additiveTables.has(name)).join(', '));
    for (const object of before.schemaObjects) {
      assert.deepEqual(migrated.schemaObjects.find(value => value.type === object.type && value.name === object.name),
        object, kind + ':' + object.type + ':' + object.name);
    }
    const addedObjects = migrated.schemaObjects.filter(object => !before.schemaObjects.some(value => value.type === object.type && value.name === object.name));
    assert.ok(addedObjects.every(object => object.type === 'index' && added.includes(object.tbl_name)),
      'Unaudited additive schema objects: ' + addedObjects.filter(object => object.type !== 'index' || !added.includes(object.tbl_name))
        .map(object => object.type + ':' + object.name).join(', '));
    for (const name of added) {
      if (name === 'sdk_transcript_counts_bootstrap') {
        assert.deepEqual(migrated.tables[name].rows.map(row => row.runtime).sort(), ['claude-code', 'ghcp']);
        assert.ok(migrated.tables[name].rows.every(row => Object.keys(row).length === 1));
      } else if (name === 'hub_login_limit_policy') {
        assert.deepEqual(migrated.tables[name].rows.map(row => ({ ...row })),
          [{ singleton: 1, policy: JSON.stringify([5, 60_000, 60_000, 10_000]) }]);
      } else assert.equal(migrated.tables[name].rows.length, 0, 'Unexpected initial rows: ' + name);
    }
    store = await open(previousRoot); await store.close();
    assert.deepEqual(snapshot(file), migrated, 'Old writer changed candidate state: ' + kind);
    store = await open(candidateRoot); await store.close();
    assert.deepEqual(snapshot(file), migrated, 'Candidate reopen changed persisted state: ' + kind);
    result.checks.push({ kind, addedTables: added, addedSchemaObjects: addedObjects,
      existingTablesAndRowsUnchanged: true, existingSchemaObjectsUnchanged: true, oldWriterReopen: true });
  }
  result.passed = true;
  result.scope = 'pre-admission unchanged/additive schema only; no rollback after new bindings or sends';
} catch (error) {
  result.error = { kind: error.name, message: error.message }; process.exitCode = 1;
}
await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify(result));
