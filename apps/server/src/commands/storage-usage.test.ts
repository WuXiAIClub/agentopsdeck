import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { TurnQueue } from './turn-queue.js';
import { MirrorOutbox } from '../messages/mirror.js';

// Count actual payload evaluation, not elapsed time (which is hardware/cache
// dependent). Replaces length only in isolated synthetic databases.
function observeLengths(db: DatabaseSync) {
  const observed = { calls: 0, fail: false };
  db.function('length', { deterministic: true }, value => {
    observed.calls++;
    if (observed.fail) throw new Error('synthetic storage read failure');
    if (value === null) return null;
    return value instanceof Uint8Array ? value.byteLength : [...String(value).split('\0')[0]!].length;
  });
  return observed;
}

const stores = [
  { name: 'turn queue', table: 'connector_turns', usage: 'connector_turn_usage', column: 'payload',
    sum: 'length(cast(payload AS BLOB)) + length(cast(session_key AS BLOB)) + 512',
    open: (db: DatabaseSync) => new TurnQueue(db),
    seed: (db: DatabaseSync, count: number) => {
      const insert = db.prepare(`INSERT INTO connector_turns(runtime,id,session_key,created_at,state,payload) VALUES (?,?,?,1,?,?)`);
      for (let i = 0; i < count; i++) insert.run(['codex', 'claude-code', 'ghcp'][i % 3]!, String(i), '会话',
        ['queued', 'dispatching', 'outcome_unknown', 'blocked'][i % 4]!, JSON.stringify({ text: '文🙂'.repeat(2048), actorId: 'synthetic' }));
    } },
  { name: 'mirror outbox', table: 'connector_mirror_outbox', usage: 'connector_mirror_usage', column: 'job',
    sum: 'length(cast(job AS BLOB)) + 512',
    open: (db: DatabaseSync) => new MirrorOutbox(db),
    seed: (db: DatabaseSync, count: number) => {
      const insert = db.prepare('INSERT INTO connector_mirror_outbox(id,session_key,job) VALUES (?,?,?)');
      for (let i = 0; i < count; i++) insert.run(String(i), '会话', JSON.stringify({ inputText: '文🙂'.repeat(2048),
        deliveryState: ['pending', 'outcome_unknown', 'sent', 'blocked'][i % 4] }));
    } },
];

