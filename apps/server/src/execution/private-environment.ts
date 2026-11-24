import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { assertWindowsPrivatePath, canonicalPrivatePath, windowsWorkerEnvironment } from '../connector/windows-private-worker.js';

const denied = () => new Error('Native execution private configuration could not be verified');

function overlaps(first: string, second: string) {
  const contains = (root: string, target: string) => {
    const suffix = relative(root, target);
    return !suffix || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
  };
  return contains(first, second) || contains(second, first);
}

export function verifyExecutionDirectory(directory: string, privateDirectory = false) {
  try {
    if (!isAbsolute(directory) || directory === parse(directory).root || /[\x00-\x1f\x7f]/.test(directory)) throw denied();
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !canonicalPrivatePath(directory)) throw denied();
    if (privateDirectory) {
      if (process.platform === 'win32') assertWindowsPrivatePath(directory);
      else if (process.getuid?.() === undefined || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw denied();
    }
  } catch { throw denied(); }
}

export function prepareExecutionHome(home: string, excluded: readonly string[] = [],
  host: { execPath: string; env: NodeJS.ProcessEnv } = process) {
  try {
    verifyExecutionDirectory(home, true);
    if (excluded.some(directory => overlaps(home, directory))) throw denied();
    for (const ambient of new Set([host.env.HOME, host.env.USERPROFILE, homedir()].filter((value): value is string => !!value))) {
      const canonical = realpathSync(ambient);
      if (canonical === home || overlaps(home, canonical) && relative(home, canonical).split(/[\\/]/)[0] !== '..') throw denied();
      for (const name of ['.openclaw', '.hermes', '.codex']) {
        if (overlaps(home, join(canonical, name))) throw denied();
      }
    }
    for (const name of ['CODEX_HOME', 'HERMES_HOME', 'OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH']) {
      const configured = host.env[name];
      if (!configured || !isAbsolute(configured)) continue;
      let ambient = resolve(configured);
      try { ambient = realpathSync(configured); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw denied(); }
      if (overlaps(home, ambient)) throw denied();
    }
    for (const name of ['config', 'cache', 'data', 'state', 'tmp']) {
      const directory = join(home, name);
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw denied(); }
      verifyExecutionDirectory(directory, true);
    }
    return executionEnvironment(home, host);
  } catch { throw denied(); }
}

export function executionEnvironment(home: string, host: { execPath: string; env: NodeJS.ProcessEnv } = process): NodeJS.ProcessEnv {
  const environment = process.platform === 'win32' ? windowsWorkerEnvironment(home, host)
    : { PATH: `${dirname(host.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', HOME: home, USERPROFILE: home };
  return { ...environment, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'),
    TMPDIR: join(home, 'tmp'), TMP: join(home, 'tmp'), TEMP: join(home, 'tmp') };
}

export function verifyExecutionBinary(executable: string) {
  try {
    if (!isAbsolute(executable) || /[\x00-\x1f\x7f]/.test(executable)) throw denied();
    const canonical = realpathSync(executable);
    const info = lstatSync(canonical);
    if (!info.isFile() || (process.platform !== 'win32'
      && (info.uid !== 0 && info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0))) throw denied();
    return canonical;
  } catch { throw denied(); }
}
