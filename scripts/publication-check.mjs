import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { reviewInventory, validateReview } from './open-source-review.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const initialIdentity = { name: 'WuXiAIClub', email: 'hi@wuxiaiclub.com' };
export const releaseApprovalPath = 'docs/review/release-approval.json';

function regularSourceFile(root, path) {
  if (typeof path !== 'string' || path.includes('\\') || path.startsWith('/')) return false;
  const parts = path.split('/');
  if (!parts.every(part => part && part !== '.' && part !== '..')) return false;
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const metadata = lstatSync(current);
    if (index === parts.length - 1 ? !metadata.isFile() : !metadata.isDirectory()) return false;
  }
  return true;
}

export function findingResolved(finding) {
  const evidence = finding?.status === 'fixed-targeted-verified' ? finding.remediation : finding?.resolution;
  return ['fixed-targeted-verified', 'reviewed-no-finding', 'verification-complete'].includes(finding?.status)
    && typeof evidence?.summary === 'string' && evidence.summary.trim().length > 0
    && Array.isArray(evidence.testEvidence) && evidence.testEvidence.length > 0
    && evidence.testEvidence.every(item => typeof item === 'string' ? item.trim().length > 0
      : item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length > 0)
    && Array.isArray(evidence.limits) && evidence.limits.length > 0 && evidence.liveAcceptance === false;
}

