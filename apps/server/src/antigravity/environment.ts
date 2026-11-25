import { dirname, join, parse } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import type { AntigravityConfig } from './config.js';

const failure = () => Error('Antigravity private environment could not be verified');

export function antigravityEnvironment(config: AntigravityConfig): NodeJS.ProcessEnv {
  if (process.platform !== 'linux') throw failure();
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: 'C.UTF-8',
    HOME: config.homeDirectory,
    XDG_CONFIG_HOME: join(config.homeDirectory, 'config'),
    XDG_CACHE_HOME: join(config.homeDirectory, 'cache'),
    XDG_DATA_HOME: join(config.homeDirectory, 'data'),
    TMPDIR: join(config.homeDirectory, 'tmp'),
  };
}

export function verifyAntigravityEnvironment(config: AntigravityConfig) {
  try { verifyPrivatePaths(config); }
  catch { throw failure(); }
}

function verifyPrivatePaths(config: AntigravityConfig) {
  if (process.platform !== 'linux' || !process.getuid) throw failure();
  for (const path of [config.homeDirectory, config.workspace, config.command]) {
    const stat = lstatSync(path);
    if (path === parse(path).root || stat.isSymbolicLink() || realpathSync(path) !== path || stat.mode & 0o022) throw failure();
    if (path === config.command) {
      if (!stat.isFile() || !(stat.mode & 0o111)) throw failure();
    } else if (!stat.isDirectory() || stat.uid !== process.getuid()
      || path === config.homeDirectory && (stat.mode & 0o777) !== 0o700) throw failure();
  }
  for (const name of ['config', 'cache', 'data', 'tmp']) {
    const path = join(config.homeDirectory, name), stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(path) !== path
      || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw failure();
  }
}
