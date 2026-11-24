import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,linkSync,symlinkSync,mkdirSync,writeFileSync,unlinkSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import type {Worker} from 'node:worker_threads';
import {StartupDatabaseOwners} from './startup-owner.js';
import {StorageConnectionUnavailable} from './connection-recovery.js';
import {PerformanceDiagnostics} from '../diagnostics/performance.js';
import {HubStore} from '../hub/hub-store.js';
import {AsyncHubMemberOwner} from '../hub/async-member-owner.js';
import {HubMemberOwnerUnavailable} from '../hub/member-owner-domain.js';
import {AsyncSqliteAuthOwner} from '../auth/async-sqlite-owner.js';
import {openSqliteAuth} from '../auth/sqlite-store.js';
import {AuthPersistenceError} from '../auth/private-store.js';

const silent=new PerformanceDiagnostics(()=>{});
function fixture(t:{after(fn:()=>void):void}){
  const root=mkdtempSync(join(tmpdir(),'agentopsdeck-mixed-owner-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {root,file:join(root,'original.sqlite'),owners:new StartupDatabaseOwners(silent)};
}
test('legacy synchronous multi-connection contract stays valid; exclusive owner waits for every native close',t=>{
  const f=fixture(t),first=f.owners.open(f.file),second=f.owners.open(f.file);
  try{
    assert.throws(()=>f.owners.reserveExclusive(f.file),StorageConnectionUnavailable);
    first.close();
    assert.throws(()=>f.owners.reserveExclusive(f.file),StorageConnectionUnavailable);
    second.close();
    const release=f.owners.reserveExclusive(f.file);
    assert.throws(()=>f.owners.open(f.file),StorageConnectionUnavailable);
    release();release();
    f.owners.open(f.file).close();
  }finally{first.close();second.close();}
});
for(const aliasKind of ['hard','symbolic'] as const){
  test('live synchronous '+aliasKind+' alias cannot admit an exclusive worker',t=>{
    const f=fixture(t),db=f.owners.open(f.file),alias=join(f.root,'alias.sqlite');
    try{
      if(aliasKind==='hard')linkSync(f.file,alias);else symlinkSync(f.file,alias);
      assert.throws(()=>f.owners.reserveExclusive(alias),StorageConnectionUnavailable);
      db.close();f.owners.reserveExclusive(alias)();
    }finally{db.close();}
  });
}
test('exclusive reservation learns a newly created inode and fences both owner types through aliases',t=>{
  const f=fixture(t),release=f.owners.reserveExclusive(f.file);
  try{
    writeFileSync(f.file,'offline fixture');
    const alias=join(f.root,'hard.sqlite');linkSync(f.file,alias);
    assert.throws(()=>f.owners.open(alias),StorageConnectionUnavailable);
    assert.throws(()=>f.owners.reserveExclusive(alias),StorageConnectionUnavailable);
  }finally{release();}
});
test('exclusive admission canonicalizes missing ancestors without creating directories',t=>{
  const f=fixture(t),alias=join(f.root,'ancestor');symlinkSync(f.root,alias);
  const file=join(f.root,'new','nested','store.sqlite'),release=f.owners.reserveExclusive(file);
  try{
    assert.throws(()=>f.owners.reserveExclusive(join(alias,'new','nested','store.sqlite')),StorageConnectionUnavailable);
    mkdirSync(join(f.root,'new','nested'),{recursive:true});writeFileSync(file,'offline fixture');
    assert.throws(()=>f.owners.reserveExclusive(file),StorageConnectionUnavailable);
  }finally{release();}
});
for(const type of ['synchronous','exclusive'] as const){
  test(type+' owner retains its original lexical pathname fence after symlink replacement',t=>{
    const f=fixture(t),alias=join(f.root,'entry.sqlite'),other=join(f.root,'other.sqlite');
    writeFileSync(f.file,'');writeFileSync(other,'');symlinkSync(f.file,alias);
    const db=type==='synchronous'?f.owners.open(alias):undefined;
    const release=type==='exclusive'?f.owners.reserveExclusive(alias):undefined;
    try{
      unlinkSync(alias);symlinkSync(other,alias);
      assert.throws(()=>f.owners.reserveExclusive(alias),StorageConnectionUnavailable);
      if(release)assert.throws(()=>f.owners.open(alias),StorageConnectionUnavailable);
    }finally{db?.close();release?.();}
  });
}
test('exclusive owner retains learned inode and original pathname after regular-file replacement',t=>{
  const f=fixture(t);writeFileSync(f.file,'');
  const release=f.owners.reserveExclusive(f.file),old=join(f.root,'old.sqlite');
  try{
    renameSync(f.file,old);writeFileSync(f.file,'');
    assert.throws(()=>f.owners.open(f.file),StorageConnectionUnavailable);
    assert.throws(()=>f.owners.reserveExclusive(old),StorageConnectionUnavailable);
  }finally{release();}
});
test('Windows lexical case aliases share the conservative fence, not native host acceptance',t=>{
  const f=fixture(t),owners=new StartupDatabaseOwners(silent,()=>0,undefined,'win32');
  const release=owners.reserveExclusive(f.file);
  try{assert.throws(()=>owners.reserveExclusive(f.file.toUpperCase()),StorageConnectionUnavailable);}
  finally{release();}
});
test('relative reservation pins acquisition cwd while learning the worker-created inode',t=>{
  const f=fixture(t),initial=process.cwd(),other=join(f.root,'other');mkdirSync(other);
  try{
    process.chdir(f.root);const release=f.owners.reserveExclusive('original.sqlite');
    try{
      writeFileSync(f.file,'');const alias=join(f.root,'hard.sqlite');linkSync(f.file,alias);
      process.chdir(other);
      assert.throws(()=>f.owners.open(alias),StorageConnectionUnavailable);
      assert.throws(()=>f.owners.reserveExclusive(alias),StorageConnectionUnavailable);
    }finally{release();}
  }finally{process.chdir(initial);}
});
test('failed native close and failed-constructor cleanup retain the original owner until actual close',t=>{
  const f=fixture(t),raw=new DatabaseSync(f.file),nativeClose=raw.close.bind(raw);
  let hold=true,now=0,creates=0;
  raw.close=()=>{if(hold)throw Error('private close failure');nativeClose();};
  const owners=new StartupDatabaseOwners(silent,()=>now,()=>{creates++;return raw;});
  const db=owners.open(f.file);
  try{
    assert.throws(()=>db.close());owners.abandon(db);
    assert.throws(()=>owners.reserveExclusive(f.file),StorageConnectionUnavailable);
    now=1001;hold=false;const release=owners.reserveExclusive(f.file);
    assert.equal(creates,1,'cleanup must close the original handle, never open a replacement');release();
  }finally{hold=false;db.close();}
});
test('exclusive-owner refusal logs remain redacted and cannot reenter original admission',t=>{
  const f=fixture(t);let owners:StartupDatabaseOwners,observations=0;
  const lines:string[]=[];
  const diagnostics=new PerformanceDiagnostics(row=>{
    lines.push(JSON.stringify(row));observations++;
    assert.throws(()=>owners.reserveExclusive(f.file),StorageConnectionUnavailable);
    throw Error('private observer error');
  });
  owners=new StartupDatabaseOwners(diagnostics);
  const db=owners.open(f.file);
  try{
    assert.throws(()=>owners.reserveExclusive(f.file),StorageConnectionUnavailable);
    assert.equal(observations,1);
    assert.ok(diagnostics.snapshot().events.some(row=>row.operation==='storage-startup-admission'&&row.step===6&&row.unknown===1));
    assert.ok(!lines.join('').includes(f.file));assert.ok(!lines.join('').includes('private observer error'));
  }finally{db.close();}
});
test('independent disk owners and legacy private memory owners remain independent',t=>{
  const f=fixture(t),release=f.owners.reserveExclusive(f.file);
  try{
    f.owners.open(join(f.root,'other.sqlite')).close();
    f.owners.open(':memory:').close();f.owners.open(':memory:').close();
  }finally{release();}
});
class FakeWorker extends EventEmitter{
  terminate(){return Promise.resolve(1);}
  postMessage(){}
}
test('actual private auth synchronous owners block async admission without launching a worker',async t=>{
  const f=fixture(t),first=openSqliteAuth(f.file,[],()=>undefined),second=openSqliteAuth(f.file,[],()=>undefined);
  let launches=0;
  const launch=()=>{launches++;return new FakeWorker() as unknown as Worker;};
  try{
    assert.throws(()=>new AsyncSqliteAuthOwner({file:f.file,legacyFiles:[]},silent,launch),AuthPersistenceError);
    await first.close();
    assert.throws(()=>new AsyncSqliteAuthOwner({file:f.file,legacyFiles:[]},silent,launch),AuthPersistenceError);
    assert.equal(launches,0);
  }finally{await first.close();await second.close();}
});
test('auth worker real exit gates synchronous auth reopen and cross-domain Hub admission',async t=>{
  const f=fixture(t),fake=new FakeWorker(),owner=new AsyncSqliteAuthOwner({file:f.file,legacyFiles:[]},silent,()=>fake as unknown as Worker);
  fake.emit('message',{kind:'ready'});await owner.open();
  const retiring=owner.closeForShutdown();
  try{
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.throws(()=>openSqliteAuth(f.file,[],()=>undefined),AuthPersistenceError);
    assert.throws(()=>new AsyncHubMemberOwner({file:f.file},silent,()=>new FakeWorker() as unknown as Worker),HubMemberOwnerUnavailable);
  }finally{fake.emit('exit',1);await retiring;}
  const reopened=openSqliteAuth(f.file,[],()=>undefined);await reopened.close();
});
test('actual Hub construction refuses worker admission before launch while legacy Hub owners remain live',async t=>{
  const f=fixture(t),first=new HubStore(f.file,'fixture'),second=new HubStore(f.file,'fixture');
  let launches=0;
  const launch=()=>{launches++;return new FakeWorker() as unknown as Worker;};
  try{
    assert.throws(()=>new AsyncHubMemberOwner({file:f.file},silent,launch),HubMemberOwnerUnavailable);
    await first.close();
    assert.throws(()=>new AsyncHubMemberOwner({file:f.file},silent,launch),HubMemberOwnerUnavailable);
    assert.equal(launches,0);await second.close();
  }finally{await first.close();await second.close();}
});
test('close observation and terminate promise cannot admit a synchronous Hub before original worker exit',async t=>{
  const f=fixture(t),fake=new FakeWorker(),owner=new AsyncHubMemberOwner({file:f.file},silent,()=>fake as unknown as Worker);
  fake.emit('message',{kind:'ready'});await owner.open();
  const retiring=owner.retireForShutdown();
  try{
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.throws(()=>new HubStore(f.file,'fixture'),StorageConnectionUnavailable);
    assert.throws(()=>new AsyncHubMemberOwner({file:f.file},silent,()=>new FakeWorker() as unknown as Worker),HubMemberOwnerUnavailable);
  }finally{fake.emit('exit',1);await retiring;}
  const reopened=new HubStore(f.file,'fixture');await reopened.close();
});
