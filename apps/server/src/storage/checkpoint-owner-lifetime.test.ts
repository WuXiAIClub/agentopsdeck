import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { checkpointOwnedWalAsync } from './owned-sqlite.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { recoverableConnection, retireConnectionForAsyncWork } from './connection-recovery.js';

for (const mode of ['closed', 'retired', 'unavailable', 'revoked'] as const) {
  test(`checkpoint release cannot acknowledge a ${mode} original owner`, async t => {
    const raw = new DatabaseSync(':memory:'); t.after(() => { if (raw.isOpen) raw.close(); });
    const logs: Record<string, unknown>[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
    const db = mode === 'retired' ? recoverableConnection(raw, diagnostics) : raw;
    let available = true, allowed = true, writes = 0;
    const pending = checkpointOwnedWalAsync(db, '/nonexistent-synthetic-checkpoint.db', {
      sample: async () => 0, diagnostics, available: () => available,
      check: () => { if (!allowed) throw Error('revoked'); },
      admission: async (_root, _bytes, write) => {
        const result = await write(); writes++; assert.equal((result as { deferred: boolean }).deferred, false);
        if (mode === 'closed') db.close();
        if (mode === 'retired') retireConnectionForAsyncWork(db);
        if (mode === 'unavailable') available = false;
        if (mode === 'revoked') allowed = false;
        return result;
      },
    });
    await assert.rejects(pending);
    assert.equal(writes, 1);
    const log = logs.find(row => row.operation === 'owned-wal-checkpoint');
    assert.equal(log?.category, 'failed'); assert.equal(log?.unknown, 1);
    assert.doesNotMatch(JSON.stringify(logs), /nonexistent|synthetic|revoked|PRAGMA/);
  });
}
