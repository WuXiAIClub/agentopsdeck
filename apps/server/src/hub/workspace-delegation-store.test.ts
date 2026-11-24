import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DelegationStore, DELEGATION_STORE_LIMITS } from "./workspace-delegation-store.js";
import type { DelegationPreviewInput } from "./workspace-delegation-preview.js";
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

const taskId = "083ba0a5-4a98-4c93-b45e-ce8e62024228";
export function input(count = 2): DelegationPreviewInput {
  return { owner: "alice", catalog: { owner: "alice", generation: 1, preferencesRevision: 1, complete: true,
    members: Array.from({ length: count }, (_, n) => ({ owner: "alice", nodeId: "node", connectionId: "connection",
      runtime: "codex", sessionId: `session-${n}`, authorityEpoch: 1, groupId: "project", tags: ["dev"], taskBinding: "supported" })) },
    selection: { tags: ["dev"], tagMode: "all" },
    board: { resourceId: "default", revision: 1, title: "Board", tasks: [{ id: taskId, title: "Selected", detail: "Task", status: "todo" }] },
    taskIds: [taskId], fields: ["status"] };
}
function memory(fn: (store: DelegationStore, db: DatabaseSync) => void) {
  const db = new DatabaseSync(":memory:");
  try { fn(new DelegationStore(db, () => 1000), db); } finally { db.close(); }
}
function prepared(store: DelegationStore, count = 2) {
  const source = input(count), id = randomUUID();
  const batch = store.prepare("alice", id, source, 60_000);
  return { id, batch, source, request: batch.members[0]!.requestId,
    confirm: () => store.confirm("alice", id, source) };
}

for (const phase of ['prepare','confirm','settle','cancel','finishCancellation','claim-effect','cancel-effect'] as const)
  test(`delegation ${phase} participant rejects escaped promises and rolls back original transaction`, async () => {
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw), store = new DelegationStore(db,() => 1000);
    const f = prepared(store); f.confirm();
    if (phase === 'settle' || phase === 'finishCancellation' || phase === 'cancel-effect') store.claim('alice',f.id,f.request,() => true);
    if (phase === 'finishCancellation') store.cancel('alice',f.id);
    const before = store.read('alice',f.id);
    db.exec('CREATE TABLE participant_effects(value INTEGER)'); const write = db.prepare('INSERT INTO participant_effects VALUES(?)');
    let release!: () => void, late: Promise<void> | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const escaped = () => { write.run(1); return late = held.then(() => { write.run(2); }); };
    const run = () => {
      if (phase === 'prepare') return store.prepare('alice',randomUUID(),input(),60_000,escaped);
      if (phase === 'confirm') return store.confirm('alice',f.id,f.source,escaped);
      if (phase === 'settle') return store.settle('alice',f.id,{requestId:f.request,state:'unknown'},escaped);
      if (phase === 'cancel') return store.cancel('alice',f.id,escaped);
      if (phase === 'finishCancellation') return store.finishCancellation('alice',f.id,f.request,escaped);
      if (phase === 'claim-effect') return store.claim('alice',f.id,f.request,() => true,escaped);
      return store.cancel('alice',f.id,undefined,escaped);
    };
    try {
      assert.throws(run,/must be synchronous/); assert.equal(raw.isTransaction,false);
      assert.equal(connectionRecoverySnapshot(db).state,'close-required');
      assert.deepEqual(raw.prepare('SELECT * FROM participant_effects').all(),[]);
      const row = raw.prepare('SELECT payload FROM hub_delegation_batches WHERE owner=? AND id=?').get('alice',f.id)!;
      assert.deepEqual(JSON.parse(row.payload as string),before);
      const rejected = assert.rejects(late!,StorageConnectionUnavailable); release(); await rejected;
      assert.deepEqual(raw.prepare('SELECT * FROM participant_effects').all(),[]);
    } finally { release(); await late?.catch(() => {}); db.close(); }
  });

