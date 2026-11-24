import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = import.meta.url.endsWith('.ts');
const hub = new URL(source ? '../hub/hub-store.ts' : '../hub/hub-store.js', import.meta.url).href;
const admission = new URL(source ? './async-volume-admission.ts' : './async-volume-admission.js', import.meta.url).href;
const loaderArgs = source ? ['--import', new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href] : [];

// Each child owns its TMPDIR ledger. Never lock the suite's shared ledger or
// contact a provider: the real Hub factory must wait without blocking the loop.
for (const scenario of ['prepare', 'revoked', 'confirm', 'closed'] as const) {
  test(`original Hub batch admission under ledger contention: ${scenario}`, { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-private-hub-batch-'));
    const code = `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { randomUUID } from 'node:crypto';
      import { mkdtempSync, readdirSync, statSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      const { HubStore } = await import(${JSON.stringify(hub)});
      const { asyncVolumeAdmission } = await import(${JSON.stringify(admission)});
      const directory = mkdtempSync(join(tmpdir(), 'hub-'));
      const file = join(directory, 'hub.sqlite');
      const store = new HubStore(file, 'synthetic-test-secret');
      let resolverCalls = 0, authorized = true, released = false, timer;
      const coordinator = store.createContentCoordinator(() => { resolverCalls++; throw Error('offline synthetic target'); });
      const resource = JSON.stringify(['taskboard', 'default']);
      await coordinator.store.initializeAsync('owner', resource, randomUUID(), JSON.stringify({kind:'taskboard',content:{title:'Fixture',tasks:[]}}));
      const member = {owner:'owner',nodeId:'fixture',connectionId:'fixture',runtime:'codex',sessionId:'synthetic',
        authorityEpoch:0,groupId:'dev',tags:[],taskBinding:'supported'};
      const catalog = {fence:()=>({generation:0,preferencesRevision:0}),authorized:()=>authorized,
        enumerate:async()=>({complete:true,members:[member]})};
      const batches = store.createContentBatches(coordinator, catalog);
      const id = randomUUID(), selection = {groupId:'dev',tags:[],tagMode:'all'};
      const scenario = ${JSON.stringify(scenario)};
      if (scenario === 'confirm' || scenario === 'closed') await batches.prepare('owner', resource, id, selection);
      await asyncVolumeAdmission.run(directory, 'durable', 1024, async () => {});
      const ledgers = readdirSync(tmpdir()).filter(name=>name.startsWith('agentopsdeck-storage-admission-'));
      assert.equal(ledgers.length, 1);
      const ledger = new DatabaseSync(join(tmpdir(), ledgers[0], 'volume-' + statSync(directory,{bigint:true}).dev + '.sqlite'));
      try {
        ledger.exec('BEGIN IMMEDIATE');
        timer = setTimeout(() => {
          if (scenario === 'revoked') authorized = false;
          if (scenario === 'closed') void store.close();
          ledger.exec('COMMIT'); released = true;
        }, 120);
        const flight = scenario === 'confirm' || scenario === 'closed'
          ? batches.confirm('owner', resource, id)
          : batches.prepare('owner', resource, id, selection);
        if (scenario === 'revoked') await assert.rejects(flight, /preview-changed-or-expired/);
        else if (scenario === 'closed') await assert.rejects(flight, /Hub store is closed/);
        else {
          const result = await flight;
          assert.equal(result.state, scenario === 'confirm' ? 'confirmed' : 'prepared');
          if (scenario === 'confirm') assert.equal(result.members[0].state, 'unknown');
          assert.equal(batches.get('owner', resource, id).state, result.state);
        }
        assert.equal(released, true, 'the original loop must release physical contention before settling');
        if (scenario === 'revoked') assert.equal(batches.get('owner', resource, id), undefined);
        assert.equal(resolverCalls, scenario === 'confirm' ? 1 : 0, 'no dispatch before durable claim');
        assert.equal(ledger.prepare('SELECT count(*) n FROM storage_work_reservations').get().n, 0, 'original admission settled');
      } finally {
        clearTimeout(timer);
        if (ledger.isTransaction) ledger.exec('ROLLBACK');
        await coordinator.close(); await store.close(); ledger.close();
      }
      const reopened = new HubStore(file, 'synthetic-test-secret');
      try {
        const restoredCoordinator = reopened.createContentCoordinator(()=>{throw Error('no replay');});
        const restored = reopened.createContentBatches(restoredCoordinator, catalog).get('owner',resource,id);
        assert.equal(restored?.state, scenario === 'revoked' ? undefined : scenario === 'confirm' ? 'confirmed' : 'prepared');
        if (scenario === 'confirm') assert.equal(restored.members[0].state, 'unknown', 'no automatic installation replay');
        await restoredCoordinator.close();
      } finally { await reopened.close(); }
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
