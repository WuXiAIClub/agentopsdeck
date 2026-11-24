import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { requireMaintenanceObservation, type MaintenanceAdapter, type MaintenanceJob, type ReleaseProof } from './connector-maintenance.js';
import type { MaintenanceConnectorClient } from './maintenance-connector-client.js';
import type { SystemdConnectorService } from './maintenance-systemd.js';
import { runSystemdPreparation, type PreparationCommand } from './maintenance-preparation.js';
import { validStoppedCodexRuns } from '../codex/stopped-recovery.js';
import { recordStoppedRecoveryOwned } from '../codex/stopped-recovery-owner.js';

const execute = promisify(execFile);
const failed = () => new Error('Node maintenance evidence is unavailable');
const contains = (parent: string, child: string) => child === parent || child.startsWith(`${parent}${sep}`);
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const same = (a: ReleaseProof, b?: ReleaseProof) => a.revision === b?.revision && a.manifestSha256 === b.manifestSha256;
export type NodeRelease = { format: 1; directory: string; revision: string; manifestSha256: string };

async function regular(file: string, privateFile = false, durable = false) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024
      || (privateFile && ((stat.mode & 0o077) || stat.uid !== process.getuid?.()))) throw failed();
    const bytes = await handle.readFile();
    if (durable) await handle.sync();
    return bytes;
  } finally { await handle.close(); }
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeNew(file: string, content: string) {
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(file));
}
async function privateDirectory(directory: string) {
  const stat = await lstat(directory);
  if (!isAbsolute(directory) || await realpath(directory) !== directory || !stat.isDirectory()
    || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw failed();
}

/** Verify every regular file, reject extras, links, path traversal and changed
 * bytes. Metadata alone or a matching revision string is never release proof.
 */
export async function verifyNodeRelease(value: unknown, releasesDirectory: string, durable = false): Promise<NodeRelease> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failed();
  const release = value as NodeRelease;
  if (Object.keys(release).sort().join(',') !== 'directory,format,manifestSha256,revision' || release.format !== 1
    || typeof release.directory !== 'string' || !isAbsolute(release.directory)
    || release.directory === releasesDirectory || !contains(releasesDirectory, release.directory)
    || await realpath(release.directory) !== release.directory
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(release.revision) || !/^[a-f0-9]{64}$/.test(release.manifestSha256)) throw failed();
  const manifestBytes = await regular(join(release.directory, 'candidate-manifest.json'), false, durable);
  if (hash(manifestBytes) !== release.manifestSha256) throw failed();
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.format !== 1 || manifest.entrypoint !== 'apps/server/dist/index.js' || !Array.isArray(manifest.files)
    || manifest.platform !== process.platform || manifest.arch !== process.arch) throw failed();
  const expected = new Map<string, { bytes: number; sha256: string }>();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !file.path.split('/').every((part: string) => part && part !== '.' && part !== '..')
      || /[\\\x00-\x1f\x7f]/.test(file.path) || file.path === 'candidate-manifest.json' || expected.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw failed();
    expected.set(file.path, file);
  }
  if (!expected.has('apps/server/dist/index.js')) throw failed();
  const visit = async (directory: string, prefix = '') => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      const file = join(directory, item.name);
      if (item.isDirectory()) { await visit(file, relative); continue; }
      if (!item.isFile()) throw failed();
      if (relative === 'candidate-manifest.json') continue;
      const entry = expected.get(relative);
      if (!entry) throw failed();
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.bytes) throw failed();
        const digest = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
        if (digest.digest('hex') !== entry.sha256) throw failed();
        if (durable) await handle.sync();
      } finally { await handle.close(); }
      expected.delete(relative);
    }
    // Children must be durable before their parent directory entry. This
    // adapter is Linux-only; unsupported fsync is a hard failure BEFORE stop.
    if (durable) await syncDirectory(directory);
  };
  await visit(release.directory);
  if (expected.size) throw failed();
  if (durable) {
    for (let parent = dirname(release.directory); contains(releasesDirectory, parent); parent = dirname(parent)) {
      await syncDirectory(parent);
      if (parent === releasesDirectory) break;
    }
  }
  return { format: 1, directory: release.directory, revision: release.revision, manifestSha256: release.manifestSha256 };
}

