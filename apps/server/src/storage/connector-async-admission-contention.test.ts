import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = import.meta.url.endsWith('.ts');
const connector = new URL(source ? '../connector/connector-user-store.ts' : '../connector/connector-user-store.js', import.meta.url).href;
const asyncAdmission = new URL(source ? './async-volume-admission.ts' : './async-volume-admission.js', import.meta.url).href;
const loaderArgs = source ? ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))] : [];

// NEVER take a write lock on the suite's shared volume ledger. The child has a
// unique TMPDIR/TMP/TEMP so this same-event-loop contention cannot block peers.
// Real original Connector connection and whole queue/receipt transaction;
// only physical admission moves to its existing coordinator thread.
for (const scenario of ['commit', 'revoked', 'rollback'] as const) {
  test(`original Connector async admission under ledger contention: ${scenario}`, { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-private-ledger-contention-'));
    const code = `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { mkdtempSync, readdirSync, statSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      const { ConnectorUserStore } = await import(${JSON.stringify(connector)});
      const { asyncVolumeAdmission } = await import(${JSON.stringify(asyncAdmission)});
      const directory = mkdtempSync(join(tmpdir(), 'connector-'));
      const store = new ConnectorUserStore(join(directory, 'connector.sqlite'), undefined, { runtimeOwner: true });
      await asyncVolumeAdmission.run(directory, 'durable', 1024, async () => {});
      const coordinator = readdirSync(tmpdir()).filter(name => name.startsWith('agentopsdeck-storage-admission-'));
      assert.equal(coordinator.length, 1, 'exact private child coordinator');
      const ledger = new DatabaseSync(join(tmpdir(), coordinator[0], 'volume-' + statSync(directory, { bigint: true }).dev + '.sqlite'));
      const turn = { id: 'successor', sessionKey: 'codex:synthetic', createdAt: 1, payload: { text: 'next', images: [] } };
      let timer, released = false, authorized = true, invoked = 0, notified = 0, ownerDb;
      const unlisten = store.turns.onAdmission(() => { notified++; });
      const receipt = db => {
        invoked++; ownerDb = db;
        assert.equal(released, true, 'business transaction only enters after original lock release');
        assert.equal(db.isTransaction, true, 'receipt remains inside original queue transaction');
        assert.equal(db.prepare('SELECT count(*) n FROM connector_turns WHERE id=?').get(turn.id).n, 1);
        db.exec('CREATE TABLE contention_original_receipt (id TEXT PRIMARY KEY)');
        db.prepare('INSERT INTO contention_original_receipt VALUES(?)').run(turn.id);
        if (${JSON.stringify(scenario)} === 'rollback') throw new Error('original receipt refused');
      };
      try {
        // Warm the REAL coordinator before taking the lock. Otherwise the
        // unlock could merely happen during worker startup rather than during
        // SQL contention in an already-ready admission owner.
        await asyncVolumeAdmission.run(directory, 'durable', 1024, async () => {});
        if (${JSON.stringify(scenario)} === 'commit') {
          ledger.exec('BEGIN IMMEDIATE');
          timer = setTimeout(() => { ledger.exec('COMMIT'); released = true; }, 120);
          assert.throws(() => store.turns.enqueue('codex', turn, receipt), /async-admission-required/);
          assert.equal(released, false, 'sync admission is refused without blocking or touching the ledger');
          assert.equal(invoked, 0, 'refused physical admission never enters business transaction');
          assert.equal(store.turns.head('codex', turn.sessionKey), undefined);
          clearTimeout(timer); ledger.exec('COMMIT');
        }
        ledger.exec('BEGIN IMMEDIATE');
        timer = setTimeout(() => {
          if (${JSON.stringify(scenario)} === 'revoked') authorized = false;
          ledger.exec('COMMIT'); released = true;
        }, 120);
        const flight = store.turns.enqueueAsync('codex', turn, receipt, () => {
          if (!authorized) throw new Error('authority changed while waiting');
        });
        if (${JSON.stringify(scenario)} === 'commit') {
          await flight;
          assert.equal(invoked, 1); assert.equal(notified, 1);
          assert.equal(store.turns.head('codex', turn.sessionKey).id, turn.id);
          assert.equal(store.turns.maintenanceCount(), 1);
          assert.equal(ownerDb.isTransaction, false);
          assert.equal(ownerDb.prepare('SELECT id FROM contention_original_receipt').get().id, turn.id);
        } else {
          await assert.rejects(flight, ${JSON.stringify(scenario)} === 'revoked' ? /authority changed/ : /original receipt refused/);
          assert.equal(invoked, ${JSON.stringify(scenario)} === 'revoked' ? 0 : 1);
          assert.equal(notified, 0);
          assert.equal(store.turns.maintenanceCount(), 0);
          assert.equal(store.turns.head('codex', turn.sessionKey), undefined);
          if (ownerDb) {
            assert.equal(ownerDb.isTransaction, false);
            assert.equal(ownerDb.prepare("SELECT count(*) n FROM sqlite_master WHERE name='contention_original_receipt'").get().n, 0);
          }
        }
        assert.equal(released, true, 'awaited admission permits same-loop lock release');
        assert.equal(ledger.prepare('SELECT count(*) n FROM storage_work_reservations').get().n, 0, 'original lease settled, no business retry');
      } finally {
        clearTimeout(timer); unlisten();
        if (ledger.isTransaction) ledger.exec('ROLLBACK');
        ledger.close(); store.close();
      }
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
      // Do not remove a ledger while its original test process is still alive.
      if (!child || child.exitCode !== null || child.signalCode !== null) rmSync(root, { recursive: true, force: true });
    }
  });
}
