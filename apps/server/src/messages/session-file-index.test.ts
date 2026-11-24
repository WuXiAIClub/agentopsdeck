import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { validateSessionFilePage, type ChatMessage } from '@agentopsdeck/shared';
import { FILE_INDEX_BYTES, FILE_INDEX_ROWS, FileIndexCursorError, SessionFileIndex } from './session-file-index.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

const key = 'codex:one';
const message = (i: number, sessionKey = key): ChatMessage => ({ id: `tool:${i}`, sessionKey, role: 'tool',
  toolPhase: 'result', status: 'sent', createdAt: i, text: '', sourceFiles: [{ path: `/project/file-${i}.ts`, kind: 'modified' }] });

test('optional index cleanup failure fails native owner closed until explicit parent rollback', () => {
  const db = recoverableConnection(new DatabaseSync(':memory:')), index = new SessionFileIndex(db);
  const exec = db.exec.bind(db);
  try {
    index.append(key, 'native', [message(1)]);
    db.exec("CREATE TRIGGER fail_summary BEFORE INSERT ON session_file_summary BEGIN SELECT RAISE(ABORT, 'original-summary'); END; BEGIN");
    db.exec = sql => { if (sql.startsWith('ROLLBACK TO optional_file_index')) throw Error('private-cleanup'); exec(sql); };
    assert.throws(() => index.append(key, 'native', [message(2)]), /original-summary/);
    assert.equal(connectionRecoverySnapshot(db).state, 'parent-rollback-required');
    assert.throws(() => db.exec('COMMIT'), StorageConnectionUnavailable);
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT count(*) n FROM session_file_evidence').get()!.n, 1);
    assert.equal(index.page(key).coverage, 'stale');
  } finally { db.close(); }
});

test('explicit rebuild preserves original error when rollback fails; later recovery does not replay', () => {
  const db = recoverableConnection(new DatabaseSync(':memory:')), index = new SessionFileIndex(db);
  const exec = db.exec.bind(db);
  try {
    index.append(key, 'native', [message(1)]);
    const entries = index.page(key).entries, expected = index.fence(key);
    db.exec("CREATE TRIGGER fail_summary BEFORE INSERT ON session_file_summary BEGIN SELECT RAISE(ABORT, 'original-summary'); END");
    db.exec = sql => { if (sql === 'ROLLBACK') throw Error('private-cleanup'); exec(sql); };
    assert.throws(() => index.replaceDurable(key, 'native', expected, entries, false), /original-summary/);
    assert.equal(connectionRecoverySnapshot(db).state, 'owner-rollback-required');
    db.exec = exec;
    assert.equal(index.page(key).coverage, 'unavailable', 'recovery access aborts; optional read degrades safely');
    assert.deepEqual(index.page(key).entries, entries);
    assert.equal(index.fence(key), expected);
  } finally { db.close(); }
});

