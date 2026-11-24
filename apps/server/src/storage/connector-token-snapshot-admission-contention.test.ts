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

// The original owner is real, but all state and physical admission locks are
// private to this child's temp volume. No provider or running runtime involved.
for (const scenario of ['fresh', 'revoked', 'cancelled', 'closed'] as const) {
  test(`real Connector token snapshot physical contention: ${scenario}`, { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-private-token-snapshot-'));
    const code = `
      import assert from 'node:assert/strict';
      import {DatabaseSync} from 'node:sqlite';
      import {randomUUID} from 'node:crypto';
      import {mkdtempSync,readdirSync,statSync} from 'node:fs';
      import {tmpdir} from 'node:os';
      import {join} from 'node:path';
      const {ConnectorUserStore}=await import(${JSON.stringify(connector)});
      const {asyncVolumeAdmission}=await import(${JSON.stringify(admission)});
      const directory=mkdtempSync(join(tmpdir(),'connector-')),file=join(directory,'connector.sqlite');
      const scenario=${JSON.stringify(scenario)},store=new ConnectorUserStore(file);
      const key='codex:synthetic-snapshot',id=randomUUID(),args=['codex',key,id,0,120000,60000];
      await asyncVolumeAdmission.run(directory,'durable',1024,async()=>{});
      const ledgers=readdirSync(tmpdir()).filter(name=>name.startsWith('agentopsdeck-storage-admission-'));assert.equal(ledgers.length,1);
      const ledger=new DatabaseSync(join(tmpdir(),ledgers[0],'volume-'+statSync(directory,{bigint:true}).dev+'.sqlite'));
      const abort=new AbortController();let allowed=true,released=false,closed=false,timer,original;
      const check=()=>{abort.signal.throwIfAborted();if(!allowed)throw Error('synthetic-revoked');};
      try {
        assert.throws(()=>store.tokenUsage.snapshot(...args),/async-admission-required/);
        assert.equal(store.tokenUsage.readSnapshot('codex',key,id),undefined);
        ledger.exec('BEGIN IMMEDIATE');
        timer=setTimeout(()=>{
          if(scenario==='revoked')allowed=false;
          if(scenario==='cancelled')abort.abort(Error('synthetic-cancelled'));
          if(scenario==='closed'){store.close();closed=true;}
          ledger.exec('COMMIT');released=true;
        },120);
        const flight=store.tokenUsage.snapshotAsync(...args,check);
        if(scenario==='fresh') {
          original=await flight;assert.equal(original.requestId,id);
          ledger.exec('BEGIN IMMEDIATE');
          try {
            assert.deepEqual(store.tokenUsage.snapshot(...args),original);
            assert.deepEqual(await store.tokenUsage.snapshotAsync(...args),original);
            assert.throws(()=>store.tokenUsage.snapshot('codex',key,id,0,60000,60000),/another selection/);
          } finally {ledger.exec('ROLLBACK');}
        } else await assert.rejects(flight,scenario==='revoked'?/synthetic-revoked/:scenario==='cancelled'?/synthetic-cancelled/:/closed/);
        assert.equal(released,true,'owning event loop must release contention before admission completes');
        assert.equal(ledger.prepare('SELECT count(*) n FROM storage_work_reservations').get().n,0);
      } finally {
        clearTimeout(timer);if(ledger.isTransaction)ledger.exec('ROLLBACK');if(!closed)store.close();ledger.close();
      }
      const reopened=new ConnectorUserStore(file);
      try {
        assert.deepEqual(reopened.tokenUsage.readSnapshot('codex',key,id),original);
        if(original)assert.deepEqual(await reopened.tokenUsage.snapshotAsync(...args),original);
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