export type NodeMaintenanceOptions = {
  nodeId: string;
  sessionKey: string;
  releasesDirectory: string;
  activeReleaseFile: string;
  workDirectory: string;
  backupRoots: readonly string[];
  tar: string;
  /** Fixed operator-installed candidate builder, NEVER supplied by a Hub job.
   * Receives only --output <private descriptor>. Must stage pinned main.
   */
  prepare?: PreparationCommand;
  /** Test seam; operator JSON cannot replace the cgroup runner. */
  runPreparation?: typeof runSystemdPreparation;
  /** Explicit node-installed capability, NOT a Hub-supplied database path.
   * The ordinary configured host does not admit recovery yet: real native
   * stop/restore acceptance is required before exposing this operation.
   */
  stoppedRecovery?: { databaseFile: string };
  authorize: (job: Readonly<MaintenanceJob>) => Promise<boolean>;
  service: Pick<SystemdConnectorService, 'verifyRunning' | 'verifyStopped' | 'stop' | 'start'>;
  connector: Pick<MaintenanceConnectorClient, 'inspect' | 'fence' | 'releaseFence' | 'readiness'>;
  /** Only the separately installed one-shot operator runner can provide these.
   * Ordinary hosts/config/Hub requests have no bootstrap capability.
   */
  archiveBootstrap?: {
    beforeStop: (job: Readonly<MaintenanceJob>) => Promise<void>;
    verifyStoppedArchive: (job: Readonly<MaintenanceJob>) => Promise<void>;
  };
};

/** Concrete filesystem/OS composition for a separately supervised Linux host.
 * Recovery is deliberately operator-led: unknown effects never replay; failed
 * readiness leaves the original execution fence in place, without DB rollback.
 */
