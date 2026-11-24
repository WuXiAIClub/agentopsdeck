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

// Each child owns its TMPDIR ledger: never lock a running service or a peer's
// coordinator. The timer must run on the same event loop as the command.
for (const runtime of ['claude-code', 'ghcp']) {
  for (const scenario of ['commit', 'revoked', 'cancelled', 'closed', 'model', 'maintenance', 'rollback', 'lost-release', 'snapshot']) {
    test(`${runtime}: SDK async send under physical contention: ${scenario}`, { timeout: 30_000 }, async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-command-admission-'));
      const code = `
        import assert from 'node:assert/strict';
        import { DatabaseSync } from 'node:sqlite';
        import { mkdtempSync, readdirSync, statSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        const { ConnectorUserStore } = await import(${JSON.stringify(moduleUrl('./connector-user-store'))});
        const { SdkCommands } = await import(${JSON.stringify(moduleUrl('./sdk-commands'))});
        const { asyncVolumeAdmission } = await import(${JSON.stringify(moduleUrl('../storage/async-volume-admission'))});
        const runtime = ${JSON.stringify(runtime)}, scenario = ${JSON.stringify(scenario)};
        const directory = mkdtempSync(join(tmpdir(), 'connector-')), file = join(directory, 'connector.sqlite');
        const store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
        const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
        const key = runtime + ':session', scope = JSON.stringify(['owner', key]);
        journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 0 });
        const models = { model: 'default', modelChoices: ['other'] };
        journal.updateModel(key, 'other', () => {});
        await store.commands.claimAsync(scope, 'send', {});
        await asyncVolumeAdmission.run(directory, 'durable', 1024, async () => {});
        const folders = readdirSync(tmpdir()).filter(name => name.startsWith('agentopsdeck-storage-admission-'));
        assert.equal(folders.length, 1);
        const ledger = new DatabaseSync(join(tmpdir(), folders[0], 'volume-' + statSync(directory, { bigint: true }).dev + '.sqlite'));
        let allowed = true, released = false, closed = false, changes = 0, wakes = 0, commits = 0, timer, accepted;
        const abort = new AbortController();
        const attachments = [{ name: 'original.txt', mimeType: 'text/plain', data: Buffer.from('original body').toString('base64') }];
        const commands = new SdkCommands({ runtime, journal, store, models,
          assertAvailable: () => { if (!store.sdkCommandAdmissionOpen) throw Error('fixture unavailable'); },
          authorize: (_key, actor) => allowed && actor.actorId === 'owner',
          changed: () => { changes++; throw Error('projection failure'); },
          driver: { wake: async () => {
            wakes++;
            assert.equal(released, true);
            assert.equal(store.commands.get(scope, 'send').state, 'accepted');
            assert.equal(store.turns.maintenanceCount(runtime), 1);
          }, interrupt: async () => 'not_started' },
        });
        const actor = { actorId: 'owner', signal: abort.signal, accept: result => {
          accepted = result;
          const receipt = store.commands.queueCommit(scope, 'send', { status: 200, body: result });
          return (db, admission) => {
            commits++;
            assert.equal(released, true);
            assert.equal(db.isTransaction, true);
            assert.equal(db.prepare('SELECT count(*) n FROM connector_turns').get().n, 1);
            assert.equal(db.prepare('SELECT count(*) n FROM sdk_attachments').get().n, 1);
            receipt(db, admission);
            if (scenario === 'rollback') throw Error('fixture receipt failed');
          };
        }};
        const originalRun = asyncVolumeAdmission.run;
        if (scenario === 'lost-release') asyncVolumeAdmission.run = async function (...args) {
          await originalRun.apply(this, args);
          throw Error('fixture release reply lost');
        };
        let original;
        try {
          ledger.exec('BEGIN IMMEDIATE');
          timer = setTimeout(() => {
            if (scenario === 'revoked') allowed = false;
            if (scenario === 'cancelled') abort.abort(Error('fixture cancelled'));
            if (scenario === 'closed') { store.close(); closed = true; }
            if (scenario === 'model') models.modelChoices.length = 0;
            if (scenario === 'maintenance') store.pauseTurnStarts();
            ledger.exec('COMMIT'); released = true;
          }, 120);
          const flight = commands.sendAsync(key, 'original text', actor, attachments);
          if (scenario === 'snapshot') {
            actor.actorId = 'replacement'; actor.signal = AbortSignal.abort();
            attachments[0].name = 'replacement.txt'; attachments[0].data = Buffer.from('replacement body').toString('base64');
          }
          assert.equal(wakes, 0); assert.equal(commits, 0);
          if (scenario === 'commit' || scenario === 'snapshot') {
            assert.deepEqual(await flight, accepted);
          } else await assert.rejects(flight);
          assert.equal(released, true, 'same-loop unlock must occur before admission finishes');
          const committed = ['commit', 'snapshot', 'lost-release'].includes(scenario);
          assert.equal(wakes, Number(committed)); assert.equal(changes, Number(committed));
          assert.equal(commits, Number(committed || scenario === 'rollback'));
          assert.equal(ledger.prepare('SELECT count(*) n FROM storage_work_reservations').get().n, 0);
          if (!closed) original = store.commands.get(scope, 'send');
        } finally {
          asyncVolumeAdmission.run = originalRun;
          clearTimeout(timer); if (ledger.isTransaction) ledger.exec('ROLLBACK'); ledger.close();
          if (!closed) store.close();
        }
        const reopened = new ConnectorUserStore(file);
        try {
          const receipt = reopened.commands.get(scope, 'send');
          if (original) assert.deepEqual(receipt, original);
          const committed = ['commit', 'snapshot', 'lost-release'].includes(scenario);
          assert.equal(receipt.state, committed ? 'accepted' : 'outcome_unknown');
          assert.equal((await reopened.commands.claimAsync(scope, 'send', {})).fresh, false);
          assert.equal(reopened.turns.maintenanceCount(runtime), Number(committed));
          if (committed) {
            const turn = reopened.turns.head(runtime, key);
            assert.equal(turn.payload.actorId, 'owner'); assert.equal(turn.payload.text, 'original text');
            const media = reopened.sdkAttachments.media(key, turn.id);
            assert.equal(media.length, 1); assert.equal(media[0].name, 'original.txt');
          } else assert.equal(reopened.db.prepare('SELECT count(*) n FROM sdk_attachments').get().n, 0);
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
}