test('index is durable, scoped, idempotent and stores metadata only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-index-')), file = join(dir, 'test.sqlite');
  let db = new DatabaseSync(file), index = new SessionFileIndex(db);
  try {
    index.append(key, 'native', [{ ...message(1), text: 'PRIVATE_TOOL_BODY', toolPreview: 'PRIVATE_INPUT' }, message(2, 'codex:other')]);
    const first = index.page(key);
    assert.equal(first.coverage, 'partial'); assert.equal(first.entries.length, 1);
    index.append(key, 'native', [message(1)]);
    assert.deepEqual(index.page(key), first);
    assert.equal(index.page('codex:other').coverage, 'unavailable');
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM session_file_evidence').all()).includes('PRIVATE'));
    db.close(); db = new DatabaseSync(file); index = new SessionFileIndex(db);
    assert.deepEqual(index.page(key), first);
    index.append(key, 'replacement-native', [message(3)]);
    assert.deepEqual(index.page(key).entries.map(e => e.messageId), ['tool:3']);
    assert.notEqual(index.page(key).generation, first.generation);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('retained evidence range covers all pages, ignores append order and follows pruning and rollback', () => {
  const db = new DatabaseSync(':memory:'), index = new SessionFileIndex(db);
  try {
    index.append(key, 'native', [message(200), ...Array.from({ length: 70 }, (_, i) => message(i))]);
    const first = index.page(key);
    assert.deepEqual(first.retained, { count: 71, earliest: 0, latest: 200 });
    assert.deepEqual(index.page(key, first.nextCursor!).retained, first.retained);
    const changed = Number(db.prepare('SELECT total_changes() AS n').get()!.n);
    for (let i = 0; i < 10; i++) { index.page(key); index.append(key, 'native', [message(1)]); }
    assert.equal(Number(db.prepare('SELECT total_changes() AS n').get()!.n), changed, 'unchanged evidence and reads never rewrite summary');
    db.exec('SAVEPOINT outer_transcript'); index.append(key, 'native', [message(1000)]);
    assert.equal(index.page(key).retained!.latest, 1000);
    db.exec('ROLLBACK TO outer_transcript; RELEASE outer_transcript');
    assert.deepEqual(index.page(key), first);
    index.append(key, 'native', Array.from({ length: FILE_INDEX_ROWS }, (_, i) => message(1000 + i)));
    assert.deepEqual(index.page(key).retained, { count: FILE_INDEX_ROWS, earliest: 1000, latest: 1000 + FILE_INDEX_ROWS - 1 });
    assert.equal(index.page(key).limited, true);
    index.append(key, 'new-native', []);
    assert.deepEqual(index.page(key).retained, { count: 0, earliest: null, latest: null });
  } finally { db.close(); }
});
test('legacy summaries are optional; stale revisions never present old ranges and summary failures roll back evidence', () => {
  const db = new DatabaseSync(':memory:'), index = new SessionFileIndex(db);
  try {
    index.append(key, 'native', [message(1)]);
    db.prepare('UPDATE session_file_indexes SET revision = revision + 1 WHERE session_key = ?').run(key);
    assert.equal(index.page(key).retained, undefined);
    index.append(key, 'native', [message(2)]);
    assert.deepEqual(index.page(key).retained, { count: 2, earliest: 1, latest: 2 });
    db.exec(`CREATE TRIGGER fail_summary BEFORE INSERT ON session_file_summary BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
    index.append(key, 'native', [message(3)]);
    const failed = index.page(key);
    assert.equal(failed.coverage, 'stale'); assert.equal(failed.retained, undefined);
    assert.deepEqual(failed.entries.map(row => row.createdAt), [2, 1]);
  } finally { db.close(); }
});
test('upstream retained range validates bounds, empty state, per-page containment and strips unknown fields', () => {
  const db = new DatabaseSync(':memory:'), index = new SessionFileIndex(db);
  try {
    index.append(key, 'native', [message(10)]); const page = index.page(key);
    for (const retained of [null, { count: -1, earliest: 0, latest: 10 }, { count: 4001, earliest: 0, latest: 10 },
      { count: 1, earliest: null, latest: null }, { count: 0, earliest: null, latest: null }, { count: 1, earliest: 11, latest: 12 },
      { count: 1, earliest: 0, latest: 9 }, { count: 1, earliest: 10, latest: 1 }, { count: 1, earliest: NaN, latest: 10 }])
      assert.throws(() => validateSessionFilePage({ ...page, retained } as any));
    assert.deepEqual(validateSessionFilePage({ ...page, retained: { ...page.retained!, secret: 'discard' } } as any), page);
    const { retained: _old, ...old } = page; assert.deepEqual(validateSessionFilePage(old), old);
    index.replaceProjection(key, []);
    assert.deepEqual(validateSessionFilePage(index.page(key)).retained, { count: 0, earliest: null, latest: null });
  } finally { db.close(); }
});

test('transaction rollback, conflicting identities and broken optional index never settle native work', () => {
  const db = new DatabaseSync(':memory:'), index = new SessionFileIndex(db);
  try {
    db.exec('SAVEPOINT transcript'); index.append(key, 'native', [message(1)]);
    db.exec('ROLLBACK TO transcript; RELEASE transcript');
    assert.equal(index.page(key).coverage, 'unavailable');
    index.append(key, 'native', [message(1)]);
    index.append(key, 'native', [{ ...message(1), sourceFiles: [{ path: '/project/file-1.ts', kind: 'deleted' }] }]);
    assert.equal(index.page(key).coverage, 'stale');
    assert.equal(index.page(key).entries[0]!.kind, 'modified');
    db.exec('DROP TABLE session_file_evidence; CREATE TABLE native_receipt(id TEXT)');
    db.exec('SAVEPOINT transcript');
    db.prepare('INSERT INTO native_receipt VALUES (?)').run('real-receipt');
    assert.doesNotThrow(() => index.append(key, 'native', [message(2)]));
    db.exec('RELEASE transcript');
    assert.equal(db.prepare('SELECT count(*) AS n FROM native_receipt').get()!.n, 1);
    assert.equal(index.page(key).coverage, 'unavailable');
  } finally { db.close(); }
});

test('pagination rejects old revisions, other sessions, malformed cursors and projection truncation', () => {
  const db = new DatabaseSync(':memory:'), index = new SessionFileIndex(db);
  try {
    const messages = Array.from({ length: 120 }, (_, i) => message(i));
    index.replaceProjection(key, messages);
    const first = index.page(key), second = index.page(key, first.nextCursor!);
    assert.equal(first.entries.length, 50); assert.equal(second.entries.length, 50);
    assert.equal(new Set([...first.entries, ...second.entries].map(e => e.messageId)).size, 100);
    assert.equal(index.page(key, second.nextCursor).entries.length, 20);
    index.replaceProjection(key, messages);
    assert.deepEqual(index.page(key), first, 'unchanged native evidence does not rewrite or change cursors');
    assert.throws(() => index.page('codex:other', first.nextCursor), FileIndexCursorError);
    assert.throws(() => index.page(key, 'bad'), FileIndexCursorError);
    index.replaceProjection(key, [message(200)]);
    assert.throws(() => index.page(key, first.nextCursor), FileIndexCursorError);
    assert.equal(index.page(key).entries.length, 1, 'native truncation cannot retain old paths');
    index.replaceProjection(key, []);
    assert.equal(index.page(key).entries.length, 0);
  } finally { db.close(); }
});

test('500 MiB-equivalent messages are not read; repeated lists stay bounded for 12 panes', () => {
  const db = new DatabaseSync(':memory:'), index = new SessionFileIndex(db);
  try {
    let bodiesRead = 0;
    const messages = Array.from({ length: 10_000 }, (_, i) => {
      const row = message(i);
      Object.defineProperty(row, 'text', { get() { bodiesRead++; throw new Error('must not read ~52KiB body'); } });
      return row;
    });
    const start = performance.now(); index.replaceProjection(key, messages);
    const first = index.page(key);
    assert.equal(first.limited, true); assert.equal(first.entries[0]!.messageId, 'tool:9999');
    const totals = db.prepare('SELECT count(*) AS count, sum(bytes) AS bytes FROM session_file_evidence').get()!;
    assert.equal(totals.count, FILE_INDEX_ROWS); assert.ok(Number(totals.bytes) <= FILE_INDEX_BYTES);
    for (let pane = 0; pane < 12; pane++) for (let read = 0; read < 10; read++) {
      const page = index.page(key); assert.equal(page.entries.length, 50); assert.ok(Buffer.byteLength(JSON.stringify(page)) < 100 * 1024);
    }
    assert.equal(bodiesRead, 0);
    console.info(JSON.stringify({ benchmark: 'file-index-metadata-only', simulatedHistoryMiB: 500, retainedRows: totals.count,
      reads: 120, elapsedMs: Math.round(performance.now() - start), pageBytes: Buffer.byteLength(JSON.stringify(first)) }));
  } finally { db.close(); }
});

test('only completed structured tool results qualify; invalid upstream evidence and URLs are rejected', () => {
  const db = new DatabaseSync(':memory:'), index = new SessionFileIndex(db);
  try {
    index.replaceProjection(key, [message(1), { ...message(2), status: 'failed' }, { ...message(3), role: 'assistant' },
      { ...message(4), toolPhase: 'call' }, { ...message(5), sourceFiles: [{ path: '../relative', kind: 'modified' }] }]);
    const page = index.page(key); assert.equal(page.entries.length, 1);
    assert.deepEqual(validateSessionFilePage({ ...page, entries: [{ ...page.entries[0]!, media: { type: 'file', name: 'bad', url: 'https://untrusted' } }] }), page);
    assert.throws(() => validateSessionFilePage({ ...page, entries: [{ ...page.entries[0]!, path: '/etc/passwd' }] }));
    assert.throws(() => validateSessionFilePage({ ...page, revision: NaN }));
  } finally { db.close(); }
});

test('append reports input truncation and keeps the warning until explicit rebuild', () => {
  const db = new DatabaseSync(':memory:'), index = new SessionFileIndex(db);
  try {
    const messages = Array.from({ length: FILE_INDEX_ROWS + 1 }, (_, i) => message(i));
    index.append(key, 'native', messages);
    const first = index.page(key);
    assert.equal(first.limited, true);
    assert.equal(first.entries[0]!.messageId, `tool:${FILE_INDEX_ROWS}`);
    assert.equal(db.prepare('SELECT count(*) AS n FROM session_file_evidence').get()!.n, FILE_INDEX_ROWS);
    index.append(key, 'native', [messages.at(-1)!]);
    assert.deepEqual(index.page(key), first, 'duplicate-only retry must not reset coverage or revision');
    index.replaceDurable(key, 'native', index.fence(key), first.entries.slice().reverse(), false);
    assert.equal(index.page(key).limited, false, 'only an explicit verified replacement can restore the scope');
  } finally { db.close(); }
});

test('a newly discovered truncation invalidates cursors even without new file rows', () => {
  const db = new DatabaseSync(':memory:'), index = new SessionFileIndex(db);
  try {
    const messages = Array.from({ length: 60 }, (_, i) => message(i));
    index.append(key, 'native', messages);
    const first = index.page(key), fence = index.fence(key);
    const empty = { ...message(100), sourceFiles: [] };
    index.append(key, 'native', Array.from({ length: 100_001 }, () => empty));
    const limited = index.page(key);
    assert.equal(limited.limited, true);
    assert.deepEqual(limited.entries, first.entries);
    assert.notEqual(index.fence(key), fence);
    assert.throws(() => index.page(key, first.nextCursor), FileIndexCursorError);
    index.append(key, 'native', Array.from({ length: 100_001 }, () => empty));
    assert.deepEqual(index.page(key), limited);
  } finally { db.close(); }
});

for (const source of ['append', 'projection'] as const) {
  test(`${source}: duplicate evidence does not crowd distinct files out of the budget`, () => {
    const db = new DatabaseSync(':memory:'), index = new SessionFileIndex(db);
    try {
      const messages = [message(1), ...Array.from({ length: FILE_INDEX_ROWS + 1 }, () => message(2))];
      if (source === 'append') index.append(key, 'native', messages);
      else index.replaceProjection(key, messages);
      const first = index.page(key);
      assert.deepEqual(first.entries.map(e => e.messageId), ['tool:2', 'tool:1']);
      assert.equal(first.limited, false);
      if (source === 'append') index.append(key, 'native', [message(1), message(2)]);
      else index.replaceProjection(key, [message(1), message(2)]);
      assert.deepEqual(index.page(key), first, 'duplicate representation does not change the index generation');
    } finally { db.close(); }
  });
}

test('empty evidence on a new native binding replaces old paths and invalidates old cursors', () => {
  const db = new DatabaseSync(':memory:'), index = new SessionFileIndex(db);
  try {
    index.append(key, 'native', Array.from({ length: 60 }, (_, i) => message(i)));
    const first = index.page(key);
    index.append(key, 'replacement', [{ ...message(200), sourceFiles: [] }]);
    const next = index.page(key, undefined, 'replacement');
    assert.equal(next.coverage, 'partial');
    assert.deepEqual(next.entries, []);
    assert.equal(next.limited, false);
    assert.notEqual(next.generation, first.generation);
    assert.deepEqual(index.page(key), next, 'unfenced readers cannot get prior native paths');
    assert.throws(() => index.page(key, first.nextCursor), FileIndexCursorError);
    index.append(key, 'replacement', []);
    assert.deepEqual(index.page(key), next);
    assert.equal(index.page(key, undefined, 'native').coverage, 'unavailable');
  } finally { db.close(); }
});

test('byte-limited append preserves truncation across reopen and resets only for a new binding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-index-budget-')), file = join(dir, 'test.sqlite');
  let db = new DatabaseSync(file), index = new SessionFileIndex(db);
  try {
    const messages = Array.from({ length: 1200 }, (_, i) => ({ ...message(i),
      sourceFiles: [{ path: `/project/${'x'.repeat(1950)}/${i}.ts`, kind: 'modified' as const }] }));
    index.append(key, 'native', messages);
    const first = index.page(key);
    assert.equal(first.limited, true);
    const totals = db.prepare('SELECT count(*) AS n, sum(bytes) AS bytes FROM session_file_evidence').get()!;
    assert.ok(Number(totals.n) < messages.length);
    assert.ok(Number(totals.bytes) <= FILE_INDEX_BYTES);
    db.close(); db = new DatabaseSync(file); index = new SessionFileIndex(db);
    assert.deepEqual(index.page(key), first);
    index.append(key, 'native', [messages.at(-1)!]);
    assert.deepEqual(index.page(key), first);
    index.append(key, 'replacement', []);
    assert.equal(index.page(key).limited, false);
    assert.deepEqual(index.page(key).entries, []);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('empty binding changes and coverage updates roll back with the owning transcript transaction', () => {
  const db = new DatabaseSync(':memory:'), index = new SessionFileIndex(db);
  try {
    index.append(key, 'native', [message(1)]);
    const original = index.page(key);
    for (const native of ['native', 'replacement']) {
      db.exec('SAVEPOINT transcript');
      index.append(key, native, Array.from({ length: 100_001 }, () => ({ ...message(2), sourceFiles: [] })));
      assert.equal(index.page(key).limited, true);
      db.exec('ROLLBACK TO transcript; RELEASE transcript');
      assert.deepEqual(index.page(key), original);
    }
  } finally { db.close(); }
});

for (const source of ['append', 'projection'] as const) {
  test(`${source}: conflicting duplicates preserve the old evidence and mark it stale`, () => {
    const db = new DatabaseSync(':memory:'), index = new SessionFileIndex(db);
    try {
      index.append(key, 'native', [message(1)]);
      const original = index.page(key), rows = [message(2), { ...message(2), createdAt: 3 }];
      if (source === 'append') index.append(key, 'replacement', rows);
      else index.replaceProjection(key, rows);
      const stale = index.page(key);
      assert.equal(stale.coverage, 'stale');
      assert.equal(stale.generation, original.generation);
      assert.deepEqual(stale.entries, original.entries);
    } finally { db.close(); }
  });
}
