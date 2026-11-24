// Operator-selected, already-tested candidate, NOT an automatic main updater.
// Arguments are installed in local maintenance config, never supplied by Hub.
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function prepareFixedRelease({ toolkit, releases, descriptor, output }) {
  if (![toolkit, releases, descriptor, output].every(path => isAbsolute(path) && resolve(path) === path)) throw new Error('Absolute local paths required');
  if (await realpath(toolkit) !== toolkit) throw new Error('Toolkit must not be a symlink');
  const { readPrivateMaintenanceFile } = await import(pathToFileURL(`${toolkit}/apps/server/dist/lifecycle/maintenance-entry.js`));
  const { verifyNodeRelease } = await import(pathToFileURL(`${toolkit}/apps/server/dist/lifecycle/maintenance-node-adapter.js`));
  const release = await verifyNodeRelease(JSON.parse(await readPrivateMaintenanceFile(descriptor)), releases, true);
  const handle = await open(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(release)); await handle.sync(); } finally { await handle.close(); }
  const parent = await open(dirname(output), constants.O_RDONLY | constants.O_DIRECTORY);
  try { await parent.sync(); } finally { await parent.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 7 || process.argv[5] !== '--output') throw new Error('Invalid preparation arguments');
    await prepareFixedRelease({ toolkit: process.argv[2], releases: process.argv[3], descriptor: process.argv[4], output: process.argv[6] });
  } catch { console.error('Fixed candidate preparation failed; no service transition requested'); process.exitCode = 1; }
}
