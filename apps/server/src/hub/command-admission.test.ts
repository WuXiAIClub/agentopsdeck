import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CommandReceipts } from '../commands/receipts.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { HubLifecycleCommands } from './lifecycle-commands.js';
import { HubMaintenanceCommands } from './maintenance-commands.js';

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

for (const domain of ['lifecycle', 'maintenance'] as const) {
  for (const fault of ['revoked', 'cancelled', 'closed', 'retargeted', 'rotated', 'lost-release'] as const) {
    test(`${domain} async receipt admission fences ${fault} without dispatch or vault replay`, async t => {
      const db = new DatabaseSync(':memory:');
      const entered = gate(), release = gate(); let authorized = true, token = 'synthetic-original', admissions = 0, bindings = 0;
      db.exec(`CREATE TABLE env_connections(id TEXT, owner_user_id TEXT, node_id TEXT, connector_url TEXT,
        authority_version INTEGER, kind TEXT, deleted_at INTEGER, status TEXT);
        CREATE TABLE fixture_vault(id TEXT PRIMARY KEY, value TEXT);`);
      const nodeId = 'node_00000000-0000-4000-8000-000000000001';
      db.prepare('INSERT INTO env_connections VALUES (?, ?, ?, ?, 1, ?, NULL, ?)')
        .run('remote', 'default', nodeId, 'https://synthetic.invalid', 'remote', 'connected');
      const receipts = new CommandReceipts(db, undefined, undefined, undefined,
        () => assert.fail('production domain must await physical admission'), new PerformanceDiagnostics(() => {}),
        async (_bytes, write) => {
          admissions++; entered.release(); await release.promise;
          const result = await write();
          if (fault === 'lost-release') throw Error('synthetic-lost-release');
          return result;
        });
      const vault = {
        current: () => token,
        read: (id: string) => (db.prepare('SELECT value FROM fixture_vault WHERE id = ?').get(id)?.value as string | undefined),
        write: (id: string, value: string) => {
          assert.equal(db.isTransaction, true, 'binding and receipt must share the original transaction');
          bindings++; db.prepare('INSERT INTO fixture_vault VALUES (?, ?)').run(id, value);
        },
      };
      const owner = domain === 'lifecycle'
        ? new HubLifecycleCommands(db, receipts, vault, [{ ownerUserId: 'default', connectionId: 'remote', nodeId, origin: 'https://synthetic.invalid' }])
        : new HubMaintenanceCommands(db, receipts, vault);
      t.after(async () => { release.release(); await owner.close(); db.close(); });
      const signal = new AbortController();
      const authorize = () => { if (!authorized) throw Error('synthetic-revoked'); };
      const flight = owner instanceof HubLifecycleCommands
        ? owner.send({ userId: 'default', connectionId: 'remote', operation: 'restart' }, 'key', authorize, signal.signal)
        : owner.send({ userId: 'default', ownerUserId: 'default', connectionId: 'remote', operation: 'apply' }, 'key',
          { version: 'v1', manifestSha256: 'a'.repeat(64) }, { read: authorize, send: authorize }, undefined, signal.signal);
      const rejected = assert.rejects(flight);
      await entered.promise;
      assert.equal(db.prepare('SELECT count(*) n FROM command_receipts').get()!.n, 0);
      assert.equal(bindings, 0);
      let closing: Promise<void> | undefined;
      if (fault === 'revoked') authorized = false;
      if (fault === 'cancelled') signal.abort(Error('synthetic-cancelled'));
      if (fault === 'closed') closing = owner.close();
      if (fault === 'retargeted') db.prepare('UPDATE env_connections SET authority_version = 2, connector_url = ?').run('https://changed.invalid');
      if (fault === 'rotated') token = 'synthetic-replacement';
      release.release(); await rejected; await closing;
      assert.equal(db.isTransaction, false); assert.equal(admissions, 1);
      const rows = db.prepare('SELECT scope, command_key, id FROM command_receipts').all();
      assert.equal(rows.length, fault === 'lost-release' ? 1 : 0);
      assert.equal(bindings, fault === 'lost-release' ? 1 : 0);
      assert.equal(db.prepare('SELECT count(*) n FROM fixture_vault').get()!.n, bindings);
      if (fault === 'lost-release') {
        const { scope, command_key: key, id } = rows[0] as { scope: string; command_key: string; id: string };
        const original = receipts.get(scope, key)!;
        assert.equal(original.state, 'outcome_unknown'); assert.equal(original.id, id);
        const payload = domain === 'lifecycle' ? { operation: 'restart' } : { version: 'v1', manifestSha256: 'a'.repeat(64) };
        const retry = await receipts.claimAsync(scope, key, payload, true, undefined, undefined,
          () => assert.fail('UNKNOWN recovery must not bind or dispatch again'));
        assert.equal(retry.fresh, false); assert.deepEqual(retry.receipt, original);
        assert.equal(bindings, 1); assert.equal(admissions, 1);
      }
    });
  }
}
