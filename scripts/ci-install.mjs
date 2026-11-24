// Real packager -> transported tar -> disposable portable install. Never builds,
// publishes, installs native agents or touches a host service manager.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';
import { isolatedEnvironment } from './run-source-tests.mjs';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function tar(args) {
  const result = spawnSync('tar', args, { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 120_000, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `tar failed: ${result.stderr}`);
}
export async function archiveCandidate(candidate, output, commit) {
  assert.match(commit, /^[a-f0-9]{40}$/, 'Exact source commit required');
  const verified = await verifyCandidateRelease(candidate);
  await mkdir(output); // never replace an existing handoff
  const archive = join(output, 'candidate.tar');
  tar(['-cf', archive, '-C', candidate, '.']);
  assert.deepEqual(await verifyCandidateRelease(candidate), verified);
  const identity = { format: 1, commit, platform: process.platform, arch: process.arch,
    node: process.version, archiveSha256: digest(await readFile(archive)), ...verified };
  await writeFile(join(output, 'identity.json'), JSON.stringify(identity, null, 2) + '\n', { flag: 'wx' });
  return identity;
}
export async function installArchive(input, destination, commit) {
  const identity = JSON.parse(await readFile(join(input, 'identity.json'), 'utf8'));
  assert.equal(identity.format, 1);
  assert.equal(identity.commit, commit, 'Artifact source commit mismatch');
  assert.equal(identity.platform, process.platform);
  assert.equal(identity.arch, process.arch);
  assert.equal(identity.node, process.version, 'Use identical pinned Node runtime');
  const archive = join(input, 'candidate.tar');
  assert.equal(digest(await readFile(archive)), identity.archiveSha256, 'Archive digest mismatch');
  // Only an archive generated from the link-free verified packager output is
  // admitted. CI artifacts are trusted source outputs, not arbitrary uploads.
  await mkdir(destination);
  try {
    tar(['-xf', archive, '--no-same-owner', '--no-same-permissions', '-C', destination]);
    const result = await verifyCandidateRelease(destination);
    for (const key of ['manifestSha256', 'files', 'entrypoint']) assert.equal(result[key], identity[key]);
    return destination;
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}
async function main() {
  assert.equal(process.platform, 'linux', 'Lifecycle integration runs only inside native Linux CI');
  assert.equal(process.env.CI, 'true');
  assert.match(process.env.CI_COMMIT_SHA ?? '', /^[a-f0-9]{40}$/);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agentopsdeck-install-')));
  const hidden = join(repository, '.ci-hidden-apps');
  let moved = false;
  const report = { lane: 'linux-portable-install', passed: false, cleanup: false,
    crossVersionUpgrade: 'unverified-no-approved-prior-artifact', systemService: 'unverified', checks: [] };
  try {
    const candidate = await installArchive(join(repository, '.ci-artifacts'), join(directory, 'release'), process.env.CI_COMMIT_SHA);
    report.artifact = JSON.parse(await readFile(join(repository, '.ci-artifacts/identity.json')));
    report.checks.push('exact-archive-digest-and-commit', 'installed-manifest');
    // No workspace dependencies are installed in this job. Hide the conventional
    // source/build paths too; do not pretend this hides the entire checkout.
    await rename(join(repository, 'apps'), hidden); moved = true;
    const env = isolatedEnvironment(directory, { PATH: '/usr/local/bin:/usr/bin:/bin' });
    await mkdir(env.HOME); await mkdir(env.TMPDIR);
    const run = spawnSync(process.execPath, [join(repository, 'scripts/verify-candidate-startup.mjs'), candidate], {
      cwd: directory, env, detached: true, stdio: 'inherit', timeout: 120_000, killSignal: 'SIGKILL',
    });
    // The whole owned group is reaped on timeout/error, not just the harness.
    if (run.pid) {
      try { process.kill(-run.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    assert.equal(run.error, undefined, 'Installed acceptance must finish within its budget');
    assert.equal(run.signal, null);
    assert.equal(run.status, 0, 'Installed acceptance failed');
    report.checks.push('installed-entrypoint-three-roles-restarts-negative-control');
    assert.equal((await verifyCandidateRelease(candidate)).manifestSha256, report.artifact.manifestSha256);
    report.passed = true;
  } finally {
    if (moved) await rename(hidden, join(repository, 'apps'));
    await rm(directory, { recursive: true, force: true });
    await assert.rejects(access(directory));
    report.cleanup = true;
    console.log('INSTALL_LIFECYCLE ' + JSON.stringify(report));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
