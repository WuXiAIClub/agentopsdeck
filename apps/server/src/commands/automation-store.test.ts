import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationStore, AUTOMATION_STORE_LIMITS } from "./automation-store.js";
import type { AutomationRule, AutomationObservation } from "./automation-policy.js";

const start = 1_000_000;
const rule: AutomationRule = { id: "rule", revision: 1, authorityEpoch: 1,
  target: { ownerId: "owner", connectionId: "connector", runtime: "codex", sessionId: "session" },
  enabled: true, startsAt: start, expiresAt: start + 86_400_000,
  maxSends: 3, maxPerHour: 3, minIntervalMs: 60_000, mode: { kind: "interval", intervalMs: 60_000 } };
const template = "Continue the explicitly authorized task.";
test('automation store preserves original clock error when rollback reporting fails', () => memory(db => {
  const original = Error('original-clock'), exec = db.exec.bind(db);
  const store = new AutomationStore(db, () => { throw original; });
  db.exec = sql => { exec(sql); if (sql === 'ROLLBACK') throw Error('cleanup'); };
  assert.throws(() => store.save('owner', rule, template, 0), error => error === original);
  assert.equal(db.isTransaction, false); assert.equal(store.read('owner', 'rule'), undefined);
}));
function fixture(db: DatabaseSync, initial: AutomationRule = rule) {
  let now = start;
  const store = new AutomationStore(db, () => now);
  const view = (revision = 1, authorityEpoch = revision): AutomationObservation => ({
    now, connectedSince: start - 1, target: initial.target, revision, authorityEpoch,
    online: true, idle: true, queueEmpty: true, admissionAllowed: true });
  const tick = (slot = 0) => ({ kind: "timer" as const, at: start + slot * 60_000, slot });
  store.save("owner", initial, template, 0);
  return { store, view, tick, at: (slot: number) => { now = start + slot * 60_000; },
    reserve: (slot = 0, revision = 1) => store.reserve("owner", "rule", tick(slot), view(revision)) };
}
function memory(fn: (db: DatabaseSync) => void) { const db = new DatabaseSync(":memory:"); try { fn(db); } finally { db.close(); } }
function disk(fn: (db: DatabaseSync, other: DatabaseSync) => void) {
  const dir = mkdtempSync(join(tmpdir(), "agentopsdeck-automation-store-")), path = join(dir, "state.sqlite");
  const db = new DatabaseSync(path), other = new DatabaseSync(path);
  try { db.exec("PRAGMA busy_timeout=0"); other.exec("PRAGMA busy_timeout=0"); fn(db, other); }
  finally { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("reads do not create schema; rule defaults disabled and invalid config is rejected", () => memory(db => {
  const s = new AutomationStore(db);
  assert.equal(s.read("owner", "missing"), undefined);
  assert.equal(s.receipt("owner", "missing"), undefined);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master").get()!.n, 0);
  const { enabled: _, ...draft } = rule;
  assert.equal(s.save("owner", draft as AutomationRule, template, 0).rule.enabled, false);
  for (const [owner, r, text, revision] of [["other", rule, template, 0], ["owner", rule, " ", 0],
    ["owner", rule, "x".repeat(8193), 0], ["owner", rule, template, -1], ["owner", { ...rule, maxSends: 0 }, template, 0]] as const)
    assert.throws(() => s.save(owner, r, text, revision), /configuration/);
}));
test("config retry is canonical; CAS, epoch and target changes cannot bypass conflict", () => memory(db => {
  const { store } = fixture(db), before = store.read("owner", "rule")!;
  assert.deepEqual(store.save("owner", { ...rule, target: { sessionId: "session", runtime: "codex", connectionId: "connector", ownerId: "owner" } }, template, 0), before);
  assert.throws(() => store.save("owner", rule, "changed", 0), /revision/);
  assert.throws(() => store.save("owner", { ...rule, revision: 2 }, template, 1), /revision/);
  assert.throws(() => store.save("owner", { ...rule, revision: 2, authorityEpoch: 2, target: { ...rule.target, sessionId: "other" } }, template, 1), /target/);
  assert.equal(store.read("other", "rule"), undefined);
}));
test("reservation fixes request identity and immutable template; replay does not consume another count", () => memory(db => {
  const f = fixture(db), r = f.reserve();
  assert.deepEqual(f.reserve(), r);
  assert.equal(db.prepare("SELECT count(*) AS n FROM automation_reservations").get()!.n, 1);
  assert.equal(f.store.receipt("other", r.requestId), undefined);
  r.snapshot.template = "local mutation";
  assert.equal(f.store.receipt("owner", r.requestId)!.snapshot.template, template);
  assert.match(r.requestId, /^[a-f0-9-]{36}$/);
}));
test("dispatch claim is once-only and settled receipts cannot regress", () => memory(db => {
  const f = fixture(db), r = f.reserve();
  assert.throws(() => f.store.settle("owner", r.requestId, "accepted"), /unclaimed/);
  assert.equal(f.store.beginDispatch("owner", r.requestId, f.view()).claimed, true);
  assert.equal(f.store.beginDispatch("owner", r.requestId, f.view()).claimed, false);
  const accepted = f.store.settle("owner", r.requestId, "accepted");
  assert.deepEqual(f.store.settle("owner", r.requestId, "accepted"), accepted);
  assert.throws(() => f.store.settle("owner", r.requestId, "unknown"), /terminal/);
  assert.throws(() => f.store.settle("owner", r.requestId, "confirmed-not-accepted"), /terminal/);
  assert.equal(f.store.beginDispatch("owner", r.requestId, f.view()).claimed, false);
}));
test("dispatch refuses an enclosing transaction so a rollback cannot resurrect sent work", () => memory(db => {
  const f = fixture(db), r = f.reserve();
  db.exec("BEGIN");
  assert.throws(() => f.store.beginDispatch("owner", r.requestId, f.view()), /top-level-commit/);
  assert.equal(db.isTransaction, true);db.exec("ROLLBACK");
  assert.equal(f.store.receipt("owner", r.requestId)!.state, "reserved");
  assert.equal(f.store.beginDispatch("owner", r.requestId, f.view()).claimed, true);
}));
test("unknown retains lifetime budget; confirmed non-acceptance frees count but keeps trigger tombstone", () => memory(db => {
  const f = fixture(db, { ...rule, maxSends: 1 }), r = f.reserve();
  f.store.beginDispatch("owner", r.requestId, f.view()); f.store.settle("owner", r.requestId, "unknown");
  assert.equal(f.reserve().state, "unknown");
  f.at(1); assert.throws(() => f.reserve(1), /limit/);
  f.store.settle("owner", r.requestId, "confirmed-not-accepted");
  assert.notEqual(f.reserve(1).requestId, r.requestId);
  assert.equal(f.store.receipt("owner", r.requestId)!.state, "rejected");
}));
test("same rejected trigger is never rearmed with a different request", () => memory(db => {
  const f = fixture(db), r = f.reserve();
  f.store.beginDispatch("owner", r.requestId, f.view());f.store.settle("owner", r.requestId, "confirmed-not-accepted");
  assert.equal(f.reserve().requestId, r.requestId);assert.equal(f.reserve().state, "rejected");
  assert.equal(f.store.beginDispatch("owner", r.requestId, f.view()).claimed, false);
}));
test("rule edits cancel only unclaimed work and do not reset spent/unknown quota", () => memory(db => {
  const f = fixture(db, { ...rule, maxSends: 1 }), r = f.reserve();
  f.store.beginDispatch("owner", r.requestId, f.view());f.store.settle("owner", r.requestId, "unknown");
  f.store.save("owner", { ...rule, maxSends: 1, revision: 2, authorityEpoch: 2 }, "new template", 1);
  assert.equal(f.store.receipt("owner", r.requestId)!.state, "unknown");
  assert.equal(f.store.receipt("owner", r.requestId)!.snapshot.template, template);
  f.at(1);assert.throws(() => f.reserve(1, 2), /limit/);
  f.store.settle("owner", r.requestId, "accepted");assert.throws(() => f.reserve(1, 2), /limit/);
}));
test("pause and revoke cancel reserved work, preserve in-flight evidence and cannot resurrect a rule", () => memory(db => {
  const f = fixture(db), r = f.reserve();
  f.store.save("owner", { ...rule, revision: 2, authorityEpoch: 2, enabled: false }, template, 1);
  assert.equal(f.store.receipt("owner", r.requestId)!.state, "cancelled");
  assert.equal(f.store.beginDispatch("owner", r.requestId, f.view()).claimed, false);
  f.store.save("owner", { ...rule, revision: 3, authorityEpoch: 3 }, template, 2);
  f.at(1);const inFlight = f.reserve(1, 3);f.store.beginDispatch("owner", inFlight.requestId, f.view(3));
  f.store.revoke("owner", "rule", 3);
  assert.equal(f.store.receipt("owner", inFlight.requestId)!.state, "dispatching");
  assert.throws(() => f.store.save("owner", { ...rule, revision: 5, authorityEpoch: 5 }, template, 4), /revoked/);
  assert.throws(() => f.reserve(1, 4), /revoked/);
  assert.equal(f.store.settle("owner", inFlight.requestId, "unknown").state, "unknown");
}));
test("dispatch rechecks authority, expiry, clock, idle, connection and maintenance gates", () => memory(db => {
  const f = fixture(db), r = f.reserve();
  for (const patch of [{ online: false }, { idle: false }, { queueEmpty: false }, { admissionAllowed: false },
    { revision: 2 }, { authorityEpoch: 2 }, { target: { ...rule.target, connectionId: "other" } }])
    assert.throws(() => f.store.beginDispatch("owner", r.requestId, { ...f.view(), ...patch }));
  f.at(-1);assert.throws(() => f.store.beginDispatch("owner", r.requestId, f.view()), /clock/);
  f.at(1);assert.throws(() => f.store.beginDispatch("owner", r.requestId, f.view()), /missed/);
  f.at(1440);assert.throws(() => f.store.beginDispatch("owner", r.requestId, f.view()), /expired/);
  assert.equal(f.store.receipt("owner", r.requestId)!.state, "reserved");
}));
test("trusted store clock replaces caller time; completion history and wrong owners cannot reserve", () => memory(db => {
  const f = fixture(db);
  assert.throws(() => f.store.reserve("owner", "rule", f.tick(1), { ...f.view(), now: start + 60_000 }), /trigger/);
  assert.throws(() => f.store.reserve("other", "rule", f.tick(), f.view()), /missing/);
  f.store.save("owner", { ...rule, revision: 2, authorityEpoch: 2, mode: { kind: "completion", allowOwnTurns: false } }, template, 1);
  assert.throws(() => f.store.reserve("owner", "rule", { kind: "completion", turnId: "old", startedAt: start, completedAt: start,
    authoritative: true, historical: true, origin: "manual", outcome: "completed", operation: "message" }, f.view(2)), /trigger/);
}));
test("completion events deduplicate across repeated observations and rate-limit distinct turns", () => memory(db => {
  const f = fixture(db, { ...rule, mode: { kind: "completion", allowOwnTurns: false } });
  const trigger = { kind: "completion" as const, turnId: "turn", startedAt: start, completedAt: start,
    authoritative: true, historical: false, origin: "manual" as const, outcome: "completed" as const, operation: "message" as const };
  const first = f.store.reserve("owner", "rule", trigger, f.view());
  assert.equal(f.store.reserve("owner", "rule", trigger, f.view()).requestId, first.requestId);
  assert.throws(() => f.store.reserve("owner", "rule", { ...trigger, turnId: "second" }, f.view()), /rate/);
}));
test("schema and inserts roll back with outer transaction, then identical operation can retry", () => memory(db => {
  db.exec("CREATE TABLE marker(value TEXT); BEGIN; INSERT INTO marker VALUES(42)");
  const f = fixture(db), r = f.reserve();assert.ok(f.store.receipt("owner", r.requestId));
  db.exec("ROLLBACK");assert.equal(f.store.read("owner", "rule"), undefined);
  f.store.save("owner", rule, template, 0);assert.ok(f.reserve());
  assert.equal(db.prepare("SELECT count(*) AS n FROM marker").get()!.n, 0);
}));
test("injected insert failure rolls back reservation, preserving caller transaction and retry budget", () => memory(db => {
  const f = fixture(db);
  db.exec("CREATE TABLE marker(value TEXT); CREATE TRIGGER fail_reservation BEFORE INSERT ON automation_reservations BEGIN SELECT RAISE(ABORT,\u0027injected\u0027); END; BEGIN; INSERT INTO marker VALUES(42)");
  assert.throws(() => f.reserve(), /injected/);assert.equal(db.isTransaction, true);
  db.exec("DROP TRIGGER fail_reservation; COMMIT");assert.ok(f.reserve());
  assert.equal(db.prepare("SELECT count(*) AS n FROM marker").get()!.n, 1);
}));
test("whole transaction rollback and invalid clock leave no partial rule or receipt", () => memory(db => {
  const f = fixture(db);
  db.exec("CREATE TRIGGER fail_all BEFORE INSERT ON automation_reservations BEGIN SELECT RAISE(ROLLBACK,\u0027whole rollback\u0027); END");
  assert.throws(() => f.reserve(), /whole rollback/);assert.equal(db.isTransaction, false);
  db.exec("DROP TRIGGER fail_all");assert.ok(f.reserve());
  const bad = new AutomationStore(db, () => NaN);
  assert.throws(() => bad.save("owner", { ...rule, revision: 2, authorityEpoch: 2 }, "new", 1), /clock/);
  assert.equal(f.store.read("owner", "rule")!.rule.revision, 1);
}));
test("byte ceiling fails closed without deleting unresolved records; existing retry remains available", () => memory(db => {
  const f = fixture(db), first = f.reserve();
  db.prepare("INSERT INTO automation_rules(owner,id,payload) VALUES(?,?,zeroblob(?))").run("fixture", "oversize", AUTOMATION_STORE_LIMITS.bytes);
  assert.deepEqual(f.reserve(), first);
  f.at(1);assert.throws(() => f.reserve(1), /capacity/);
  assert.equal(f.store.receipt("owner", first.requestId)!.state, "reserved");
}));
test("WAL connections contest one reservation and one claim; stale reader must retry fresh", () => disk((db, other) => {
  db.exec("PRAGMA journal_mode=WAL");const f = fixture(db), second = new AutomationStore(other, () => start);
  other.exec("BEGIN");assert.ok(second.read("owner", "rule"));
  const first = f.reserve();
  assert.throws(() => second.reserve("owner", "rule", f.tick(), f.view()), /locked|busy/);
  assert.equal(other.isTransaction, true);other.exec("ROLLBACK");
  assert.equal(second.reserve("owner", "rule", f.tick(), f.view()).requestId, first.requestId);
  assert.equal(f.store.beginDispatch("owner", first.requestId, f.view()).claimed, true);
  assert.equal(second.beginDispatch("owner", first.requestId, f.view()).claimed, false);
}));
test("pinned reader commit failure does not leave hidden reservations", () => disk((db, other) => {
  const f = fixture(db);other.exec("BEGIN");assert.ok(other.prepare("SELECT * FROM automation_rules").get());
  assert.throws(() => f.reserve(), /locked|busy/);assert.equal(db.isTransaction, false);
  other.exec("ROLLBACK");assert.ok(f.reserve());
  assert.equal(db.prepare("SELECT count(*) AS n FROM automation_reservations").get()!.n, 1);
}));
test("physical close and reopen preserve unknown receipts, occupied count and claim refusal", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentopsdeck-automation-reopen-")), path = join(dir, "state.sqlite");
  let db = new DatabaseSync(path);
  try {
    const f = fixture(db, { ...rule, maxSends: 1 }), r = f.reserve();
    f.store.beginDispatch("owner", r.requestId, f.view());f.store.settle("owner", r.requestId, "unknown");
    db.close();db = new DatabaseSync(path);const store = new AutomationStore(db, () => start + 60_000);
    assert.equal(store.receipt("owner", r.requestId)!.state, "unknown");
    assert.equal(store.beginDispatch("owner", r.requestId, f.view()).claimed, false);
    assert.throws(() => store.reserve("owner", "rule", f.tick(1), { ...f.view(), now: start + 60_000 }), /limit/);
  } finally { db.close();rmSync(dir, { recursive: true, force: true }); }
});
