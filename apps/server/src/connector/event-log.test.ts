import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorEventLog } from './event-log.js';
import { DeckStore } from '../projection/deck-store.js';

const event = (payload: unknown = {}) => ({ id: 'ignored', type: 'session.updated' as const, ts: 1, sessionKey: 'synthetic', payload });

for (const executed of [false, true]) test(`epoch commit failure fences projection without masking original (${executed})`, () => {
  const db = new DatabaseSync(':memory:'), log = new ConnectorEventLog(db), original = Error('synthetic-commit');
  const exec = db.exec.bind(db); let commits = 0;
  try {
    db.exec = sql => { if (sql === 'COMMIT') { commits++; if (executed) exec(sql); throw original; } exec(sql); };
    assert.throws(() => log.beginEpoch(), error => error === original);
    assert.equal(commits, 1); assert.equal(db.isTransaction, false);
    assert.throws(() => log.latestEventId(), /unavailable/);
    assert.equal(log.recoverProjection(), false, 'optional projection recovery cannot settle an uncertain epoch');
    assert.equal(log.appendBatch([event()]), undefined);
    assert.equal(commits, 1);
  } finally { db.close(); }
});

test('projection failure remains recoverable after cleanup throws without replaying partial events', () => {
  const db = new DatabaseSync(':memory:'), log = new ConnectorEventLog(db), exec = db.exec.bind(db);
  try {
    db.exec("CREATE TRIGGER reject_projection BEFORE INSERT ON connector_events BEGIN SELECT RAISE(ABORT,'synthetic-body'); END");
    db.exec = sql => { if (sql === 'ROLLBACK') { exec(sql); throw Error('synthetic-cleanup'); } exec(sql); };
    assert.equal(log.appendBatch([event()]), undefined); assert.equal(db.isTransaction, false);
    assert.throws(() => log.latestEventId(), /unavailable/);
    db.exec = exec; db.exec('DROP TRIGGER reject_projection');
    assert.equal(log.recoverProjection(), true);
    assert.equal(log.getEventsSince(log.latestEventId()).length, 0);
    assert.ok(log.appendBatch([event()]));
  } finally { db.close(); }
});

for (const wrongOwner of [false, true]) test(`transactional append rejects ${wrongOwner ? 'another database' : 'autocommit'} without opening or committing a transaction`, () => {
  const db = new DatabaseSync(':memory:'), other = new DatabaseSync(':memory:');
  try {
    const log = new ConnectorEventLog(db), cursor = log.latestEventId();
    if (wrongOwner) other.exec('BEGIN IMMEDIATE');
    assert.throws(() => log.appendInTransaction(wrongOwner ? other : db, event()), /owning transaction/);
    assert.equal(db.isTransaction, false);
    assert.equal(other.isTransaction, wrongOwner, 'does not interfere with the caller transaction');
    assert.equal(new ConnectorEventLog(db).latestEventId(), cursor);
    assert.throws(() => log.latestEventId(), /unavailable/);
  } finally { db.close(); other.close(); }
});

test('projection batches use one transaction and stay bounded without journaling full messages', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const log = new ConnectorEventLog(db, 3, 4096, 1024), start = log.latestEventId();
    const statements: string[] = [], exec = db.exec.bind(db);
    db.exec = sql => { statements.push(sql); exec(sql); };
    assert.equal(log.appendBatch([]), undefined); assert.deepEqual(statements, []);
    const events = Array.from({ length: 200 }, (_, n) => ({ ...event({ id: String(n), text: 'private'.repeat(1000) }), type: 'message.created' as const }));
    const last = log.appendBatch(events)!;
    assert.deepEqual(statements, ['BEGIN IMMEDIATE', 'COMMIT']);
    assert.equal(last.id, start.replace(/:0$/, ':200'));
    assert.equal(log.hasEvent(start), false);
    const page = log.getEventsSince(start.replace(/:0$/, ':197'));
    assert.equal(page.length, 3); assert.ok(!JSON.stringify(page).includes('private'));
    const head = db.prepare('SELECT rows, bytes FROM connector_event_head').get() as { rows: number; bytes: number };
    assert.equal(head.rows, 3); assert.ok(head.bytes < 4096);
  } finally { db.close(); }
});

test('later batch failure rolls back the cursor, earlier inserts and retention deletes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const log = new ConnectorEventLog(db, 1, 4096, 1024);
    const first = log.append(event({ keep: true })), before = log.latestEventId();
    db.exec("CREATE TRIGGER reject_third BEFORE INSERT ON connector_events WHEN new.seq = 3 BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
    assert.doesNotThrow(() => log.appendBatch([event(), event()]));
    assert.throws(() => log.latestEventId(), /unavailable/);
    const reader = new ConnectorEventLog(db, 1, 4096, 1024);
    assert.equal(reader.latestEventId(), before);
    assert.deepEqual(reader.getEventsSince(before.replace(/:1$/, ':0')), [first]);
    assert.equal(log.appendBatch([event()]), undefined, 'failed writer never silently resumes');
  } finally { db.close(); }
});

