import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditProductionDatabaseRoots } from './audit-production-database-roots.mjs';
import { auditDatabaseRoots } from './audit-async-database-roots.mjs';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'production-root-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(resolve(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text);
  }
  return root;
}
const legacy = `import { HubStore as Store } from './hub-store.js'; new Store(file);`;
test('production graph excludes unreachable legacy roots without weakening the whole-source inventory', async t => {
  const root = await fixture(t, { 'index.ts': `import { type Old } from './legacy.js'; import './async.js';`,
    'async.ts': 'export const ready = true;', 'legacy.ts': legacy });
  const actual = await auditProductionDatabaseRoots(root);
  assert.equal(actual.productionRootGatePassed, true); assert.equal(actual.inputs.length, 2);
  assert.equal((await auditDatabaseRoots(root)).structuralRootGatePassed, false);
  assert.equal(actual.wholeDatabaseAsyncAcceptance, 'requires-production-chain-and-full-regression');
});
for (const edge of [`import './legacy.js';`, `export * from './legacy.js';`, `await import('./legacy.js');`]) {
  test('value dependency cannot hide an original root: ' + edge, async t => {
    const root = await fixture(t, { 'index.ts': edge, 'legacy.ts': legacy, 'hub-store.ts': 'export class HubStore {}' });
    const result = await auditProductionDatabaseRoots(root);
    assert.equal(result.productionRootGatePassed, false); assert.equal(result.pending[0].symbol, 'HubStore');
  });
}
test('worker filename, test fixture and opaque dynamic imports do not authorize main-thread SQL', async t => {
  const root = await fixture(t, { 'index.ts': `import './connector/connector-owner-worker.js'; import './fixture.test.js'; await import(target);`,
    'connector/connector-owner-worker.ts': `import { DatabaseSync } from 'node:sqlite'; new DatabaseSync(file);`,
    'fixture.test.ts': 'export const x = true;' });
  const result = await auditProductionDatabaseRoots(root);
  assert.equal(result.productionRootGatePassed, false);
  assert.deepEqual(result.workerImports, ['connector/connector-owner-worker.ts']);
  assert.deepEqual(result.fixtureImports, ['fixture.test.ts']); assert.deepEqual(result.opaqueImports, ['index.ts']);
});
test('missing local modules, escaping imports and malformed source cannot yield a green gate', async t => {
  for (const text of [`import './absent.js';`, `import '../escape.js';`, 'import { broken from;']) {
    const root = await fixture(t, { 'index.ts': text });
    await assert.rejects(auditProductionDatabaseRoots(root));
  }
});
test('actual process entry reaches only asynchronous roots, keeping legacy constructors outside the production graph', async () => {
  const root = fileURLToPath(new URL('../apps/server/src', import.meta.url));
  const result = await auditProductionDatabaseRoots(root);
  assert.equal(result.productionRootGatePassed, true, JSON.stringify({ pending: result.pending,
    workers: result.workerImports, fixtures: result.fixtureImports, opaque: result.opaqueImports }));
  for (const path of ['application-process.ts', 'application-connector-async.ts', 'application-hub-async.ts']) {
    assert.ok(result.inputs.some(row => row.path === path));
  }
  for (const path of ['application.ts', 'connector/runtime.ts']) assert.ok(!result.inputs.some(row => row.path === path));
});
