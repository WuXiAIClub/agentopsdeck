import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { stageCandidateRelease, verifyCandidateRelease } from './stage-candidate-release.mjs';

const execute = promisify(execFile);
const fail = () => new Error('Pinned main candidate preparation failed; inspect private operator configuration');
const inside = (root, file) => file === root || file.startsWith(`${root}${sep}`);
const absolute = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value
  && value !== dirname(value) && !/[\x00-\x1f\x7f]/.test(value);

async function privateDirectory(directory) {
  if (!absolute(directory) || await realpath(directory) !== directory) throw fail();
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw fail();
}
async function privateJson(file) {
  if (!absolute(file)) throw fail();
  await privateDirectory(dirname(file));
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 16384) throw fail();
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

export function mainCandidateConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== 1
    || Object.keys(value).sort().join(',') !== 'buildsDirectory,format,git,node,pnpm,releasesDirectory,repository'
    || !['git', 'node', 'pnpm', 'buildsDirectory', 'releasesDirectory'].every(key => absolute(value[key]))) throw fail();
  const repository = new URL(value.repository);
  if (repository.protocol !== 'https:' || repository.username || repository.password || repository.search || repository.hash) throw fail();
  if (inside(value.buildsDirectory, value.releasesDirectory) || inside(value.releasesDirectory, value.buildsDirectory)) throw fail();
  return structuredClone(value);
}

const SAFE_BUILD_ENV_KEYS = Object.freeze([
  'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'PNPM_HOME', 'PNPM_STORE_DIR', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND',
  'GIT_SSL_CAINFO', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);

export function mainBuildEnvironment(config, inherited = process.env) {
  // Install build tools explicitly (--prod=false), but compile production
  // assets. NODE_ENV=development would embed React's development runtime.
  // Retain only explicit locale/cache/Git-helper variables; never expose
  // ambient operator/provider credentials, npm tokens, or NODE_OPTIONS.
  const filtered = {};
  for (const key of SAFE_BUILD_ENV_KEYS) {
    if (typeof inherited?.[key] === 'string' && inherited[key].length > 0) {
      filtered[key] = inherited[key];
    }
  }
  return { ...filtered, GIT_TERMINAL_PROMPT: '0', NODE_ENV: 'production',
    npm_config_production: 'false', NPM_CONFIG_PRODUCTION: 'false',
    PATH: `${dirname(config.node)}:${dirname(config.pnpm)}:/usr/bin:/bin` };
}

/** Fixed-main preparation only. Does not stop services, select a release,
 * alter a working checkout, read provider credentials, or apply migrations.
 * Failed staging/build directories are retained for operator inspection.
 */
export async function prepareConnectorMain(configFile, output) {
  const config = mainCandidateConfiguration(await privateJson(configFile));
  if (!absolute(output)) throw fail();
  await privateDirectory(dirname(output));
  await privateDirectory(config.buildsDirectory); await privateDirectory(config.releasesDirectory);
  if (inside(config.releasesDirectory, output) || inside(config.buildsDirectory, output)) throw fail();
  const build = await mkdtemp(join(config.buildsDirectory, 'main-'));
  const source = join(build, 'source');
  const environment = mainBuildEnvironment(config);
  const run = (binary, args, cwd = build) => execute(binary, args, {
    cwd, env: environment, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024,
  });
  try {
    await run(config.git, ['-c', 'core.hooksPath=/dev/null', 'clone', '--single-branch', '--branch', 'main', '--', config.repository, source]);
    const revision = (await run(config.git, ['rev-parse', '--verify', 'HEAD'], source)).stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)
      || (await run(config.git, ['rev-parse', '--verify', 'refs/remotes/origin/main'], source)).stdout.trim() !== revision) throw fail();
    await run(config.git, ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', revision], source);
    await run(config.pnpm, ['install', '--frozen-lockfile', '--prod=false'], source);
    await run(config.pnpm, ['build'], source);
    // Build output may be untracked; tracked sources must still be the pinned main.
    if ((await run(config.git, ['status', '--porcelain', '--untracked-files=no'], source)).stdout.trim()
      || (await run(config.git, ['rev-parse', 'HEAD'], source)).stdout.trim() !== revision) throw fail();
    const directory = join(config.releasesDirectory, `${revision}-${build.split(sep).at(-1)}`);
    const staged = await stageCandidateRelease({ root: source, destination: directory });
    const verified = await verifyCandidateRelease(directory);
    if (verified.manifestSha256 !== staged.manifestSha256) throw fail();
    const handle = await open(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify({ format: 1, directory, revision, manifestSha256: verified.manifestSha256 }));
      await handle.sync();
    } finally { await handle.close(); }
    const parent = await open(dirname(output), constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } catch { throw fail(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 6 || process.argv[2] !== '--config' || process.argv[4] !== '--output') throw fail();
    await prepareConnectorMain(process.argv[3], process.argv[5]);
  } catch {
    console.error('Pinned main candidate preparation failed; no release was activated');
    process.exitCode = 1;
  }
}