test('delegation revocation participant failure rolls back cancellation and all local effects', () => memory((s,db) => {
  const f = prepared(s); f.confirm(); s.claim('alice',f.id,f.request,() => true);
  const before = s.read('alice',f.id); db.exec('CREATE TABLE revocation_effects(value INTEGER)');
  assert.throws(() => s.cancel('alice',f.id,undefined,() => {
    db.prepare('INSERT INTO revocation_effects VALUES(1)').run(); throw Error('injected revoke failure');
  }),/injected revoke failure/);
  assert.equal(db.isTransaction,false); assert.deepEqual(s.read('alice',f.id),before);
  assert.deepEqual(db.prepare('SELECT * FROM revocation_effects').all(),[]);
}));

for (const phase of ['claim', 'canWrite'] as const) test(`delegation ${phase} rejects escaped authority and fences late SQL`, async () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
  const store = new DelegationStore(db, () => 1000), f = prepared(store); f.confirm();
  if (phase === 'canWrite') assert.equal(store.claim('alice', f.id, f.request, () => true).claimed, true);
  const before = store.read('alice', f.id);
  db.exec('CREATE TABLE authority_effects(value INTEGER)'); const statement = db.prepare('INSERT INTO authority_effects VALUES(?)');
  let release!: () => void, late!: Promise<boolean>, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const authorize = (() => {
    calls++; statement.run(1);
    return late = (async () => { await held; statement.run(2); return false; })();
  }) as unknown as () => boolean;
  try {
    assert.throws(() => store[phase]('alice', f.id, f.request, authorize), /must be synchronous/);
    assert.equal(calls, 1); assert.equal(raw.isTransaction, false);
    assert.deepEqual(raw.prepare('SELECT * FROM authority_effects').all(), []);
    const record = raw.prepare('SELECT payload FROM hub_delegation_batches WHERE owner = ? AND id = ?').get('alice', f.id)!;
    assert.deepEqual(JSON.parse(record.payload as string), before);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    const rejected = assert.rejects(late, StorageConnectionUnavailable); release(); await rejected;
    assert.deepEqual(raw.prepare('SELECT * FROM authority_effects').all(), []); assert.equal(calls, 1);
  } finally { release(); if (late) await late.catch(() => {}); db.close(); }
});

