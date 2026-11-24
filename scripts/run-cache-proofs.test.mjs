import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');
const runnerScript = join(repoRoot, 'scripts', 'run-cache-proofs.sh');

test('run-cache-proofs.sh runs verify-cache and verify-hydration cleanly in isolated temp dir', async (t) => {
  const customTmp = await mkdtemp(join(tmpdir(), 'aod-cache-proof-test-'));
  t.after(async () => {
    await rm(customTmp, { recursive: true, force: true });
  });

  const { stdout } = await execFileAsync('bash', [runnerScript], {
    cwd: repoRoot,
    env: { ...process.env, TMPDIR: customTmp },
  });

  assert.match(stdout, /PASS: unauthenticated recoveryScope fail-closed/);
  assert.match(stdout, /PASS: per-session 200-message cap \+ newest-tail retained/);
  assert.match(stdout, /PASS: stale-while-revalidate timeline verified/);

  const leftoverTmp = await readdir(customTmp);
  assert.deepEqual(leftoverTmp, [], 'temp bundle directory must be removed after run');

  const scriptsEntries = await readdir(join(repoRoot, 'scripts'));
  assert.equal(
    scriptsEntries.some((entry) => entry.endsWith('.bundle.mjs')),
    false,
    'scripts/ directory must not accumulate shared .bundle.mjs artifacts',
  );
});

test('run-cache-proofs.sh cleans up isolated temp bundle even when proof exits non-zero', async (t) => {
  const customTmp = await mkdtemp(join(tmpdir(), 'aod-cache-proof-fail-'));
  const failingFixtureDir = await mkdtemp(join(tmpdir(), 'aod-cache-proof-src-'));
  t.after(async () => {
    await rm(customTmp, { recursive: true, force: true });
    await rm(failingFixtureDir, { recursive: true, force: true });
  });

  const failingProof = join(failingFixtureDir, 'verify-synthetic-failure.mts');
  await writeFile(failingProof, 'throw new Error("synthetic proof failure");\n', 'utf8');

  await assert.rejects(
    () =>
      execFileAsync('bash', [runnerScript, failingProof], {
        cwd: repoRoot,
        env: { ...process.env, TMPDIR: customTmp },
      }),
    /synthetic proof failure/,
  );

  const leftoverTmp = await readdir(customTmp);
  assert.deepEqual(leftoverTmp, [], 'trap EXIT must remove temp bundle directory on failure');
});
