import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const depths = new Set(['semantic', 'structural', 'asset', 'pending']);
const dispositions = new Set(['no-finding', 'finding', 'pending', 'not-applicable']);
const kinds = new Set(['runtime', 'test', 'config', 'generated', 'asset', 'docs']);
const reportPath = 'docs/review/file-review.json';

export function validateReview(records, inventory) {
  const errors = [];
  if (!Array.isArray(inventory) || !inventory.length) return { passed: false, errors: [{ category: 'invalid-inventory' }], complete: false };
  const expected = new Map();
  for (const file of inventory) {
    if (!file || typeof file.path !== 'string' || !file.path.length
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.size) || file.size < 0) {
      errors.push({ category: 'invalid-inventory-entry' });
      continue;
    }
    if (expected.has(file.path)) errors.push({ path: file.path, category: 'duplicate-inventory-entry' });
    expected.set(file.path, file);
  }
  const seen = new Set();
  const byDepth = {};
  const byKind = {};
  const byDisposition = {};
  if (!Array.isArray(records)) return { passed: false, errors: [{ category: 'invalid-records' }], complete: false };
  for (const record of records) {
    const path = record?.path;
    if (typeof path !== 'string' || !expected.has(path)) {
      errors.push({ category: 'unexpected-path', ...(typeof path === 'string' ? { path } : {}) });
      continue;
    }
    if (seen.has(path)) errors.push({ path, category: 'duplicate-record' });
    seen.add(path);
    const file = expected.get(path);
    if (record.sha256 !== file.sha256 || record.size !== file.size) errors.push({ path, category: 'stale-record' });
    if (!depths.has(record.depth) || !dispositions.has(record.disposition) || !kinds.has(record.kind)
      || !Array.isArray(record.checks) || !record.checks.length
      || record.checks.some(check => typeof check !== 'string' || !check.trim())
      || typeof record.notes !== 'string' || record.notes.trim().length < 12
      || !Array.isArray(record.findings) || record.findings.some(finding => typeof finding !== 'string' || !finding.trim())) {
      errors.push({ path, category: 'invalid-review-evidence' });
    }
    if (record.depth === 'pending' && record.disposition !== 'pending'
      || record.disposition === 'finding' && !record.findings?.length
      || ['no-finding', 'not-applicable'].includes(record.disposition) && record.findings?.length) {
      errors.push({ path, category: 'inconsistent-disposition' });
    }
    if (record.depth === 'asset' && !['asset', 'generated'].includes(record.kind)) {
      errors.push({ path, category: 'inconsistent-depth' });
    }
    byDepth[record.depth] = (byDepth[record.depth] ?? 0) + 1;
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
    byDisposition[record.disposition] = (byDisposition[record.disposition] ?? 0) + 1;
  }
  for (const path of expected.keys()) if (!seen.has(path)) errors.push({ path, category: 'missing-record' });
  const complete = errors.length === 0 && records.every(record => ['semantic', 'asset'].includes(record.depth)
    && ['no-finding', 'not-applicable'].includes(record.disposition));
  return { passed: errors.length === 0, complete, inventoryFiles: inventory.length,
    recordedFiles: records.length, byDepth, byKind, byDisposition, errors };
}

export function reviewInventory(root = repository) {
  const paths = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean))].sort();
  return paths.filter(path => path !== reportPath).map(path => {
    const absolute = join(root, path);
    if (!lstatSync(absolute).isFile()) throw new Error('Review inventory refuses nonregular source');
    const bytes = readFileSync(absolute);
    return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3 || process.argv[2] && process.argv[2] !== '--require-complete') throw new Error('Invalid review options');
    const report = JSON.parse(readFileSync(join(repository, reportPath), 'utf8'));
    const result = validateReview(report.files, reviewInventory());
    console.log(JSON.stringify({ ...result, ledgerSelfExcluded: reportPath, publicationApproved: false }, null, 2));
    if (!result.passed || process.argv[2] === '--require-complete' && !result.complete) process.exitCode = 1;
  } catch {
    console.error('Open-source review evidence could not be validated; no source content printed.');
    process.exitCode = 1;
  }
}
