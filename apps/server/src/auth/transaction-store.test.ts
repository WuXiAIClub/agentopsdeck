import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactionAuthStore } from './transaction-store.js';
const h = (c:string) => c.repeat(64);
function setup(db:DatabaseSync) {
  const s = new TransactionAuthStore(db,()=>1000); s.register('alice','credential','example.test');
  const base = s.prepareChallenge('alice','credential',h('a'),2000);
  const input = {owner:'alice',credentialId:'credential',rpId:'example.test',...base,challengeDigest:h('a'),sessionDigest:h('b'),requestId:'first',counter:1,expiresAt:10000};
  return {s,input};
}
function memory(fn:(db:DatabaseSync)=>void) {const db=new DatabaseSync(':memory:');try{fn(db);}finally{db.close();}}
test('auth issuance atomically consumes challenge, persists original receipt, and stores only digests',()=>memory(db=>{
  const {s,input}=setup(db), r=s.issueVerified(input);
  assert.deepEqual(s.issueVerified(input),r); assert.equal(s.authorize(h('b'))?.owner,'alice');
  assert.throws(()=>s.issueVerified({...input,requestId:'second',sessionDigest:h('c')}),/stale/);
  assert.throws(()=>s.issueVerified({...input,sessionDigest:h('c')}),/reused/);
  assert.equal(db.prepare('SELECT count(*) n FROM auth_v2_sessions').get()!.n,1);
}));
test('counter advance does not invalidate older live sessions; revoked credentials invalidate all',()=>memory(db=>{
  const {s,input}=setup(db);s.issueVerified(input);
  const base=s.prepareChallenge('alice','credential',h('c'),2000);
  s.issueVerified({...input,...base,challengeDigest:h('c'),sessionDigest:h('d'),requestId:'next',counter:2});
  assert.ok(s.authorize(h('b'))); assert.ok(s.authorize(h('d')));
  s.revoke('alice','credential',1); assert.equal(s.authorize(h('b')),undefined);assert.equal(s.authorize(h('d')),undefined);
  assert.throws(()=>s.issueVerified(input),/unavailable/);assert.throws(()=>s.register('alice','credential','example.test'));
}));
test('wrong owner/rp/counter/expired challenge cannot issue a session',()=>memory(db=>{
  const {s,input}=setup(db);
  assert.throws(()=>s.issueVerified({...input,owner:'bob'}),/unavailable/);
  assert.throws(()=>s.issueVerified({...input,rpId:'wrong'}),/stale/);
  assert.throws(()=>s.issueVerified({...input,expiresAt:1000}),/expiry/);
  const later=new TransactionAuthStore(db,()=>2000);assert.throws(()=>later.issueVerified(input),/stale/);
  s.issueVerified(input);const base=s.prepareChallenge('alice','credential',h('c'),2000);
  assert.throws(()=>s.issueVerified({...input,...base,challengeDigest:h('c'),sessionDigest:h('d'),requestId:'next',counter:1}),/counter/);
}));
test('audit failure rolls back session, counter, receipt and challenge consumption',()=>memory(db=>{
  const {s,input}=setup(db);db.exec("CREATE TRIGGER fail_auth BEFORE INSERT ON auth_v2_events BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(()=>s.issueVerified(input),/fixture/);assert.equal(s.authorize(h('b')),undefined);
  assert.equal(db.prepare('SELECT consumed FROM auth_v2_challenges').get()!.consumed,0);
  assert.equal(db.prepare('SELECT version FROM auth_v2_credentials').get()!.version,0);
  db.exec('DROP TRIGGER fail_auth');assert.equal(s.issueVerified(input).generation,1);
}));
test('independent connections reject stale verification and see revocation after reopen',()=>{
  const dir=mkdtempSync(join(tmpdir(),'auth-transaction-'));let a=new DatabaseSync(join(dir,'fixture.db')),b=new DatabaseSync(join(dir,'fixture.db'));
  try{const {s,input}=setup(a), other=new TransactionAuthStore(b,()=>1000);s.issueVerified(input);
    assert.throws(()=>other.issueVerified({...input,requestId:'race',sessionDigest:h('c')}),/stale/);
    assert.ok(other.authorize(h('b')));other.revoke('alice','credential',1);assert.equal(s.authorize(h('b')),undefined);
    a.close();a=new DatabaseSync(join(dir,'fixture.db'));assert.equal(new TransactionAuthStore(a,()=>1000).authorize(h('b')),undefined);
  }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test('outer transactions and exhausted capacity cannot authorize uncommitted state',()=>memory(db=>{
  const {s,input}=setup(db);db.exec('BEGIN');assert.throws(()=>s.issueVerified(input),/outer/);db.exec('ROLLBACK');
  db.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO auth_v2_sessions SELECT printf('%064x',x),'fixture','fixture',1,0,1 FROM n");
  assert.throws(()=>s.issueVerified(input),/capacity/);assert.equal(s.authorize(h('b')),undefined);
}));
