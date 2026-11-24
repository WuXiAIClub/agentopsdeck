import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ChatMessage } from '@agentopsdeck/shared';
import { FileIndexCursorError, SessionFileIndex } from './session-file-index.js';
import { FileRebuildError, SessionFileRebuilds } from './session-file-rebuild.js';

const key = 'codex:projection';
const message = (i: number, sessionKey = key): ChatMessage => ({ id: `tool-${i}`, sessionKey,
  role: 'tool', toolPhase: 'result', status: 'sent', text: 'PRIVATE_BODY', createdAt: i,
  sourceFiles: [{ path: `/repo/${i}.ts`, kind: 'modified' }] });
function fixture() {
  const db = new DatabaseSync(':memory:'), index = new SessionFileIndex(db);
  let time = 0, reads = 0;
  const jobs = new SessionFileRebuilds(index, k => index.projectionBinding(k), (k, cursor) => {
    reads++; return index.projectionEvidencePage(k, cursor);
  }, () => time, () => 'verified-projection');
  return { db, index, jobs, reads: () => reads, tick: (ms = 251) => { time += ms; } };
}

test('projection cursor covers evidence outside both the UI window and retained index, without tool text', () => {
  const f = fixture();
  try {
    f.index.replaceProjection(key, Array.from({ length: 4200 }, (_, i) => message(i)));
    assert.equal(f.index.page(key).retained?.count, 4000);
    let cursor: string | undefined, count = 0;
    const ids = new Set<string>();
    do {
      const page = f.index.projectionEvidencePage(key, cursor);
      assert.ok(page.scanned <= 20); assert.ok(page.bytes <= 1024 * 1024);
      assert.doesNotMatch(JSON.stringify(page), /PRIVATE_BODY/);
      for (const m of page.messages) { assert.ok(!ids.has(m.id)); ids.add(m.id); }
      count += page.scanned; cursor = page.before;
    } while (cursor);
    assert.equal(count, 4200); assert.ok(ids.has('tool-0'));
    assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM session_file_projection_rows').all()), /PRIVATE_BODY/);
  } finally { f.db.close(); }
});

test('cursor is stable for unchanged evidence but rejects changes, other sessions and malformed values', () => {
  const f = fixture();
  try {
    const rows = Array.from({ length: 45 }, (_, i) => message(i));
    f.index.replaceProjection(key, rows);
    const binding = f.index.projectionBinding(key), page = f.index.projectionEvidencePage(key);
    f.index.replaceProjection(key, rows);
    assert.equal(f.index.projectionBinding(key), binding);
    assert.equal(f.index.projectionEvidencePage(key, page.before).scanned, 20);
    f.index.replaceProjection('codex:other', [message(1, 'codex:other')]);
    for (const cursor of ['bad', Buffer.from('null').toString('base64url'), 'x'.repeat(1025)])
      assert.throws(() => f.index.projectionEvidencePage(key, cursor), FileIndexCursorError);
    assert.throws(() => f.index.projectionEvidencePage('codex:other', page.before), FileIndexCursorError);
    f.index.replaceProjection(key, rows.slice(0, 25));
    assert.throws(() => f.index.projectionEvidencePage(key, page.before), FileIndexCursorError);
    assert.equal(f.index.projectionEvidencePage(key).messages.at(-1)?.id, 'tool-24');
  } finally { f.db.close(); }
});

test('explicit Codex job resumes, cools down, commits atomically and retains verified-projection provenance', () => {
  const f = fixture();
  try {
    f.index.replaceProjection(key, Array.from({ length: 45 }, (_, i) => message(i)));
    const initial = f.index.page(key), job = f.jobs.start(key, 'actor');
    assert.equal(f.reads(), 0);
    let progress = f.jobs.step(key, 'actor', job.id, 0);
    assert.equal(progress.state, 'scanning'); assert.deepEqual(f.index.page(key), initial);
    assert.deepEqual(f.jobs.start(key, 'actor'), progress);
    assert.deepEqual(f.jobs.step(key, 'actor', job.id, 0), progress);
    assert.deepEqual(f.jobs.step(key, 'actor', job.id, 1), progress);
    assert.equal(f.reads(), 1);
    while (progress.state === 'scanning') { f.tick(); progress = f.jobs.step(key, 'actor', job.id, progress.step); }
    assert.equal(progress.state, 'completed'); assert.equal(progress.scanned, 45);
    assert.equal(progress.found, 45); assert.equal(f.reads(), 3);
    assert.equal(f.index.page(key).source, 'verified-projection');
    assert.equal(f.index.page(key).coverage, 'partial');
    assert.deepEqual(f.index.page(key).entries, initial.entries);
  } finally { f.db.close(); }
});

