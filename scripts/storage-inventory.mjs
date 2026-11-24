import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const kind = name => /-(wal|shm)$/.test(name) ? name.endsWith('-wal') ? 'sqlite-wal' : 'sqlite-shm'
  : /\.(sqlite|sqlite3|db)$/.test(name) ? 'database'
  : /\.jsonl$/.test(name) ? 'jsonl' : /\.json$/.test(name) ? 'json'
  : /\.(tar|gz|zip|zst)$/.test(name) ? 'archive' : 'other';

const dayMs = 86_400_000;
const defaultAgeDays = [1, 7, 30, 90];
const ageKey = (mtimeMs, sampledAtMs, days) => {
  if (!Number.isFinite(mtimeMs) || mtimeMs < 0 || mtimeMs > sampledAtMs) return 'unknown-or-future';
  const ageDays = (sampledAtMs - mtimeMs) / dayMs;
  const index = days.findIndex(day => ageDays < day);
  if (index < 0) return `ge-${days.at(-1)}d`;
  return index === 0 ? `lt-${days[0]}d` : `${days[index - 1]}d-to-${days[index]}d`;
};

/** Explicit directories only; never opens file contents, follows a known
 * symlink, probes SQLite, hashes native history or deletes/compacts anything.
 * This is a bounded live metadata sample, NOT a transactional disk snapshot. */
export async function inventoryStorage(roots, { maxEntries = 100_000, maxMs = 10_000, maxDepth = 32,
  ageThresholdsDays = defaultAgeDays, sampledAtMs = Date.now() } = {}) {
  if (!Array.isArray(roots) || !roots.length || roots.length > 16) throw Error('Specify 1–16 labelled roots');
  for (const [value, min, max] of [[maxEntries, 1, 1_000_000], [maxMs, 1, 60_000], [maxDepth, 0, 64]])
    if (!Number.isSafeInteger(value) || value < min || value > max) throw Error('Invalid inventory budget');
  if (!Array.isArray(ageThresholdsDays) || !ageThresholdsDays.length || ageThresholdsDays.length > 8
    || ageThresholdsDays.some((day, i) => !Number.isSafeInteger(day) || day < 1 || day > 36500 || (i > 0 && day <= ageThresholdsDays[i - 1])))
    throw Error('Use 1–8 increasing age thresholds in days');
  if (!Number.isSafeInteger(sampledAtMs) || sampledAtMs < 0 || sampledAtMs > 8_640_000_000_000_000) throw Error('Invalid sample time');
  const days = [...ageThresholdsDays];
  const canonical = [], labels = new Set();
  for (const { label, directory } of roots) {
    if (typeof label !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(label) || labels.has(label)) throw Error('Use unique short root labels');
    if (typeof directory !== 'string' || !isAbsolute(directory) || resolve(directory) === parse(directory).root) throw Error('Use explicit, narrow absolute directories');
    const path = resolve(directory), stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(path) !== path) throw Error('Root must be a canonical directory, not a symlink');
    labels.add(label); canonical.push({ label, path });
  }
  const started = performance.now(), seen = new Set(), samples = [];
  let inspected = 0;
  const exhausted = () => inspected >= maxEntries || performance.now() - started >= maxMs;
  for (const { label, path } of canonical) {
    const sample = { label, files: 0, directories: 0, bytes: 0, allocatedBytes: 0, allocationAvailable: true,
      symlinksSkipped: 0, duplicateFiles: 0, inaccessible: 0, specialFilesSkipped: 0, complete: true, types: {}, ageBuckets: {} };
    const visit = async (directory, depth) => {
      if (exhausted() || depth > maxDepth) { sample.complete = false; return; }
      try {
        // Also check again at traversal time, not only the parent dirent.
        if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) { sample.symlinksSkipped++; sample.complete = false; return; }
        const handle = await opendir(directory); sample.directories++;
        for await (const entry of handle) {
          if (exhausted()) { sample.complete = false; break; }
          inspected++;
          const path = join(directory, entry.name);
          try {
            const stat = await lstat(path);
            if (stat.isSymbolicLink()) { sample.symlinksSkipped++; continue; }
            if (stat.isDirectory()) { await visit(path, depth + 1); continue; }
            if (!stat.isFile()) { sample.specialFilesSkipped++; continue; }
            const identity = `${stat.dev}:${stat.ino}`;
            // Some filesystems cannot provide inode identity. Do not collapse
            // all such files to inode zero; report apparent bytes instead.
            if (stat.ino !== 0 && seen.has(identity)) { sample.duplicateFiles++; continue; }
            if (stat.ino !== 0) seen.add(identity);
            const type = kind(entry.name), bucket = sample.types[type] ??= { files: 0, bytes: 0 };
            bucket.files++; bucket.bytes += stat.size;
            const age = sample.ageBuckets[ageKey(stat.mtimeMs, sampledAtMs, days)] ??= { files: 0, bytes: 0, types: {} };
            const ageType = age.types[type] ??= { files: 0, bytes: 0 };
            age.files++; age.bytes += stat.size; ageType.files++; ageType.bytes += stat.size;
            sample.files++; sample.bytes += stat.size;
            if (Number.isFinite(stat.blocks)) sample.allocatedBytes += stat.blocks * 512;
            else sample.allocationAvailable = false;
          } catch { sample.inaccessible++; sample.complete = false; }
        }
      } catch { sample.inaccessible++; sample.complete = false; }
    };
    await visit(path, 0); samples.push(sample);
  }
  return { version: 2, readOnly: true, consistentSnapshot: false, complete: samples.every(sample => sample.complete),
    sampledAt: new Date(sampledAtMs).toISOString(), ageBasis: 'mtime', ageThresholdsDays: days,
    // Old mtime is not proof of inactivity, ownership, recoverability or a
    // released lease. This report never grants permission to delete a file.
    coldnessProven: false, reclaimableBytes: null,
    durationMs: Math.round(performance.now() - started), inspected, budgets: { maxEntries, maxMs, maxDepth }, roots: samples };
}

export function parseInventoryArgs(args) {
  let ageThresholdsDays;
  const roots = [];
  for (const arg of args) {
    if (arg.startsWith('--age-days=')) {
      if (ageThresholdsDays || !/^\d+(,\d+)*$/.test(arg.slice(11))) throw Error('Invalid age option');
      ageThresholdsDays = arg.slice(11).split(',').map(Number);
    } else {
      const split = arg.indexOf('=');
      if (arg.startsWith('--') || split < 1) throw Error('Use label=directory');
      roots.push({ label: arg.slice(0, split), directory: arg.slice(split + 1) });
    }
  }
  return { roots, options: { ageThresholdsDays } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') {
      console.log('Usage: node scripts/storage-inventory.mjs [--age-days=1,7,30,90] label=/absolute/narrow/directory [label=/other/directory ...]\nMetadata only; max 100000 entries / 10s / 32 levels. Age uses mtime, NOT last access or deletion eligibility. No file contents, database queries or deletion. JSON omits paths and names.');
    } else {
      const { roots, options } = parseInventoryArgs(args);
      console.log(JSON.stringify(await inventoryStorage(roots, options), null, 2));
    }
  } catch { console.error('Inventory failed: check labelled canonical directories, permissions and budgets. No contents read or files changed.'); process.exitCode = 1; }
}
