import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stageCandidateRelease, verifyCandidateRelease } from './stage-candidate-release.mjs';

const helper = new URL('./ci-install.mjs', import.meta.url);
async function load() {
  assert.ok(existsSync(helper), 'portable artifact installation helper missing');
  return import(helper);
}
test('required Linux installation gate follows all original gates without rebuilding', async () => {
  const config = JSON.parse(await readFile(new URL('./fixtures/gitlab-ci.json', import.meta.url)));
  assert.ok(config['install-lifecycle'], 'required installation job missing');
  assert.equal(config['install-lifecycle'].stage, 'install');
  assert.deepEqual(config['install-lifecycle'].dependencies, ['validation']);
  assert.deepEqual(config['install-lifecycle'].script, ['node scripts/ci-install.mjs']);
  assert.equal(config['install-lifecycle'].allow_failure, undefined);
  assert.deepEqual(config.stages, ['source', 'prepare', 'tests', 'validation', 'browser', 'install']);
  assert.equal(config['source-prepare'].stage, 'prepare');
  assert.equal(config['server-source-tests'].stage, 'tests');
  assert.equal(config['windows-exe'].stage, 'validation');
  assert.equal(config['windows-exe'].artifacts, undefined);
});
test('archive installs exact packager output after source removal and rejects corruption', async t => {
  const { archiveCandidate, installArchive } = await load();
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agentopsdeck-install-unit-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source'), candidate = join(directory, 'candidate'), artifacts = join(directory, 'artifacts');
  for (const part of ['apps/server/dist', 'apps/web/dist', 'packages/shared/dist', 'node_modules']) await mkdir(join(source, part), { recursive: true });
  for (const [file, bytes] of Object.entries({
    'apps/server/package.json': '{"name":"@agentopsdeck/server","version":"1","type":"module"}',
    'packages/shared/package.json': '{"name":"@agentopsdeck/shared","version":"1"}',
    'apps/server/dist/index.js': 'console.log("unit fixture, not runtime acceptance")',
    'apps/server/dist/application.js': 'export const fixture = true;',
    'apps/web/dist/index.html': '<title>fixture</title>',
  })) await writeFile(join(source, file), bytes);
  await stageCandidateRelease({ root: source, destination: candidate });
  const expected = await verifyCandidateRelease(candidate);
  const commit = 'a'.repeat(40);
  await archiveCandidate(candidate, artifacts, commit);
  await rename(source, join(directory, 'source-hidden'));
  await rm(candidate, { recursive: true });
  const installed = await installArchive(artifacts, join(directory, 'installed'), commit);
  assert.deepEqual(await verifyCandidateRelease(installed), expected);
  await assert.rejects(installArchive(artifacts, join(directory, 'wrong-commit'), 'b'.repeat(40)), /commit/);
  await writeFile(join(artifacts, 'candidate.tar'), 'corrupt');
  await assert.rejects(installArchive(artifacts, join(directory, 'broken'), commit), /Archive digest/);
  assert.equal(existsSync(join(directory, 'broken')), false);
});

test('installed entry guard permits ephemeral loopback but rejects egress and native spawning', () => {
  const guard = new URL('./ci-install-guard.mjs', import.meta.url);
  assert.ok(existsSync(guard), 'installation runtime safety guard missing');
  const run = code => spawnSync(process.execPath, ['--import', fileURLToPath(guard), '--input-type=module', '-e', code],
    { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
  const ok = run("import net from 'node:net'; const s = net.createServer(); s.listen(0, '127.0.0.1', () => s.close());");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /AOD_TEST_LISTENER/);
  for (const code of [
    "import net from 'node:net'; net.connect(443, '192.0.2.1');",
    "import tls from 'node:tls'; tls.connect(443, '192.0.2.1');",
    "import {spawn} from 'node:child_process'; spawn('node', ['-v']);",
    "import net from 'node:net'; net.createServer().listen(8790, '127.0.0.1');",
    "import net from 'node:net'; net.createServer().listen(0, '0.0.0.0');",
  ]) {
    const result = run(code);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /INSTALL_BOUNDARY/);
  }
});