test("reads are owner scoped and do not initialize a database", () => memory((s, db) => {
  assert.equal(s.read("alice", randomUUID()), undefined);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master").get()!.n, 0);
  for (const [owner, id] of [["", randomUUID()], ["alice", "bad"], [" alice", randomUUID()]])
    assert.throws(() => s.read(owner!, id!), /scope/);
}));
test("preparation fixes member requests, whitelists data and conflicts on changed content or expiry", () => memory(s => {
  const f = prepared(s);
  assert.deepEqual(s.prepare("alice", f.id, f.source, 60_000), f.batch);
  assert.equal(s.read("bob", f.id), undefined);
  assert.equal(new Set(f.batch.members.map(m => m.requestId)).size, 2);
  assert.throws(() => s.prepare("alice", f.id, f.source, 60_001), /batch-reused/);
  f.source.board.tasks[0]!.detail = "Changed";
  assert.throws(() => s.prepare("alice", f.id, f.source, 60_000), /batch-reused/);
  s.read("alice", f.id)!.preview.resource.tasks[0]!.detail = "Mutation";
  assert.equal(s.read("alice", f.id)!.preview.resource.tasks[0]!.detail, "Task");
  const source = input(); Object.assign(source.catalog.members[0]!, { token: "PRIVATE", endpoint: "PRIVATE" });
  source.board.tasks.push({ id: randomUUID(), title: "PRIVATE", detail: "PRIVATE", status: "todo" });
  assert.ok(!JSON.stringify(s.prepare("alice", randomUUID(), source, 60_000)).includes("PRIVATE"));
}));
test("unsupported, empty, foreign and over-capacity previews never become executable batches", () => memory(s => {
  for (const change of [
    (i: DelegationPreviewInput) => { i.catalog.members = []; },
    (i: DelegationPreviewInput) => { i.catalog.members[0]!.taskBinding = "unknown"; },
    (i: DelegationPreviewInput) => { i.catalog.members[0]!.owner = "bob"; },
    (i: DelegationPreviewInput) => { i.catalog.complete = false; },
  ]) { const i = input(); change(i); assert.throws(() => s.prepare("alice", randomUUID(), i, 60_000)); }
  assert.throws(() => s.prepare("alice", randomUUID(), input(33), 60_000));
  for (const expiry of [999, 1000, NaN, 1000 + 86_400_001])
    assert.throws(() => s.prepare("alice", randomUUID(), input(), expiry));
  assert.throws(() => s.prepare("bob", randomUUID(), input(), 60_000), /scope/);
}));
test("confirmation rechecks revision, scope and epochs but never expands an already confirmed batch", () => memory(s => {
  const f = prepared(s), changed = structuredClone(f.source);
  changed.catalog.members[0]!.authorityEpoch++;
  assert.throws(() => s.confirm("alice", f.id, changed), /preview/);
  changed.catalog.members[0]!.authorityEpoch--; changed.board.revision++;
  assert.throws(() => s.confirm("alice", f.id, changed), /preview/);
  const confirmed = f.confirm();
  assert.deepEqual(s.confirm("alice", f.id, input(3)), confirmed);
  assert.equal(s.read("alice", f.id)!.members.length, 2);
}));
test("expired previews and clock reversal cannot confirm, expired grants cannot dispatch", () => memory((_, db) => {
  let now = 1000; const s = new DelegationStore(db, () => now), f = prepared(s);
  now = 999; assert.throws(f.confirm, /preview/);
  now = 301000; assert.throws(f.confirm, /preview/);
  now = 1000; f.confirm(); now = 60_000;
  const result = s.claim("alice", f.id, f.request, () => true);
  assert.equal(result.claimed, false); assert.equal(result.receipt.reason, "expired");
}));
test("confirmation is required and a synchronous authority check runs for each member", () => memory(s => {
  const f = prepared(s); let calls = 0;
  assert.equal(s.claim("alice", f.id, f.request, () => true).claimed, false);
  f.confirm();
  assert.equal(s.claim("alice", f.id, f.request, intent => {
    calls++; assert.equal(intent.member.authorityEpoch, 1); assert.deepEqual(intent.grant.fields, ["status"]);
    assert.deepEqual(intent.grant.taskIds, [taskId]); return false;
  }).receipt.reason, "authority-changed");
  assert.equal(calls, 1);
  assert.equal(s.claim("alice", f.id, f.request, () => true).claimed, false);
  const second = f.batch.members[1]!.requestId;
  assert.throws(() => s.claim("alice", f.id, second, () => Promise.resolve(true) as unknown as boolean), /must be synchronous/);
}));
test("two connections claim once, receipts survive an actual close/reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "delegation-store-")), path = join(root, "test.sqlite");
  let db = new DatabaseSync(path); const other = new DatabaseSync(path);
  try {
    const s = new DelegationStore(db, () => 1000), competing = new DelegationStore(other, () => 1000), f = prepared(s); f.confirm();
    assert.equal(s.claim("alice", f.id, f.request, () => true).claimed, true);
    assert.equal(competing.claim("alice", f.id, f.request, () => true).claimed, false);
    const before = s.read("alice", f.id); db.close(); db = new DatabaseSync(path);
    const reopened = new DelegationStore(db, () => 2000);
    assert.deepEqual(reopened.read("alice", f.id), before);
    assert.equal(reopened.claim("alice", f.id, f.request, () => true).claimed, false);
    reopened.settle("alice", f.id, { requestId: f.request, state: "unknown" });
    assert.equal(competing.read("alice", f.id)!.members[0]!.state, "unknown");
  } finally { db.close(); other.close(); rmSync(root, { recursive: true, force: true }); }
});
test("claims and cancellations must commit independently; rolled-back schema is recreated", () => memory((s, db) => {
  db.exec("BEGIN"); const abandoned = prepared(s); db.exec("ROLLBACK");
  assert.equal(s.read("alice", abandoned.id), undefined);
  const f = prepared(s); f.confirm(); db.exec("BEGIN");
  assert.throws(() => s.claim("alice", f.id, f.request, () => true), /top-level/);
  assert.throws(() => s.cancel("alice", f.id), /top-level/);
  db.exec("ROLLBACK"); assert.equal(s.claim("alice", f.id, f.request, () => true).claimed, true);
}));
test("four durable in-flight slots include unknown results and are not bypassed by another runner", () => memory(s => {
  const f = prepared(s, 6); f.confirm();
  for (const m of f.batch.members.slice(0, 4)) assert.equal(s.claim("alice", f.id, m.requestId, () => true).claimed, true);
  s.settle("alice", f.id, { requestId: f.request, state: "unknown" });
  const fifth = f.batch.members[4]!.requestId;
  assert.equal(s.claim("alice", f.id, fifth, () => true).claimed, false);
  s.settle("alice", f.id, { requestId: f.request, state: "installed", bindingId: randomUUID() });
  assert.equal(s.claim("alice", f.id, fifth, () => true).claimed, true);
}));
test("terminal outcomes are monotonic; unclaimed or wrong request responses cannot settle", () => memory(s => {
  const f = prepared(s); f.confirm();
  assert.throws(() => s.settle("alice", f.id, { requestId: f.request, state: "unknown" }), /unclaimed/);
  s.claim("alice", f.id, f.request, () => true);
  assert.throws(() => s.settle("alice", f.id, { requestId: randomUUID(), state: "unknown" }), /request/);
  const outcome = { requestId: f.request, state: "installed" as const, bindingId: randomUUID() };
  const installed = s.settle("alice", f.id, outcome);
  assert.deepEqual(s.settle("alice", f.id, outcome), installed);
  assert.deepEqual(s.settle("alice", f.id, { requestId: f.request, state: "unknown" }), installed);
  assert.throws(() => s.settle("alice", f.id, { ...outcome, bindingId: randomUUID() }), /terminal/);
  assert.throws(() => s.settle("alice", f.id, { requestId: f.request, state: "rejected" }), /terminal/);
}));
test("cancel-before-prepare is durable and owner scoped; late confirmation cannot revive it", () => memory(s => {
  const id = randomUUID(); s.cancel("alice", id);
  assert.throws(() => s.prepare("alice", id, input(), 60_000), /cancelled/);
  const other = input(); other.owner = other.catalog.owner = "bob"; other.catalog.members.forEach(m => { m.owner = "bob"; });
  assert.ok(s.prepare("bob", id, other, 60_000));
  const f = prepared(s); s.cancel("alice", f.id);
  assert.equal(s.prepare("alice", f.id, f.source, 60_000).state, "cancelled");
  assert.throws(f.confirm, /cancelled/);
}));
test("cancellation separates unsent work from remote cleanup and fences late installation", () => memory(s => {
  const f = prepared(s); f.confirm(); s.claim("alice", f.id, f.request, () => true);
  assert.equal(s.canWrite("alice", f.id, f.request, () => true), true);
  const cancelled = s.cancel("alice", f.id)!;
  assert.deepEqual(cancelled.members.map(m => m.state), ["cleanup_pending", "cancelled"]);
  assert.equal(s.canWrite("alice", f.id, f.request, () => true), false);
  const outcome = { requestId: f.request, state: "installed" as const, bindingId: randomUUID() };
  assert.equal(s.settle("alice", f.id, outcome).state, "cleanup_pending");
  assert.equal(s.finishCancellation("alice", f.id, f.request).state, "revoked");
  assert.equal(s.settle("alice", f.id, outcome).state, "revoked");
}));
test("capacity fails closed without evicting deduplication receipts or cancellation tombstones", () => memory((s, db) => {
  const f = prepared(s); const before = s.read("alice", f.id);
  const insert = db.prepare("INSERT INTO hub_delegation_cancellations VALUES (?,?)");
  for (let n = 0; n < DELEGATION_STORE_LIMITS.batches; n++) insert.run("alice", randomUUID());
  assert.throws(() => s.cancel("alice", randomUUID()), /capacity/);
  assert.deepEqual(s.read("alice", f.id), before);
  const batchInsert = db.prepare("INSERT INTO hub_delegation_batches VALUES (?,?,?,?)");
  for (let n = 1; n < DELEGATION_STORE_LIMITS.batches; n++) batchInsert.run("alice", randomUUID(), "{}", 128);
  assert.throws(() => prepared(s), /capacity/);
  assert.deepEqual(s.prepare("alice", f.id, f.source, 60_000), before);
  assert.equal(s.cancel("alice", f.id)!.state, "cancelled");
}));