for (const crash of ['during', 'after'] as const) test(`process exit ${crash} projection batch leaves no partially committed cursor`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-event-batch-crash-')), file = join(dir, 'events.sqlite');
  try {
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      import { ConnectorEventLog } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? './event-log.ts' : './event-log.js', import.meta.url).href)};
      const db = new DatabaseSync(${JSON.stringify(file)}), log = new ConnectorEventLog(db);
      const event = payload => ({ id: 'ignored', type: 'session.updated', ts: 1, payload });
      log.append(event('old'));
      log.appendBatch([event('new-one'), event({ toJSON() { if (${JSON.stringify(crash)} === 'during') process.exit(0); return 'new-two'; } })]);
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, [...(import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const db = new DatabaseSync(file);
    try {
      const log = new ConnectorEventLog(db), head = log.latestEventId();
      const events = log.getEventsSince(head.replace(/:\d+$/, ':0'));
      assert.deepEqual(events.map(row => row.payload), crash === 'during' ? ['old'] : ['old', 'new-one', 'new-two']);
      assert.ok(head.endsWith(crash === 'during' ? ':1' : ':3'));
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history replacement publishes one batch after the complete snapshot is installed', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const log = new ConnectorEventLog(db), store = new DeckStore({ eventLog: log }), start = log.latestEventId();
    const exec = db.exec.bind(db), statements: string[] = [];
    db.exec = sql => { statements.push(sql); exec(sql); };
    const messages = Array.from({ length: 50 }, (_, n) => ({ id: String(n), sessionKey: 'codex:synthetic', role: 'assistant' as const, text: String(n), createdAt: n }));
    store.replaceMessages('codex:synthetic', messages);
    assert.deepEqual(statements, ['BEGIN IMMEDIATE', 'COMMIT']);
    assert.equal(store.changes.revision, 1); assert.equal(log.getEventsSince(start).length, 50);
    statements.length = 0;
    store.replaceMessages('codex:synthetic', messages);
    assert.deepEqual(statements, []); assert.equal(store.changes.revision, 1, 'identical history does not wake itself');
    const before = log.latestEventId();
    store.replaceMessages('codex:synthetic', [messages[0]!], { authoritative: true });
    assert.equal(log.getEventsSince(before)[0]?.type, 'stream.reset');
    assert.equal(store.getMessages('codex:synthetic').length, 1);
  } finally { db.close(); }
});

test('persistent source cursors support bounded replay and readers do not reset an active epoch', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-events-')), 'events.sqlite');
  let db = new DatabaseSync(file), log = new ConnectorEventLog(db);
  try {
    const before = log.latestEventId();
    const a = log.append(event()), b = log.append(event());
    assert.notEqual(a.id, b.id);
    assert.equal(log.hasEvent(before), true, 'empty epoch cursor is a valid snapshot boundary');
    const reader = new DatabaseSync(file);
    try { assert.equal(new ConnectorEventLog(reader).latestEventId(), b.id); } finally { reader.close(); }
    db.close(); db = new DatabaseSync(file); log = new ConnectorEventLog(db);
    assert.deepEqual(log.getEventsSince(before).map((item) => item.id), [a.id, b.id]);
    assert.equal(log.hasEvent(b.id.replace(/:2$/, ':02')), false);
    assert.equal(log.hasEvent(b.id.replace(/:2$/, ':3')), false);
    const old = log.latestEventId();
    log.beginEpoch();
    assert.equal(log.hasEvent(old), false, 'reconstructed projection requires snapshot resync');
    assert.equal(log.getEventsSince(old).length, 0);
    assert.equal(log.hasEvent(log.latestEventId()), true);
  } finally { db.close(); }
});

