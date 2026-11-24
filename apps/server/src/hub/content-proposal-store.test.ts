import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentProposalStore } from './content-proposal-store.js';
import type { NativeWorkspaceCardFileProjection } from './workspace-card-file-projection.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

test('binding revocation cannot commit while its receipt callback is still asynchronous', async () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
  const store = new ContentProposalStore(db, text => text, () => true);
  store.initialize('alice', 'note', 'epoch', 'Original');
  const binding = store.bind('alice', 'note', 'binding', 'authority');
  db.exec('CREATE TABLE late_effect(value INTEGER)'); const insert = db.prepare('INSERT INTO late_effect VALUES(1)');
  let release!: () => void, late: Promise<void> | undefined, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const before = raw.prepare('SELECT * FROM v2_proposal_bindings').all();
    assert.throws(() => store.revokeBindings('alice', 'note', [binding.id], () => {
      calls++; return late = (async () => { await held; insert.run(); })();
    }), /must be synchronous/);
    assert.equal(calls, 1); assert.equal(raw.isTransaction, false);
    assert.deepEqual(raw.prepare('SELECT * FROM v2_proposal_bindings').all(), before);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    const rejected = assert.rejects(late!, StorageConnectionUnavailable); release(); await rejected;
    assert.deepEqual(raw.prepare('SELECT * FROM late_effect').all(), []);
  } finally { release(); if (late) await late.catch(() => {}); db.close(); }
});

test('migration recovery serializes absent request and rejects delayed migration without touching native content',()=>memory(db=>{
  const store=new ContentProposalStore(db,normalize,()=>true);
  let claims=0;
  const projection={claimMigration:()=>{claims++;throw Error('must not touch native');}} as unknown as NativeWorkspaceCardFileProjection;
  assert.equal(store.migrationTermination('alice','request'),undefined);
  const proof=store.recoverMigration('alice','note','request');
  assert.deepEqual(proof,{receipt:null,termination:{mutationId:'request',resource:'note',state:'not-executed'}});
  assert.deepEqual(store.recoverMigration('alice','note','request'),proof);
  assert.throws(()=>store.migrateNativeRequest('alice','note',0,'request',projection),/migration-terminated/);
  assert.equal(claims,0);assert.equal(store.resource('alice','note'),undefined);
  assert.equal(store.migration('alice','request'),undefined);
  assert.throws(()=>store.recoverMigration('alice','other','request'),/migration-reused/);
  assert.equal(store.migrationTermination('bob','request'),undefined);
  assert.equal(store.recoverMigration('bob','other','request').termination?.resource,'other');
}));

test('migration recovery persistence failure rolls back fence, limits capacity and rejects nested transaction',()=>memory(db=>{
  const store=new ContentProposalStore(db,normalize,()=>true);
  store.recoverMigration('alice','note','first');
  db.exec("CREATE TRIGGER reject_termination BEFORE INSERT ON v2_content_migration_terminations BEGIN SELECT RAISE(ABORT,'injected persistence failure'); END");
  assert.throws(()=>store.recoverMigration('alice','note','lost'),/injected persistence/);
  assert.equal(store.migrationTermination('alice','lost'),undefined);
  db.exec('DROP TRIGGER reject_termination');
  for(let i=1;i<128;i++)store.recoverMigration('alice','note','request'+i);
  assert.throws(()=>store.recoverMigration('alice','note','overflow'),/migration-recovery-capacity/);
  assert.equal(store.recoverMigration('alice','note','first').termination?.state,'not-executed');
  db.exec('BEGIN');assert.throws(()=>store.recoverMigration('alice','note','first'),/outer-transaction/);db.exec('ROLLBACK');
}));

