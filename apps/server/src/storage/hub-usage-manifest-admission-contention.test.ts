import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const source=import.meta.url.endsWith('.ts');
const hub=new URL(source?'../hub/hub-store.ts':'../hub/hub-store.js',import.meta.url).href;
const admission=new URL(source?'./async-volume-admission.ts':'./async-volume-admission.js',import.meta.url).href;
const loaders=source?['--import',new URL('../../node_modules/tsx/dist/loader.mjs',import.meta.url).href]:[];

// Private child ledger only. The real factory must yield to the ORIGINAL loop,
// retain its connection/receipt, and never dispatch a native snapshot or turn.
for(const scenario of ['prepare','claim','revoked','closed','cancelled'] as const) {
  test(`real Hub usage manifest admission under physical lock: ${scenario}`,{timeout:30_000},async()=>{
    const root=mkdtempSync(join(tmpdir(),'agentopsdeck-private-hub-usage-'));
    const code=`
      import assert from 'node:assert/strict';
      import {DatabaseSync} from 'node:sqlite';
      import {mkdtempSync,readdirSync,statSync} from 'node:fs';
      import {randomUUID} from 'node:crypto';
      import {tmpdir} from 'node:os';
      import {join} from 'node:path';
      const {HubStore}=await import(${JSON.stringify(hub)});
      const {asyncVolumeAdmission}=await import(${JSON.stringify(admission)});
      const directory=mkdtempSync(join(tmpdir(),'hub-')),file=join(directory,'hub.sqlite');
      const store=new HubStore(file,'synthetic-test-secret'),owner=store.createUser('Synthetic').id;
      store.upsertConnection({id:'dev',ownerUserId:owner,label:'Dev',connectorUrl:'https://synthetic.invalid'});
      const nodeId='node_'+randomUUID();store.pinConnectionNode('dev',owner,store.connectionAuthority('dev',owner),nodeId);
      const member={owner,nodeId,connectionId:'dev',sessionId:'synthetic',runtime:'codex',
        authorityEpoch:store.connectionAuthority('dev',owner),groupId:null,tags:[],taskBinding:'unknown'};
      const selection={requestId:randomUUID(),from:0,to:60000,bucketMs:60000,tags:[],tagMode:'all'};
      const scenario=${JSON.stringify(scenario)},id=selection.requestId;
      let original,timer,released=false;
      if(scenario==='claim') {
        original=await store.usageManifests.prepareAsync(owner,selection,'directory',[member]);
        store.usageManifests.confirm(owner,id);
      }
      await asyncVolumeAdmission.run(directory,'durable',1024,async()=>{});
      const ledgers=readdirSync(tmpdir()).filter(name=>name.startsWith('agentopsdeck-storage-admission-'));assert.equal(ledgers.length,1);
      const ledger=new DatabaseSync(join(tmpdir(),ledgers[0],'volume-'+statSync(directory,{bigint:true}).dev+'.sqlite'));
      try {
        const syncWrite=()=>scenario==='claim'?store.usageManifests.claim(owner,id,original.members[0].requestId):
          store.usageManifests.prepare(owner,selection,'directory',[member]);
        assert.throws(syncWrite,/async-admission-required/);
        ledger.exec('BEGIN IMMEDIATE');
        timer=setTimeout(()=>{
          if(scenario==='revoked')store.upsertConnection({id:'dev',ownerUserId:owner,label:'Dev',connectorUrl:'https://synthetic.invalid',status:'disabled'});
          if(scenario==='cancelled')store.usageManifests.cancel(owner,id);
          if(scenario==='closed')void store.close();
          ledger.exec('COMMIT');released=true;
        },120);
        const flight=scenario==='claim'?store.usageManifests.claimAsync(owner,id,original.members[0].requestId):
          store.usageManifests.prepareAsync(owner,selection,'directory',[member]);
        if(['revoked','closed','cancelled'].includes(scenario))await assert.rejects(flight);
        else {const result=await flight;assert.equal(scenario==='claim'?result:result.state,scenario==='claim'?true:'prepared');}
        assert.equal(released,true,'the original loop must release the lock before admission settles');
        assert.equal(ledger.prepare('SELECT count(*) n FROM storage_work_reservations').get().n,0);
      } finally {
        clearTimeout(timer);if(ledger.isTransaction)ledger.exec('ROLLBACK');await store.close();ledger.close();
      }
      const reopened=new HubStore(file,'synthetic-test-secret');
      try {
        const restored=reopened.usageManifests.read(owner,id);
        assert.equal(restored?.state,scenario==='prepare'?'prepared':scenario==='claim'?'collecting':undefined);
        if(scenario==='claim') {
          assert.equal(restored.members[0].state,'unknown');assert.equal(restored.members[0].requestId,original.members[0].requestId);
          assert.equal(await reopened.usageManifests.claimAsync(owner,id,restored.members[0].requestId),false);
        }
        assert.equal(reopened.usageManifests.cancelled(owner,id),scenario==='cancelled');
      } finally {await reopened.close();}
    `;
    let child:ReturnType<typeof spawn>|undefined;
    try {
      await new Promise<void>((resolve,reject)=>{
        child=spawn(process.execPath,[...loaders,'--input-type=module','-e',code],{
          env:{...process.env,TMPDIR:root,TMP:root,TEMP:root},stdio:['ignore','pipe','pipe'],timeout:25_000});
        let output='';for(const stream of [child.stdout,child.stderr])stream!.on('data',data=>{output=(output+String(data)).slice(-16_384);});
        child.once('error',reject);child.once('exit',(status,signal)=>{try{assert.equal(status,0,`isolated child failed (${signal??'no signal'}): ${output}`);resolve();}catch(error){reject(error);}});
      });
    } finally {if(!child||child.exitCode!==null||child.signalCode!==null)rmSync(root,{recursive:true,force:true});}
  });
}
