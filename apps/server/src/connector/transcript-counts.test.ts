import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { TranscriptCounts } from './transcript-counts.js';
import { ClaudeTranscriptStore } from '../claude/transcript-store.js';
import { CopilotTranscriptStore } from '../copilot/transcript-store.js';

for (const runtime of ['claude-code', 'ghcp'] as const) {
  const table = runtime === 'claude-code' ? 'claude_transcript_messages' : 'copilot_transcript_messages';
  const key = `${runtime}:count`, other = `${runtime}:other`;
  const index = runtime === 'claude-code' ? 'claude_transcript_block_counts' : 'copilot_transcript_page';
  const size = runtime === 'claude-code' ? 'json_array_length(data)' : '1';
  function schema(db: DatabaseSync) {
    if (runtime === 'claude-code') new ClaudeTranscriptStore(db); else new CopilotTranscriptStore(db);
  }
  function legacy(db: DatabaseSync) {
    schema(db);
    for (const type of ['insert', 'update', 'delete']) db.exec(`DROP TRIGGER ${table}_count_${type}`);
    db.exec('DROP TABLE sdk_transcript_counts; DROP TABLE sdk_transcript_counts_bootstrap');
  }
  function insert(db: DatabaseSync, sequence: number, blocks = 1, session = key) {
    // Count fixtures deliberately contain only a synthetic body array; public
    // projection validation/paging is covered by each real store's test suite.
    const data = JSON.stringify(Array.from({ length: blocks }, () => ({ text: '测试 🐟' })));
    if (runtime === 'claude-code') db.prepare(`INSERT INTO ${table}
      (sequence,session_key,execution_id,native_session_id,message_id,parent_id,data,created_at)
      VALUES (?,?,'execution','native',?,'',?,0)`).run(sequence, session, String(sequence), data);
    else db.prepare(`INSERT INTO ${table}
      (sequence,session_key,public_id,native_session_id,execution_id,event_id,data)
      VALUES (?,?,?,'native','execution',?,?)`).run(sequence, session, String(sequence), String(sequence), data);
  }
  function exact(db: DatabaseSync, counts: TranscriptCounts) {
    for (const session of [key, other, `${runtime}:empty`]) {
      const oracle = (before: number) => Number(db.prepare(`SELECT coalesce(sum(${size}),0) AS n FROM ${table}
        WHERE session_key=? AND sequence<?`).get(session, before)!.n);
      assert.equal(counts.count(session), oracle(Number.MAX_SAFE_INTEGER));
      for (const boundary of [1, 2, 511, 1023, 1024, 1025, 2048, 2049, 4096, 4097, 99999, Number.MAX_SAFE_INTEGER]) {
        assert.equal(counts.count(session, boundary), oracle(boundary), `${session} before ${boundary}`);
      }
    }
  }

  test(`${runtime}: exact legacy backfill, bucket edges, sparse sessions and bounded range plans`, t => {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close()); legacy(db);
    for (const [i, sequence] of [1, 511, 1023, 1024, 1025, 2048, 2049, 4096, 4097].entries()) insert(db, sequence, i % 4, i % 2 ? other : key);
    const counts = new TranscriptCounts(db, runtime); exact(db, counts);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT sum(${size}) FROM ${table} INDEXED BY ${index}
      WHERE session_key=? AND sequence>=? AND sequence<?`).all(key, 1024, 1500).map(r => r.detail).join(' ');
    assert.match(plan, /SEARCH/); assert.match(plan, /sequence>\? AND sequence<\?/);
    assert.doesNotMatch(plan, /SCAN .*transcript_messages/);
    const bucketPlan = db.prepare('EXPLAIN QUERY PLAN SELECT sum(blocks) FROM sdk_transcript_counts WHERE runtime=? AND session_key=? AND bucket<?')
      .all(runtime, key, 4).map(r => r.detail).join(' ');
    assert.match(bucketPlan, /SEARCH .*PRIMARY KEY/);
    for (const invalid of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => counts.count(key, invalid));
  });

  test(`${runtime}: counts track inserts, ignored duplicates, deletes, moves and caller rollback`, t => {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close()); schema(db);
    const counts = new TranscriptCounts(db, runtime);
    insert(db, 1, 3); insert(db, 1024, 2); insert(db, 2048, 1, other); exact(db, counts);
    db.exec(`INSERT OR IGNORE INTO ${table} SELECT * FROM ${table}`); exact(db, counts);
    db.prepare(`UPDATE ${table} SET session_key=?,sequence=4097,data=? WHERE sequence=1`).run(other, JSON.stringify([1, 2, 3, 4]));
    exact(db, counts);
    const before = db.prepare('SELECT * FROM sdk_transcript_counts ORDER BY runtime,session_key,bucket').all();
    db.exec('BEGIN IMMEDIATE'); insert(db, 512, 2);
    db.exec(`DELETE FROM ${table} WHERE sequence=1024`); exact(db, counts);
    db.exec('ROLLBACK'); exact(db, counts);
    assert.deepEqual(db.prepare('SELECT * FROM sdk_transcript_counts ORDER BY runtime,session_key,bucket').all(), before);
    db.exec(`DELETE FROM ${table}`); exact(db, counts);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sdk_transcript_counts').get()!.n, 0);
  });

  test(`${runtime}: normal reopen never backfills; missing marker rebuilds exact counts once`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-count-reopen-')), file = join(dir, 'synthetic.sqlite');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let db = new DatabaseSync(file); db.exec('PRAGMA journal_mode=WAL'); schema(db); insert(db, 1024, 3); db.close();
    db = new DatabaseSync(file); t.after(() => db.close());
    let backfills = 0;
    const exec = db.exec.bind(db);
    db.exec = sql => { if (sql.includes('GROUP BY session_key,sequence')) backfills++; return exec(sql); };
    for (let i = 0; i < 4; i++) { schema(db); exact(db, new TranscriptCounts(db, runtime)); }
    assert.equal(backfills, 0);
    db.prepare('DELETE FROM sdk_transcript_counts_bootstrap WHERE runtime=?').run(runtime);
    db.prepare('UPDATE sdk_transcript_counts SET blocks=1000 WHERE runtime=?').run(runtime);
    exact(db, new TranscriptCounts(db, runtime)); assert.equal(backfills, 1);
    exact(db, new TranscriptCounts(db, runtime)); assert.equal(backfills, 1);
  });

  test(`${runtime}: failed migration cannot publish counts/marker; preserves parent transaction`, t => {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close()); legacy(db); insert(db, 1, 2);
    db.exec(`CREATE TABLE sdk_transcript_counts_bootstrap(runtime TEXT PRIMARY KEY NOT NULL);
      CREATE TRIGGER fail_marker BEFORE INSERT ON sdk_transcript_counts_bootstrap BEGIN SELECT RAISE(ABORT,'fail marker'); END;
      CREATE TABLE caller_work(value TEXT); BEGIN; INSERT INTO caller_work VALUES ('preserved');`);
    assert.throws(() => new TranscriptCounts(db, runtime), /fail marker/);
    assert.equal(db.isTransaction, true);
    assert.equal(db.prepare('SELECT count(*) AS n FROM caller_work').get()!.n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='sdk_transcript_counts'").get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sdk_transcript_counts_bootstrap').get()!.n, 0);
    db.exec('COMMIT; DROP TRIGGER fail_marker'); exact(db, new TranscriptCounts(db, runtime));
  });

  test(`${runtime}: real SQLITE_FULL during migration retains source and original error`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-count-full-')), db = new DatabaseSync(join(dir, 'synthetic.sqlite'));
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    db.exec('PRAGMA journal_mode=WAL'); legacy(db); insert(db, 1, 2);
    // Reuse free pages first: the max-page limit must force actual allocation.
    db.exec('VACUUM');
    const pages = db.prepare('PRAGMA page_count').get()!.page_count;
    db.exec(`PRAGMA max_page_count=${pages}`);
    assert.throws(() => new TranscriptCounts(db, runtime), (e: unknown) => (e as { errcode: number }).errcode === 13);
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='sdk_transcript_counts'").get()!.n, 0);
    db.exec('PRAGMA max_page_count=10000'); exact(db, new TranscriptCounts(db, runtime));
  });

  test(`${runtime}: abrupt owner exit preserves committed counts and discards uncommitted WAL work`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-count-crash-')), file = join(dir, 'synthetic.sqlite');
    let owner: DatabaseSync | undefined;
    // Close before deleting: Windows does not allow unlinking an open DB/WAL.
    t.after(() => { owner?.close(); rmSync(dir, { recursive: true, force: true }); });
    let db = new DatabaseSync(file); owner = db;
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL'); schema(db); insert(db, 1, 2); db.close(); owner = undefined;
    const statement = runtime === 'claude-code'
      ? `INSERT INTO ${table}(sequence,session_key,execution_id,native_session_id,message_id,parent_id,data,created_at)
        SELECT ?,session_key,execution_id,native_session_id,?,'',data,0 FROM ${table} WHERE sequence=1`
      : `INSERT INTO ${table}(sequence,session_key,public_id,native_session_id,execution_id,event_id,data)
        SELECT ?,session_key,?,native_session_id,execution_id,'event',data FROM ${table} WHERE sequence=1`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA synchronous=FULL; PRAGMA cache_size=8');
      const insert = db.prepare(${JSON.stringify(statement)});
      insert.run(2,'committed');
      db.exec('BEGIN IMMEDIATE');
      for(let i=3;i<3000;i++) insert.run(i,String(i));
      // Deliberately bypass close/finalizers with an active transaction.
      process.exit(17);
    `, file], { timeout: 15_000, encoding: 'utf8' });
    assert.equal(child.status, 17, child.stderr);
    db = new DatabaseSync(file); owner = db;
    const counts = new TranscriptCounts(db, runtime);
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 2);
    assert.equal(counts.count(key), runtime === 'claude-code' ? 4 : 2);
    exact(db, counts); assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
  });
}

test('CC and GHCP counters bootstrap independently on the same owning database', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  new ClaudeTranscriptStore(db); new CopilotTranscriptStore(db);
  assert.deepEqual(db.prepare('SELECT runtime FROM sdk_transcript_counts_bootstrap ORDER BY runtime').all().map(r => r.runtime), ['claude-code', 'ghcp']);
});
