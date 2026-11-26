import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReview } from './open-source-review.mjs';
import { inferKind, inferModule, syncReviewLedger } from './sync-review-ledger.mjs';

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const hashC = 'c'.repeat(64);

test('syncReviewLedger updates changed hashes, adds new files, removes deleted files, and passes validation', () => {
  const report = {
    schemaVersion: 1,
    summary: { totalFiles: 2 },
    files: [
      {
        path: 'apps/server/src/example.ts',
        size: 10,
        sha256: hashA,
        module: 'server',
        kind: 'runtime',
        depth: 'semantic',
        disposition: 'no-finding',
        checks: ['complete-file-and-callers'],
        notes: 'Reviewed runtime entry.',
        findings: [],
      },
      {
        path: 'apps/server/src/deleted.ts',
        size: 12,
        sha256: hashA,
        module: 'server',
        kind: 'runtime',
        depth: 'semantic',
        disposition: 'no-finding',
        checks: ['complete-file-and-callers'],
        notes: 'Deleted file entry.',
        findings: [],
      },
    ],
  };
  const inventory = [
    { path: 'apps/server/src/example.ts', size: 22, sha256: hashB },
    { path: 'scripts/new-tool.test.mjs', size: 40, sha256: hashC },
  ];
  const { next, stats } = syncReviewLedger(report, inventory);
  assert.deepEqual(stats, { totalFiles: 2, added: 1, updated: 1, removed: 1 });
  assert.equal(next.files[0].sha256, hashB);
  assert.equal(next.files[0].size, 22);
  assert.equal(next.files[0].notes, 'Reviewed runtime entry.');
  assert.equal(next.files[1].kind, 'test');
  assert.equal(next.files[1].module, 'scripts');
  assert.equal(validateReview(next.files, inventory).passed, true);
});

test('inferKind and inferModule classify common repository paths', () => {
  assert.equal(inferKind('scripts/sync-review-ledger.test.mjs'), 'test');
  assert.equal(inferKind('docs/api/openapi.json'), 'generated');
  assert.equal(inferKind('docs/guide.md'), 'docs');
  assert.equal(inferKind('apps/web/public/icon.png'), 'asset');
  assert.equal(inferKind('.github/workflows/ci.yml'), 'config');
  assert.equal(inferKind('apps/server/src/app.ts'), 'runtime');
  assert.equal(inferModule('apps/web/src/App.tsx'), 'web');
  assert.equal(inferModule('apps/server/src/connector/a.ts'), 'connector');
  assert.equal(inferModule('scripts/a.mjs'), 'scripts');
});
