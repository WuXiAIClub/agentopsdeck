import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createLocalConfig(root) {
  const lock = join(root, '.env.aod-config.lock');
  let descriptor;
  try { descriptor = openSync(lock, 'wx', 0o600); }
  catch { throw new Error('CONFIG_CREATION_LOCK_UNAVAILABLE'); }
  try { createLockedConfig(root); }
  finally {
    try { closeSync(descriptor); }
    finally { rmSync(lock, { force: true }); }
  }
}

function createLockedConfig(root) {
  const file = join(root, '.env');
  const current = lstatSync(file, { throwIfNoEntry: false });
  if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error('CONFIG_MUST_BE_REGULAR_FILE');
  const original = readFileSync(existsSync(file) ? file : join(root, '.env.example'), 'utf8');
  const lines = original.split(/\r?\n/);
  if (lines.some(line => /^\s*AOD_ACCESS_KEY\s*=\s*[^\s]/.test(line)
    && !/^\s*AOD_ACCESS_KEY\s*=\s*(?:''|"")\s*$/.test(line))) throw new Error('ACCESS_KEY_ALREADY_CONFIGURED');
  const retained = lines.filter(line => !/^\s*AOD_ACCESS_KEY\s*=/.test(line)).join('\n').trimEnd();
  const temporary = join(root, `.env.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, `${retained}\nAOD_ACCESS_KEY=${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
  provisionDefaultDirectories(lines);
}

function provisionDefaultDirectories(lines) {
  if (process.platform === 'win32') return;
  const values = Object.create(null);
  for (const line of lines) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const raw = match[2].trim();
    values[match[1]] = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1).trim() : raw;
  }
  const home = process.env.HOME?.trim() || homedir();
  const xdg = process.env.XDG_DATA_HOME?.trim() || (home ? join(home, '.local', 'share') : '');
  const dataDir = values.AOD_DATA_DIR || process.env.AOD_DATA_DIR?.trim() || (xdg ? join(xdg, 'agentopsdeck') : '');
  if (!dataDir || !isAbsolute(dataDir)) return;
  const dirs = [
    dataDir,
    values.AOD_CODEX_HOME || join(dataDir, 'codex-home'),
    values.AOD_CODEX_DEFAULT_CWD || join(dataDir, 'workspace'),
    values.AOD_OPENCLAW_HOME || join(dataDir, 'openclaw-home'),
  ];
  for (const dir of dirs) {
    if (!isAbsolute(dir) || existsSync(dir)) continue;
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); } catch {}
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    createLocalConfig(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    console.log('Private .env prepared; access key is not printed.');
  } catch {
    console.error('Local config refused: use a regular .env with an empty access key and no concurrent generator; inspect stale locks privately. Existing keys are never rotated.');
    process.exitCode = 1;
  }
}
