import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {chmodSync,lstatSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';

// Model Linux lstat observing a regular rollback journal after its last link
// was removed. Only a second ENOENT observation can establish disappearance;
// a replacement, alias or unexpected error must still refuse this owner.
for(const scenario of ['vanished','still-zero','replacement','hardlink','symlink','directory','io-error'] as const)
test(`readonly Hub journal ${scenario} keeps the exact filesystem boundary`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'agentopsdeck-sidecar-race-')),file=join(dir,'hub.sqlite');
  const db=new DatabaseSync(file);db.exec('CREATE TABLE harmless(n)');db.close();chmodSync(file,0o600);
  const {dev,ino}=lstatSync(file),source=import.meta.url.endsWith('.ts');
  const entry=new URL(`../hub/delivery-reader-worker.${source?'ts':'js'}`,import.meta.url).href;
  const worker=new Worker(`(async()=>{
    const fs=require('node:fs'),{workerData,parentPort}=require('node:worker_threads');
    const original=fs.lstatSync;let calls=0;
    fs.lstatSync=function(path,...args){
      if(path===workerData.file+'-journal'){
        const scenario=workerData.scenario;
        if(scenario==='io-error')throw Object.assign(Error('PRIVATE_FS_ERROR'),{code:'EIO'});
        if(scenario==='vanished'&&calls++>0)return original.call(this,path,...args);
        const stat=original.call(this,workerData.file,...args);
        return Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{
          nlink:scenario==='hardlink'?2:scenario==='replacement'&&calls++>0?1:0,
          isFile:()=>scenario!=='directory',isSymbolicLink:()=>scenario==='symlink'
        });
      }
      return original.call(this,path,...args);
    };
    require('node:module').syncBuiltinESMExports();
    if(workerData.loader){const {tsImport}=await import(workerData.loader);await tsImport(workerData.entry,workerData.entry);}
    else await import(workerData.entry);
  })().catch(()=>{process.exitCode=1;require('node:worker_threads').parentPort.close();});`,{
    eval:true,execArgv:[],workerData:{file,dev,ino,scenario,entry,loader:source?import.meta.resolve('tsx/esm/api'):undefined},stdout:true,stderr:true
  });
  const messages:any[]=[];let output='';
  worker.stdout.on('data',chunk=>{output+=chunk;});worker.stderr.on('data',chunk=>{output+=chunk;});
  const exit=once(worker,'exit'),watchdog=setTimeout(()=>{void worker.terminate();},10000);
  worker.on('message',message=>{messages.push(message);if(message.kind==='ready')worker.postMessage({id:1,kind:'close'});});
  try{
    const [code]=await exit;
    assert.doesNotMatch(output,/PRIVATE_FS_ERROR/);
    if(scenario==='vanished'){
      assert.equal(code,0);assert.deepEqual(messages,[{kind:'ready'},{id:1,kind:'close',ok:true}]);
    }else{
      assert.equal(code,1);assert.deepEqual(messages,[{kind:'readonly-owner-failure',step:4,ownerFailureCode:3}]);
    }
  }finally{clearTimeout(watchdog);await worker.terminate();rmSync(dir,{recursive:true,force:true});}
});
