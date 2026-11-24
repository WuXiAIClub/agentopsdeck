import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { MaintenanceConnectorClient } from './maintenance-connector-client.js';
import { startMaintenanceHost, closeFailedMaintenanceStartup, maintenanceHostStartupRecovery } from './maintenance-host.js';
import { ProcessLifetime } from './process-lifetime.js';
import { NodeMaintenanceAdapter, type NodeMaintenanceOptions } from './maintenance-node-adapter.js';
import { SystemdConnectorService } from './maintenance-systemd.js';
import type { MaintenanceJob } from './connector-maintenance.js';

const failure = () => new Error('Independent maintenance configuration is unavailable');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const absolute = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && resolve(value) === value
  && value !== dirname(value) && !/[\x00-\x1f\x7f]/.test(value);

/** Operator configuration/credentials only. Callers must not log either data
 * or low-level errors. Reject links and non-private files before reading.
 */
export async function readPrivateMaintenanceFile(file: string): Promise<string> {
  if (!absolute(file) || await realpath(dirname(file)) !== dirname(file)) throw failure();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 || (stat.mode & 0o077)
      || stat.uid !== process.getuid?.()) throw failure();
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

export type MaintenanceHostConfiguration = Pick<NodeMaintenanceOptions,
  'nodeId' | 'sessionKey' | 'releasesDirectory' | 'activeReleaseFile' | 'workDirectory' | 'backupRoots' | 'tar' | 'prepare'> & {
  format: 1;
  connectorUrl: string;
  credentialFile: string;
  tokenFile: string;
  journalFile: string;
  listener: { hostname: string; port: number };
  service: { unit: string; controlGroup: string; systemctl: string; allowDelegated?: boolean };
};

export function maintenanceHostConfiguration(value: unknown): MaintenanceHostConfiguration {
  if (!object(value) || value.format !== 1 || !keys(value, ['format', 'nodeId', 'sessionKey', 'releasesDirectory', 'activeReleaseFile',
    'workDirectory', 'backupRoots', 'tar', 'prepare', 'connectorUrl', 'credentialFile', 'tokenFile', 'journalFile', 'listener', 'service'])
    || !['nodeId', 'sessionKey', 'connectorUrl'].every(key => typeof value[key] === 'string')
    || !['releasesDirectory', 'activeReleaseFile', 'workDirectory', 'tar', 'credentialFile', 'tokenFile', 'journalFile'].every(key => absolute(value[key]))
    || !Array.isArray(value.backupRoots) || !value.backupRoots.length || value.backupRoots.length > 32 || !value.backupRoots.every(absolute)
    || !object(value.listener) || !keys(value.listener, ['hostname', 'port']) || typeof value.listener.hostname !== 'string'
    || !Number.isInteger(value.listener.port) || (value.listener.port as number) < 1 || (value.listener.port as number) > 65535
    || !object(value.service) || !keys(value.service, ['unit', 'controlGroup', 'systemctl', 'allowDelegated'])
    || (value.service.allowDelegated !== undefined && typeof value.service.allowDelegated !== 'boolean')
    || typeof value.service.unit !== 'string' || typeof value.service.controlGroup !== 'string' || !absolute(value.service.systemctl)) throw failure();
  if (value.prepare !== undefined && (!object(value.prepare) || !keys(value.prepare, ['executable', 'args', 'systemdRun', 'systemctl'])
    || !['executable', 'systemdRun', 'systemctl'].every(key => absolute((value.prepare as Record<string, unknown>)[key]))
    || !Array.isArray(value.prepare.args) || value.prepare.args.length > 32
    || !value.prepare.args.every(arg => typeof arg === 'string' && arg.length <= 4096 && !/[\x00-\x1f\x7f]/.test(arg)))) throw failure();
  // Credentials and persistent fence state survive upgrade because they are
  // outside candidate trees. Backups must include the durable token authority.
  const inside = (root: string, file: string) => file === root || file.startsWith(`${root}${sep}`);
  if (inside(value.releasesDirectory as string, value.tokenFile as string)
    || inside(value.releasesDirectory as string, value.credentialFile as string)
    || !(value.backupRoots as string[]).some(root => inside(root, value.tokenFile as string))) throw failure();
  return structuredClone(value) as MaintenanceHostConfiguration;
}

/** Runnable independent host; never imported/started by Connector runtime. */
export async function startConfiguredMaintenance(file: string) {
  const config = maintenanceHostConfiguration(JSON.parse(await readPrivateMaintenanceFile(file)));
  const allowed = (job: Readonly<MaintenanceJob>) => job.nodeId === config.nodeId
    && new ConnectorTokenStore(config.tokenFile).hasScope(job.actorId, 'connector:lifecycle');
  // Load the loopback token privately once. Revocation is checked by the
  // Connector on each request; rotation requires restarting this host.
  const credential = (await readPrivateMaintenanceFile(config.credentialFile)).trim();
  if (!credential || /\s/.test(credential)) throw failure();
  const connector = new MaintenanceConnectorClient({ connectorUrl: config.connectorUrl, nodeId: config.nodeId,
    credential: () => {
      const request = new Request(config.connectorUrl, { headers: { authorization: `Bearer ${credential}` } });
      if (!new ConnectorTokenStore(config.tokenFile).requireScope(request, 'connector:lifecycle')) throw failure();
      return credential;
    }, authorize: job => { if (!allowed(job)) throw failure(); } });
  const service = new SystemdConnectorService(config.service);
  const adapter = new NodeMaintenanceAdapter({ ...config, connector, service, authorize: async job => allowed(job) });
  return startMaintenanceHost({ nodeId: config.nodeId, journalFile: config.journalFile, tokenFile: config.tokenFile,
    protectedRoots: [...config.backupRoots, config.releasesDirectory, config.workDirectory, dirname(config.activeReleaseFile)],
    adapter, operations: config.prepare ? ['restart', 'upgrade'] : ['restart'],
    hostname: config.listener.hostname, port: config.listener.port });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let host: Awaited<ReturnType<typeof startConfiguredMaintenance>> | undefined;
  // Defer construction until the signal handlers and original-owner close
  // protocol are installed. A signal during startup waits for that one attempt.
  const starting = Promise.resolve().then(async () => {
    if (process.argv.length !== 3 || !process.argv[2]) throw failure();
    host = await startConfiguredMaintenance(process.argv[2]);
    return host;
  });
  const lifetime = new ProcessLifetime({
    onClosed: exitCode => { process.exitCode = exitCode; },
    onFailure: () => {
      process.exitCode = 1;
      console.error('Independent maintenance shutdown encountered a failure; inspect original owner recovery state');
    },
  });
  lifetime.own(() => starting.then(original => original.close(), () => closeFailedMaintenanceStartup()),
    () => host ? host.close.snapshot().state === 'cleanup-required' : maintenanceHostStartupRecovery().retryable > 0);
  // Keep both handlers throughout pending/unknown cleanup. Removing a once()
  // handler would let the next signal kill a still-owned journal/effect. Only
  // cleanup-required may automatically retry the exact original close; never
  // replay startup, drain, SQL commands, or external maintenance effects.
  const stop = () => { void lifetime.shutdown(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    await starting;
    if (!lifetime.snapshot().started) console.info('Independent Connector maintenance host ready');
  } catch {
    console.error('Independent Connector maintenance host could not start; inspect private node configuration');
    process.exitCode = 1;
    void lifetime.shutdown(1);
  }
}
