import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNoAdjacentJavaScript } from './source-shadow-guard.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function discoverTests(directory, compiled = false) {
  const matches = [];
  const visit = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Test discovery refuses symbolic links: ${relative(directory, path)}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && (compiled ? /\.test\.js$/ : /\.test\.tsx?$/).test(entry.name)) matches.push(relative(directory, path));
    }
  };
  await visit(directory);
  if (!matches.length) throw new Error('No source-matched tests found');
  return matches.sort();
}

export function assertCompiledCoverage(sources, compiled) {
  const expected = sources.map(source => source.replace(/\.tsx?$/, '.js')).sort();
  const actual = [...compiled].sort();
  if (new Set(expected).size !== expected.length || expected.length !== actual.length
    || expected.some((source, index) => source !== actual[index])) {
    throw new Error('Compiled tests do not match the complete source test manifest');
  }
}

export function isolatedEnvironment(directory, environment = process.env) {
  return { PATH: environment.PATH ?? '/usr/bin:/bin', HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'),
    TMP: join(directory, 'tmp'), TEMP: join(directory, 'tmp'), LANG: 'C.UTF-8',
    ...(environment.SystemRoot ? { SystemRoot: environment.SystemRoot } : {}) };
}

/** Exact source-relative paths only: typos must fail, never run zero tests. */
export function selectTests(sources, requested = []) {
  if (!Array.isArray(requested) || requested.some(path => typeof path !== 'string' || !sources.includes(path))) {
    throw new Error('Test selection must contain exact discovered source-relative paths');
  }
  return requested.length ? [...new Set(requested)].sort() : sources;
}

export function resolveTestConcurrency(target, environment = process.env) {
  const fallback = target === 'server' ? 4 : target === 'web' ? 2 : null;
  if (fallback === null) throw new Error('Unknown test target');
  const raw = environment?.AOD_TEST_CONCURRENCY;
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > fallback) {
    throw new Error(`Invalid AOD_TEST_CONCURRENCY=${raw}; expected integer 1..${fallback}`);
  }
  return parsed;
}

export function testArguments(target, files, environment = process.env) {
  const concurrency = resolveTestConcurrency(target, environment);
  if (target === 'server') return ['--import', 'tsx', '--test', '--test-reporter=tap', `--test-concurrency=${concurrency}`, ...files];
  if (target === 'web') return ['--test', '--test-reporter=tap', `--test-concurrency=${concurrency}`, ...files];
  throw new Error('Unknown test target');
}

export function assertTestCommandResult(result) {
  if (!result.error && !result.signal && result.status === 0) return;
  const error = new Error('Source test command failed', {
    cause: result.error ?? new Error(`exit=${result.status}, signal=${result.signal}`),
  });
  // spawnSync timeouts report an error here, but the wrapper itself otherwise
  // exits normally. Do not lose that distinction at the next process boundary.
  if (result.error || result.signal || !Number.isInteger(result.status) || result.status < 0) {
    error.code = 'SOURCE_TEST_INFRASTRUCTURE_FAILURE';
  }
  throw error;
}

export function sourceTestFailureExitCode(error) {
  return error?.code === 'SOURCE_TEST_INFRASTRUCTURE_FAILURE' ? 2 : 1;
}

export async function runSourceTests(target, requested = []) {
  if (!['server', 'web'].includes(target)) throw new Error('Usage: node scripts/run-source-tests.mjs server|web');
  const workspace = join(repository, 'apps', target);
  const sourceRoot = join(workspace, 'src');
  await assertNoAdjacentJavaScript(sourceRoot);
  await assertNoAdjacentJavaScript(join(repository, 'packages/shared/src'));
  const sources = await discoverTests(sourceRoot);
  const selected = selectTests(sources, requested);
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-source-tests-'));
  const environment = isolatedEnvironment(directory);
  let output;
  const run = (arguments_, timeout) => {
    const result = spawnSync(process.execPath, arguments_, { cwd: workspace, env: environment, stdio: 'inherit', timeout });
    assertTestCommandResult(result);
  };
  try {
    await mkdir(environment.HOME);
    await mkdir(environment.TMPDIR);
    console.log(`${target}: discovered ${sources.length} source test files`);
    console.log(`${target}: ${requested.length ? 'TARGETED (not full-suite)' : 'FULL'} verification, ${selected.length} selected files`);
    if (target === 'server') {
      run(testArguments(target, selected.map(source => join(sourceRoot, source))), 900_000);
    } else {
      const parent = join(workspace, '.tmp-test');
      await mkdir(parent, { recursive: true });
      output = await mkdtemp(join(parent, 'candidate-'));
      run([join(repository, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.test.json', '--outDir', output], 120_000);
      const compiled = await discoverTests(output, true);
      assertCompiledCoverage(sources, compiled);
      console.log(`web: fresh compiled test manifest matches all ${sources.length} source files`);
      run(testArguments(target, selected.map(test => join(output, test.replace(/\.tsx?$/, '.js')))), 120_000);
    }
  } finally {
    if (output) await rm(output, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runSourceTests(process.argv[2], process.argv.slice(3)); }
  catch (error) { console.error(error); process.exitCode = sourceTestFailureExitCode(error); }
}
