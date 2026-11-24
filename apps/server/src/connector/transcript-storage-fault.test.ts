import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ClaudeTranscriptStore } from '../claude/transcript-store.js';
import { projectClaudeMessage } from '../claude/message-projection.js';
import { CopilotTranscriptStore } from '../copilot/transcript-store.js';
import { projectCopilotMessage } from '../copilot/message-projection.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { SdkExecutionJournal } from './sdk-execution-journal.js';

// All tables belong to an isolated fixture, including queue, execution facts,
// transcript, display identities and file index. Never inspect a live owner DB.
function facts(db: DatabaseSync) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => ({
    name: row.name, rows: db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all(),
  }));
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  function fixture(db: DatabaseSync, transcriptDb = db) {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE parent_work(value TEXT)');
    const turns = new TurnQueue(db), journal = new SdkExecutionJournal(db, runtime);
    const key = `${runtime}:storage-fault`, ref = { key, id: 'execution', epoch: 'epoch' };
    journal.create({ key, nativeSessionId: 'native', title: 'Synthetic', createdAt: 0 });
    turns.enqueue(runtime, { id: 'first', sessionKey: key, createdAt: 0, payload: { text: 'Hello' } });
    journal.begin(ref, ['first'], turns);
    const cc = runtime === 'claude-code' ? new ClaudeTranscriptStore(transcriptDb) : undefined;
    const ghcp = runtime === 'ghcp' ? new CopilotTranscriptStore(transcriptDb) : undefined;
    const append = (id: string, text: string) => {
      if (cc) cc.append(ref, projectClaudeMessage({ type: 'assistant', uuid: id, session_id: 'native',
        parent_tool_use_id: null, message: { role: 'assistant', content: text } }, 'native'));
      else ghcp!.append(ref, projectCopilotMessage({ id, type: 'assistant.message',
        timestamp: new Date(1).toISOString(), data: { messageId: id, content: text } })!);
    };
    append('existing', 'Preserved history');
    return { append };
  }

  for (const effected of [false, true]) test(`${runtime}: lost transcript RELEASE never replays writes (${effected})`, t => {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    let armed = false, releases = 0;
    const name = runtime === 'claude-code' ? 'claude_transcript_append' : 'copilot_transcript_append';
    const table = runtime === 'claude-code' ? 'claude_transcript_messages' : 'copilot_transcript_messages';
    const original = Error('private-release');
    const proxy = new Proxy(db, { get(target, key) {
      if (key === 'exec') return (sql: string) => {
        if (armed && sql === `RELEASE ${name}`) { releases++; if (effected) target.exec(sql); throw original; }
        target.exec(sql);
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const f = fixture(db, proxy); armed = true;
    assert.throws(() => f.append('lost-release', 'Synthetic history'), error => error === original);
    assert.equal(releases, 1); assert.equal(db.isTransaction, false);
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 1 + Number(effected));
    armed = false; f.append('distinct-event', 'Explicit later event');
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 2 + Number(effected));
  });

  for (const nested of [false, true]) for (const effected of [false, true]) test(`${runtime}: cleanup failure retains original trigger error (${nested}/${effected})`, t => {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close()); let armed = false;
    const name = runtime === 'claude-code' ? 'claude_transcript_append' : 'copilot_transcript_append';
    const table = runtime === 'claude-code' ? 'claude_transcript_messages' : 'copilot_transcript_messages';
    const proxy = new Proxy(db, { get(target, key) {
      if (key === 'exec') return (sql: string) => {
        if (armed && sql === (nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK')) {
          if (effected) target.exec(sql); throw Error('cleanup-only');
        } target.exec(sql);
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const f = fixture(db, proxy);
    db.exec(`CREATE TRIGGER reject_transcript BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'original-trigger'); END`);
    if (nested) db.exec("BEGIN; INSERT INTO parent_work VALUES('parent')");
    armed = true;
    assert.throws(() => f.append('rejected', 'Synthetic history'), /original-trigger/);
    assert.equal(db.isTransaction, nested || !effected);
    if (nested && effected) assert.deepEqual(db.prepare('SELECT value FROM parent_work').all().map(row => row.value), ['parent']);
    if (db.isTransaction) db.exec('ROLLBACK');
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 1);
  });

  for (const nested of [false, true]) {
    test(`${runtime}: transcript SQLITE_FULL preserves original error and durable facts (parent=${nested})`, t => {
      const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-transcript-full-'));
      const db = new DatabaseSync(join(dir, 'state.sqlite'));
      t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
      const f = fixture(db), before = facts(db);
      const pages = Number(db.prepare('PRAGMA page_count').get()!.page_count);
      const previousLimit = Number(db.prepare('PRAGMA max_page_count').get()!.max_page_count);
      db.exec(`PRAGMA max_page_count=${pages + 1}`);
      if (nested) db.exec("BEGIN IMMEDIATE; INSERT INTO parent_work VALUES ('uncommitted')");
      assert.throws(() => f.append('too-large', 'x'.repeat(128 * 1024)),
        (error: unknown) => error instanceof Error && (error as Error & { errcode: number }).errcode === 13);
      // SQLite may abort the whole transaction OR only the failing statement
      // (e.g. with count triggers installed). Neither permits partial history.
      if (db.isTransaction) {
        assert.equal(nested, true, 'standalone append must not leave a transaction');
        assert.deepEqual(db.prepare('SELECT value FROM parent_work').all().map(row => row.value), ['uncommitted']);
        db.exec('ROLLBACK');
      }
      assert.deepEqual(facts(db), before, 'no partial transcript, index, admission or execution changes');
      db.exec(`PRAGMA max_page_count=${previousLimit}`);
      f.append('distinct-later-event', 'Explicit later event after storage recovery');
      assert.equal(db.isTransaction, false);
    });
  }

  test(`${runtime}: ordinary transcript abort rolls back only its savepoint, not caller work`, t => {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    const f = fixture(db);
    const target = runtime === 'claude-code' ? 'claude_transcript_messages' : 'copilot_transcript_messages';
    db.exec(`CREATE TRIGGER fail_transcript AFTER INSERT ON ${target}
      BEGIN SELECT RAISE(ABORT, 'synthetic transcript failure'); END`);
    db.exec("BEGIN IMMEDIATE; INSERT INTO parent_work VALUES ('caller work')");
    const before = facts(db);
    assert.throws(() => f.append('failed-event', 'Must not partially persist'), /synthetic transcript failure/);
    assert.equal(db.isTransaction, true, 'caller still owns its transaction');
    assert.deepEqual(facts(db), before);
    db.exec('COMMIT; DROP TRIGGER fail_transcript');
    assert.equal(db.prepare('SELECT count(*) AS n FROM parent_work').get()!.n, 1);
    f.append('distinct-later-event', 'New explicit event');
  });
}
