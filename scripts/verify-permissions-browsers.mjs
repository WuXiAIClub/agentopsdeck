import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { permissionsBrowserRuntime, permissionsBrowserWorkingDirectory, selectPermissionsBrowsers } from './permissions-browser-runtime.mjs';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';
import { validateHubCodexBrowserReceipt } from './lib/permissions-browser-receipts.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [directory, playwright, chromium, ...requested] = process.argv.slice(2);
for (const path of [directory, playwright, chromium]) assert.ok(path && isAbsolute(path), 'Absolute evidence/module/executable paths required');
await access(playwright); await access(chromium);
const fixtures = selectPermissionsBrowsers(requested);
const needsCandidate = fixtures.some(fixture => ['hub-codex', 'workspace-research'].includes(fixture));
assert.ok(!needsCandidate || process.env.AOD_TEST_CANDIDATE_ROOT,
  'Release-backed fixtures require an explicitly supplied sealed candidate');
// Exclusive new output directory: never overwrite original failed evidence.
await mkdir(directory, { mode: 0o700 });
const temp = join(directory, 'tmp'); await mkdir(temp); await mkdir(join(temp, 'home'));
const runtime = permissionsBrowserRuntime({ repository, temp, playwright, chromium });
const result = { version: 1, passed: false, productionTouched: false, sourceCandidate: false,
  startedAt: new Date().toISOString(), fixtures, stages: [] };
const candidateRoot = process.env.AOD_TEST_CANDIDATE_ROOT;
async function save() {
  const path = join(directory, 'result.json');
  await writeFile(path + '.tmp', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  await rename(path + '.tmp', path);
}
function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
try {
  if (needsCandidate) result.compiledCandidate = { root: candidateRoot, ...await verifyCandidateRelease(candidateRoot) };
  await save();
  for (const fixture of fixtures) {
    const stage = { fixture, passed: false, startedAt: new Date().toISOString(), log: join(directory, fixture + '.log') };
    result.stages.push(stage); await save(); console.log('START ' + fixture);
    const output = createWriteStream(stage.log, { flags: 'wx', mode: 0o600 });
    const child = spawn(process.execPath, [...runtime.prefix, join(repository, `apps/web/tests/${fixture}.browser.mjs`)], {
      cwd: permissionsBrowserWorkingDirectory({ fixture, repository, candidate: candidateRoot }), env: { ...runtime.env, ...(fixture === 'hub-codex'
        ? { AOD_TEST_CANDIDATE_ROOT: process.env.AOD_TEST_CANDIDATE_ROOT } : {}) },
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { stage.timedOut = true; killGroup(child.pid); }, 600_000);
    child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
    try {
      Object.assign(stage, await new Promise((accept, reject) => {
        output.once('error', reject); child.once('error', reject);
        child.once('close', (code, signal) => output.end(() => accept({ code, signal })));
      }));
    } finally { clearTimeout(timer); if (child.pid) killGroup(child.pid); }
    const text = await readFile(stage.log, 'utf8');
    stage.sha256 = createHash('sha256').update(text).digest('hex');
    stage.completedAt = new Date().toISOString();
    stage.passed = stage.code === 0 && stage.signal === null && !stage.timedOut;
    if (fixture === 'hub-codex' && stage.passed) {
      try {
        const paths = text.split('\n').filter(line => line.startsWith('EVIDENCE ')).map(line => line.slice(9));
        assert.equal(paths.length, 1, 'Exactly one inner Hub browser receipt');
        const inner = resolve(paths[0]);
        assert.equal(dirname(inner), temp, 'Receipt must belong to this isolated invocation');
        assert.ok(inner.startsWith(join(temp, 'agentopsdeck-codex-multinode-browser-')));
        const receipt = join(inner, 'result.json'), bytes = await readFile(receipt);
        const verified = await verifyCandidateRelease(candidateRoot);
        assert.deepEqual({ root: candidateRoot, ...verified }, result.compiledCandidate);
        validateHubCodexBrowserReceipt(JSON.parse(bytes), candidateRoot, verified);
        stage.receipt = { path: receipt, sha256: createHash('sha256').update(bytes).digest('hex') };
      } catch (error) { stage.passed = false; stage.failure = error.message; }
    }
    await save(); console.log((stage.passed ? 'PASS ' : 'FAIL ') + fixture);
    assert.ok(!stage.timedOut && stage.signal === null, 'Infrastructure failure: stop before next fixture');
  }
  result.passed = result.stages.length === fixtures.length && result.stages.every(stage => stage.passed);
} catch (error) { result.failure = error.message; }
finally { result.completedAt = new Date().toISOString(); await save(); }
if (!result.passed) process.exitCode = 1;
