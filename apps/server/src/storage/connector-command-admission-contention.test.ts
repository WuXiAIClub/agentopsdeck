import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = import.meta.url.endsWith('.ts');
const connector = new URL(source ? '../connector/connector-user-store.ts' : '../connector/connector-user-store.js', import.meta.url).href;
const admission = new URL(source ? './async-volume-admission.ts' : './async-volume-admission.js', import.meta.url).href;
const loaders = source ? ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))] : [];

// All state and the physical ledger are private to a child TMP directory.
for (const scenario of ['fresh', 'revoked', 'cancelled', 'closed'] as const) {
  test(`real Connector command receipt physical contention: ${scenario}`, { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-private-connector-command-'));
    const code = `
      import assert from 'node:assert/strict';
      import {DatabaseSync} from 'node:sqlite';
      import {mkdtempSync,readdirSync,statSync} from 'node:fs';
      import {tmpdir} from 'node:os';
      import {join} from 'node:path';
      const {ConnectorUserStore}=await import(${JSON.stringify(connector)});
      const {asyncVolumeAdmission}=await import(${JSON.stringify(admission)});
      const directory=mkdtempSync(join(tmpdir(),'connector-')),file=join(directory,'connector.sqlite');
      const scenario=${JSON.stringify(scenario)},store=new ConnectorUserStore(file);
      await asyncVolumeAdmission.run(directory,'durable',1024,async()=>{});
      const ledgers=readdirSync(tmpdir()).filter(name=>name.startsWith('agentopsdeck-storage-admission-'));assert.equal(ledgers.length,1);
      const ledger=new DatabaseSync(join(tmpdir(),ledgers[0],'volume-'+statSync(directory,{bigint:true}).dev+'.sqlite'));
      const abort=new AbortController();let allowed=true,released=false,closed=false,timer,original;
      const check=()=>{abort.signal.throwIfAborted();if(!allowed)throw Error('synthetic-revoked');};
      try {
        let decisions=0;
        assert.throws(()=>store.commands.claim('scope','key',{},false,undefined,()=>{decisions++;return true;}),/async-admission-required/);
        assert.equal(decisions,0);assert.equal(store.commands.get('scope','key'),undefined);
        // An existing owner transaction must not become a synchronous physical
        // admission bypass. Async entry also refuses before running authority.
        const owner=store.turns;
        let transactionDb;
        // The original queue commit participant exposes the actual SQL owner,
        // not a second connection or an async callback inside a transaction.
        await owner.enqueueAsync('fixture',{id:'boundary',sessionKey:'fixture',createdAt:0,payload:{}},db=>{transactionDb=db;});
        transactionDb.exec('BEGIN IMMEDIATE');
        try {
          assert.throws(()=>store.commands.claim('scope','key',{},false,undefined,()=>{decisions++;return true;}),/async-admission-required/);
          await assert.rejects(store.commands.claimAsync('scope','key',{},false,undefined,()=>{decisions++;return true;}),/owning database boundary/);
          assert.equal(decisions,0);assert.equal(transactionDb.isTransaction,true);
          assert.equal(store.commands.get('scope','key'),undefined);
        } finally {transactionDb.exec('ROLLBACK');}
        ledger.exec('BEGIN IMMEDIATE');
        timer=setTimeout(()=>{
          if(scenario==='revoked')allowed=false;
          if(scenario==='cancelled')abort.abort(Error('synthetic-cancelled'));
          if(scenario==='closed'){store.close();closed=true;}
          ledger.exec('COMMIT');released=true;
        },120);
        const flight=store.commands.claimAsync('scope','key',{},false,undefined,undefined,undefined,false,check,check);
        if(scenario==='fresh') {
          original=(await flight).receipt;assert.equal(original.state,'outcome_unknown');
          ledger.exec('BEGIN IMMEDIATE');
          try {
            const duplicate=store.commands.claim('scope','key',{});
            assert.equal(duplicate.fresh,false);assert.equal(duplicate.receipt.id,original.id);
            assert.throws(()=>store.commands.claim('scope','key',{changed:true}),/different|conflict|another/i);
            assert.equal((await store.commands.claimAsync('scope','key',{})).fresh,false);
          } finally {ledger.exec('ROLLBACK');}
        } else await assert.rejects(flight,scenario==='revoked'?/synthetic-revoked/:scenario==='cancelled'?/synthetic-cancelled/:/closed/);
        assert.equal(released,true,'the owning event loop must release contention before admission completes');
        assert.equal(ledger.prepare('SELECT count(*) n FROM storage_work_reservations').get().n,0);
      } finally {
        clearTimeout(timer);if(ledger.isTransaction)ledger.exec('ROLLBACK');if(!closed)store.close();ledger.close();
      }
      const reopened=new ConnectorUserStore(file);
      try {
        assert.deepEqual(reopened.commands.get('scope','key'),original);
        if(original){const retry=await reopened.commands.claimAsync('scope','key',{});assert.equal(retry.fresh,false);assert.equal(retry.receipt.id,original.id);}
      } finally {reopened.close();}
    `;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        child = spawn(process.execPath, [...loaders, '--input-type=module', '-e', code], {
          env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 25_000,
        });
        let output = '';
        for (const stream of [child.stdout, child.stderr]) stream!.on('data', data => { output = (output + String(data)).slice(-16_384); });
        child.once('error', reject);
        child.once('exit', (status, signal) => {
          try { assert.equal(status, 0, `isolated child failed (${signal ?? 'no signal'}): ${output}`); resolve(); }
          catch (error) { reject(error); }
        });
      });
    } finally { if (!child || child.exitCode !== null || child.signalCode !== null) rmSync(root, { recursive: true, force: true }); }
  });
}
