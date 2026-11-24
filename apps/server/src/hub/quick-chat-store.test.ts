import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { QuickChatStore } from './quick-chat-store.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';
const capability = { ephemeralRequest: true, noPersistentThread: true, originalLookup: true, maxOutput: 1024, epoch: 'epoch1' };
const profile = (id = 'LowPriority') => ({ id, name: id, target: 'fixture:node', model: 'fixture-model', outputLimit: 512 });
test('async claim authorization cannot admit quick chat or outlive its original transaction', async () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
  let release!: () => void, late: Promise<boolean> | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const store = new QuickChatStore(db, () => 1000, Buffer.alloc(32, 1));
    store.saveProfile('alice', 0, profile(), capability);
    store.admit('alice', 'request', 'LowPriority', 1, 'question', capability);
    db.exec('CREATE TABLE late_effect(value INTEGER)'); const insert = db.prepare('INSERT INTO late_effect VALUES(1)');
    const before = raw.prepare('SELECT * FROM quick_chat_receipts').all();
    assert.throws(() => store.claim('alice', 'request', 'question', capability,
      (() => late = (async () => { await held; insert.run(); return true; })()) as any), /must be synchronous/);
    assert.deepEqual(raw.prepare('SELECT * FROM quick_chat_receipts').all(), before);
    assert.equal(raw.isTransaction, false); assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    const rejected = assert.rejects(late!, StorageConnectionUnavailable); release(); await rejected;
    assert.deepEqual(raw.prepare('SELECT * FROM late_effect').all(), []);
  } finally { release(); if (late) await late.catch(() => {}); db.close(); }
});
test('expired encrypted bodies are deleted without releasing unknown or replay barriers', () => {
  const db = new DatabaseSync(':memory:'); let now = 1000;
  try {
    const store = new QuickChatStore(db, () => now, Buffer.alloc(32, 1));
    store.saveProfile('alice', 0, profile(), capability);
    store.admit('alice', 'result', 'LowPriority', 1, 'question', capability);
    store.claim('alice', 'result', 'question', capability, () => true);
    assert.throws(() => store.clearResult('alice', 'result'), /not-terminal/);
    store.complete('alice', 'result', 'answer');
    store.admit('alice', 'pending', 'LowPriority', 1, 'next', capability);
    now += 86400001;
    assert.equal(store.result('alice', 'result'), undefined);
    assert.equal(db.prepare('SELECT count(*) n FROM quick_chat_results').get()!.n, 0);
    assert.equal(store.receipt('alice', 'pending')?.state, 'admitted');
    assert.equal(store.admit('alice', 'result', 'LowPriority', 1, 'question', capability).state, 'completed');
  } finally { db.close(); }
});
test('result persistence failure rolls back both ciphertext and terminal receipt', () => memory((_, db) => {
  const store = new QuickChatStore(db, () => 1000, Buffer.alloc(32, 1));
  store.saveProfile('alice', 0, profile(), capability);
  store.admit('alice', 'result', 'LowPriority', 1, 'question', capability);
  store.claim('alice', 'result', 'question', capability, () => true);
  db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON quick_chat_receipts BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(() => store.complete('alice', 'result', 'answer'), /fixture/);
  assert.equal(store.receipt('alice', 'result')?.state, 'unknown');
  assert.equal(db.prepare('SELECT count(*) n FROM quick_chat_results').get()!.n, 0);
}));
test('provider-wide minute quota survives a store replacement', () => memory((store, db) => {
  for (let n = 0; n < 10; n++) {
    const owner = 'owner' + n;
    store.saveProfile(owner, 0, profile(), capability);
    store.admit(owner, 'request', 'LowPriority', 1, 'hello', capability);
  }
  const reopened = new QuickChatStore(db, () => 1000);
  reopened.saveProfile('extra', 0, profile(), capability);
  assert.throws(() => reopened.admit('extra', 'new', 'LowPriority', 1, 'hello', capability), /provider-rate/);
  assert.equal(reopened.admit('owner0', 'request', 'LowPriority', 1, 'hello', capability).state, 'admitted');
}));
test('canceling a not-yet-dispatched request releases capacity; unknown dispatch cannot be canceled locally', () => memory(s => {
  s.saveProfile('alice', 0, profile(), capability);
  s.admit('alice', 'old', 'LowPriority', 1, 'hello', capability);
  assert.equal(s.cancelAdmitted('alice', 'old').state, 'failed');
  assert.equal(s.cancelAdmitted('alice', 'old').state, 'failed');
  s.admit('alice', 'new', 'LowPriority', 1, 'hello', capability);
  s.claim('alice', 'new', 'hello', capability, () => true);
  assert.throws(() => s.cancelAdmitted('alice', 'new'), /dispatched/);
  assert.throws(() => s.admit('alice', 'third', 'LowPriority', 1, 'hello', capability), /inflight/);
}));
function memory(fn: (s: QuickChatStore, db: DatabaseSync) => void) { const db = new DatabaseSync(':memory:'); try { fn(new QuickChatStore(db, () => 1000), db); } finally { db.close(); } }
test('quick chat requires explicit no-thread/lookup capability and a bounded profile', () => memory(s => {
  for (const key of ['ephemeralRequest', 'noPersistentThread', 'originalLookup'] as const) assert.throws(() => s.saveProfile('alice', 0, profile(), { ...capability, [key]: false }), /unsupported/);
  assert.throws(() => s.saveProfile('alice', 0, { ...profile(), outputLimit: 2048 }, capability), /unsupported/);
  assert.equal(s.saveProfile('alice', 0, profile(), capability).revision, 1);
  assert.throws(() => s.saveProfile('alice', 0, profile(), capability), /revision/);
}));
test('admission stores only a digest, never creates sessions and caps owner/profile inflight', () => memory((s, db) => {
  for (const id of ['LowPriority', 'Heavy', 'Third']) s.saveProfile('alice', 0, profile(id), capability);
  s.admit('alice', 'r1', 'LowPriority', 1, 'PRIVATE_INPUT', capability);
  assert.throws(() => s.admit('alice', 'r2', 'LowPriority', 1, 'hello', capability), /inflight/);
  s.admit('alice', 'r2', 'Heavy', 1, 'hello', capability);
  assert.throws(() => s.admit('alice', 'r3', 'Third', 1, 'hello', capability), /inflight/);
  const data = JSON.stringify(db.prepare('SELECT payload FROM quick_chat_receipts').all()); assert.equal(data.includes('PRIVATE_INPUT'), false);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE '%session%'").get()!.n, 0);
  assert.equal(s.receipt('bob', 'r1'), undefined);
}));
test('same request cannot mutate input, dispatch twice or use changed authority/capability/profile', () => memory(s => {
  s.saveProfile('alice', 0, profile(), capability); const first = s.admit('alice', 'r1', 'LowPriority', 1, 'hello', capability);
  assert.deepEqual(s.admit('alice', 'r1', 'LowPriority', 1, 'hello', capability), first);
  assert.throws(() => s.admit('alice', 'r1', 'LowPriority', 1, 'other', capability), /reused/);
  assert.throws(() => s.claim('alice', 'r1', 'hello', capability, () => false), /preflight/);
  assert.throws(() => s.claim('alice', 'r1', 'hello', { ...capability, epoch: 'new' }, () => true), /preflight/);
  assert.equal(s.claim('alice', 'r1', 'hello', capability, () => true).claimed, true);
  assert.equal(s.claim('alice', 'r1', 'hello', capability, () => true).claimed, false);
  s.saveProfile('alice', 1, { ...profile(), model: 'other' }, capability);
  assert.equal(s.receipt('alice', 'r1')!.profile.model, 'fixture-model');
}));
test('unknown survives TTL; cleared/expired results never delete deduplication or resurrect on a late result', () => memory((s, db) => {
  s.saveProfile('alice', 0, profile(), capability); s.admit('alice', 'r1', 'LowPriority', 1, 'hello', capability); s.claim('alice', 'r1', 'hello', capability, () => true);
  const later = new QuickChatStore(db, () => 86401001); assert.equal(later.receipt('alice', 'r1')!.state, 'unknown');
  s.reconcile('alice', 'r1', 'completed', 'private_result_1'); assert.equal(later.receipt('alice', 'r1')!.resultRef, null);
  assert.equal(later.reconcile('alice', 'r1', 'completed', 'private_result_1').resultRef, null);
  s.clearResult('alice', 'r1'); assert.equal(s.reconcile('alice', 'r1', 'completed', 'private_result_1').resultRef, null);
  assert.equal(s.admit('alice', 'r1', 'LowPriority', 1, 'hello', capability).state, 'completed');
}));
test('synthetic adapter receives exactly one claim and terminal original lookup releases admission', () => memory(s => {
  s.saveProfile('alice', 0, profile(), capability); s.admit('alice', 'r1', 'LowPriority', 1, 'hello', capability);
  let calls = 0;
  const adapter = () => { if (s.claim('alice', 'r1', 'hello', capability, () => true).claimed) calls++; };
  adapter(); adapter(); assert.equal(calls, 1);
  s.reconcile('alice', 'r1', 'failed', null);
  assert.equal(s.admit('alice', 'r2', 'LowPriority', 1, 'hello', capability).state, 'admitted');
}));