test('migration termination survives database reopen and lost recovery response',()=>{
  const root=mkdtempSync(join(tmpdir(),'content-termination-')),path=join(root,'db.sqlite');
  let db=new DatabaseSync(path);
  try {
    new ContentProposalStore(db,normalize,()=>true).recoverMigration('alice','note','original');
    db.close();db=new DatabaseSync(path);
    const store=new ContentProposalStore(db,normalize,()=>true);
    assert.deepEqual(store.migrationTermination('alice','original'),{mutationId:'original',resource:'note',state:'not-executed'});
    assert.throws(()=>store.migrateNativeRequest('alice','note',0,'original',{} as NativeWorkspaceCardFileProjection),/migration-terminated/);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

const normalize = (text: string) => { if (text.length > 50000) throw Error('notebook-capacity'); return text; };
function setup(db: DatabaseSync, authority = () => true) {
  const store = new ContentProposalStore(db, normalize, authority);
  const base = store.initialize('alice', 'note', 'v2-epoch', 'Original');
  const a = store.bind('alice', 'note', 'a', 'auth1'), b = store.bind('alice', 'note', 'b', 'auth1');
  store.acknowledgeInstallation('alice', 'note', a.id, a.generation, base);
  store.acknowledgeInstallation('alice', 'note', b.id, b.generation, base);
  const proposal = { bindingId: a.id, generation: a.generation, mutationId: 'mutation1', modeEpoch: base.epoch, baseRevision: base.revision, baseHash: base.hash, content: 'Changed' };
  return { store, base, a, b, proposal };
}
function memory(fn: (db: DatabaseSync) => void) { const db = new DatabaseSync(':memory:'); try { fn(db); } finally { db.close(); } }
test('write recovery fences a delayed owner save without changing content, bindings or outbox',()=>memory(db=>{
  const {store:s,base,proposal:p}=setup(db);
  const before=s.resource('alice','note'),bindings=s.listBindings('alice','note');
  const proof=s.recoverWrite('alice','note',base.epoch,p.mutationId);
  assert.deepEqual(proof,{receipt:null,termination:{mutationId:p.mutationId,resource:'note',epoch:base.epoch,state:'not-executed'}});
  assert.deepEqual(s.recoverWrite('alice','note',base.epoch,p.mutationId),proof);
  assert.throws(()=>s.write('alice','note',p),/write-terminated/);
  assert.deepEqual(s.resource('alice','note'),before);assert.deepEqual(s.listBindings('alice','note'),bindings);
  assert.equal(db.prepare('SELECT count(*) n FROM v2_projection_outbox').get()!.n,0);
  assert.equal(s.ownerReceipt('alice','note',base.epoch,p.mutationId),undefined);
  assert.equal(s.writeTermination('other','note',base.epoch,p.mutationId),undefined);
  assert.equal(s.writeTermination('alice','other',base.epoch,p.mutationId),undefined);
  assert.equal(s.writeTermination('alice','note','other-epoch',p.mutationId),undefined);
  assert.throws(()=>s.recoverWrite('alice','note','other-epoch',p.mutationId),/mode-epoch/);
  assert.throws(()=>s.recoverWrite('other','note',base.epoch,p.mutationId),/resource-missing/);
  // Session proposals are a separate authority and cannot be cancelled by an owner-write fence.
  assert.equal(s.propose('alice','note',p).state,'committed');
}));
test('write recovery returns committed/conflict receipts and never rolls back a remote save',()=>memory(db=>{
  const {store:s,base,proposal:p}=setup(db);
  const receipt=s.write('alice','note',p),after=s.resource('alice','note');
  assert.deepEqual(s.recoverWrite('alice','note',base.epoch,p.mutationId),{receipt,termination:null});
  assert.equal(s.writeTermination('alice','note',base.epoch,p.mutationId),undefined);
  assert.deepEqual(s.resource('alice','note'),after);
  const conflict=s.write('alice','note',{...p,mutationId:'conflicted'});
  assert.equal(conflict.state,'conflict');assert.deepEqual(s.recoverWrite('alice','note',base.epoch,'conflicted'),{receipt:conflict,termination:null});
}));
test('write recovery persistence failure, capacity and nested transaction leave content untouched',()=>memory(db=>{
  const {store:s,base,proposal:p}=setup(db);s.recoverWrite('alice','note',base.epoch,'first');
  db.exec("CREATE TRIGGER reject_write_termination BEFORE INSERT ON v2_content_write_terminations BEGIN SELECT RAISE(ABORT,'injected-failure'); END");
  assert.throws(()=>s.recoverWrite('alice','note',base.epoch,'failed'),/injected-failure/);assert.equal(s.writeTermination('alice','note',base.epoch,'failed'),undefined);
  db.exec('DROP TRIGGER reject_write_termination');
  for(let i=1;i<128;i++)s.recoverWrite('alice','note',base.epoch,'fence-'+i);
  assert.throws(()=>s.recoverWrite('alice','note',base.epoch,p.mutationId),/write-recovery-capacity/);
  assert.equal(s.resource('alice','note')!.revision,0);
  db.exec('BEGIN');assert.throws(()=>s.recoverWrite('alice','note',base.epoch,'nested'),/outer-transaction/);db.exec('ROLLBACK');
}));
test('owner write termination survives database reopen and storage admission failures',()=>{
  const root=mkdtempSync(join(tmpdir(),'owner-write-termination-')),path=join(root,'db.sqlite');
  let db=new DatabaseSync(path);
  try{
    const {store,base,proposal}=setup(db);
    const proof=store.recoverWrite('alice','note',base.epoch,proposal.mutationId);
    db.close();db=new DatabaseSync(path);
    const reopened=new ContentProposalStore(db,normalize,()=>true,()=>{throw Error('disk-low');});
    assert.deepEqual(reopened.recoverWrite('alice','note',base.epoch,proposal.mutationId),proof);
    assert.throws(()=>reopened.write('alice','note',proposal),/write-terminated/);
    assert.throws(()=>reopened.recoverWrite('alice','note',base.epoch,'unfenced'),/disk-low/);
    assert.equal(reopened.writeTermination('alice','note',base.epoch,'unfenced'),undefined);
    assert.equal(reopened.resource('alice','note')!.content,base.content);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
test('storage rejects fresh durable work but original receipts, settlement and revoke remain available',()=>memory(db=>{
  const f=setup(db);let deny=false;const reservations:number[]=[];
  const s=new ContentProposalStore(db,normalize,()=>true,(bytes,write)=>{reservations.push(bytes);if(deny)throw Error('disk-low');return write();});
  deny=true;
  assert.throws(()=>s.propose('alice','note',f.proposal),/disk-low/);
  assert.equal(s.receipt('alice','note',f.a.id,f.a.generation,f.proposal.mutationId),undefined);
  assert.equal(s.resource('alice','note')!.revision,0);
  assert.throws(()=>s.bind('alice','note','new','auth1'),/disk-low/);
  deny=false;const receipt=s.propose('alice','note',f.proposal);
  const job=s.projections('alice','note',f.b.id,f.b.generation)[0]!;
  deny=true;assert.throws(()=>s.claimProjection('alice','note',job.id,f.base.hash,false),/disk-low/);
  assert.deepEqual(s.propose('alice','note',f.proposal),receipt);
  s.acknowledgeProposal('alice','note',f.a.id,f.a.generation,receipt.mutationId,receipt.hash);
  s.revoke('alice','note',f.b.id);
  assert.ok(reservations.some(bytes=>bytes>=128*1024*1024));
}));
test('unconfirmed installation cannot propose or receive projection, and stale proof cannot be adopted', () => memory(db => {
  const { store: s, base, proposal: p } = setup(db);
  const fresh = s.bind('alice', 'note', 'fresh', 'auth1');
  assert.throws(() => s.propose('alice', 'note', { ...p, bindingId: fresh.id, generation: fresh.generation }), /installation-unconfirmed/);
  s.propose('alice', 'note', p);
  const job = s.projections('alice', 'note', fresh.id, fresh.generation)[0]!;
  assert.throws(() => s.claimProjection('alice', 'note', job.id, base.hash, false), /installation-unconfirmed/);
  assert.throws(() => s.acknowledgeInstallation('alice', 'note', fresh.id, fresh.generation, base), /installation-stale/);
  const current = s.resource('alice', 'note')!;
  assert.throws(() => s.acknowledgeInstallation('alice', 'note', fresh.id, fresh.generation, { ...current, epoch: 'wrong' }), /installation-proof/);
  assert.equal(s.acknowledgeInstallation('alice', 'note', fresh.id, fresh.generation, current).acknowledgedRevision, 1);
  assert.equal(s.acknowledgeInstallation('alice', 'note', fresh.id, fresh.generation, current).acknowledgedRevision, 1);
  assert.throws(() => s.acknowledgeInstallation('alice', 'note', fresh.id, fresh.generation, base), /installation-reused/);
}));
test('originating proposal ACK needs original committed proof and cannot downgrade or clear another job', () => memory(db => {
  const { store: s, a, b, proposal: p } = setup(db), receipt = s.propose('alice', 'note', p);
  assert.throws(() => s.acknowledgeProposal('alice', 'note', a.id, a.generation, p.mutationId, p.baseHash), /unproven/);
  assert.throws(() => s.acknowledgeProposal('alice', 'note', b.id, b.generation, p.mutationId, receipt.hash), /unproven/);
  s.acknowledgeProposal('alice', 'note', a.id, a.generation, p.mutationId, receipt.hash);
  assert.equal(s.projections('alice', 'note', a.id, a.generation)[0]!.state, 'acknowledged');
  assert.equal(s.projections('alice', 'note', b.id, b.generation)[0]!.state, 'pending');
  const next = s.propose('alice', 'note', { ...p, mutationId: 'next', baseRevision: receipt.revision, baseHash: receipt.hash, content: 'Next' });
  s.acknowledgeProposal('alice', 'note', a.id, a.generation, next.mutationId, next.hash);
  assert.throws(() => s.acknowledgeProposal('alice', 'note', a.id, a.generation, p.mutationId, receipt.hash), /stale/);
}));
test('content, immutable receipt and per-binding outbox commit together; same request does not duplicate', () => memory(db => {
  const { store: s, a, b, proposal: p } = setup(db);
  const receipt = s.propose('alice', 'note', p); assert.equal(receipt.state, 'committed'); assert.equal(receipt.revision, 1);
  assert.equal(s.resource('alice', 'note')!.content, 'Changed');
  assert.deepEqual(s.propose('alice', 'note', p), receipt);
  assert.equal(s.projections('alice', 'note', a.id, a.generation).length, 1);
  assert.equal(s.projections('alice', 'note', b.id, b.generation).length, 1);
  assert.throws(() => s.propose('alice', 'note', { ...p, content: 'Different' }), /reused/);
}));
test('parallel bases produce a durable conflict, not a merge; retries preserve original outcome', () => memory(db => {
  const { store: s, b, proposal: p } = setup(db); s.propose('alice', 'note', p);
  const other = { ...p, bindingId: b.id, generation: b.generation, content: 'Other draft' };
  const conflict = s.propose('alice', 'note', other); assert.equal(conflict.state, 'conflict');
  assert.equal(s.resource('alice', 'note')!.content, 'Changed');
  assert.deepEqual(s.propose('alice', 'note', other), conflict);
  assert.equal(db.prepare('SELECT content FROM v2_content_proposals WHERE binding=?').get(b.id)!.content, 'Other draft');
  assert.equal(s.projections('alice', 'note', b.id, b.generation).length, 1);
}));
test('failed outbox insert rolls back content and receipt as one transaction', () => memory(db => {
  const { store: s, base, proposal: p } = setup(db);
  db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON v2_projection_outbox BEGIN SELECT RAISE(ABORT, 'fixture-outbox-failure'); END");
  assert.throws(() => s.propose('alice', 'note', p), /fixture-outbox/);
  assert.deepEqual(s.resource('alice', 'note'), base);
  assert.equal(s.receipt('alice', 'note', p.bindingId, p.generation, p.mutationId), undefined);
  db.exec('DROP TRIGGER fail_outbox'); assert.equal(s.propose('alice', 'note', p).state, 'committed');
}));
test('dirty content, local proposals and unproven ACK cannot be overwritten; unknown dispatch does not retry', () => memory(db => {
  const { store: s, a, proposal: p } = setup(db); s.propose('alice', 'note', p);
  const job = s.projections('alice', 'note', a.id, a.generation)[0];
  assert.ok(job);
  assert.throws(() => s.claimProjection('alice', 'note', job.id, '1'.repeat(64), false), /dirty/);
  assert.throws(() => s.claimProjection('alice', 'note', job.id, '1'.repeat(64), true), /dirty/);
  assert.throws(() => s.acknowledgeProjection('alice', 'note', job.id, job.hash), /unproven/);
  assert.equal(s.claimProjection('alice', 'note', job.id, p.baseHash, false).claimed, true);
  assert.equal(s.claimProjection('alice', 'note', job.id, p.baseHash, false).claimed, false);
  assert.throws(() => s.acknowledgeProjection('alice', 'note', job.id, '0'.repeat(64)), /unproven/);
  assert.equal(s.acknowledgeProjection('alice', 'note', job.id, job.hash).state, 'acknowledged');
  assert.equal(s.acknowledgeProjection('alice', 'note', job.id, job.hash).state, 'acknowledged');
  assert.equal(s.resource('alice', 'note')!.revision, 1, 'ACK never increments content revision');
}));
test('out-of-order projection cannot downgrade a newer acknowledged file', () => memory(db => {
  const { store: s, a, proposal: p } = setup(db); s.propose('alice', 'note', p);
  const current = s.resource('alice', 'note')!;
  s.propose('alice', 'note', { ...p, mutationId: 'second', baseHash: current.hash, baseRevision: current.revision, content: 'Newest' });
  const jobs = s.projections('alice', 'note', a.id, a.generation).sort((a, b) => a.revision - b.revision);
  const [older, newer] = jobs;
  assert.ok(older); assert.ok(newer);
  s.claimProjection('alice', 'note', newer.id, p.baseHash, false);
  assert.throws(() => s.claimProjection('alice', 'note', older.id, p.baseHash, false), /unresolved/);
  s.acknowledgeProjection('alice', 'note', newer.id, newer.hash);
  assert.throws(() => s.claimProjection('alice', 'note', older.id, newer.hash, false), /stale/);
}));
test('revocation hides receipts, blocks pending and unknown projections, and never reuses a tombstone', () => memory(db => {
  const { store: s, a, proposal: p } = setup(db); s.propose('alice', 'note', p);
  const job = s.projections('alice', 'note', a.id, a.generation)[0]; assert.ok(job); s.claimProjection('alice', 'note', job.id, p.baseHash, false);
  s.revoke('alice', 'note', a.id);
  assert.throws(() => s.receipt('alice', 'note', a.id, a.generation, p.mutationId), /forbidden/);
  assert.throws(() => s.acknowledgeProjection('alice', 'note', job.id, job.hash), /forbidden/);
  assert.throws(() => s.propose('alice', 'note', p), /forbidden/);
  assert.throws(() => s.bind('alice', 'note', a.id, 'auth2'), /reused/);
  assert.equal(s.resource('bob', 'note'), undefined);
  assert.throws(() => s.projections('bob', 'note', a.id, a.generation), /forbidden/);
}));
test('authority is rechecked, invalid schema/epoch/outer transaction cannot write', () => memory(db => {
  let allowed = true; const { store: s, proposal: p } = setup(db, () => allowed);
  allowed = false; assert.throws(() => s.propose('alice', 'note', p), /forbidden/); allowed = true;
  assert.throws(() => s.propose('alice', 'note', { ...p, modeEpoch: 'legacy' }), /epoch/);
  assert.throws(() => s.propose('alice', 'note', { ...p, content: 'x'.repeat(50001) }), /capacity/);
  db.exec('BEGIN'); assert.throws(() => s.propose('alice', 'note', p), /outer/); db.exec('ROLLBACK');
  assert.equal(s.resource('alice', 'note')!.revision, 0);
}));
test('physical reopen preserves original receipt, proposal draft and unresolved dispatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-store-')); let db = new DatabaseSync(join(dir, 'fixture.db'));
  try {
    const { store: s, a, proposal: p } = setup(db), receipt = s.propose('alice', 'note', p);
    const job = s.projections('alice', 'note', a.id, a.generation)[0]; assert.ok(job); s.claimProjection('alice', 'note', job.id, p.baseHash, false);
    db.close(); db = new DatabaseSync(join(dir, 'fixture.db'));
    const reopened = new ContentProposalStore(db, normalize, () => true);
    assert.deepEqual(reopened.propose('alice', 'note', p), receipt);
    assert.equal(reopened.claimProjection('alice', 'note', job.id, p.baseHash, false).claimed, false);
    assert.equal(reopened.acknowledgeProjection('alice', 'note', job.id, job.hash).state, 'acknowledged');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
