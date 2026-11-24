import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { checkpointOwnedWal, checkpointOwnedWalAsync } from "./owned-sqlite.js";
import { StorageAdmissionDeferred } from "./work-admission.js";
import { performanceDiagnostics, PerformanceDiagnostics } from "../diagnostics/performance.js";

function failure(kind: string): unknown {
  if (kind === 'deferred') return new StorageAdmissionDeferred('private-original-failure');
  if (kind === 'revoked') { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; }
  if (kind === 'prototype') return new Proxy({}, { getPrototypeOf() { throw Error('private-inspection-failure'); } });
  return Error('private-original-failure');
}

for (const mode of ['sync', 'async']) for (const stage of ['admission', 'sql']) {
  for (const kind of ['deferred', 'revoked', 'prototype', 'ordinary']) {
    test(`${mode} checkpoint ${stage}/${kind} preserves the original outcome`, async t => {
      const db = new DatabaseSync(':memory:'), original = failure(kind), rows: Record<string, unknown>[] = [];
      const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
      if (mode === 'sync') t.mock.method(performanceDiagnostics, 'start', diagnostics.start.bind(diagnostics));
      let admissions = 0, sql = 0, rejected = false, value: unknown;
      t.mock.method(db, 'prepare', () => { sql++; throw original; });
      try {
        if (mode === 'sync') {
          value = checkpointOwnedWal(db, '/nonexistent-private-error-contract.db', () => ({
            runSync: (_class, _bytes, write) => { admissions++; if (stage === 'admission') throw original; return write(); },
          }));
        } else {
          value = await checkpointOwnedWalAsync(db, '/nonexistent-private-error-contract.db', {
            diagnostics,
            sample: async () => 0,
            admission: async (_root, _bytes, write) => { admissions++; if (stage === 'admission') throw original; return write(); },
          });
        }
      } catch (error) { rejected = true; value = error; }
      finally { db.close(); }
      assert.equal(admissions, 1); assert.equal(sql, Number(stage === 'sql'));
      const deferred = stage === 'admission' && kind === 'deferred';
      assert.equal(rejected, !deferred);
      if (deferred) assert.deepEqual(value, { deferred: true });
      else assert.ok(value === original, 'classification must not mask the original failure');
      if (mode === 'async' || !deferred) {
        assert.equal(rows.length, 1); assert.equal(rows[0]!.unknown ?? 0, Number(stage === 'sql'));
        assert.equal(rows[0]!.classificationUnknown ?? 0, Number(stage === 'admission' && ['revoked', 'prototype'].includes(kind)));
        assert.equal(rows[0]!.category, deferred ? 'routine' : 'failed');
        assert.doesNotMatch(JSON.stringify(rows), /private|nonexistent|PRAGMA/);
      } else assert.equal(rows.length, 0);
    });
  }
}

for (const kind of ['revoked', 'prototype', 'ordinary']) test(`failed checkpoint sampling ${kind} cannot be replaced by classification`, async () => {
  const db = new DatabaseSync(':memory:'), original = failure(kind), rows: Record<string, unknown>[] = [];
  let admissions = 0;
  try {
    let rejected = false, value: unknown;
    try { await checkpointOwnedWalAsync(db, '/nonexistent-private-error-contract.db', {
      diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line))),
      sample: async () => { throw original; },
      admission: async (_root, _bytes, write) => { admissions++; return write(); },
    }); } catch (error) { rejected = true; value = error; }
    assert.equal(rejected, true); assert.ok(value === original);
    assert.equal(admissions, 0); assert.equal(rows.length, 1); assert.equal(rows[0]!.category, 'failed');
    assert.equal(rows[0]!.unknown ?? 0, 0);
    assert.equal(rows[0]!.classificationUnknown ?? 0, Number(['revoked', 'prototype'].includes(kind)));
    assert.doesNotMatch(JSON.stringify(rows), /private|nonexistent/);
  } finally { db.close(); }
});

test('admitted checkpoint failure is never inspected as a pre-admission deferral', async t => {
  const db = new DatabaseSync(':memory:'); let inspected = 0, sql = 0;
  const original = new Proxy({}, { getPrototypeOf() { inspected++; throw Error('private-inspection-failure'); } });
  t.mock.method(db, 'prepare', () => { sql++; throw original; });
  try {
    await assert.rejects(checkpointOwnedWalAsync(db, '/nonexistent-private-error-contract.db', {
      sample: async () => 0,
      diagnostics: new PerformanceDiagnostics(() => { throw Error('private-sink-failure'); }),
      admission: async (_root, _bytes, write) => write(),
    }), error => error === original);
    assert.equal(sql, 1); assert.equal(inspected, 0);
  } finally { db.close(); }
});