export function releaseSourceDigest(root, files) {
  const inputs = [...files].filter(path => path !== releaseApprovalPath && path !== 'docs/review/file-review.json')
    .sort().map(path => {
      if (!regularSourceFile(root, path)) throw new Error('NONREGULAR_RELEASE_SOURCE');
      return [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')];
    });
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

export function checkReleaseApproval(root, files, version) {
  const errors = [];
  try {
    if (!files.includes(releaseApprovalPath) || !regularSourceFile(root, releaseApprovalPath)) throw new Error('MISSING_APPROVAL');
    const approval = JSON.parse(readFileSync(join(root, releaseApprovalPath), 'utf8'));
    if (approval.schemaVersion !== 1 || approval.sourceVersion !== version
      || approval.sourceSha256 !== releaseSourceDigest(root, files)) {
      errors.push({ category: 'release-approval-source-mismatch' });
    }
    for (const gate of ['inheritedRights', 'artifactAttribution', 'acceptance', 'releaseAuthorization']) {
      const decision = approval.gates?.[gate];
      const evidenceValid = Array.isArray(decision?.evidence) && decision.evidence.length > 0
        && decision.evidence.every(item => {
          const path = item?.path;
          return typeof path === 'string' && path !== releaseApprovalPath && files.includes(path)
            && !unsafePathCategory(path) && path.split('/').every(part => part && part !== '.' && part !== '..')
            && regularSourceFile(root, path)
            && item.sha256 === createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
        });
      if (decision?.status !== 'approved' || typeof decision.approvedBy !== 'string' || !decision.approvedBy.trim()
        || typeof decision.approvedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(decision.approvedAt)
        || !Number.isFinite(Date.parse(decision.approvedAt)) || Date.parse(decision.approvedAt) > Date.now()
        || new Date(decision.approvedAt).toISOString() !== decision.approvedAt || !evidenceValid) {
        errors.push({ category: 'release-approval-required', gate });
      }
    }
  } catch {
    errors.push({ category: 'release-approval-unavailable' });
  }
  try {
    const path = 'docs/review/file-review.json';
    if (!files.includes(path) || !regularSourceFile(root, path)) throw new Error('MISSING_REVIEW');
    if (files.some(source => !regularSourceFile(root, source))) throw new Error('UNSAFE_REVIEW_SOURCE');
    const review = JSON.parse(readFileSync(join(root, path), 'utf8'));
    const result = validateReview(review.files, reviewInventory(root));
    if (!result.passed || !result.complete) errors.push({ category: 'complete-source-review-required' });
  } catch {
    errors.push({ category: 'complete-source-review-required' });
  }
  try {
    const path = 'docs/review/findings.json';
    if (!files.includes(path) || !regularSourceFile(root, path)) throw new Error('MISSING_FINDINGS');
    const findings = JSON.parse(readFileSync(join(root, path), 'utf8'));
    if (findings.sourceVersion !== version || !Array.isArray(findings.findings)
      || findings.findings.some(finding => !findingResolved(finding))) {
      errors.push({ category: 'unresolved-release-findings' });
    }
  } catch {
    errors.push({ category: 'unresolved-release-findings' });
  }
  return errors;
}

export function unsafeTextCategory(text) {
  if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(text)
    || /\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{15,}|sk-[A-Za-z0-9_-]{32,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{20,})\b/.test(text)
    || /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/.test(text)
    || /(?:api[_-]?key|access[_-]?key|client[_-]?secret|owner[_-]?token|(?:bearer|refresh|auth|provider)[_-]?token|password)\s*["']?\s*[:=]\s*["'][A-Za-z0-9+/=_-]{32,}["']/i.test(text)
    || /(?:api[_-]?key|access[_-]?key|client[_-]?secret|owner[_-]?token|password)\s*=\s*[A-Za-z0-9+/=_-]{32,}(?=\s|$)/i.test(text)) return 'credential-pattern';
  if (new RegExp(['claw', 'pool'].join(''), 'i').test(text)
    || new RegExp(['claw', 'connector'].join(''), 'i').test(text)
    || new RegExp([
      `\\b${['cp', 'conn', ''].join('_')}`,
      `\\b${['cp', 'local', ''].join('_')}`,
      `\\b${['cp', 'board', ''].join('_')}`,
      `\\b${['cp', 'note', ''].join('_')}`,
    ].join('|'), 'i').test(text)) return 'legacy-brand';
  const home = homedir();
  if (home !== '/' && home !== '/root' && text.includes(home + '/')) return 'private-origin';
  if (/https?:\/\/[^\s/]*(?:\.internal|\.lan)(?=[:/\s]|$)/i.test(text)) return 'private-origin';
  if (/https?:\/\/[^\s/]*:[^\s/@]+@/i.test(text)) return 'credential-url';
  return undefined;
}

export function unsafePathCategory(path) {
  if (new RegExp(['claw', 'pool'].join(''), 'i').test(path)) return 'legacy-brand-path';
  if (/(?:^|\/)(?:node_modules|dist|private|local|\.local|state|data|backups|releases|evidence|vault|logs)(?:\/|$)/.test(path)
    || /(?:^|\/)(?:\.env(?:\..*)?|\.agentopsdeck[^/]*|id_rsa|id_ed25519)$/.test(path) && !path.endsWith('.env.example')
    || /\.(?:sqlite(?:-.*)?|db(?:-.*)?|pem|key|p12|pfx|log)$/i.test(path)) return 'private-runtime-file';
  return undefined;
}

export function checkIdentityHistory(history) {
  return history.split('\n').filter(Boolean).every(line => {
    const [author, email, committer, committerEmail] = line.split('\t');
    return author === initialIdentity.name && email === initialIdentity.email
      && committer === initialIdentity.name && committerEmail === initialIdentity.email;
  });
}

export function unsafeEnvironmentCategory(text, path) {
  if (/(?:\.test\.(?:ts|tsx|mjs)|Test\.java|Tests\.swift|\/test_[^/]+\.c)$/.test(path) || /(?:^|\/)fixtures\//.test(path)) return undefined;
  if (/\/(?:home|Users)\/[A-Za-z0-9_.-]+\//.test(text)
    || /[A-Z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+[\\/]/i.test(text)
    || /https?:\/\/(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?=[:/\s'"`]|$)/.test(text)) return 'fixed-environment';
  return undefined;
}

export function checkPublication(root = repository, release = false) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))];
  const errors = [];
  const fixtureFile = join(root, 'scripts/publication-fixtures.json');
  const fixtures = existsSync(fixtureFile) && regularSourceFile(root, 'scripts/publication-fixtures.json')
    ? JSON.parse(readFileSync(fixtureFile, 'utf8')) : [];
  if (!files.length) errors.push({ category: 'empty-source' });
  for (const path of files) {
    const badPath = unsafePathCategory(path);
    if (badPath) { errors.push({ path, category: badPath }); continue; }
    const absolute = join(root, path);
    let regular;
    try { regular = regularSourceFile(root, path); }
    catch (error) {
      if (error.code === 'ENOENT') { errors.push({ path, category: 'missing-source' }); continue; }
      throw error;
    }
    if (!regular) { errors.push({ path, category: 'nonregular-source' }); continue; }
    const bytes = readFileSync(absolute);
    const text = bytes.toString('utf8');
    const category = unsafeTextCategory(text) ?? unsafeEnvironmentCategory(text, path);
    const reviewedFixture = category === 'credential-url' && fixtures.some(fixture => fixture.path === path
      && fixture.category === category && fixture.sha256 === createHash('sha256').update(bytes).digest('hex')
      && /(?:\.test\.(?:ts|tsx|mjs)|Test\.java|Tests\.swift)$/.test(path));
    if (category && !reviewedFixture) errors.push({ path, category });
  }
  const manifestPaths = ['package.json', 'apps/server/package.json', 'apps/web/package.json', 'packages/shared/package.json'];
  const protocolPath = 'packages/shared/src/protocol.ts';
  let version;
  if ([...manifestPaths, protocolPath].every(path => regularSourceFile(root, path))) {
    const versions = manifestPaths.map(path => JSON.parse(readFileSync(join(root, path), 'utf8')).version);
    const protocol = readFileSync(join(root, protocolPath), 'utf8');
    version = /AGENTOPSDECK_VERSION\s*=\s*'([^']+)'/.exec(protocol)?.[1];
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? '') || versions.some(value => value !== version)) {
      errors.push({ category: 'product-version-mismatch' });
    }
  } else {
    errors.push({ category: 'product-version-mismatch' });
  }
  let committed = false;
  try {
    git(['rev-parse', '--verify', 'HEAD']);
    committed = true;
    if (!checkIdentityHistory(git(['log', 'HEAD', '--format=%an%x09%ae%x09%cn%x09%ce']))) errors.push({ category: 'unexpected-release-identity' });
  } catch { }
  if (release) {
    errors.push(...checkReleaseApproval(root, files, version));
    if (!committed) errors.push({ category: 'initial-commit-required' });
    if (git(['status', '--porcelain']).trim()) errors.push({ category: 'uncommitted-source' });
    if (!files.includes('LICENSE') || !regularSourceFile(root, 'LICENSE') || readFileSync(join(root, 'LICENSE'), 'utf8').trim().length < 100) {
      errors.push({ category: 'approved-license-required' });
    }
    if (committed && git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags']).split('\n').filter(Boolean)
      .some(ref => ref !== 'refs/heads/main' && !/^refs\/tags\/(?:v)?1\.0\.0(?:-[\w.-]+)?$/.test(ref))) {
      errors.push({ category: 'unexpected-publication-ref' });
    }
  }
  return { passed: errors.length === 0, release, filesChecked: files.length, version, committed, licensePresent: files.includes('LICENSE'), errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(argument => argument !== '--release')) throw new Error('INVALID_ARGUMENT');
    const result = checkPublication(repository, process.argv.includes('--release'));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
  } catch {
    console.error(JSON.stringify({ passed: false, category: 'publication-check-unavailable' }));
    process.exitCode = 1;
  }
}
