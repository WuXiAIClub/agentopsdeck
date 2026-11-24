import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnvironment } from './run-source-tests.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Include nested tooling tests, not only the shell's top-level wildcard.
 * Refuse linked trees and empty manifests instead of silently losing coverage. */
export async function discoverScriptTests(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Script discovery refuses symbolic links');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(relative(root, path));
    }
  }
  await visit(root);
  assert.ok(files.length, 'No script tests found');
  return files.sort();
}

export function selectScriptTests(files, requested = []) {
  assert.ok(Array.isArray(requested) && requested.every(file => typeof file === 'string' && files.includes(file)),
    'Select exact discovered script-relative paths');
  return requested.length ? [...new Set(requested)].sort() : files;
}

export function scriptTestArguments(loader, files) {
  assert.ok(isAbsolute(loader), 'Use an absolute workspace loader');
  assert.ok(files.length && new Set(files).size === files.length && files.every(file => isAbsolute(file)),
    'Use a nonempty, unique absolute test manifest');
  // A URL handles Windows drive letters, spaces and URL-significant characters.
  return ['--import', pathToFileURL(loader).href, '--test', '--test-reporter=tap', '--test-concurrency=1', ...files];
}

export async function runScriptTests(requested = []) {
  const root = join(repository, 'scripts');
  const manifest = await discoverScriptTests(root);
  const files = selectScriptTests(manifest, requested);
  // pnpm installs tsx in the server workspace, not necessarily at repo root.
  // Resolve the installed dependency; never rely on NODE_OPTIONS or a global CLI.
  const require = createRequire(join(repository, 'apps/server/package.json'));
  const loader = require.resolve('tsx');
  const args = scriptTestArguments(loader, files.map(file => join(root, file)));
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-script-tests-'));
  const env = isolatedEnvironment(directory);
  try {
    await mkdir(env.HOME); await mkdir(env.TMPDIR);
    console.log(`scripts: ${requested.length ? 'TARGETED (not full-suite)' : 'FULL'} verification, ${files.length}/${manifest.length} files`);
    await new Promise((done, reject) => {
      const child = spawn(process.execPath, args, { cwd: repository, env, stdio: 'inherit', timeout: 300_000 });
      let failure;
      child.once('error', error => { failure = error; });
      child.once('close', (code, signal) => {
        if (failure || signal || code !== 0) reject(new Error('Script test command failed', { cause: failure ?? new Error(`exit=${code}, signal=${signal}`) }));
        else done();
      });
    });
  } finally {
    // Only this invocation's disposable home, after its original child closes.
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runScriptTests(process.argv.slice(2)); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
