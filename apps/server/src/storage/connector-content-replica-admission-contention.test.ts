import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = import.meta.url.endsWith('.ts');
const connector = new URL(source ? '../connector/connector-user-store.ts' : '../connector/connector-user-store.js', import.meta.url).href;
const admission = new URL(source ? './async-volume-admission.ts' : './async-volume-admission.js', import.meta.url).href;
const loaderArgs = source ? ['--import', new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href] : [];

// The real production factory, disk DB and physical admission ledger. Each
// child owns its TMP ledger: no locking peers' shared volume coordinator.
for (const scenario of ['install', 'claim', 'publish', 'project', 'revoked', 'closed'] as const) {
  test(`Connector content replica yields under physical ledger contention: ${scenario}`, { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-private-replica-'));
    const code = `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { createHash, randomUUID } from 'node:crypto';
      import { mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
      import { writeFile } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      const { ConnectorUserStore } = await import(${JSON.stringify(connector)});
      const { asyncVolumeAdmission } = await import(${JSON.stringify(admission)});
      const directory = mkdtempSync(join(tmpdir(), 'connector-')), file = join(directory, 'connector.sqlite');
      const store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
      mkdirSync(join(directory, 'files'), {mode:0o700});
      const files = store.createFileCards(join(directory, 'files'), () => true), replica = store.createContentReplicas(files);
      const hash = value => createHash('sha256').update(value).digest('hex');
      const content = JSON.stringify({kind:'taskboard',content:{title:'Original',tasks:[]}});
      const base = {epoch:'synthetic',revision:0,hash:hash(content),content};
      const id = randomUUID(), input = {id,resource:'board',generation:'synthetic',sessionKey:'codex:synthetic',base};
      const scenario = ${JSON.stringify(scenario)};
      let local, timer, released = false, closed = false, sends = 0;
      if (scenario !== 'install') await replica.install('owner', input);
      if (['claim','publish','revoked','closed'].includes(scenario)) {
        await writeFile(files.get('owner', id).path, files.codec.serialize({kind:'taskboard',content:{title:'Draft',tasks:[]}}));
        local = await replica.observe('owner', id);
      }
      const projected = JSON.stringify({kind:'taskboard',content:{title:'Projected',tasks:[]}});
      const job = {id:randomUUID(),bindingId:id,generation:input.generation,revision:1,hash:hash(projected),content:projected,
        expectedHash:base.hash,state:'unknown'};
      await asyncVolumeAdmission.run(directory, 'durable', 1024, async () => {});
      const ledgers = readdirSync(tmpdir()).filter(name => name.startsWith('agentopsdeck-storage-admission-'));
      assert.equal(ledgers.length, 1);
      const ledger = new DatabaseSync(join(tmpdir(), ledgers[0], 'volume-' + statSync(directory,{bigint:true}).dev + '.sqlite'));
      try {
        ledger.exec('BEGIN IMMEDIATE');
        timer = setTimeout(async () => {
          if (scenario === 'revoked') await replica.revoke('owner', id);
          if (scenario === 'closed') { store.close(); closed = true; }
          ledger.exec('COMMIT'); released = true;
        }, 120);
        const flight = scenario === 'install' ? replica.install('owner', input)
          : scenario === 'project' ? replica.project('owner', id, job)
          : scenario === 'publish' ? replica.publish('owner', id, local.proposal.mutationId, {
            propose:async()=>{ sends++; throw Error('offline synthetic endpoint'); }, original:async()=>undefined })
          : replica.claimPublish('owner', id, local.proposal.mutationId);
        if (scenario === 'revoked') await assert.rejects(flight, /replica-unavailable/);
        else if (scenario === 'closed') await assert.rejects(flight, /Connector store is closed/);
        else {
          const result = await flight;
          if (scenario === 'claim') assert.equal(result.claimed, true);
          if (scenario === 'publish') assert.equal(result.state, 'unknown');
          if (scenario === 'project') assert.equal(result.state, 'saved');
        }
        assert.equal(released, true, 'same loop must release physical contention');
        assert.equal(sends, scenario === 'publish' ? 1 : 0);
        assert.equal(ledger.prepare('SELECT count(*) n FROM storage_work_reservations').get().n, 0);
      } finally {
        clearTimeout(timer); if (ledger.isTransaction) ledger.exec('ROLLBACK');
        ledger.close(); await files.close(); if (!closed) store.close();
      }
      const reopened = new ConnectorUserStore(file, undefined, {runtimeOwner:true});
      const restoredFiles = reopened.createFileCards(join(directory,'files'),()=>true);
      try {
        const restored = reopened.createContentReplicas(restoredFiles);
        if (scenario === 'revoked') await assert.rejects(restored.view('owner',id), /replica-unavailable/);
        else {
          const snapshot = await restored.view('owner',id);
          if (scenario === 'claim' || scenario === 'publish') assert.equal(snapshot.proposals[0].state,'unknown');
          if (scenario === 'closed') assert.equal(snapshot.proposals[0].state,'prepared');
          if (scenario === 'project') assert.equal(snapshot.base.hash,job.hash);
          if (scenario === 'install') assert.equal(snapshot.base.hash,base.hash);
        }
        assert.equal(sends, scenario === 'publish' ? 1 : 0, 'reopen never replays a handoff');
      } finally { await restoredFiles.close(); reopened.close(); }
    `;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        child = spawn(process.execPath, [...loaderArgs, '--input-type=module', '-e', code], {
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
    } finally {
      if (!child || child.exitCode !== null || child.signalCode !== null) rmSync(root, { recursive: true, force: true });
    }
  });
}
