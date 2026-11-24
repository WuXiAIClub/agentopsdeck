import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for(const scenario of ['migration','write','recover-migration','recover-write','bind','revoked','closed']) {
  test(`real Hub content owner yields to physical ledger contention: ${scenario}`,{timeout:35_000},async()=>{
    const root=mkdtempSync(join(tmpdir(),'hub-content-owner-admission-'));
    const source=import.meta.url.endsWith('.ts'),extension=source?'ts':'js';
    const hub=new URL(`../hub/hub-store.${extension}`,import.meta.url).href;
    const admission=new URL(`./async-volume-admission.${extension}`,import.meta.url).href;
    const loaders=source?['--import',import.meta.resolve('tsx')]:[];
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
      const store=new HubStore(file,'synthetic-test-secret');
      let authorized=true,effects=0,released=false,timer;
      const target={sessionId:'synthetic',sessionKey:'codex:synthetic',connectionId:'synthetic',authority:0,
        valid(){if(!authorized)throw Error('revoked');},transport:{capability:async()=>({protocol:1,available:true}),
          install:async input=>{effects++;return input.base;},view:async()=>{throw Error('no replay');}}};
      const coordinator=store.createContentCoordinator(()=>target),resource=JSON.stringify(['taskboard','default']);
      const scenario=${JSON.stringify(scenario)},id=randomUUID();
      let base;
      if(scenario!=='migration')base=(await coordinator.migrateAsync('owner',resource,0,randomUUID())).result;
      await asyncVolumeAdmission.run(directory,'durable',1024,async()=>{});
      const ledgers=readdirSync(tmpdir()).filter(name=>name.startsWith('agentopsdeck-storage-admission-'));assert.equal(ledgers.length,1);
      const ledger=new DatabaseSync(join(tmpdir(),ledgers[0],'volume-'+statSync(directory,{bigint:true}).dev+'.sqlite'));
      const check=()=>{if(!authorized)throw Error('revoked');};
      try {
        ledger.exec('BEGIN IMMEDIATE');
        timer=setTimeout(()=>{if(scenario==='revoked')authorized=false;if(scenario==='closed')void store.close();
          ledger.exec('COMMIT');released=true;},120);
        const input=base&&{mutationId:id,modeEpoch:base.epoch,baseRevision:base.revision,baseHash:base.hash,
          content:JSON.stringify({kind:'taskboard',content:{title:'Asynchronous owner',tasks:[]}})};
        const flight=scenario==='migration'?coordinator.migrateAsync('owner',resource,0,id,check):
          scenario==='recover-migration'?coordinator.store.recoverMigrationAsync('owner',resource,id,check):
          scenario==='recover-write'?coordinator.store.recoverWriteAsync('owner',resource,base.epoch,id,check):
          scenario==='bind'?coordinator.bind('owner',resource,{id,sessionId:'synthetic',epoch:base.epoch,revision:base.revision},check):
          coordinator.store.writeAsync('owner',resource,input,check);
        if(scenario==='revoked')await assert.rejects(flight,/revoked/);
        else if(scenario==='closed')await assert.rejects(flight,/Hub store is closed/);
        else {const result=await flight;assert.ok(result);}
        assert.equal(released,true,'the original event loop must release the held ledger');
        assert.equal(effects,scenario==='bind'?1:0,'no external installation before the original binding intent');
        assert.equal(ledger.prepare('SELECT count(*) n FROM storage_work_reservations').get().n,0);
      } finally {
        clearTimeout(timer);if(ledger.isTransaction)ledger.exec('ROLLBACK');await coordinator.close();await store.close();ledger.close();
      }
      const reopened=new HubStore(file,'synthetic-test-secret');
      try {
        const restored=reopened.createContentCoordinator(()=>target);
        if(scenario==='migration')assert.ok(restored.store.migration('owner',id));
        else if(scenario==='recover-migration')assert.equal(restored.store.migrationTermination('owner',id).state,'not-executed');
        else if(scenario==='recover-write')assert.equal(restored.store.writeTermination('owner',resource,base.epoch,id).state,'not-executed');
        else if(scenario==='bind')assert.equal(restored.store.bindingRecord('owner',resource,id).acknowledgedRevision,base.revision);
        else assert.equal(restored.store.ownerReceipt('owner',resource,base.epoch,id)?.state,scenario==='write'?'committed':undefined);
        assert.equal(restored.store.resource('owner',resource).revision,scenario==='write'?1:0);
        await restored.close();
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
