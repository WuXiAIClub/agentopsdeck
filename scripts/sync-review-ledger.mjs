import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewInventory, validateReview } from './open-source-review.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = 'docs/review/file-review.json';

export function inferKind(path) {
  if (/\.test\.(?:[cm]?[jt]sx?|py|c)$|(?:^|\/)test_[^/]+\.(?:py|c)$|(?:^|\/)__tests__\//.test(path)) return 'test';
  if (/\.generated\.|openapi\.json$/i.test(path)) return 'generated';
  if (/\.(?:png|jpe?g|gif|webp|ico|svg|icns|woff2?|ttf|otf|mp3|wav)$/i.test(path)) return 'asset';
  if (path.startsWith('docs/') || /\.md$/i.test(path)) return 'docs';
  if (/(?:^|\/)(?:\.[^/]+|[^/]+\.(?:json|ya?ml|toml|ini|conf|lock|rc)|Dockerfile[^/]*|Makefile|LICENSE)$/i.test(path)) return 'config';
  return 'runtime';
}

export function inferModule(path) {
  if (path.startsWith('apps/web/')) return 'web';
  if (path.startsWith('apps/server/src/connector/')) return 'connector';
  if (path.startsWith('apps/server/src/storage/')) return 'storage';
  if (path.startsWith('apps/server/')) return 'server';
  if (path.startsWith('packages/shared/')) return 'shared';
  if (path.startsWith('native/')) return 'native';
  if (path.startsWith('scripts/')) return 'scripts';
  if (path.startsWith('docs/')) return 'docs';
  return 'governance';
}

export function syncReviewLedger(report, inventory) {
  if (!report || !Array.isArray(report.files)) throw new Error('Invalid review ledger document');
  const byPath = new Map(report.files.map(record => [record.path, record]));
  const inventoryPaths = new Set(inventory.map(item => item.path));
  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const existingPath of byPath.keys()) {
    if (!inventoryPaths.has(existingPath)) removed += 1;
  }

  const files = inventory.map(item => {
    const existing = byPath.get(item.path);
    if (!existing) {
      added += 1;
      const kind = inferKind(item.path);
      return {
        path: item.path,
        size: item.size,
        sha256: item.sha256,
        module: inferModule(item.path),
        kind,
        depth: kind === 'asset' ? 'asset' : 'semantic',
        disposition: kind === 'asset' ? 'not-applicable' : 'no-finding',
        checks: ['current-source-sha256-and-size'],
        notes: 'Ledger entry synced for newly added repository file.',
        findings: [],
      };
    }
    if (existing.size !== item.size || existing.sha256 !== item.sha256) {
      updated += 1;
      return { ...existing, size: item.size, sha256: item.sha256 };
    }
    return existing;
  });

  const byKind = {};
  const byModule = {};
  const byDepth = {};
  const byDisposition = {};
  for (const record of files) {
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
    if (record.module) byModule[record.module] = (byModule[record.module] ?? 0) + 1;
    byDepth[record.depth] = (byDepth[record.depth] ?? 0) + 1;
    byDisposition[record.disposition] = (byDisposition[record.disposition] ?? 0) + 1;
  }

  const next = {
    ...report,
    summary: {
      ...(report.summary ?? {}),
      totalFiles: files.length,
      byKind,
      byModule,
      byDepth,
      byDisposition,
    },
    files,
  };
  return { next, stats: { totalFiles: files.length, added, updated, removed } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const fullPath = join(repository, reportPath);
  const report = JSON.parse(readFileSync(fullPath, 'utf8'));
  const inventory = reviewInventory(repository);
  const { next, stats } = syncReviewLedger(report, inventory);
  const validation = validateReview(next.files, inventory);
  if (!validation.passed) {
    console.error('Synced review ledger failed validation:', JSON.stringify(validation.errors.slice(0, 10), null, 2));
    process.exitCode = 1;
  } else {
    if (!dryRun && (stats.added || stats.updated || stats.removed)) {
      writeFileSync(fullPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    }
    console.log(JSON.stringify({ dryRun, ...stats, passed: validation.passed }, null, 2));
  }
}
