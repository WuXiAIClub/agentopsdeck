import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = import.meta.url.endsWith('.ts');
const moduleUrl = (path: string) => new URL(path + (source ? '.ts' : '.js'), import.meta.url).href;
const loaders = source ? ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))] : [];

// Never contend with the running service. Every child owns its physical ledger.
for (const scenario of ['commit', 'revoked', 'cancelled', 'closed', 'deleted', 'unknown',
  'maintenance', 'rollback', 'lost-release', 'snapshot', 'async-authority']) {
  test(`Hermes durable async queue admission: ${scenario}`, { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-hermes-admission-'));
    const code = `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { readdirSync, statSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      const { ConnectorUserStore } = await import(${JSON.stringify(moduleUrl('../connector/connector-user-store'))});
      const { HermesRuntime } = await import(${JSON.stringify(moduleUrl('./runtime'))});
      const { DeckStore } = await import(${JSON.stringify(moduleUrl('../projection/deck-store'))});
      const { asyncVolumeAdmission } = await import(${JSON.stringify(moduleUrl('../storage/async-volume-admission'))});
      const scenario = ${JSON.stringify(scenario)}, file = join(tmpdir(), 'connector.sqlite');
      const owner = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
      const key = 'hermes:session', scope = JSON.stringify(['owner', key]);
      owner.hermesJournal.save({ key, stored: 'native', title: 'Fixture', started: false, messages: [] });
      await owner.commands.claimAsync(scope, 'send', {});
      await asyncVolumeAdmission.run(tmpdir(), 'durable', 1024, async () => {});
      const folders = readdirSync(tmpdir()).filter(name => name.startsWith('agentopsdeck-storage-admission-'));
      assert.equal(folders.length, 1);
      const ledger = new DatabaseSync(join(tmpdir(), folders[0], 'volume-' + statSync(tmpdir(), { bigint: true }).dev + '.sqlite'));
      let allowed = true, released = false, wakes = 0, commits = 0, timer, asyncCalls = 0;
      const native = { ready: true, epoch: 'fixture', async start() {}, async close() { this.ready = false; },
        async request() { assert.fail('admission must not call the provider'); } };
      const authorize = scenario === 'async-authority' ? async () => { asyncCalls++; return true; }
        : (actor, target, action, grant) => allowed && actor === 'owner' && target.sessionKey === key
          && action === 'messages:send' && grant.id === 'original';
      const runtime = new HermesRuntime({ config: {}, journal: owner.hermesJournal,
        turns: owner.turns, store: new DeckStore(), authorize,
        admissionAvailable: () => owner.sdkCommandAdmissionOpen }, () => native);
      runtime.wake = () => {
        wakes++; assert.equal(released, true);
        assert.equal(owner.commands.get(scope, 'send').state, 'accepted');
        assert.equal(owner.turns.maintenanceCount('hermes'), 1);
      };
      const abort = new AbortController(), actor = { actorId: 'owner', signal: abort.signal,
        executionGrant: { id: 'original', actorId: 'owner', issuerTokenId: 'issuer' },
        accept: result => {
          const receipt = owner.commands.queueCommit(scope, 'send', { status: 200, body: result });
          return (db, admission) => {
            commits++; assert.equal(released, true); assert.equal(db.isTransaction, true);
            assert.equal(db.prepare('SELECT count(*) n FROM connector_turns').get().n, 1);
            receipt(db, admission);
            if (scenario === 'rollback') throw Error('fixture receipt failed');
          };
        } };
      const originalRun = asyncVolumeAdmission.run;
      if (scenario === 'lost-release') asyncVolumeAdmission.run = async function(...args) {
        await originalRun.apply(this, args); throw Error('fixture release reply lost');
      };
      try {
        ledger.exec('BEGIN IMMEDIATE');
        timer = setTimeout(() => {
          if (scenario === 'revoked') allowed = false;
          if (scenario === 'cancelled') abort.abort(Error('fixture cancelled'));
          if (scenario === 'closed') void runtime.close();
          if (scenario === 'deleted') owner.hermesJournal.beginDeletion(key);
          if (scenario === 'unknown') owner.hermesJournal.update({ id: 'uncertain', key, live: 'native',
            epoch: 'fixture', phase: 'unknown', members: [], at: 0, updated: 0 });
          if (scenario === 'maintenance') owner.pauseTurnStarts();
          ledger.exec('COMMIT'); released = true;
        }, 120);
        const flight = runtime.send(key, 'original text', actor);
        if (scenario === 'snapshot') {
          actor.actorId = 'replacement'; actor.signal = AbortSignal.abort(); actor.executionGrant.id = 'replacement';
        }
        assert.equal(wakes, 0); assert.equal(commits, 0);
        if (['commit', 'snapshot'].includes(scenario)) assert.equal((await flight).status, 'queued');
        else await assert.rejects(flight);
        if (scenario === 'async-authority') assert.equal(asyncCalls, 0);
        else assert.equal(released, true, 'same-loop timer must unlock before admission completes');
        const committed = ['commit', 'snapshot', 'lost-release'].includes(scenario);
        assert.equal(wakes, Number(committed));
        assert.equal(commits, Number(committed || scenario === 'rollback'));
        assert.equal(ledger.prepare('SELECT count(*) n FROM storage_work_reservations').get().n, 0);
      } finally {
        asyncVolumeAdmission.run = originalRun; clearTimeout(timer);
        if (ledger.isTransaction) ledger.exec('ROLLBACK'); ledger.close();
        await runtime.close(); owner.close();
      }
      const reopened = new ConnectorUserStore(file);
      try {
        const committed = ['commit', 'snapshot', 'lost-release'].includes(scenario);
        assert.equal(reopened.commands.get(scope, 'send').state, committed ? 'accepted' : 'outcome_unknown');
        assert.equal((await reopened.commands.claimAsync(scope, 'send', {})).fresh, false);
        assert.equal(reopened.turns.maintenanceCount('hermes'), Number(committed));
        if (committed) {
          const turn = reopened.turns.head('hermes', key);
          assert.equal(turn.payload.text, 'original text'); assert.equal(turn.payload.actorId, 'owner');
          assert.equal(turn.payload.executionGrant.id, 'original');
        }
      } finally { reopened.close(); }
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
