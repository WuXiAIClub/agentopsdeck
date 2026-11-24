import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { HubStore } from './hub-store.js';
import { readDeliveryPage } from './delivery-page.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-event-scaling-')), file = join(dir, 'hub.sqlite');
  let store = new HubStore(file, 'synthetic');
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    file,
    get store() { return store; },
    get db() { return (store as unknown as { db: DatabaseSync }).db; },
    reopen() { store.close(); store = new HubStore(file, 'synthetic'); },
  };
}

const event = { envConnectionId: 'node', type: 'message.created', ts: 1, payload: {} };
const domains = new Map([['node', 'domain']]);

function observePreparation(db: DatabaseSync, observe: (sql: string) => void) {
  return new Proxy(db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => { observe(sql); return target.prepare(sql); };
    return Reflect.get(target, key);
  } });
}

test('synchronous synthetic replay also refuses an oversized original row rather than reporting idle', t => {
  const f = fixture(t); seed(f.db, 'default', 1, 180_000);
  const before = f.db.prepare('SELECT payload_json FROM hub_events').get()!.payload_json;
  let payloadReads = 0;
  const observed = observePreparation(f.db, sql => {
    if (sql.startsWith('SELECT CAST(id AS BLOB) AS id, CAST(connection_id AS BLOB)')) payloadReads++;
  });
  assert.throws(() => readDeliveryPage(observed, { owner: 'default', domains: [...domains] }), /hub_delivery_read_unavailable/);
  assert.throws(() => f.store.deliveryPage(undefined, domains), /hub_delivery_read_unavailable/);
  assert.equal(payloadReads, 0, 'only length/type metadata may be read for an unpageable body');
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.db.prepare('SELECT payload_json FROM hub_events').get()!.payload_json, before);
});

test('replay never commits or rolls back its caller-owned transaction', t => {
  const f = fixture(t); seed(f.db, 'default', 1, 10);
  const before = f.db.prepare('SELECT payload_json FROM hub_events').get()!.payload_json;
  f.db.exec('BEGIN IMMEDIATE');
  try {
    assert.equal(f.store.deliveryPage(undefined, domains).events.length, 1);
    assert.equal(f.db.isTransaction, true);
    f.db.prepare('UPDATE hub_events SET payload_json=?').run('x'.repeat(524289));
    assert.throws(() => f.store.deliveryPage(undefined, domains), /hub_delivery_read_unavailable/);
    assert.equal(f.db.isTransaction, true);
  } finally { f.db.exec('ROLLBACK'); }
  assert.equal(f.db.prepare('SELECT payload_json FROM hub_events').get()!.payload_json, before);
});

test('metadata admission and payload read share one snapshot despite an intervening WAL writer', t => {
  const f = fixture(t); seed(f.db, 'default', 1, 10);
  const original = JSON.parse(f.db.prepare('SELECT payload_json FROM hub_events').get()!.payload_json as string);
  const writer = new DatabaseSync(f.file);
  let changed = false;
  const observed = observePreparation(f.db, sql => {
    if (!changed && sql.startsWith('SELECT CAST(id AS BLOB) AS id, CAST(connection_id AS BLOB)')) {
      changed = true;
      writer.prepare('UPDATE hub_events SET payload_json=?').run(JSON.stringify({ ...original, payload: 'changed' }));
    }
  });
  try {
    assert.deepEqual(readDeliveryPage(observed, { owner: 'default', domains: [...domains] }).events, [original]);
    assert.equal(changed, true); assert.equal(f.db.isTransaction, false);
    assert.equal(f.store.deliveryPage(undefined, domains).events[0]!.payload, 'changed');
  } finally { writer.close(); }
});