for (const store of stores) {
  test(`${store.name}: reopen skips all retained payload evaluation and preserves counters`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-usage-reopen-')), file = join(dir, 'state.sqlite');
    let db = new DatabaseSync(file);
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    db.exec('PRAGMA journal_mode=WAL');
    store.open(db); store.seed(db, 96);
    const before = db.prepare(`SELECT * FROM ${store.usage}`).get();
    const facts = db.prepare(`SELECT * FROM ${store.table}`).all();
    db.close(); db = new DatabaseSync(file);
    const observed = observeLengths(db);
    for (let i = 0; i < 4; i++) store.open(db);
    assert.equal(observed.calls, 0, 'ordinary startup must not measure historical payloads');
    assert.deepEqual(db.prepare(`SELECT * FROM ${store.usage}`).get(), before);
    assert.deepEqual(db.prepare(`SELECT * FROM ${store.table}`).all(), facts, 'including unknown/blocked work');
  });

  test(`${store.name}: missing accounting bootstraps once, then trigger accounting and rollback remain exact`, t => {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    store.open(db);
    assert.equal(db.prepare(`SELECT rows FROM ${store.usage}`).get()!.rows, 0);
    store.seed(db, 12);
    const before = db.prepare(`SELECT * FROM ${store.usage}`).get();
    db.exec(`DELETE FROM ${store.usage}`);
    const observed = observeLengths(db);
    store.open(db);
    assert.ok(observed.calls >= 12, 'a genuinely missing counter must measure existing UTF-8 payloads');
    assert.deepEqual(db.prepare(`SELECT * FROM ${store.usage}`).get(), before);
    observed.calls = 0; store.open(db); assert.equal(observed.calls, 0);
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`UPDATE ${store.table} SET ${store.column} = ? WHERE id = '0'`).run(JSON.stringify({ text: 'changed🙂' }));
    db.exec(`DELETE FROM ${store.table} WHERE id = '1'`);
    const expected = db.prepare(`SELECT count(*) AS rows, coalesce(sum(${store.sum}),0) AS bytes FROM ${store.table}`).get();
    assert.deepEqual(db.prepare(`SELECT rows, bytes FROM ${store.usage}`).get(), expected);
    db.exec('ROLLBACK');
    assert.deepEqual(db.prepare(`SELECT * FROM ${store.usage}`).get(), before);
    db.exec('BEGIN IMMEDIATE');
    db.exec(`DELETE FROM ${store.usage}`); store.open(db);
    assert.equal(db.isTransaction, true, 'bootstrap must not commit its caller transaction');
    db.exec('ROLLBACK');
    assert.deepEqual(db.prepare(`SELECT * FROM ${store.usage}`).get(), before);
  });

  test(`${store.name}: failed bootstrap does not install a zero/partial counter or lose work`, t => {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    store.open(db); store.seed(db, 6);
    const before = db.prepare(`SELECT * FROM ${store.usage}`).get();
    db.exec(`DELETE FROM ${store.usage}`);
    const observed = observeLengths(db); observed.fail = true;
    assert.throws(() => store.open(db), /synthetic storage read failure/);
    assert.equal(db.prepare(`SELECT * FROM ${store.usage}`).get(), undefined);
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${store.table}`).get()!.n, 6);
    observed.fail = false; store.open(db);
    assert.deepEqual(db.prepare(`SELECT * FROM ${store.usage}`).get(), before);
  });
}

for (const runtime of ['codex', 'claude-code', 'ghcp']) {
  test(`${runtime}: SQLite FULL leaves queue/counters intact, emits no admission and preserves the original error`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-queue-full-'));
    const db = new DatabaseSync(join(dir, 'state.sqlite'));
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    db.exec('PRAGMA journal_mode=WAL');
    const queue = new TurnQueue(db);
    queue.enqueue(runtime, { id: 'existing', sessionKey: 's', createdAt: 1, state: 'outcome_unknown', payload: { text: 'preserve' } });
    const before = db.prepare('SELECT * FROM connector_turn_usage').get();
    const pages = db.prepare('PRAGMA page_count').get()!.page_count as number;
    const previousLimit = db.prepare('PRAGMA max_page_count').get()!.max_page_count as number;
    db.exec(`PRAGMA max_page_count=${pages + 1}`);
    let admitted = 0, committed = 0;
    queue.onAdmission(() => admitted++);
    assert.throws(() => queue.enqueue(runtime, { id: 'too-large', sessionKey: 's', createdAt: 2, payload: { text: 'x'.repeat(128 * 1024) } },
      () => committed++), (error: unknown) => error instanceof Error && (error as Error & { errcode: number }).errcode === 13);
    assert.equal(db.isTransaction, false);
    assert.equal(admitted, 0); assert.equal(committed, 0);
    assert.deepEqual(db.prepare('SELECT * FROM connector_turn_usage').get(), before);
    assert.equal(queue.list(runtime).length, 1);
    assert.equal(queue.head(runtime, 's')!.state, 'outcome_unknown');
    db.exec(`PRAGMA max_page_count=${previousLimit}`);
    queue.enqueue(runtime, { id: 'new-explicit-request', sessionKey: 'other', createdAt: 3, payload: { text: 'healthy' } });
    assert.equal(admitted, 1);
    assert.equal(queue.head(runtime, 's')!.state, 'outcome_unknown', 'restoring storage does not replay unknown work');
  });
}

test('mirror SQLite FULL preserves original error and cannot create a partial outbound intent', t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-mirror-full-'));
  const db = new DatabaseSync(join(dir, 'state.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('PRAGMA journal_mode=WAL');
  const outbox = new MirrorOutbox(db);
  const params = { actorId: 'synthetic', sessionKey: 's', after: 1, inputText: 'preserve', idempotencyKey: 'existing',
    explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'synthetic', outboundTarget: 'synthetic' } };
  outbox.upsert(params);
  const before = db.prepare('SELECT * FROM connector_mirror_usage').get();
  const existing = outbox.get('existing');
  const pages = db.prepare('PRAGMA page_count').get()!.page_count as number;
  const previousLimit = db.prepare('PRAGMA max_page_count').get()!.max_page_count as number;
  db.exec(`PRAGMA max_page_count=${pages + 1}`);
  assert.throws(() => outbox.upsert({ ...params, idempotencyKey: 'too-large', inputText: 'x'.repeat(128 * 1024) }),
    (error: unknown) => error instanceof Error && (error as Error & { errcode: number }).errcode === 13);
  assert.equal(db.isTransaction, false);
  assert.equal(outbox.get('too-large'), undefined);
  assert.deepEqual(outbox.get('existing'), existing);
  assert.deepEqual(db.prepare('SELECT * FROM connector_mirror_usage').get(), before);
  db.exec(`PRAGMA max_page_count=${previousLimit}`);
  outbox.upsert({ ...params, idempotencyKey: 'new-explicit-request' });
  assert.equal(outbox.list().length, 2);
});