for (const change of ['cancel', 'generation', 'eviction', 'expiry', 'actor'] as const) {
  test(`Codex staged rebuild protects ${change} without publishing partial work`, () => {
    const f = fixture();
    try {
      f.index.replaceProjection(key, Array.from({ length: 45 }, (_, i) => message(i)));
      const job = f.jobs.start(key, 'actor');
      f.jobs.step(key, 'actor', job.id, 0);
      if (change === 'cancel') f.jobs.cancel(key, 'actor', job.id);
      if (change === 'generation') f.index.replaceProjection(key, [message(99)]);
      if (change === 'eviction') for (let i = 0; i < 16; i++) f.index.replaceProjection(`codex:${i}`, []);
      if (change === 'expiry') f.tick(300_000);
      const indexBefore = f.index.page(key); f.tick();
      if (change === 'expiry' || change === 'actor')
        assert.throws(() => f.jobs.step(key, change === 'actor' ? 'other' : 'actor', job.id, 1), FileRebuildError);
      else assert.equal(f.jobs.step(key, 'actor', job.id, 1).state, change === 'cancel' ? 'cancelled' : 'conflict');
      assert.equal(f.reads(), 1); assert.deepEqual(f.index.page(key), indexBefore);
    } finally { f.db.close(); }
  });
}

test('snapshot and output budgets remain explicit; no claim of complete native history', () => {
  const f = fixture();
  try {
    f.index.replaceProjection(key, Array.from({ length: 10_001 }, (_, i) => message(i)));
    let cursor: string | undefined, count = 0, limited = false;
    do { const page = f.index.projectionEvidencePage(key, cursor); count += page.scanned; cursor = page.before; limited ||= !!page.limited; } while (cursor);
    assert.equal(count, 10_000); assert.equal(limited, true);
    const job = f.jobs.start(key, 'actor'); let progress = job;
    while (progress.state === 'scanning') { f.tick(); progress = f.jobs.step(key, 'actor', job.id, progress.step); }
    assert.equal(progress.state, 'completed'); assert.equal(progress.limited, true);
    assert.equal(progress.found, 4000); assert.equal(f.index.page(key).limited, true);
    assert.equal(f.index.page(key).coverage, 'partial');
  } finally { f.db.close(); }
});

test('restart can reuse persisted metadata; failed refresh rolls back and fences stale evidence', () => {
  const f = fixture();
  try {
    f.index.replaceProjection(key, Array.from({ length: 45 }, (_, i) => message(i)));
    const binding = f.index.projectionBinding(key), cursor = f.index.projectionEvidencePage(key).before;
    const reopened = new SessionFileIndex(f.db);
    assert.equal(reopened.projectionBinding(key), binding);
    assert.equal(reopened.projectionEvidencePage(key, cursor).scanned, 20);
    const before = f.db.prepare('SELECT * FROM session_file_projection_rows').all();
    f.db.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON session_file_projection_rows BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END");
    reopened.replaceProjection(key, [message(999)]);
    assert.equal(reopened.projectionBinding(key), undefined);
    assert.equal(reopened.page(key).coverage, 'stale');
    assert.deepEqual(f.db.prepare('SELECT * FROM session_file_projection_rows').all(), before);
    assert.throws(() => reopened.projectionEvidencePage(key, cursor), FileIndexCursorError);
    f.db.exec('DROP TRIGGER fail_projection'); reopened.replaceProjection(key, [message(999)]);
    assert.equal(reopened.projectionEvidencePage(key).scanned, 1);
  } finally { f.db.close(); }
});