test('row and byte retention detect gaps; source pages are bounded by rows and bytes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const log = new ConnectorEventLog(db, 3, 4096, 1024), start = log.latestEventId();
    const first = log.append(event());
    for (let i = 0; i < 3; i++) log.append(event());
    assert.equal(log.hasEvent(start), false);
    assert.equal(log.hasEvent(first.id), true, 'predecessor of retained floor is still replayable');
    assert.equal(log.getEventsSince(first.id).length, 3);
    const head = () => db.prepare('SELECT rows, bytes FROM connector_event_head').get() as { rows: number; bytes: number };
    for (let i = 0; i < 20; i++) log.append(event('x'.repeat(600)));
    assert.ok(head().rows <= 3 && head().bytes <= 4096);
    const larger = new ConnectorEventLog(db, 100, 1024 * 1024, 128 * 1024);
    larger.beginEpoch();
    const cursor = larger.latestEventId();
    for (let i = 0; i < 80; i++) larger.append(event('x'.repeat(16_000)));
    const floor = db.prepare('SELECT min(seq) AS seq FROM connector_events').get() as { seq: number };
    const retained = larger.latestEventId().replace(/:\d+$/, `:${floor.seq - 1}`);
    const page = larger.getEventsSince(retained);
    assert.ok(page.length <= 64);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 513 * 1024);
    assert.equal(larger.hasEvent(cursor), false);
    const huge = larger.append(event('x'.repeat(256 * 1024)));
    assert.equal(huge.type, 'stream.reset');
    assert.deepEqual(huge.payload, { reason: 'event_too_large' });
  } finally { db.close(); }
});

test('message token updates journal bounded invalidations instead of repeated full transcripts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const log = new ConnectorEventLog(db), before = log.latestEventId();
    const saved = log.append({ ...event({ id: 'm', text: 'sensitive synthetic text'.repeat(10_000), media: ['not-for-event-log'] }), type: 'message.updated' });
    assert.deepEqual(saved.payload, { invalidation: true, revision: saved.id, id: 'm' });
    const serialized = JSON.stringify(log.getEventsSince(before));
    assert.ok(serialized.length < 512);
    assert.ok(!serialized.includes('sensitive') && !serialized.includes('not-for-event-log'));
  } finally { db.close(); }
});

test('journal transaction failure blocks snapshots/replay without throwing from runtime projection callbacks', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const log = new ConnectorEventLog(db), store = new DeckStore({ eventLog: log });
    const session = { sessionKey: 'codex:synthetic', agentId: 'codex', source: 'codex' as const, title: 'Synthetic', status: 'running' as const, lastActiveAt: 1 };
    store.upsertSession(session);
    const before = log.latestEventId();
    db.exec("CREATE TRIGGER reject_journal BEFORE INSERT ON connector_events BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
    assert.doesNotThrow(() => store.upsertSession({ ...session, title: 'Still executing' }));
    assert.throws(() => store.latestEventId(), /unavailable/);
    assert.throws(() => store.getEventsSince(before), /unavailable/);
    assert.equal(store.getSession(session.sessionKey)?.status, 'running');
    const fresh = new ConnectorEventLog(db);
    assert.equal(fresh.latestEventId(), before, 'failed transaction did not advance source cursor');
    db.exec('DROP TRIGGER reject_journal');
    fresh.beginEpoch();
    assert.equal(fresh.hasEvent(before), false);
  } finally { db.close(); }
});

test('a new owning epoch fences stale writers and snapshots bracket subsequent events', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const old = new ConnectorEventLog(db), log = new ConnectorEventLog(db);
    log.beginEpoch();
    const cursor = log.latestEventId();
    assert.doesNotThrow(() => old.append(event()));
    assert.throws(() => old.latestEventId());
    assert.equal(log.latestEventId(), cursor);
    const store = new DeckStore({ eventLog: log });
    const key = 'codex:synthetic';
    store.upsertSession({ sessionKey: key, agentId: 'codex', source: 'codex', title: 'Synthetic', status: 'running', lastActiveAt: 1 });
    const snapshot = { state: store.getSessionsState(), sourceCursor: store.latestEventId() };
    store.addMessage({ id: 'final', sessionKey: key, role: 'assistant', text: 'Done', createdAt: 2 });
    assert.equal(snapshot.state.groups[0]?.sessions[0]?.status, 'running');
    const after = store.getEventsSince(snapshot.sourceCursor);
    assert.equal(after.length, 1);
    assert.equal(after[0]?.type, 'message.created');
    assert.equal((after[0]?.payload as any).id, 'final');
  } finally { db.close(); }
});

test('growing message updates have linear small journal volume and corrupt counters fail closed', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const log = new ConnectorEventLog(db);
    let fullBytes = 0, journalBytes = 0;
    for (let i = 1; i <= 512; i++) {
      const update = { ...event({ id: 'same-message', text: 'x'.repeat(i * 128) }), type: 'message.updated' as const };
      fullBytes += Buffer.byteLength(JSON.stringify(update));
      journalBytes += Buffer.byteLength(JSON.stringify(log.append(update)));
    }
    assert.ok(journalBytes < 512 * 512);
    assert.ok(fullBytes > journalBytes * 50, 'synthetic growing transcript avoids repeated full-text IO');
    db.exec('UPDATE connector_event_head SET rows = rows + 1');
    assert.throws(() => new ConnectorEventLog(db), /counters invalid/);
  } finally { db.close(); }
});
