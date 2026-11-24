import { serve } from '@hono/node-server';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import type { MaintenanceAdapter, MaintenanceOperation } from './connector-maintenance.js';
import { createMaintenanceApp } from './maintenance-http.js';
import { AsyncMaintenanceJournal } from './async-maintenance-journal.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { MaintenanceSupervisor } from './maintenance-supervisor.js';
import { createMaintenanceHostClose } from './maintenance-host-close.js';
import { StartupApplicationCleanup } from './startup-cleanup.js';

const contains = (parent: string, child: string) => child === parent || child.startsWith(`${parent}${sep}`);
const failure = () => new Error('Independent maintenance host configuration or storage is unavailable');
// A constructor that fails cannot return its journal/listener owners. Keep
// those exact cleanup callbacks, independently of the Connector app registry.
// Neither a rejected start nor a cleanup deadline permits another writer.
const startupCleanup = new StartupApplicationCleanup();
export const maintenanceHostStartupRecovery = () => startupCleanup.snapshot();
export const closeFailedMaintenanceStartup = () => startupCleanup.closeRetainedOwners();

/** Must run in its own supervised OS process. Never instantiate this in
 * createConnectorRuntime: its HTTP listener and worker must survive stopping
 * the Connector. Node-local adapters supply OS/backup/pinned-release/readiness
 * evidence; no HTTP request can replace those adapters or their configuration.
 */
export async function startMaintenanceHost(options: {
  nodeId: string;
  journalFile: string;
  tokenFile: string;
  /** Every updated or backed-up root; the journal must be outside all of them. */
  protectedRoots: readonly string[];
  adapter: MaintenanceAdapter;
  operations: readonly MaintenanceOperation[];
  hostname?: string;
  port: number;
  tickMs?: number;
  timeoutMs?: number;
}) {
  // Keep the admitted local policy stable even if the caller reuses its
  // configuration object. The adapter itself owns its mutable runtime state.
  options = { ...options, operations: [...options.operations], protectedRoots: [...options.protectedRoots] };
  const hostname = options.hostname ?? '127.0.0.1', tickMs = options.tickMs ?? 1000;
  if (process.platform === 'win32' || !isIP(hostname) || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535
    || !Number.isInteger(tickMs) || tickMs < 50 || tickMs > 60_000
    || !isAbsolute(options.journalFile) || !isAbsolute(options.tokenFile) || !options.protectedRoots.length
    || options.protectedRoots.some(path => !isAbsolute(path) || resolve(path) === dirname(resolve(path)))) throw failure();
  const journalFile = resolve(options.journalFile), parent = dirname(journalFile);
  startupCleanup.assertAvailable();
  let journal: AsyncMaintenanceJournal | undefined;
  let server: ReturnType<typeof serve> | undefined;
  let stopped = false;
  try {
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077) !== 0
      || (process.getuid && parentStat.uid !== process.getuid()) || await realpath(parent) !== parent) throw failure();
    for (const path of options.protectedRoots) {
      const root = await realpath(path);
      if (contains(root, parent) || contains(parent, root)) throw failure();
    }
    let handle;
    try { handle = await open(journalFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (handle) { try { await handle.sync(); } finally { await handle.close(); } }
    const stat = await lstat(journalFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw failure();
    const directory = await open(parent, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    let workerFailed = false;
    const halt = () => {
      if (workerFailed) return;
      workerFailed = true;
      const trace = guardedTrace(performanceDiagnostics, 'maintenance-host-halt'); trace.add('unknown', 1); trace.finish(true);
    };
    journal = new AsyncMaintenanceJournal({ file: journalFile, dev: stat.dev, ino: stat.ino,
      reconciliation: { nodeId: options.nodeId, tokenFile: resolve(options.tokenFile), operations: options.operations } }, performanceDiagnostics, halt);
    await journal.open();
    const tokens = () => new ConnectorTokenStore(options.tokenFile);
    const supervisor = new MaintenanceSupervisor(journal, options.adapter,
      async (actor, nodeId) => nodeId === options.nodeId && tokens().hasScope(actor, 'connector:lifecycle'),
      { nodeId: options.nodeId, operations: options.operations,
        // Observation endpoints can inspect the same durable receipt only
        // after the failed SQL owner has actually exited. Submit/tick keep
        // the permanently halted original writer; no effects are resumed.
        receiptJournal: {
          get: id => journal!.snapshot().unavailable ? journal!.inspectStopped('get', id) : journal!.get(id),
          unresolved: node => journal!.snapshot().unavailable ? journal!.inspectStopped('unresolved', node) : journal!.unresolved(node),
        },
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
    const originalJournal = journal;
    const app = createMaintenanceApp({ supervisor, tokens, recovery: () => originalJournal.recovery(),
      workerState: () => stopped ? 'stopping' : workerFailed ? 'halted' : 'running' });
    const address = await new Promise<{ port: number }>((resolveAddress, reject) => {
      server = serve({ fetch: app.fetch, hostname, port: options.port }, resolveAddress);
      server.once('error', reject);
    });
    server!.on('error', halt);
    const timer = setInterval(() => {
      if (stopped || workerFailed) return;
      // A journal/host error must not create an automatic retry loop. An
      // adapter failure is already durably recorded by the coordinator.
      void supervisor.tick().catch(halt);
    }, tickMs);
    timer.unref();
    const close = createMaintenanceHostClose({
      stopAdmissions: () => { stopped = true; clearInterval(timer); },
      closeListener: () => new Promise<void>((resolveClose, reject) => server!.close(error => error ? reject(error) : resolveClose())),
      drainWorker: () => supervisor.drainWorker(),
      closeJournal: () => originalJournal.closeForShutdown(),
    });
    return { port: address.port, get workerFailed() { return workerFailed; }, close };

  } catch {
    stopped = true;
    const originalServer = server, originalJournal = journal;
    const cleanups: (() => Promise<void>)[] = [];
    if (originalJournal) cleanups.push(() => originalJournal.closeForShutdown());
    if (originalServer) cleanups.push(() => new Promise<void>((resolveClose, reject) => {
      originalServer.close(error => {
        // Failed bind never acquired a listener. All other failures stay
        // unknown and retain the journal behind the original listener step.
        if (!error || ((error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING' && !originalServer.listening)) resolveClose();
        else reject(error);
      });
    }));
    startupCleanup.abandon([], cleanups);
    // Report startup failure promptly, retaining asynchronous cleanup rather
    // than swallowing its rejection or leaving the caller hung on an owner.
    throw failure();
  }
}
