import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

for(const action of ['migrate','write','migration-recover','write-recover']){
  test(`document command rechecks original identity inside root transaction after volume wait: ${action}`,{timeout:35_000},async()=>{
    const root=mkdtempSync(join(tmpdir(),'content-document-admission-'));
    const source=import.meta.url.endsWith('.ts'),ext=source?'ts':'js';
    const hub=new URL(`../hub/hub-store.${ext}`,import.meta.url).href;
    const original=new URL(`../hub/original-administrative-commands.${ext}`,import.meta.url).href;
    const admission=new URL(`./async-volume-admission.${ext}`,import.meta.url).href;
    const code=`
      import assert from 'node:assert/strict';
      import {DatabaseSync} from 'node:sqlite';
      import {mkdtempSync,readdirSync,statSync} from 'node:fs';
      import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
      const {HubStore}=await import(${JSON.stringify(hub)});
      const {OriginalHubAdministrativeCommands}=await import(${JSON.stringify(original)});
      const {asyncVolumeAdmission}=await import(${JSON.stringify(admission)});
      const directory=mkdtempSync(join(tmpdir(),'hub-')),store=new HubStore(join(directory,'hub.sqlite'),'fixture');
      const user=store.createUser('Member'),key=store.identities.issueKey(user.id),port=new OriginalHubAdministrativeCommands(store);
      const resourceId=JSON.stringify(['taskboard','default']),domain=store.createContentDocumentStore(),action=${JSON.stringify(action)},id=randomUUID();
      const evidence={accessKey:key.token},snapshot=await port.command('memberSnapshot',evidence);assert.ok(snapshot);
      let head;if(action!=='migrate')head=(await domain.migrateNativeRequestAsync(user.id,resourceId,0,randomUUID(),store.cardFileProjection)).result;
      await asyncVolumeAdmission.run(directory,'durable',1024,async()=>{});
      const ledgers=readdirSync(tmpdir()).filter(n=>n.startsWith('agentopsdeck-storage-admission-'));assert.equal(ledgers.length,1);
      const ledger=new DatabaseSync(join(tmpdir(),ledgers[0],'volume-'+statSync(directory,{bigint:true}).dev+'.sqlite'));let timer,released=false;
      try{
        ledger.exec('BEGIN IMMEDIATE');
        timer=setTimeout(()=>{store.identities.revokeKey(user.id,key.id);ledger.exec('COMMIT');released=true;},120);
        const command=action==='migrate'?{action,resourceId,requestId:id,revision:0}:
          action==='migration-recover'?{action,resourceId,requestId:id}:
          action==='write-recover'?{action,resourceId,mutationId:id,epoch:head.epoch}:
          {action,resourceId,mutationId:id,modeEpoch:head.epoch,baseRevision:0,baseHash:head.hash,
            content:JSON.stringify({kind:'taskboard',content:{title:'Never commit after revoke',tasks:[]}})};
        assert.equal(await port.command('contentDocument',{evidence,expectedScope:snapshot.recoveryScope,command}),null);
        assert.equal(released,true,'volume admission must yield to original loop');
        assert.equal(domain.migration(user.id,id),undefined);assert.equal(domain.migrationTermination(user.id,id),undefined);
        if(head){assert.equal(domain.ownerReceipt(user.id,resourceId,head.epoch,id),undefined);
          assert.equal(domain.writeTermination(user.id,resourceId,head.epoch,id),undefined);assert.equal(domain.resource(user.id,resourceId).revision,0);}
        else assert.equal(domain.resource(user.id,resourceId),undefined);
        assert.equal(ledger.prepare('SELECT count(*) n FROM storage_work_reservations').get().n,0);
      }finally{clearTimeout(timer);if(ledger.isTransaction)ledger.exec('ROLLBACK');await port.close();await store.close();ledger.close();}
    `;
    let child:ReturnType<typeof spawn>|undefined;
    try{
      await new Promise<void>((resolve,reject)=>{
        child=spawn(process.execPath,[...(source?['--import',import.meta.resolve('tsx')]:[]),'--input-type=module','-e',code],{
          env:{...process.env,TMPDIR:root,TMP:root,TEMP:root},stdio:['ignore','pipe','pipe'],timeout:25_000});
        let output='';for(const stream of [child.stdout,child.stderr])stream!.on('data',data=>{output=(output+String(data)).slice(-16_384);});
        child.once('error',reject);child.once('exit',(status,signal)=>{try{assert.equal(status,0,`isolated child failed (${signal??'no signal'}): ${output}`);resolve();}catch(error){reject(error);}});
      });
    }finally{if(!child||child.exitCode!==null||child.signalCode!==null)rmSync(root,{recursive:true,force:true});}
  });
}
