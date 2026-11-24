import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnvironment } from './run-source-tests.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const smokeTests = ['notebook-wrap.browser.mjs', 'workspace-polish.browser.mjs'];

/** Deliberately a small smoke selection, never reported as the full browser suite.
 * Uses isolated synthetic fixtures and does not inherit deployment credentials. */
export async function verifyUiSmoke(directory) {
  await mkdir(directory, { mode: 0o700 });
  const result = { version: 1, target: 'browser-smoke', passed: false, startedAt: new Date().toISOString(), tests: [] };
  let temporary;
  try {
    const playwright = join(repository, 'apps/server/node_modules/playwright-core/index.mjs');
    const { chromium } = await import(pathToFileURL(playwright).href);
    // Chrome creates Unix-domain sockets beneath the profile directory. The
    // host's deeply nested TMPDIR can exceed their path limit after isolation.
    temporary = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cp-ui-'));
    const environment = isolatedEnvironment(temporary);
    await mkdir(environment.HOME); await mkdir(environment.TMPDIR);
    environment.AOD_TEST_PLAYWRIGHT = playwright;
    environment.AOD_TEST_CHROMIUM = process.env.AOD_TEST_CHROMIUM || chromium.executablePath();
    for (const file of smokeTests) {
      const child = spawnSync(process.execPath, ['--import', join(repository, 'apps/server/node_modules/tsx/dist/loader.mjs'),
        join(repository, 'apps/web/tests', file)], { cwd: repository, env: environment, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
      const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
      const log = `${file}.log`;
      await writeFile(join(directory, log), output, { flag: 'wx', mode: 0o600 });
      const source = await readFile(join(repository, 'apps/web/tests', file));
      result.tests.push({ file, log, sourceSha256: createHash('sha256').update(source).digest('hex'),
        logSha256: createHash('sha256').update(output).digest('hex'), passed: !child.error && child.status === 0 && child.signal === null });
      assert.ok(result.tests.at(-1).passed, `${file} failed (${child.error?.code ?? child.signal ?? child.status}); inspect ${join(directory, log)}`);
      console.log(`SMOKE (not full-suite): ${file} passed`);
    }
    result.passed = true;
    result.completedAt = new Date().toISOString();
  } catch (error) {
    result.failure = error.message;
    throw error;
  } finally {
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-ui-smoke.mjs EXCLUSIVE_EVIDENCE_DIRECTORY');
  await verifyUiSmoke(resolve(process.argv[2]));
}