export class NodeMaintenanceAdapter implements MaintenanceAdapter {
  private readonly options: NodeMaintenanceOptions;
  constructor(options: NodeMaintenanceOptions) {
    this.options = { ...options, backupRoots: [...options.backupRoots],
      ...(options.stoppedRecovery ? { stoppedRecovery: { ...options.stoppedRecovery } } : {}),
      ...(options.prepare ? { prepare: { ...options.prepare, args: [...options.prepare.args] } } : {}) };
    for (const path of [options.releasesDirectory, options.activeReleaseFile, options.workDirectory, options.tar,
      ...options.backupRoots, ...(options.stoppedRecovery ? [options.stoppedRecovery.databaseFile] : []),
      ...(options.prepare ? [options.prepare.executable, options.prepare.systemdRun, options.prepare.systemctl] : [])]) {
      if (!isAbsolute(path) || resolve(path) !== path || path === dirname(path) || path === homedir()
        || /[\x00-\x1f\x7f]/.test(path)) throw failed();
    }
    if (!options.backupRoots.length || !/^(?:codex|claude-code|ghcp):[A-Za-z0-9-]{1,128}$/.test(options.sessionKey)) throw failed();
    if (options.stoppedRecovery && (!options.backupRoots.some(root => root !== options.stoppedRecovery!.databaseFile
      && contains(root, options.stoppedRecovery!.databaseFile))
      || contains(options.releasesDirectory, options.stoppedRecovery.databaseFile))) throw failed();
    for (const root of [...options.backupRoots, options.releasesDirectory, dirname(options.activeReleaseFile)]) {
      if (contains(root, options.workDirectory) || contains(options.workDirectory, root)) throw failed();
    }
  }
  async authorize(job: Readonly<MaintenanceJob>) {
    return (!job.archiveBootstrap || !!this.options.archiveBootstrap)
      && (job.operation !== 'recover' || !!this.options.stoppedRecovery)
      && job.nodeId === this.options.nodeId && await this.options.authorize(job);
  }
  private async guard(job: Readonly<MaintenanceJob>) {
    if (job.deadline <= Date.now() || !await this.authorize(job)) throw failed();
    await privateDirectory(this.options.workDirectory);
    await privateDirectory(dirname(this.options.activeReleaseFile));
    if (await realpath(this.options.releasesDirectory) !== this.options.releasesDirectory) throw failed();
    // Authorization and filesystem proof are asynchronous. Admission before
    // either await is not authority to perform an effect after the deadline.
    if (job.deadline <= Date.now()) throw failed();
  }
  private directory(job: Readonly<MaintenanceJob>) { return join(this.options.workDirectory, hash(job.id)); }
  private async readRelease(file: string, durable = false) {
    return verifyNodeRelease(JSON.parse((await regular(file, true)).toString('utf8')), this.options.releasesDirectory, durable);
  }
  private async pinned(job: Readonly<MaintenanceJob>, file: string) {
    const release = await this.readRelease(file);
    if (!job.release || !same(release, job.release)) throw failed();
    return release;
  }
  private async verifiedBackup(job: Readonly<MaintenanceJob>) {
    if (job.backupId !== hash(job.id)) throw failed();
    const directory = join(this.directory(job), 'backup');
    await privateDirectory(directory);
    const manifest = JSON.parse((await regular(join(directory, 'manifest.json'), true)).toString('utf8'));
    if (manifest.format !== 1 || manifest.nodeId !== job.nodeId || manifest.jobId !== job.id
      || !Array.isArray(manifest.records) || manifest.records.length !== this.options.backupRoots.length) throw failed();
    for (const [index, source] of this.options.backupRoots.entries()) {
      await this.guard(job);
      const record = manifest.records[index];
      if (record.source !== source || record.archive !== `${index}.tar` || !Number.isSafeInteger(record.bytes)
        || record.bytes < 1 || !/^[a-f0-9]{64}$/.test(record.sha256)) throw failed();
      const handle = await open(join(directory, `${index}.tar`), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size !== record.bytes) throw failed();
        const digest = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
        if (digest.digest('hex') !== record.sha256) throw failed();
      } finally { await handle.close(); }
    }
  }
  async prepare(job: Readonly<MaintenanceJob>) {
    await this.guard(job);
    await this.options.service.verifyRunning();
    const current = await this.readRelease(this.options.activeReleaseFile, true);
    if (job.archiveBootstrap && !same(current, job.archiveBootstrap.previous)) throw failed();
    const directory = this.directory(job);
    await mkdir(directory, { mode: 0o700 }); await syncDirectory(this.options.workDirectory);
    await writeNew(join(directory, 'previous.json'), JSON.stringify(current));
    let candidate = current;
    if (job.operation === 'upgrade') {
      const builder = this.options.prepare;
      if (!builder) throw failed();
      await this.guard(job);
      try {
        await (this.options.runPreparation ?? runSystemdPreparation)(
          { ...builder, args: [...builder.args, '--output', join(directory, 'prepared.json')] }, directory,
          Math.max(1, Math.min(20 * 60_000, job.deadline - Date.now())));
      } catch { throw failed(); }
      candidate = await this.readRelease(join(directory, 'prepared.json'), true);
    }
    if (job.archiveBootstrap && !same(candidate, job.archiveBootstrap.candidate)) throw failed();
    await this.guard(job);
    await writeNew(join(directory, 'candidate.json'), JSON.stringify(candidate));
    return { revision: candidate.revision, manifestSha256: candidate.manifestSha256 };
  }
  inspect(job: Readonly<MaintenanceJob>) { return this.options.connector.inspect(job); }
  fence(job: Readonly<MaintenanceJob>) { return this.options.connector.fence(job); }
  releaseFence(job: Readonly<MaintenanceJob>) { return this.options.connector.releaseFence(job); }
  async stop(job: Readonly<MaintenanceJob>) {
    await this.guard(job);
    const previous = await this.readRelease(join(this.directory(job), 'previous.json'));
    const current = await this.readRelease(this.options.activeReleaseFile);
    if (previous.directory !== current.directory || !same(current, previous)) throw failed();
    if (job.archiveBootstrap) await this.options.archiveBootstrap!.beforeStop(job);
    // Inventory verification can take longer than the coordinator's idle
    // evidence lifetime. Re-observe after disk work, immediately before stop.
    const quiet = await this.options.connector.inspect(job);
    if (!job.fenceId || !requireMaintenanceObservation(quiet, job, Date.now(), true)) throw failed();
    await this.guard(job); await this.options.service.stop();
  }
  async stopped(job: Readonly<MaintenanceJob>) {
    await this.guard(job); await this.options.service.verifyStopped();
    return { nodeId: job.nodeId, serviceStopped: true as const, descendantsStopped: true as const };
  }
  async backup(job: Readonly<MaintenanceJob>) {
    await this.guard(job); await this.options.service.verifyStopped();
    const directory = join(this.directory(job), 'backup');
    await mkdir(directory, { mode: 0o700 }); await syncDirectory(dirname(directory));
    const records: { source: string; archive: string; sha256: string; bytes: number }[] = [];
    for (const [index, source] of this.options.backupRoots.entries()) {
      await this.guard(job); await this.options.service.verifyStopped();
      if (await realpath(source) !== source) throw failed();
      const archive = `${index}.tar`, file = join(directory, archive);
      // Precreate with 0600; no secrets or archive listing are printed.
      await writeNew(file, '');
      try {
        await execute(this.options.tar, ['-cf', file, '-C', dirname(source), '--', basename(source)], {
          timeout: Math.max(1, Math.min(5 * 60_000, job.deadline - Date.now())), maxBuffer: 64 * 1024,
        });
      } catch { throw failed(); }
      const handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || !stat.size) throw failed();
        await handle.sync();
        const digest = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
        records.push({ source, archive, bytes: stat.size, sha256: digest.digest('hex') });
      } finally { await handle.close(); }
      await this.options.service.verifyStopped();
    }
    await this.guard(job);
    await writeNew(join(directory, 'manifest.json'), JSON.stringify({ format: 1, nodeId: job.nodeId, jobId: job.id, records }));
    return { nodeId: job.nodeId, backupId: hash(job.id), consistent: true as const, verified: true as const };
  }
  async activate(job: Readonly<MaintenanceJob>) {
    await this.guard(job); await this.options.service.verifyStopped();
    await this.verifiedBackup(job);
    if (job.archiveBootstrap) await this.options.archiveBootstrap!.verifyStoppedArchive(job);
    const previous = await this.readRelease(join(this.directory(job), 'previous.json'));
    const current = await this.readRelease(this.options.activeReleaseFile);
    if (current.directory !== previous.directory || !same(current, previous)) throw failed();
    const candidate = await this.pinned(job, join(this.directory(job), 'candidate.json'));
    const pending = `${this.options.activeReleaseFile}.${hash(job.id)}.pending`;
    await writeNew(pending, JSON.stringify(candidate));
    await this.guard(job); await this.options.service.verifyStopped();
    await rename(pending, this.options.activeReleaseFile); await syncDirectory(dirname(this.options.activeReleaseFile));
    return { revision: candidate.revision, manifestSha256: candidate.manifestSha256 };
  }
  async recover(job: Readonly<MaintenanceJob>) {
    await this.guard(job);
    if (job.operation !== 'recover' || job.stage !== 'recover' || !job.fenceId || !job.backupId
      || !validStoppedCodexRuns(job.recoveryRuns) || !this.options.stoppedRecovery) throw failed();
    await this.options.service.verifyStopped();
    await this.pinned(job, this.options.activeReleaseFile);
    await this.verifiedBackup(job);
    const file = this.options.stoppedRecovery.databaseFile;
    await privateDirectory(dirname(file));
    if (await realpath(file) !== file) throw failed();
    const handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) || before.uid !== process.getuid?.()) throw failed();
      // SQLite opens its own descriptor and may use sibling WAL/SHM files.
      // Refuse redirected/shared sidecars before opening the fixed database.
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          const sidecar = await lstat(`${file}${suffix}`);
          if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1
            || (sidecar.mode & 0o077) || sidecar.uid !== process.getuid?.()) throw failed();
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      await this.guard(job);
      await this.options.service.verifyStopped();
      const current = await lstat(file);
      if (current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1
        || (current.mode & 0o077) || !current.isFile()) throw failed();
      await recordStoppedRecoveryOwned({ file, dev: before.dev, ino: before.ino, deadline: job.deadline,
        runs: job.recoveryRuns, proof: { nodeId: job.nodeId, jobId: job.id,
          fenceId: job.fenceId, backupId: job.backupId, verifiedAt: Date.now() } });
      await handle.sync();
      await syncDirectory(dirname(file));
    } finally { await handle.close(); }
    // Lost acknowledgment/revocation stays attention in the coordinator. It
    // must never cause an automatic second write, start, or fence release.
    await this.guard(job); await this.options.service.verifyStopped();
    return { nodeId: job.nodeId, recovered: true as const };
  }
  async start(job: Readonly<MaintenanceJob>) {
    await this.guard(job); await this.pinned(job, this.options.activeReleaseFile);
    await this.verifiedBackup(job);
    await this.guard(job);
    await this.options.service.start();
  }
  async ready(job: Readonly<MaintenanceJob>) {
    await this.guard(job); await this.options.service.verifyRunning();
    const release = await this.pinned(job, this.options.activeReleaseFile);
    // systemd active is not HTTP/native ready. Only this non-mutating native
    // observation is polled; the history probe is invoked once and never
    // retried after an ambiguous response.
    const deadline = Math.min(job.deadline, Date.now() + 60_000);
    for (;;) {
      await this.guard(job);
      try {
        await this.options.connector.inspect(job);
        break;
      } catch {
        await this.guard(job);
        if (Date.now() >= deadline) throw failed();
        await delay(Math.min(500, deadline - Date.now()));
      }
    }
    if (job.operation === 'recover' && !validStoppedCodexRuns(job.recoveryRuns)) throw failed();
    const sessions = new Set([this.options.sessionKey,
      ...(job.operation === 'recover' ? job.recoveryRuns!.map(run => run.sessionKey) : [])]);
    for (const sessionKey of sessions) {
      await this.guard(job);
      await this.options.connector.readiness(job, sessionKey);
    }
    await this.guard(job); await this.options.service.verifyRunning();
    const after = await this.pinned(job, this.options.activeReleaseFile);
    if (release.directory !== after.directory) throw failed();
    return { nodeId: job.nodeId, revision: release.revision, manifestSha256: release.manifestSha256,
      protocolCompatible: true as const, projectionVerified: true as const, businessReadVerified: true as const };
  }
}
