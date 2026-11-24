import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverTests, isolatedEnvironment } from './run-source-tests.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function runNode(args, cwd, timeout) {
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-ci-child-'));
  const env = isolatedEnvironment(directory);
  try {
    await mkdir(env.HOME);
    await mkdir(env.TMPDIR);
    const result = spawnSync(process.execPath, args, { cwd, env, timeout, stdio: 'inherit' });
    if (result.error || result.signal || result.status !== 0) {
      throw new Error(`Validation command failed: exit=${result.status}, signal=${result.signal}`, { cause: result.error });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function runValidation(target, root = repository, artifactDirectory) {
  if (target === 'package') {
    const { stageCandidateRelease, verifyCandidateRelease } = await import('./stage-candidate-release.mjs');
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'agentopsdeck-ci-package-')));
    const destination = join(directory, 'candidate');
    try {
      const staged = await stageCandidateRelease({ root, destination });
      const verified = await verifyCandidateRelease(destination);
      if (verified.manifestSha256 !== staged.manifestSha256) throw new Error('Package manifest changed');
      await runNode([join(repository, 'scripts/verify-candidate-history-admission.mjs'), destination], destination, 120_000);
      // Import the shipped module graph without invoking the server entrypoint,
      // binding a port, creating a runtime, or contacting a provider.
      await runNode(['--input-type=module', '-e',
        "const app = await import('./apps/server/dist/application.js'); if (typeof app.createApplication !== 'function') throw new Error('Missing packaged application');"], destination, 120_000);
      if ((await verifyCandidateRelease(destination)).manifestSha256 !== staged.manifestSha256) throw new Error('Package changed during validation');
      console.log(JSON.stringify({ packageIntegrity: true, applicationImports: true, nativeExecutionTested: false }));
      if (artifactDirectory) {
        const { archiveCandidate } = await import('./ci-install.mjs');
        console.log('INSTALL_ARTIFACT ' + JSON.stringify(await archiveCandidate(destination, artifactDirectory, process.env.CI_COMMIT_SHA)));
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
    return;
  }
  if (!['scripts', 'poc'].includes(target)) throw new Error('Unknown validation target');
  const tsx = pathToFileURL(createRequire(join(root, 'apps/server/package.json')).resolve('tsx')).href;
  if (target === 'scripts') {
    const files = await discoverScriptTests(join(root, 'scripts'));
    console.log(`scripts: ${JSON.stringify(files)}`);
    await runNode(['--import', tsx, '--test', '--test-concurrency=1', ...files.map(file => join(root, 'scripts', file))], root, 120_000);
  } else {
    const workspace = join(root, 'apps/server');
    const files = await discoverTests(join(workspace, 'poc'));
    console.log(`poc: ${JSON.stringify(files)}`);
    await runNode([join(root, 'node_modules/typescript/bin/tsc'), '-p', 'poc/communication/tsconfig.json'], workspace, 120_000);
    await runNode(['--import', tsx, '--test', '--test-concurrency=1', ...files.map(file => join(workspace, 'poc', file))], workspace, 120_000);
  }
}

export async function discoverScriptTests(directory) {
  const files = [];
  const visit = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Script discovery refuses symbolic links: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(relative(directory, path));
    }
  };
  await visit(directory);
  if (!files.length) throw new Error('No script tests found');
  return files.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 4 || (process.argv[3] && process.argv[2] !== 'package')) throw new Error('Invalid validation arguments');
    await runValidation(process.argv[2], repository, process.argv[3] ? resolve(process.argv[3]) : undefined);
  }
  catch (error) { console.error(error); process.exitCode = 1; }
}
