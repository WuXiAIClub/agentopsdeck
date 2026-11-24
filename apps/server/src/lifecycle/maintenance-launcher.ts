import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPrivateMaintenanceFile } from './maintenance-entry.js';
import { verifyNodeRelease } from './maintenance-node-adapter.js';

/** Opt-in launcher for installations using the independent maintenance host.
 * Keep this executable OUTSIDE the replaceable release tree. Service config
 * supplies runtime paths/provider secrets as before; only release identity is
 * injected here. A pointer switch never edits runtime data or native config.
 */
export async function launchMaintainedConnector(pointer: string, releasesDirectory: string) {
  const release = await verifyNodeRelease(JSON.parse(await readPrivateMaintenanceFile(pointer)), releasesDirectory);
  process.env.AOD_CONNECTOR_REVISION = release.revision;
  // Use the selected build's compiled version, not a stale service override.
  delete process.env.AOD_CONNECTOR_VERSION;
  process.env.AOD_SERVER_ROLE = 'connector';
  // Existing provider/runtime config remains in the service environment.
  await import(pathToFileURL(`${release.directory}/apps/server/dist/index.js`).href);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || !process.argv[2] || !process.argv[3]
      || resolve(process.argv[3]) === dirname(resolve(process.argv[3]))) throw new Error('Invalid launcher arguments');
    await launchMaintainedConnector(process.argv[2], process.argv[3]);
  } catch {
    console.error('Maintained Connector release could not be verified or started');
    process.exitCode = 1;
  }
}