function seed(db: DatabaseSync, owner: string, count: number, characters: number) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(`INSERT INTO hub_events(id,owner_user_id,connection_id,remote_event_id,event_type,payload_json,created_at,stream_domain)
      VALUES (?,?,'node',?,'message.created',?,1,'domain')`);
    for (let i = 0; i < count; i++) {
      const id = `${owner}:${i}`;
      insert.run(id, owner, String(i), JSON.stringify({ ...event, id, payload: '文'.repeat(characters) }));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function observeLengths(db: DatabaseSync) {
  const observed = { bytes: 0 };
  db.function('length', { deterministic: true }, value => {
    if (value === null) return null;
    if (value instanceof Uint8Array) { observed.bytes += value.byteLength; return value.byteLength; }
    return [...String(value).split('\0')[0]!].length;
  });
  return observed;
}

test('Hub retention never remeasures retained payloads on each event or duplicate', t => {
  const f = fixture(t);
  seed(f.db, 'default', 128, 4096);
  seed(f.db, 'unrelated', 128, 8192);
  const observed = observeLengths(f.db);
  assert.equal(f.store.appendDelivery(event, 'domain', 'next'), true);
  assert.ok(observed.bytes < 1024, `only the incoming event may be measured, measured ${observed.bytes}`);
  observed.bytes = 0;
  assert.equal(f.store.appendDelivery(event, 'domain', 'next'), false);
  assert.equal(observed.bytes, 0, 'duplicate acknowledgement must not reread retained bodies');
  assert.equal(f.store.upstreamCursor('node', 'domain'), 'next');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM hub_events WHERE owner_user_id='unrelated'").get()!.n, 128);
});

test('Hub byte retention matches reference suffix exactly, isolates owners, and keeps checkpoint', t => {
  const f = fixture(t);
  seed(f.db, 'default', 40, 80_000);
  seed(f.db, 'unrelated', 4, 10);
  f.store.appendDelivery(event, 'domain', 'newest');
  const rows = f.db.prepare("SELECT id, payload_json FROM hub_events WHERE owner_user_id='default' ORDER BY rowid DESC").all() as { id: string; payload_json: string }[];
  assert.ok(rows.length > 1 && rows.length < 41);
  const bytes = rows.reduce((n, row) => n + Buffer.byteLength(row.payload_json), 0);
  assert.ok(bytes <= 8 * 1024 * 1024);
  const nextOldest = { ...event, id: `default:${40 - rows.length}`, payload: '文'.repeat(80_000) };
  assert.ok(bytes + Buffer.byteLength(JSON.stringify(nextOldest)) > 8 * 1024 * 1024, 'retains the maximal newest suffix');
  assert.deepEqual(rows.slice(1).map(row => row.id), Array.from({ length: rows.length - 1 }, (_, i) => `default:${39 - i}`));
  assert.equal(f.store.deliveryPage('default:0', domains).reset, true);
  assert.equal(f.store.upstreamCursor('node', 'domain'), 'newest');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM hub_events WHERE owner_user_id='unrelated'").get()!.n, 4);
  const page = f.store.deliveryPage(undefined, domains);
  assert.ok(page.events.length > 0 && page.events.length <= 16);
  assert.ok(page.events.reduce((n, value) => n + Buffer.byteLength(JSON.stringify(value)), 0) <= 524288);
});

test('Hub count retention and append rollback preserve event/cursor atomicity', t => {
  const f = fixture(t);
  seed(f.db, 'default', 2050, 1);
  const before = f.store.latestDeliveryCursor();
  f.db.exec(`CREATE TRIGGER fail_cursor BEFORE INSERT ON remote_event_cursors
    BEGIN SELECT RAISE(ABORT, 'synthetic checkpoint failure'); END`);
  assert.throws(() => f.store.appendDelivery(event, 'domain', 'failed'), /synthetic checkpoint failure/);
  assert.equal(f.store.latestDeliveryCursor(), before);
  assert.equal(f.store.upstreamCursor('node', 'domain'), undefined);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM hub_events').get()!.n, 2050);
  f.db.exec('DROP TRIGGER fail_cursor');
  f.store.appendDelivery(event, 'domain', 'successful');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM hub_events').get()!.n, 2048);
  assert.equal(f.store.deliveryPage('default:2', domains).reset, true);
  assert.equal(f.store.deliveryPage('default:3', domains).reset, false);
});

test('Hub existing journal gains size index without rewriting events or checkpoints; reopen stays indexed', t => {
  const f = fixture(t);
  seed(f.db, 'default', 64, 1024);
  f.store.appendDelivery(event, 'domain', 'checkpoint');
  const before = f.db.prepare('SELECT rowid, * FROM hub_events ORDER BY rowid').all();
  f.db.exec('DROP INDEX IF EXISTS hub_event_retention_bytes');
  f.reopen();
  assert.deepEqual(f.db.prepare('SELECT rowid, * FROM hub_events ORDER BY rowid').all(), before);
  assert.equal(f.store.upstreamCursor('node', 'domain'), 'checkpoint');
  f.reopen();
  const plan = f.db.prepare(`EXPLAIN QUERY PLAN SELECT rowid, length(CAST(payload_json AS BLOB))
    FROM hub_events INDEXED BY hub_event_retention_bytes WHERE owner_user_id = ?`).all('default');
  assert.ok(plan.some(row => String(row.detail).includes('COVERING INDEX hub_event_retention_bytes')));
  const observed = observeLengths(f.db);
  assert.equal(f.store.appendDelivery(event, 'domain', 'checkpoint'), false);
  assert.equal(observed.bytes, 0);
  assert.equal(f.store.deliveryPage('default:0', new Map([['node', 'other-domain']])).events.length, 0);
  assert.equal(f.store.deliveryPage('default:0', domains, 'different-owner').reset, true);
});

test('Hub SQLite FULL never acknowledges an unpersisted event, and returns the original capacity error', t => {
  const f = fixture(t);
  f.store.appendDelivery(event, 'domain', 'checkpoint');
  const cursor = f.store.latestDeliveryCursor();
  const pages = f.db.prepare('PRAGMA page_count').get()!.page_count as number;
  const previousLimit = f.db.prepare('PRAGMA max_page_count').get()!.max_page_count as number;
  f.db.exec(`PRAGMA max_page_count=${pages + 1}`);
  assert.throws(() => f.store.appendDelivery({ ...event, payload: 'x'.repeat(128 * 1024) }, 'domain', 'too-large'),
    (error: unknown) => error instanceof Error && (error as Error & { errcode: number }).errcode === 13);
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.store.latestDeliveryCursor(), cursor);
  assert.equal(f.store.upstreamCursor('node', 'domain'), 'checkpoint');
  assert.equal(f.store.deliveryPage(undefined, domains).events.length, 1);
  f.db.exec(`PRAGMA max_page_count=${previousLimit}`);
  assert.equal(f.store.appendDelivery(event, 'domain', 'after-full'), true);
  assert.equal(f.store.upstreamCursor('node', 'domain'), 'after-full');
});
