import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskSessionWorkflow,type TaskSessionIntent } from './task-session-workflow.js';
const intent:TaskSessionIntent={owner:'alice',requestId:'11111111-1111-4111-8111-111111111111',nodeId:'node',connectionId:'connector',runtime:'codex',authorityEpoch:1,
  boardId:'22222222-2222-4222-8222-222222222222',boardRevision:3,title:'Synthetic',tasks:[{id:'33333333-3333-4333-8333-333333333333',title:'Task',detail:'',status:'todo'}],fields:['status'],expiresAt:1900000000000};
function memory(fn:(s:TaskSessionWorkflow,db:DatabaseSync)=>void){const db=new DatabaseSync(':memory:');try{fn(new TaskSessionWorkflow(db,()=>true),db);}finally{db.close();}}
const claim=(s:TaskSessionWorkflow,phase:'create'|'bind')=>s.claim(intent.owner,intent.requestId,phase);
function created(s:TaskSessionWorkflow){const r=s.prepare(intent);claim(s,'create');return s.recordCreation(intent.owner,intent.requestId,{requestId:r.creationRequestId,state:'created',sessionId:'native-created'});}
test('task selection and phase identities are immutable and both dispatches are single-claim',()=>memory(s=>{
  const r=s.prepare(intent);assert.notEqual(r.creationRequestId,r.bindingRequestId);
  assert.deepEqual(s.prepare(intent),r);assert.throws(()=>s.prepare({...intent,fields:['detail']}),/reused/);
  assert.equal(claim(s,'bind').claimed,false);assert.equal(claim(s,'create').claimed,true);assert.equal(claim(s,'create').claimed,false);
  s.recordCreation(intent.owner,intent.requestId,{requestId:r.creationRequestId,state:'created',sessionId:'session'});
  assert.equal(claim(s,'bind').claimed,true);assert.equal(claim(s,'bind').claimed,false);
  const done=s.recordBinding(intent.owner,intent.requestId,{requestId:r.bindingRequestId,state:'bound',sessionId:'session',bindingId:'binding'});
  assert.equal(done.state,'bound');assert.equal(done.intent.tasks[0]?.status,'todo');
}));
test('binding failure retains the session and cannot restart creation or auto-retry binding',()=>memory(s=>{
  const r=created(s);claim(s,'bind');const failure=s.recordBinding(intent.owner,intent.requestId,{requestId:r.bindingRequestId,state:'rejected'});
  assert.equal(failure.sessionId,'native-created');assert.equal(failure.state,'binding_rejected');
  assert.equal(claim(s,'create').claimed,false);assert.equal(claim(s,'bind').claimed,false);
}));
test('late unknown cannot downgrade confirmed creation/binding and wrong identities fail closed',()=>memory(s=>{
  const r=created(s);assert.equal(s.recordCreation(intent.owner,intent.requestId,{requestId:r.creationRequestId,state:'unknown'}).state,'created');
  assert.throws(()=>s.recordCreation(intent.owner,intent.requestId,{requestId:r.creationRequestId,state:'created',sessionId:'other'}),/receipt/);
  claim(s,'bind');assert.throws(()=>s.recordBinding(intent.owner,intent.requestId,{requestId:r.bindingRequestId,state:'bound',sessionId:'other',bindingId:'b'}),/receipt/);
  s.recordBinding(intent.owner,intent.requestId,{requestId:r.bindingRequestId,state:'bound',sessionId:'native-created',bindingId:'b'});
  assert.equal(s.recordBinding(intent.owner,intent.requestId,{requestId:r.bindingRequestId,state:'unknown'}).state,'bound');
}));
test('cancel only before dispatch, outer transactions cannot return dispatch permission',()=>memory((s,db)=>{
  s.prepare(intent);db.exec('BEGIN');assert.throws(()=>claim(s,'create'),/outer/);db.exec('ROLLBACK');
  assert.equal(s.cancelPrepared(intent.owner,intent.requestId).state,'cancelled');assert.equal(claim(s,'create').claimed,false);
}));
test('original proof and trusted binding participant share the real workflow transaction',()=>memory((s,db)=>{
  const r=created(s);db.exec('CREATE TABLE participant(value TEXT)');
  let proofs=0;
  const proof=()=>{assert.equal(db.isTransaction,true);proofs++;};
  assert.throws(()=>s.claim(intent.owner,intent.requestId,'bind',proof,()=>{
    assert.equal(db.isTransaction,true);db.prepare('INSERT INTO participant VALUES (?)').run('rolled-back');throw Error('participant-rejected');
  }),/participant-rejected/);
  assert.equal(s.read(intent.owner,intent.requestId)?.state,'created');
  assert.equal(db.prepare('SELECT count(*) n FROM participant').get()!.n,0);
  let participants=0;
  const result=s.claim(intent.owner,intent.requestId,'bind',proof,receipt=>{
    participants++;assert.equal(receipt.state,'binding_unknown');assert.equal(receipt.bindingRequestId,r.bindingRequestId);
    db.prepare('INSERT INTO participant VALUES (?)').run('committed');
  });
  assert.equal(result.claimed,true);assert.equal(db.isTransaction,false);
  assert.equal(s.claim(intent.owner,intent.requestId,'bind',proof,()=>{participants++;}).claimed,false);
  assert.equal(participants,1);assert.equal(proofs,3);
  assert.equal(db.prepare('SELECT count(*) n FROM participant').get()!.n,1);
}));
for(const callback of ['proof','participant'] as const)test(`async ${callback} cannot escape a synchronous workflow transaction`,()=>memory((s,db)=>{
  created(s);
  const asyncCallback=async()=>{db.prepare('INSERT INTO hub_task_session_cancellations VALUES (?,?)').run('async','test');};
  assert.throws(()=>s.claim(intent.owner,intent.requestId,'bind',callback==='proof'?asyncCallback:undefined,
    callback==='participant'?asyncCallback:undefined),/synchronous/);
  assert.equal(db.isTransaction,false);
  assert.equal(db.prepare('SELECT count(*) n FROM hub_task_session_cancellations').get()!.n,0);
  const row=db.prepare('SELECT payload FROM hub_task_session_workflows').get()!;
  assert.equal(JSON.parse(String(row.payload)).state,'created');
}));
test('revocation prevents reads and settlement; another owner cannot see the workflow',()=>memory((_s,db)=>{
  let allowed=true;const s=new TaskSessionWorkflow(db,()=>allowed);s.prepare(intent);claim(s,'create');allowed=false;
  assert.throws(()=>s.read(intent.owner,intent.requestId),/forbidden/);assert.throws(()=>claim(s,'create'),/forbidden/);
  assert.equal(s.read('bob',intent.requestId),undefined);
}));
test('physical reopen keeps unknown creation, then recovers original identity without replay',()=>{
  const dir=mkdtempSync(join(tmpdir(),'task-session-'));let db=new DatabaseSync(join(dir,'fixture.db'));
  try{let s=new TaskSessionWorkflow(db,()=>true);const r=s.prepare(intent);claim(s,'create');db.close();db=new DatabaseSync(join(dir,'fixture.db'));s=new TaskSessionWorkflow(db,()=>true);
    assert.equal(claim(s,'create').claimed,false);assert.equal(s.read(intent.owner,intent.requestId)?.state,'creation_unknown');
    assert.equal(s.recordCreation(intent.owner,intent.requestId,{requestId:r.creationRequestId,state:'created',sessionId:'recovered'}).sessionId,'recovered');
    assert.equal(claim(s,'bind').claimed,true);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
