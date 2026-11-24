import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkIdentityHistory, checkPublication, checkReleaseApproval, findingResolved, releaseApprovalPath, releaseSourceDigest,
  unsafePathCategory, unsafeTextCategory } from './publication-check.mjs';
import { reviewInventory } from './open-source-review.mjs';

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'aod-publication-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--initial-branch=main', root], { stdio: 'ignore' });
  for (const path of ['package.json', 'apps/server/package.json', 'apps/web/package.json', 'packages/shared/package.json']) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify({ version: '1.0.0' }));
  }
  mkdirSync(join(root, 'packages/shared/src'), { recursive: true });
  writeFileSync(join(root, 'packages/shared/src/protocol.ts'), "export const AGENTOPSDECK_VERSION = '1.0.0';\n");
  return root;
}

test('publication gate accepts history-free source but refuses premature public release', context => {
  const root = fixture(context);
  assert.equal(checkPublication(root).passed, true);
  const release = checkPublication(root, true);
  assert.equal(release.passed, false);
  for (const category of ['initial-commit-required', 'uncommitted-source', 'approved-license-required']) {
    assert.ok(release.errors.some(error => error.category === category));
  }
});

function approvalFixture(context) {
  const root = fixture(context);
  mkdirSync(join(root, 'docs/review'), { recursive: true });
  const path = 'docs/review/synthetic-evidence.md';
  writeFileSync(join(root, path), 'Synthetic approval fixture; not a real rights or acceptance decision.\n');
  const files = ['package.json', 'apps/server/package.json', 'apps/web/package.json', 'packages/shared/package.json',
    'packages/shared/src/protocol.ts', path, releaseApprovalPath];
  const decision = { status: 'approved', approvedBy: 'Synthetic reviewer', approvedAt: '2026-01-01T00:00:00.000Z',
    evidence: [{ path, sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') }] };
  const approval = { schemaVersion: 1, sourceVersion: '1.0.0', sourceSha256: releaseSourceDigest(root, files),
    gates: Object.fromEntries(['inheritedRights', 'artifactAttribution', 'acceptance', 'releaseAuthorization']
      .map(gate => [gate, structuredClone(decision)])) };
  const save = () => writeFileSync(join(root, releaseApprovalPath), JSON.stringify(approval));
  save();
  return { root, files, approval, save, evidencePath: path };
}

test('a license text cannot substitute for rights, exact-source acceptance or release authorization', context => {
  const root = fixture(context);
  writeFileSync(join(root, 'LICENSE'), 'Synthetic license text '.repeat(20));
  const result = checkPublication(root, true);
  for (const category of ['release-approval-unavailable', 'complete-source-review-required', 'unresolved-release-findings']) {
    assert.ok(result.errors.some(error => error.category === category), category);
  }
  assert.ok(!result.errors.some(error => error.category === 'approved-license-required'));
});

test('source fixes and explicitly reconciled evidence gaps require distinct evidence-backed closure', () => {
  const evidence = { summary: 'Synthetic reviewed resolution.', testEvidence: ['Synthetic bounded contract evidence.'],
    limits: ['No actual release approval.'], liveAcceptance: false };
  assert.equal(findingResolved({ status: 'fixed-targeted-verified', remediation: evidence }), true);
  assert.equal(findingResolved({ status: 'fixed-targeted-verified', remediation: { ...evidence,
    testEvidence: [{ run: 'synthetic', selectors: ['fixture.test.mjs'] }] } }), true);
  assert.equal(findingResolved({ status: 'reviewed-no-finding', resolution: evidence }), true);
  assert.equal(findingResolved({ status: 'verification-complete', resolution: evidence }), true);
  assert.equal(findingResolved({ status: 'fixed-targeted-verified' }), false);
  assert.equal(findingResolved({ status: 'open', resolution: evidence }), false);
  assert.equal(findingResolved({ status: 'reviewed-no-finding', resolution: { ...evidence, testEvidence: [] } }), false);
});

test('approval validation binds current source and does not infer semantic review from approvals', context => {
  const { root, files } = approvalFixture(context);
  const errors = checkReleaseApproval(root, files, '1.0.0');
  assert.deepEqual(errors.map(error => error.category), ['complete-source-review-required', 'unresolved-release-findings']);
  writeFileSync(join(root, 'package.json'), '{"version":"1.0.0","changed":true}');
  assert.ok(checkReleaseApproval(root, files, '1.0.0').some(error => error.category === 'release-approval-source-mismatch'));
});

test('synthetic complete records pass only at their exact bytes and forged complete summaries do not', context => {
  const { root, files, approval, save } = approvalFixture(context);
  const findingsPath = 'docs/review/findings.json';
  const ledgerPath = 'docs/review/file-review.json';
  files.push(findingsPath, ledgerPath);
  writeFileSync(join(root, findingsPath), JSON.stringify({ sourceVersion: '1.0.0', findings: [] }));
  approval.sourceSha256 = releaseSourceDigest(root, files);
  save();
  const records = reviewInventory(root).map(file => ({ ...file, module: 'synthetic', kind: 'docs',
    depth: 'semantic', disposition: 'no-finding', checks: ['synthetic-test-evidence-only'],
    notes: 'Synthetic fixture, never actual approval.', findings: [] }));
  writeFileSync(join(root, ledgerPath), JSON.stringify({ complete: true, files: records }));
  assert.deepEqual(checkReleaseApproval(root, files, '1.0.0'), []);
  records[0].depth = 'structural';
  writeFileSync(join(root, ledgerPath), JSON.stringify({ complete: true, files: records }));
  assert.ok(checkReleaseApproval(root, files, '1.0.0').some(error => error.category === 'complete-source-review-required'));
  writeFileSync(join(root, findingsPath), JSON.stringify({ sourceVersion: '1.0.0', findings: [{ status: 'open' }] }));
  assert.ok(checkReleaseApproval(root, files, '1.0.0').some(error => error.category === 'unresolved-release-findings'));
});

test('pending, expired evidence bytes, wrong versions and missing decisions fail closed', context => {
  const { root, files, approval, save, evidencePath } = approvalFixture(context);
  approval.gates.inheritedRights.status = 'pending';
  approval.gates.releaseAuthorization.approvedAt = '2999-01-01T00:00:00.000Z';
  delete approval.gates.acceptance;
  approval.sourceVersion = '2.0.0';
  save();
  const errors = checkReleaseApproval(root, files, '1.0.0');
  for (const gate of ['inheritedRights', 'acceptance', 'releaseAuthorization']) {
    assert.ok(errors.some(error => error.gate === gate));
  }
  assert.ok(errors.some(error => error.category === 'release-approval-source-mismatch'));
  writeFileSync(join(root, evidencePath), 'Changed synthetic evidence.');
  assert.ok(checkReleaseApproval(root, files, '1.0.0').some(error => error.gate === 'artifactAttribution'));
});

test('approval refuses self-evidence, unsafe paths and malformed or linked decision files without content leaks', context => {
  const { root, files, approval, save } = approvalFixture(context);
  approval.gates.inheritedRights.evidence[0].path = releaseApprovalPath;
  approval.gates.acceptance.evidence[0].path = '../private/fixture.json';
  save();
  let errors = checkReleaseApproval(root, files, '1.0.0');
  assert.ok(errors.some(error => error.gate === 'inheritedRights'));
  assert.ok(errors.some(error => error.gate === 'acceptance'));
  const secret = 'synthetic-private-decision-content';
  writeFileSync(join(root, releaseApprovalPath), secret);
  errors = checkReleaseApproval(root, files, '1.0.0');
  assert.ok(errors.some(error => error.category === 'release-approval-unavailable'));
  assert.equal(JSON.stringify(errors).includes(secret), false);
  rmSync(join(root, releaseApprovalPath));
  symlinkSync('synthetic-evidence.md', join(root, releaseApprovalPath));
  assert.ok(checkReleaseApproval(root, files, '1.0.0').some(error => error.category === 'release-approval-unavailable'));
});

test('runtime paths and credential matches are reported without matched values', context => {
  const root = fixture(context);
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data', 'runtime.json'), '{}');
  const syntheticKey = 'ghp_' + 'a'.repeat(40);
  writeFileSync(join(root, 'unsafe.txt'), syntheticKey);
  const result = checkPublication(root);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(error => error.category === 'credential-pattern'));
  assert.ok(result.errors.some(error => error.category === 'private-runtime-file'));
  assert.equal(JSON.stringify(result).includes(syntheticKey), false);
  assert.equal(unsafePathCategory('.env.example'), undefined);
  assert.equal(unsafePathCategory('.env.local'), 'private-runtime-file');
  assert.equal(unsafeTextCategory('https://' + 'fixture:fixture@example.invalid'), 'credential-url');
  assert.equal(unsafeTextCategory('https://' + 'fixture:fixture@service.internal'), 'private-origin');
  assert.equal(unsafeTextCategory(['cp', 'board', 'synthetic'].join('_')), 'legacy-brand');
  assert.equal(unsafeTextCategory(['cp', 'note', 'synthetic'].join('_')), 'legacy-brand');
});

test('product version drift and unexpected initial author/committer are rejected', context => {
  const root = fixture(context);
  writeFileSync(join(root, 'apps/web/package.json'), '{"version":"2.5.0"}');
  assert.ok(checkPublication(root).errors.some(error => error.category === 'product-version-mismatch'));
  assert.equal(checkIdentityHistory('WuXiAIClub\thi@wuxiaiclub.com\tWuXiAIClub\thi@wuxiaiclub.com\n'), true);
  assert.equal(checkIdentityHistory('Fixture\tfixture@example.invalid\tWuXiAIClub\thi@wuxiaiclub.com\n'), false);
});

test('synthetic URL fixture exceptions require matching path, category and exact bytes', context => {
  const root = fixture(context);
  mkdirSync(join(root, 'scripts'));
  const path = 'scripts/rejection.test.mjs';
  const text = "const rejected = 'https://" + "fixture:fixture@example.invalid';\n";
  writeFileSync(join(root, path), text);
  writeFileSync(join(root, 'scripts/publication-fixtures.json'), JSON.stringify([{path, category: 'credential-url',
    sha256: createHash('sha256').update(text).digest('hex')}]));
  assert.equal(checkPublication(root).passed, true);
  writeFileSync(join(root, path), text + '\n');
  assert.equal(checkPublication(root).passed, false);
});

test('ignored private state stays excluded, while forcibly tracked state remains refused', context => {
  const root = fixture(context);
  writeFileSync(join(root, '.gitignore'), 'private/\n');
  mkdirSync(join(root, 'private'));
  writeFileSync(join(root, 'private', 'fixture.json'), '{}');
  assert.equal(checkPublication(root).passed, true);
  execFileSync('git', ['add', '--force', 'private/fixture.json'], { cwd: root });
  assert.equal(checkPublication(root).passed, false);
});

test('binary credentials cannot use synthetic fixture exceptions', context => {
  const root = fixture(context);
  mkdirSync(join(root, 'scripts'));
  const path = 'scripts/binary.test.mjs';
  const secret = 'ghp_' + 'a'.repeat(40);
  const bytes = Buffer.concat([Buffer.from([0, 1]), Buffer.from(secret)]);
  writeFileSync(join(root, path), bytes);
  writeFileSync(join(root, 'scripts/publication-fixtures.json'), JSON.stringify([{path, category: 'credential-pattern',
    sha256: createHash('sha256').update(bytes).digest('hex')} ]));
  const result = checkPublication(root);
  assert.ok(result.errors.some(error => error.path === path && error.category === 'credential-pattern'));
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('dangling source links fail without following their private targets', context => {
  const root = fixture(context);
  symlinkSync(join(root, 'missing-private-target'), join(root, 'linked-source'));
  const result = checkPublication(root);
  assert.ok(result.errors.some(error => error.path === 'linked-source' && error.category === 'nonregular-source'));
});

test('tracked source under a replaced symlink directory is refused without reading outside bytes', context => {
  const root = fixture(context);
  const outside = fixture(context);
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'example.txt'), 'Original synthetic source.');
  execFileSync('git', ['add', 'nested/example.txt'], { cwd: root });
  const privateText = 'ghp_' + 'b'.repeat(40);
  writeFileSync(join(outside, 'example.txt'), privateText);
  rmSync(join(root, 'nested'), { recursive: true });
  symlinkSync(outside, join(root, 'nested'), 'dir');
  const result = checkPublication(root);
  assert.ok(result.errors.some(error => error.path === 'nested/example.txt' && error.category === 'nonregular-source'));
  assert.equal(result.errors.some(error => error.category === 'credential-pattern'), false);
  assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.throws(() => releaseSourceDigest(root, ['nested/example.txt']), /NONREGULAR_RELEASE_SOURCE/);
});

test('missing indexed source is refused rather than silently counted as scanned', context => {
  const root = fixture(context);
  const path = 'indexed-source.ts';
  writeFileSync(join(root, path), 'export const synthetic = true;\n');
  execFileSync('git', ['add', path], { cwd: root });
  rmSync(join(root, path));
  const result = checkPublication(root);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(error => error.path === path && error.category === 'missing-source'));
});
