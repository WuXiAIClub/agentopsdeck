import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { QuickChatStore, type QuickChatAuthority } from './quick-chat-store.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

const capability = { ephemeralRequest: true, noPersistentThread: true, originalLookup: true, maxOutput: 1024, epoch: 'epoch1' };
const profile = { id: 'profile', name: 'Temporary', target: 'fixture', model: 'fixture', outputLimit: 512 };
const actions = ['save','admit','claim','cancel','reconcile','complete','clear'] as const;
function fixture(action: typeof actions[number], work: (db: DatabaseSync, store: QuickChatStore) => void) {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new QuickChatStore(db, () => 1000, Buffer.alloc(32,1));
    store.saveProfile('alice',0,profile,capability);
    if (action !== 'save' && action !== 'admit') store.admit('alice','request',profile.id,1,'input',capability);
    if (action === 'reconcile' || action === 'complete' || action === 'clear') store.claim('alice','request','input',capability,()=>true);
    if (action === 'clear') store.complete('alice','request','PRIVATE_OUTPUT');
    work(db,store);
  } finally { db.close(); }
}
function invoke(store: QuickChatStore, action: typeof actions[number], authority: QuickChatAuthority) {
  if (action === 'save') return store.saveProfile('alice',1,{...profile,name:'Changed'},capability,authority);
  if (action === 'admit') return store.admit('alice','request',profile.id,1,'input',capability,authority);
  if (action === 'claim') return store.claim('alice','request','input',capability,authority);
  if (action === 'cancel') return store.cancelAdmitted('alice','request',authority);
  if (action === 'reconcile') return store.reconcile('alice','request','failed',null,authority);
  if (action === 'complete') return store.complete('alice','request','PRIVATE_OUTPUT',authority);
  return store.clearResult('alice','request',authority);
}
const snapshot = (db: DatabaseSync) => ['quick_chat_profiles','quick_chat_receipts','quick_chat_results']
  .map(table => db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());
for (const action of actions) {
  test('quick chat '+action+' denial at root entry changes nothing',()=>fixture(action,(db,store)=>{
    const before = snapshot(db); let calls = 0;
    assert.throws(()=>invoke(store,action,()=>{calls++;return false;}),/authority|preflight/);
    assert.equal(calls,1); assert.deepEqual(snapshot(db),before); assert.equal(db.isTransaction,false);
  }));
  test('quick chat '+action+' rechecks authority after SQL before COMMIT',()=>fixture(action,(db,store)=>{
    const before = snapshot(db); let calls = 0;
    const final = action === 'claim' ? 3 : 2;
    assert.throws(()=>invoke(store,action,()=>++calls < final),/authority|preflight/);
    assert.equal(calls,final); assert.deepEqual(snapshot(db),before); assert.equal(db.isTransaction,false);
    // Once-only barriers remain at their original state, with no emitted permit.
    if (action === 'claim') assert.equal(store.receipt('alice','request')?.state,'admitted');
    if (action === 'complete') assert.equal(store.result('alice','request'),undefined);
    if (action === 'clear') assert.equal(store.result('alice','request'),'PRIVATE_OUTPUT');
  }));
  test('quick chat '+action+' accepts synchronous fresh authority and leaves no open transaction',()=>fixture(action,(db,store)=>{
    let calls = 0; invoke(store,action,()=>{calls++;return true;});
    assert.equal(calls,action === 'claim' ? 3 : 2); assert.equal(db.isTransaction,false);
    if (action === 'claim') { assert.equal(store.claim('alice','request','input',capability,()=>true).claimed,false);
      assert.throws(()=>store.cancelAdmitted('alice','request'),/already-dispatched/); }
  }));
}
test('async late precommit authority is rejected, original owner fenced, and no claim escapes',async()=>{
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
  let release!:()=>void, late:Promise<boolean>|undefined;
  const held = new Promise<void>(resolve=>{release=resolve;});
  try {
    const store = new QuickChatStore(db,()=>1000,Buffer.alloc(32,1));
    store.saveProfile('alice',0,profile,capability); store.admit('alice','request',profile.id,1,'input',capability);
    db.exec('CREATE TABLE late_effect(value INTEGER)'); const insert = db.prepare('INSERT INTO late_effect VALUES(1)');
    let calls = 0;
    const before = snapshot(raw);
    const authorized = (()=>++calls < 3 ? true : late=(async()=>{await held;insert.run();return true;})()) as QuickChatAuthority;
    assert.throws(()=>store.claim('alice','request','input',capability,authorized),/must be synchronous/);
    assert.deepEqual(snapshot(raw),before); assert.equal(connectionRecoverySnapshot(db).state,'close-required');
    const rejected = assert.rejects(late!,StorageConnectionUnavailable);release();await rejected;
    assert.deepEqual(raw.prepare('SELECT * FROM late_effect').all(),[]);
  } finally {release();if(late)await late.catch(()=>{});db.close();}
});
