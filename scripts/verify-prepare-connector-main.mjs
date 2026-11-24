// Opt-in real Git/helper/install/build acceptance. All new files stay in a
// private fixture; no existing checkout, release pointer or service is changed.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prepareConnectorMain } from './prepare-connector-main.mjs';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';

const [repository, git, node, pnpm] = process.argv.slice(2);
assert.equal(process.argv.length, 6, 'Usage: node verify-prepare-connector-main.mjs https-repository absolute-git absolute-node absolute-pnpm');
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-main-preparation-'));
const evidence = { directory, passed: false, realRemoteMainBuild: true, servicesTouched: false };
try {
  const buildsDirectory = join(directory, 'builds'), releasesDirectory = join(directory, 'releases');
  await mkdir(buildsDirectory, { mode: 0o700 });
  await mkdir(releasesDirectory, { mode: 0o700 });
  const configuration = join(directory, 'builder.json'), output = join(directory, 'candidate.json');
  await writeFile(configuration, JSON.stringify({ format: 1, repository, git, node, pnpm, buildsDirectory, releasesDirectory }),
    { flag: 'wx', mode: 0o600 });
  await prepareConnectorMain(configuration, output);
  const descriptor = JSON.parse(await readFile(output, 'utf8'));
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const verified = await verifyCandidateRelease(descriptor.directory);
  assert.equal(verified.manifestSha256, descriptor.manifestSha256);
  const { stdout } = await promisify(execFile)(git, ['ls-remote', '--exit-code', repository, 'refs/heads/main'],
    { cwd: directory, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  // If main advances during the build, keep the pinned commit explicit rather
  // than falsely certifying the candidate as the now-current head.
  const currentMain = stdout.trim().split(/\s+/)[0];
  evidence.revision = descriptor.revision;
  evidence.mainAtFinish = currentMain;
  evidence.mainUnchangedDuringBuild = currentMain === descriptor.revision;
  evidence.manifestSha256 = descriptor.manifestSha256;
  evidence.passed = true;
} catch {
  evidence.error = 'Real main preparation failed; inspect isolated fixture without exposing credentials';
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(evidence));
}
