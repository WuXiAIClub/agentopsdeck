import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectDatabaseRoots, isFixture, auditDatabaseRoots } from './audit-async-database-roots.mjs';

test('original runtime owners are pending, including imported aliases and namespace calls', () => {
  const source = `import { HubStore as Store } from './hub/hub-store.js';
    import * as auth from './auth/sqlite-store.js';
    import * as sqlite from 'node:sqlite';
    new Store(path); auth.openSqliteAuth(path, [], key); new sqlite.DatabaseSync(path);`;
  const findings = inspectDatabaseRoots(source, 'application.ts');
  assert.deepEqual(findings.map(f => f.symbol), ['HubStore', 'openSqliteAuth', 'DatabaseSync']);
  assert.ok(findings.every(f => f.classification === 'synchronous-root-requires-migration-review'));
  assert.ok(findings.every(f => f.line > 0 && f.column > 0));
  assert.equal(JSON.stringify(findings).includes('[], key'), false, 'no arguments/credentials copied into evidence');
});
test('worker ownership and implementations are distinct from activated runtime migration', () => {
  const source = `import { ConnectorUserStore } from './connector-user-store.js'; new ConnectorUserStore(file);`;
  assert.equal(inspectDatabaseRoots(source, 'connector/connector-owner-worker.ts')[0].classification, 'worker-owned-boundary');
  assert.equal(inspectDatabaseRoots(source, 'connector/runtime.ts')[0].classification, 'synchronous-root-requires-migration-review');
  const original = `import { startupDatabaseOwners as owners } from '../storage/startup-owner.js'; owners.open(file);`;
  assert.equal(inspectDatabaseRoots(original, 'connector/connector-user-store.ts')[0].classification, 'original-domain-owner-implementation');
  assert.equal(inspectDatabaseRoots(original, 'storage/volume-admission.ts')[0].classification, 'synchronous-root-requires-migration-review');
});
test('type imports, comments, strings and constructor references are not invocation evidence', () => {
  const source = `import type { HubStore } from './hub-store.js';
    import { type ConnectorUserStore } from './connector-user-store.js';
    import { DatabaseSync } from 'node:sqlite';
    // new DatabaseSync('private');
    const note = 'new DatabaseSync(secret)'; const ctor = DatabaseSync;`;
  assert.deepEqual(inspectDatabaseRoots(source, 'application.ts'), []);
});
test('namespace startup factories are found and unknown file boundaries remain pending', () => {
  const source = `import * as startup from './startup-owner.js'; startup.startupDatabaseOwners.open(file);`;
  assert.equal(inspectDatabaseRoots(source, 'other/new-runtime.ts')[0].symbol, 'startupDatabaseOwners');
  assert.equal(inspectDatabaseRoots(source, 'other/new-runtime.ts')[0].classification, 'synchronous-root-requires-migration-review');
});
test('maintenance locking is not silently certified asynchronous', () => {
  const source = `import { DatabaseSync } from 'node:sqlite'; new DatabaseSync(lock);`;
  assert.equal(inspectDatabaseRoots(source, 'connector/update-service.ts')[0].classification, 'synchronous-root-requires-migration-review');
  assert.equal(inspectDatabaseRoots(source, 'storage/startup-owner.ts')[0].classification, 'connection-factory');
});
test('only the reviewed update lock worker is exempt, never arbitrary worker names or volume coordination', () => {
  const source = `import { DatabaseSync } from 'node:sqlite'; new DatabaseSync(lock);`;
  assert.equal(inspectDatabaseRoots(source, 'connector/update-lock-worker.ts')[0].classification, 'worker-owned-boundary');
  for (const path of ['connector/other-worker.ts', 'storage/volume-admission.ts', 'connector/update-service.ts']) {
    assert.equal(inspectDatabaseRoots(source, path)[0].classification, 'synchronous-root-requires-migration-review');
  }
});
test('only explicit source test/fixture filenames are excluded', () => {
  for (const path of ['auth/foo.test.ts', 'openclaw/turn-queue.test-fixture.ts', 'hub/workspace-card-file-fixture.ts']) assert.equal(isFixture(path), true);
  for (const path of ['auth/test-policy.ts', 'connector/runtime.ts', 'some-fixture/runtime.ts']) assert.equal(isFixture(path), false);
});
test('volume coordinator requires a real parent-port rejection before its connection factory', () => {
  const owner = `import { startupDatabaseOwners } from './startup-owner.js';`;
  const parent = `import { parentPort } from 'node:worker_threads';`;
  const open = `startupDatabaseOwners.open(file);`;
  const path = 'storage/volume-admission-worker.ts';
  for (const source of [owner + open, parent + owner + open,
    parent + owner + open + `if (!parentPort) throw Error('worker');`,
    parent + owner + `if (!parentPort) console.error('worker');` + open,
    owner + `const parentPort = true; if (!parentPort) throw Error('worker');` + open]) {
    assert.equal(inspectDatabaseRoots(source, path)[0].classification, 'synchronous-root-requires-migration-review');
  }
  const guarded = parent + owner + `if (!parentPort) throw Error('worker');` + open;
  assert.equal(inspectDatabaseRoots(guarded, path)[0].classification, 'worker-owned-boundary');
  assert.equal(inspectDatabaseRoots(guarded, 'storage/arbitrary-worker.ts')[0].classification, 'synchronous-root-requires-migration-review');
});
test('malformed inputs cannot produce a green audit', () => {
  assert.throws(() => inspectDatabaseRoots('import { DatabaseSync from;', 'application.ts'), /Cannot audit/);
});
test('an empty structural gate is explicitly not whole-database async acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'async-root-audit-'));
  try {
    await mkdir(join(root, 'nested'));
    const result = await auditDatabaseRoots(root);
    assert.equal(result.structuralRootGatePassed, true);
    assert.equal(result.wholeDatabaseAsyncAcceptance, 'not-established-by-static-audit');
    assert.equal(result.sourceSha256.length, 64);
  } finally { await rm(root, { recursive: true, force: true }); }
});
