import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionGuidanceStore } from './session-guidance-store.js';
import { commandKeyIssuedAt } from '@agentopsdeck/shared';
import { validHubGuidanceResult } from './member-guidance-domain.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';
function memory(fn: (s: SessionGuidanceStore, db: DatabaseSync) => void) { const db = new DatabaseSync(':memory:'); try { fn(new SessionGuidanceStore(db, () => 1000), db); } finally { db.close(); } }
function setup(s: SessionGuidanceStore) { const config = s.save('alice', 'session', 0, 'Use fixture only', true); s.context('alice', 'session', 'epoch1'); return config; }
test('guidance preparation freezes one time sample across worker receipt and dispatch key', () => {
  const db = new DatabaseSync(':memory:');
  let clock = 1000;
  try {
    const store = new SessionGuidanceStore(db, () => clock++);
    setup(store);
    const before = clock;
    const receipt = store.prepare('alice', 'session', 'time-boundary-request', 1, 'hello');
    assert.equal(validHubGuidanceResult({ action: 'prepare', digest: 'a'.repeat(64), status: 201,
      nodeVersion: 1, config: null, state: null, receipt, claimed: null, cancelled: null }), true);
    assert.equal(clock - before, 1);
    assert.equal(receipt.createdAt, before);
    assert.equal(commandKeyIssuedAt(receipt.commandKey!), before);
    assert.equal(receipt.expiresAt! - receipt.createdAt!, 300_000);
    assert.deepEqual(store.receipt('alice', 'session', receipt.requestId), receipt);
    assert.deepEqual(store.prepare('alice', 'session', receipt.requestId, 1, 'hello'), receipt);
    assert.equal(clock - before, 1, 'idempotent retry retains the original time and command key');
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});
const guardedChanges = ['save','context','prepare','cancel','claim','reconcile','evidence'] as const;
function guardedChange(s: SessionGuidanceStore, kind: typeof guardedChanges[number], guard: () => boolean) {
  const config=s.config('alice','session')!;
  if(kind==='save')return s.save('alice','session',1,'New fixture',true,guard);
  if(kind==='context')return s.context('alice','session','epoch2',guard);
  if(kind==='prepare')return s.prepare('alice','session','fresh-request',1,'hello',guard);
  if(kind==='cancel')return s.cancel('alice','session','request',guard);
  if(kind==='claim')return s.claim('alice','session','request',guard);
  if(kind==='reconcile')return s.reconcile('alice','session','request',{state:'submitted',queueReceipt:'queue'},guard);
  return s.evidence('alice','session',{epoch:'epoch1',hash:config.hash,checkId:'fixture',state:'confirmed_present',observedAt:900,expiresAt:1500},guard);
}
for(const kind of guardedChanges)for(const deniedAt of [1,2])
test(`guidance ${kind} checks fresh authority at root entry and before settlement (${deniedAt})`,()=>memory((s,db)=>{
  setup(s);s.prepare('alice','session','request',1,'hello');
  if(kind==='reconcile')s.claim('alice','session','request',()=>true);
  const facts=()=>['session_guidance','guidance_submissions','guidance_cancellations'].map(table=>db.prepare('SELECT * FROM '+table).all());
  const before=facts();let calls=0;
  assert.throws(()=>guardedChange(s,kind,()=>{assert.equal(db.isTransaction,true);return ++calls!==deniedAt;}),/authority|preflight/);
  assert.equal(calls,deniedAt);assert.equal(db.isTransaction,false);assert.deepEqual(facts(),before);
}));
for(const kind of guardedChanges)for(const contract of ['async','proxy'] as const)
test(`guidance ${kind} refuses ${contract} authority before executing injected work`,()=>memory((s,db)=>{
  setup(s);s.prepare('alice','session','request',1,'hello');
  if(kind==='reconcile')s.claim('alice','session','request',()=>true);
  let invoked=0;
  const guard=contract==='async'?(async()=>{invoked++;return true;}):new Proxy(()=>true,{apply(){invoked++;return true;}});
  assert.throws(()=>guardedChange(s,kind,guard as any),/authority-contract/);
  assert.equal(invoked,0);assert.equal(db.isTransaction,false);
}));
test('guidance idempotent already-claimed request still checks current root authority',()=>memory(s=>{
  setup(s);s.prepare('alice','session','request',1,'hello');s.claim('alice','session','request',()=>true);
  assert.throws(()=>s.claim('alice','session','request',()=>false),/authority|preflight/);
  assert.equal(s.receipt('alice','session','request')!.state,'unknown');
}));
test('async guidance authorization preserves original prepared submission and fences late SQL', async () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
  let release!: () => void, late: Promise<boolean> | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const store = new SessionGuidanceStore(db, () => 1000); setup(store);
    store.prepare('alice', 'session', 'request', 1, 'hello');
    db.exec('CREATE TABLE late_effect(value INTEGER)'); const insert = db.prepare('INSERT INTO late_effect VALUES(1)');
    const before = raw.prepare('SELECT * FROM guidance_submissions').all();
    assert.throws(() => store.claim('alice', 'session', 'request',
      (() => late = (async () => { await held; insert.run(); return true; })()) as any), /must be synchronous/);
    assert.deepEqual(raw.prepare('SELECT * FROM guidance_submissions').all(), before);
    assert.equal(raw.isTransaction, false); assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    const rejected = assert.rejects(late!, StorageConnectionUnavailable); release(); await rejected;
    assert.deepEqual(raw.prepare('SELECT * FROM late_effect').all(), []);
  } finally { release(); if (late) await late.catch(() => {}); db.close(); }
});
test('configuration CAS is isolated, bounded, and never submits a message', () => memory((s, db) => {
  assert.equal(s.config('alice', 'session'), undefined); assert.equal(db.prepare('SELECT count(*) n FROM sqlite_master').get()!.n, 0);
  const config = setup(s); assert.equal(config.revision, 1); assert.equal(s.inspect('alice', 'session')!.state, 'not_submitted');
  assert.equal(s.config('bob', 'session'), undefined);
  assert.equal(db.prepare('SELECT count(*) n FROM guidance_submissions').get()!.n, 0);
  assert.throws(() => s.save('alice', 'session', 0, 'stale', true), /revision/);
  assert.throws(() => s.save('alice', 'session', 1, 'x'.repeat(8001), true), /config/);
}));
test('immutable submission uses fixed revision and input digest, not a mutable config reference', () => memory(s => {
  setup(s); const first = s.prepare('alice', 'session', 'request', 1, 'hello');
  s.save('alice', 'session', 1, 'Changed', true);
  assert.deepEqual(s.prepare('alice', 'session', 'request', 1, 'hello'), first);
  assert.throws(() => s.prepare('alice', 'session', 'request', 1, 'changed'), /reused/);
  assert.throws(() => s.receipt('alice', 'other', 'request'), /target/);
  assert.throws(() => s.claim('alice', 'session', 'request', () => true), /preflight/);
}));
test('claim is committed once, unknown is not retryable, queue acceptance is not context confirmation', () => memory(s => {
  setup(s); s.prepare('alice', 'session', 'request', 1, 'hello');
  assert.throws(() => s.claim('alice', 'session', 'request', () => false), /preflight/);
  assert.equal(s.claim('alice', 'session', 'request', () => true).claimed, true);
  assert.equal(s.inspect('alice', 'session')!.state, 'unknown');
  assert.equal(s.claim('alice', 'session', 'request', () => true).claimed, false);
  s.reconcile('alice', 'session', 'request', { state: 'submitted', queueReceipt: 'queue-id' });
  assert.equal(s.inspect('alice', 'session')!.state, 'submitted');
  assert.throws(() => s.reconcile('alice', 'session', 'request', { state: 'rejected', queueReceipt: null }), /transition/);
  s.context('alice', 'session', 'epoch2'); assert.equal(s.inspect('alice', 'session')!.state, 'unknown');
}));
test('only exact fresh context/hash evidence confirms presence or absence; stale checks cannot overwrite it', () => memory((s, db) => {
  const config = setup(s), value = { epoch: 'epoch1', hash: config.hash, checkId: 'check1', state: 'confirmed_present' as const, observedAt: 999, expiresAt: 2000 };
  s.evidence('alice', 'session', value); assert.equal(s.inspect('alice', 'session')!.state, 'confirmed_present');
  assert.throws(() => s.evidence('alice', 'session', { ...value, hash: '0'.repeat(64) }), /stale/);
  assert.throws(() => s.evidence('alice', 'session', { ...value, epoch: 'other' }), /stale/);
  assert.throws(() => s.evidence('alice', 'session', { ...value, state: 'confirmed_absent' }), /order/);
  const later = new SessionGuidanceStore(db, () => 2000); assert.equal(later.inspect('alice', 'session')!.state, 'unknown');
  s.context('alice', 'session', 'epoch2'); assert.throws(() => s.evidence('alice', 'session', value), /stale/);
  assert.equal(s.inspect('alice', 'session')!.state, 'unknown');
}));
test('disabled and changed revisions invalidate evidence without automatic re-submission', () => memory((s, db) => {
  const c = setup(s); s.evidence('alice', 'session', { epoch: 'epoch1', hash: c.hash, checkId: 'check', state: 'confirmed_absent', observedAt: 900, expiresAt: 1500 });
  assert.equal(db.prepare('SELECT count(*) n FROM guidance_submissions').get()!.n, 0);
  s.save('alice', 'session', 1, 'Updated', false);
  assert.notEqual(s.inspect('alice', 'session')!.state, 'confirmed_absent');
  assert.throws(() => s.prepare('alice', 'session', 'request', 2, 'hi'), /config/);
}));
test('outer transaction cannot expose an uncommitted claim and stale config cannot submit', () => memory((s, db) => {
  setup(s); s.prepare('alice', 'session', 'request', 1, 'hello');
  db.exec('BEGIN'); assert.throws(() => s.claim('alice', 'session', 'request', () => true), /outer/); db.exec('ROLLBACK');
  assert.equal(s.receipt('alice', 'session', 'request')!.state, 'prepared');
  assert.throws(() => s.reconcile('alice', 'session', 'request', { state: 'submitted', queueReceipt: 'never-claimed' }), /transition/);
}));
test('physical reopen retains unknown delivery and reconciles only the original receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-guidance-')), path = join(dir, 'test.sqlite'); let db = new DatabaseSync(path);
  try {
    let s = new SessionGuidanceStore(db, () => 1000); setup(s); s.prepare('alice', 'session', 'request', 1, 'hello'); s.claim('alice', 'session', 'request', () => true);
    db.close(); db = new DatabaseSync(path); s = new SessionGuidanceStore(db, () => 1100);
    assert.equal(s.claim('alice', 'session', 'request', () => true).claimed, false);
    assert.equal(s.receipt('bob', 'session', 'request'), undefined);
    assert.equal(s.reconcile('alice', 'session', 'request', { state: 'submitted', queueReceipt: 'queue1' }).state, 'submitted');
  } finally { db.close(); rmSync(dir, { recursive: true }); }
});
test('expired or backwards-clock preview is not dispatchable', () => memory((s,db) => {
  setup(s);s.prepare('alice','session','request',1,'hello');
  assert.throws(()=>new SessionGuidanceStore(db,()=>301000).claim('alice','session','request',()=>true),/expired/);
  assert.throws(()=>new SessionGuidanceStore(db,()=>999).claim('alice','session','request',()=>true),/expired/);
  assert.equal(s.receipt('alice','session','request')!.state,'prepared');
}));