test('empty native snapshot is valid and multiple paths on one tool preserve identity', () => {
  const f = fixture();
  try {
    f.index.replaceProjection(key, []);
    const empty = f.jobs.start(key, 'actor');
    assert.equal(f.jobs.step(key, 'actor', empty.id, 0).state, 'completed');
    const messages = [message(1), message(2)].map(m => ({ ...m,
      sourceFiles: Array.from({ length: 16 }, (_, i) => ({ path: `/repo/${i}.ts`, kind: 'modified' as const })) }));
    f.index.replaceProjection(key, messages);
    let progress = f.jobs.start(key, 'actor');
    while (progress.state === 'scanning') { f.tick(); progress = f.jobs.step(key, 'actor', progress.id, progress.step); }
    assert.equal(progress.state, 'completed'); assert.equal(progress.found, 32);
  } finally { f.db.close(); }
});

test('read-only storage cannot expose stale snapshots and a verified write restores availability', () => {
  const f = fixture();
  try {
    f.index.replaceProjection(key, [message(1)]);
    const cursor = f.index.page(key);
    f.db.exec('PRAGMA query_only = ON');
    f.index.replaceProjection(key, [message(2)]);
    assert.equal(f.index.projectionBinding(key), undefined);
    assert.equal(f.index.page(key).coverage, 'stale');
    assert.deepEqual(f.index.page(key).entries, []);
    assert.throws(() => f.index.fence(key));
    assert.throws(() => f.index.projectionEvidencePage(key), FileIndexCursorError);
    f.db.exec('PRAGMA query_only = OFF');
    f.index.replaceProjection(key, [message(2)]);
    assert.ok(f.index.projectionBinding(key));
    assert.equal(f.index.page(key).coverage, 'partial');
    assert.notDeepEqual(f.index.page(key).entries, cursor.entries);
  } finally { f.db.close(); }
});

test('projection byte budget and global session eviction bound retained metadata', () => {
  const f = fixture();
  try {
    const large = Array.from({ length: 1200 }, (_, i) => ({ ...message(i), id: `${i}-${'x'.repeat(4000)}` }));
    f.index.replaceProjection(key, large);
    const totals = f.db.prepare('SELECT count(*) AS count, sum(bytes) AS bytes FROM session_file_projection_rows').get() as { count: number; bytes: number };
    assert.ok(totals.count < 1200); assert.ok(totals.bytes <= 4 * 1024 * 1024);
    let cursor: string | undefined, count = 0, lastLimited = false;
    do {
      const page = f.index.projectionEvidencePage(key, cursor);
      assert.ok(page.bytes <= 1024 * 1024);
      if (page.before) assert.equal(page.limited, undefined);
      count += page.scanned; cursor = page.before; lastLimited = !!page.limited;
    } while (cursor);
    assert.equal(count, totals.count); assert.equal(lastLimited, true);
    for (let i = 0; i < 16; i++) f.index.replaceProjection(`codex:session-${i}`, [message(i, `codex:session-${i}`)]);
    assert.equal(f.index.projectionBinding(key), undefined);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM session_file_projection_snapshots').get()!.n, 16);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM session_file_projection_rows').get()!.n, 16);
    assert.ok(f.index.page(key).entries.length > 0, 'snapshot eviction does not delete the ordinary file index');
  } finally { f.db.close(); }
});

test('snapshot cursors survive closing and reopening a persistent database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-projection-reopen-'));
  let db: DatabaseSync | undefined;
  try {
    const path = join(directory, 'fixture.sqlite');
    db = new DatabaseSync(path);
    const original = new SessionFileIndex(db);
    original.replaceProjection(key, Array.from({ length: 45 }, (_, i) => message(i)));
    const binding = original.projectionBinding(key), cursor = original.projectionEvidencePage(key).before;
    db.close(); db = undefined;
    db = new DatabaseSync(path);
    const reopened = new SessionFileIndex(db);
    assert.equal(reopened.projectionBinding(key), binding);
    const page = reopened.projectionEvidencePage(key, cursor);
    assert.equal(page.scanned, 20);
    assert.equal(page.messages[0]!.id, 'tool-5');
    assert.equal(page.messages.at(-1)!.id, 'tool-24');
    assert.equal(reopened.page(key).source, 'verified-projection');
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});
