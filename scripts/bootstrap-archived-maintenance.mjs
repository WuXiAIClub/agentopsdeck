// One operator-authorized bootstrap. Not a public API or an automatic updater.
// Runs in a separate systemd cgroup. Original receipts, execution facts, queues
// and native files are never edited to make an observation appear quiescent.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';
import { reconciliationOrigin } from './reconcile-local-maintenance.mjs';
import { verifyWeb } from './observe-local-maintenance.mjs';
import { archiveDatabaseEvidence, nativeHistoryFile, fileEvidence } from './archive-bootstrap-evidence.mjs';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => path.startsWith(root + sep);
async function syncDirectory(directory) {
  const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}
async function writeNew(file, data) {
  const fd = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(JSON.stringify(data)); await fd.sync(); } finally { await fd.close(); }
  await syncDirectory(dirname(file));
}
export async function runArchiveBootstrap({ toolkit, toolkitSha256, specFile }) {
  assert.match(toolkitSha256, /^[a-f0-9]{64}$/);
  assert.equal((await verifyCandidateRelease(toolkit)).manifestSha256, toolkitSha256);
  const module = name => import(pathToFileURL(join(toolkit, 'apps/server/dist', name)).href);
  const { readPrivateMaintenanceFile, maintenanceHostConfiguration } = await module('lifecycle/maintenance-entry.js');
  const { NodeMaintenanceAdapter, verifyNodeRelease } = await module('lifecycle/maintenance-node-adapter.js');
  const { SystemdConnectorService } = await module('lifecycle/maintenance-systemd.js');
  const { MaintenanceConnectorClient } = await module('lifecycle/maintenance-connector-client.js');
  const { ConnectorTokenStore } = await module('auth/connector-token.js');
  const { SqliteMaintenanceJournal } = await module('lifecycle/maintenance-journal.js');
  const { advanceMaintenance, validMaintenanceJob, terminalMaintenanceJob } = await module('lifecycle/connector-maintenance.js');
  const specBytes = await readPrivateMaintenanceFile(specFile), spec = JSON.parse(specBytes);
  assert.equal(spec.format, 1);
  assert.equal(spec.authorization, 'one-controlled-archived-pending-window');
  assert.ok(Number.isSafeInteger(spec.expiresAt) && spec.expiresAt > Date.now() && spec.expiresAt <= Date.now() + 24 * 60 * 60_000);
  assert.ok(Array.isArray(spec.scriptPins) && spec.scriptPins.length >= 5 && spec.scriptPins.length <= 12);
  for (const pin of spec.scriptPins) {
    assert.ok(isAbsolute(pin.file)); assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    assert.equal(await realpath(pin.file), pin.file);
    assert.equal(hash(await readFile(pin.file)), pin.sha256, 'installed operator script changed');
  }
  assert.ok(spec.scriptPins.some(pin => pathToFileURL(pin.file).href === import.meta.url));
  const config = maintenanceHostConfiguration(JSON.parse(await readPrivateMaintenanceFile(spec.maintenanceConfig)));
  reconciliationOrigin(config.connectorUrl);
  assert.equal(spec.nodeId, config.nodeId);
  assert.match(spec.commandKey, /^[A-Za-z0-9._:-]{1,150}$/);
  assert.match(spec.workerUnit, /^[A-Za-z0-9_.@-]+\.service$/);
  assert.notEqual(spec.workerUnit, config.service.unit);
  for (const path of [spec.databaseFile, spec.nativeRoot, spec.resultDirectory, spec.fixedPreparationScript]) {
    assert.ok(isAbsolute(path) && resolve(path) === path && !/[\x00-\x1f\x7f]/.test(path));
  }
  assert.ok(config.backupRoots.some(root => within(root, spec.databaseFile)));
  assert.ok(config.backupRoots.some(root => root === spec.nativeRoot || within(root, spec.nativeRoot)));
  assert.ok(config.backupRoots.every(root => !within(root, spec.resultDirectory) && !within(spec.resultDirectory, root) && root !== spec.resultDirectory));
  assert.ok(!within(config.workDirectory, spec.resultDirectory) && !within(config.releasesDirectory, spec.resultDirectory));
  assert.ok(spec.scriptPins.some(pin => pin.file === spec.fixedPreparationScript));
  const previous = await verifyNodeRelease(spec.previous, config.releasesDirectory, true);
  const candidate = await verifyNodeRelease(spec.candidate, config.releasesDirectory, true);
  const service = new SystemdConnectorService(config.service);
  const worker = new SystemdConnectorService({ ...config.service, unit: spec.workerUnit,
    controlGroup: `${dirname(config.service.controlGroup)}/${spec.workerUnit}` });
  await worker.verifyStopped(); await service.verifyRunning();
  const invocation = async () => (await execute(config.service.systemctl,
    ['--user', 'show', '--property=InvocationID', '--value', config.service.unit], { timeout: 5000, maxBuffer: 1024 })).stdout.trim();
  assert.equal(await invocation(), spec.archiveBootstrap.serviceInvocationId);
  assert.deepEqual(JSON.parse(await readPrivateMaintenanceFile(config.activeReleaseFile)), previous);
  const proof = value => ({ revision: value.revision, manifestSha256: value.manifestSha256 });
  assert.deepEqual(spec.archiveBootstrap.previous, proof(previous));
  assert.deepEqual(spec.archiveBootstrap.candidate, proof(candidate));
  const credential = (await readPrivateMaintenanceFile(config.credentialFile)).trim();
  const principal = new ConnectorTokenStore(config.tokenFile).requireScope(
    new Request(config.connectorUrl, { headers: { authorization: `Bearer ${credential}` } }), 'connector:lifecycle');
  assert.ok(principal?.tokenId);
  const id = `maintenance:${hash(JSON.stringify([config.nodeId, principal.tokenId, spec.commandKey]))}`;
  const createdAt = Date.now();
  let job = { version: 1, id, nodeId: config.nodeId, actorId: principal.tokenId, operation: 'upgrade',
    createdAt, deadline: Math.min(spec.expiresAt, createdAt + 40 * 60_000), revision: 0, stage: 'prepare', archiveBootstrap: spec.archiveBootstrap };
  assert.ok(validMaintenanceJob(job));
  // No second invocation, even if a prior attempt failed before enqueue. The
  // dedicated journal also enforces single use across *different* job IDs.
  await mkdir(spec.resultDirectory, { mode: 0o700 }); await syncDirectory(dirname(spec.resultDirectory));
  await writeNew(join(spec.resultDirectory, 'authorization.json'), { specSha256: hash(specBytes), toolkitSha256,
    job, previous, candidate, authorization: spec.authorization, pendingCountsAreNotQuiescence: true });
  const evidence = { format: 1, status: 'preflight', jobId: id, commandKey: spec.commandKey,
    authorizedException: spec.archiveBootstrap, previous, candidate, stages: [], startedAt: Date.now() };
  let saves = 0, db;
  const save = async () => {
    const pending = join(spec.resultDirectory, `result-${++saves}.pending`);
    await writeNew(pending, evidence); await rename(pending, join(spec.resultDirectory, 'result.json'));
    await syncDirectory(spec.resultDirectory);
  };
  try {
    const parent = await lstat(dirname(config.journalFile)), stat = await lstat(config.journalFile);
    assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && !(parent.mode & 0o077) && parent.uid === process.getuid());
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && !(stat.mode & 0o077) && stat.uid === process.getuid());
    assert.equal(await realpath(dirname(config.journalFile)), dirname(config.journalFile));
    db = new DatabaseSync(config.journalFile); db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const journal = new SqliteMaintenanceJournal(db), old = journal.get(spec.oldJobId);
    assert.ok(old && old.stage === 'cancelled' && old.revision === spec.oldJobRevision && old.nodeId === config.nodeId
      && old.actorId === job.actorId && !old.fenceId && !old.backupId);
    assert.equal(journal.unresolved(config.nodeId), undefined);
    assert.equal(journal.get(id), undefined, 'never resume or retarget a bootstrap invocation');
    const allowed = async snapshot => {
      await worker.verifyStopped();
      return snapshot.id === id && snapshot.nodeId === config.nodeId && snapshot.actorId === principal.tokenId
        && snapshot.operation === 'upgrade' && JSON.stringify(snapshot.archiveBootstrap) === JSON.stringify(spec.archiveBootstrap)
        && new ConnectorTokenStore(config.tokenFile).hasScope(snapshot.actorId, 'connector:lifecycle');
    };
    const connector = new MaintenanceConnectorClient({ connectorUrl: config.connectorUrl, nodeId: config.nodeId,
      credential: () => credential, authorize: async snapshot => { assert.ok(await allowed(snapshot)); } });
    // Pin a NEW descriptor; never retarget the cancelled command's descriptor.
    const descriptor = join(spec.resultDirectory, 'candidate.json'); await writeNew(descriptor, candidate);
    const adapter = new NodeMaintenanceAdapter({ ...config, service, connector, authorize: allowed,
      prepare: { executable: '/usr/bin/node', args: [spec.fixedPreparationScript, toolkit, config.releasesDirectory, descriptor],
        systemdRun: '/usr/bin/systemd-run', systemctl: config.service.systemctl },
      archiveBootstrap: {
        beforeStop: async snapshot => {
          await worker.verifyStopped(); await service.verifyRunning();
          assert.equal(await invocation(), snapshot.archiveBootstrap.serviceInvocationId);
          assert.deepEqual(JSON.parse(await readPrivateMaintenanceFile(config.activeReleaseFile)), previous);
          // The adapter obtains another FRESH raw native observation immediately
          // after these disk checks and immediately before its stop action.
        },
        verifyStoppedArchive: async snapshot => {
          await service.verifyStopped(); await worker.verifyStopped();
          const stopped = await archiveDatabaseEvidence(spec.databaseFile, spec.archiveBootstrap.sessions);
          const files = [];
          for (const key of spec.archiveBootstrap.sessions) {
            const file = await nativeHistoryFile(join(spec.nativeRoot, 'archived_sessions'), key);
            files.push({ file, archived: true, ...await fileEvidence(file) });
          }
          const transcript = await nativeHistoryFile(join(spec.nativeRoot, 'sessions'), config.sessionKey);
          files.push({ file: transcript, archived: false, ...await fileEvidence(transcript) });
          const backupDirectory = join(config.workDirectory, hash(snapshot.id), 'backup');
          const manifest = JSON.parse(await readPrivateMaintenanceFile(join(backupDirectory, 'manifest.json')));
          const restored = join(spec.resultDirectory, 'backup-validation'); await mkdir(restored, { mode: 0o700 });
          const extract = async (sourceFile, wholeRoot = false) => {
            const records = manifest.records.filter(record => within(record.source, sourceFile)); assert.equal(records.length, 1);
            const record = records[0], root = join(restored, String(manifest.records.indexOf(record)));
            await mkdir(root, { mode: 0o700, recursive: true });
            const member = join(basename(record.source), relative(record.source, sourceFile));
            await execute(config.tar, ['-xf', join(backupDirectory, record.archive), '-C', root, '--', wholeRoot ? basename(record.source) : member],
              { timeout: 120_000, maxBuffer: 1024 });
            return join(root, member);
          };
          const restoredDb = await extract(spec.databaseFile, true);
          assert.deepEqual(await archiveDatabaseEvidence(restoredDb, spec.archiveBootstrap.sessions), stopped);
          for (const file of files) assert.deepEqual(await fileEvidence(await extract(file.file)), { bytes: file.bytes, sha256: file.sha256 });
          await service.verifyStopped();
          evidence.stoppedArchive = stopped; evidence.nativeFiles = files; evidence.backupVerified = true;
          await writeNew(join(spec.resultDirectory, 'stopped-archive-proof.json'), { stopped, files, backupId: snapshot.backupId });
          await save();
        },
      },
    });
    const inspect = adapter.inspect.bind(adapter);
    adapter.inspect = async snapshot => {
      const observation = await inspect(snapshot);
      evidence.observation = observation; await save(); return observation;
    };
    const ready = adapter.ready.bind(adapter);
    adapter.ready = async snapshot => {
      const result = await ready(snapshot);
      const after = await connector.inspect(snapshot);
      assert.ok(['activeRuns','backgroundTerminals','pendingExecutions','queuedMessages','inFlightWrites'].every(key => after[key] === 0));
      assert.notEqual(await invocation(), spec.archiveBootstrap.serviceInvocationId);
      for (const file of evidence.nativeFiles) {
        assert.deepEqual(await fileEvidence(file.file, file.archived ? undefined : file.bytes), { bytes: file.bytes, sha256: file.sha256 });
      }
      evidence.businessReady = result; evidence.after = after; await save(); return result;
    };
    job = journal.enqueue(job);
    evidence.status = 'observing'; await save();
    for (;;) {
      assert.ok(!job.executing, 'interrupted effects require operator review, never replay');
      if (terminalMaintenanceJob(job)) break;
      const next = await advanceMaintenance(job, journal, adapter); assert.ok(next, 'journal changed; do not retry an effect'); job = next;
      evidence.receipt = job;
      if (!evidence.stages.includes(job.stage)) evidence.stages.push(job.stage);
      await save();
      if (['drain', 'recheck'].includes(job.stage)) await delay(2000);
    }
    assert.equal(job.stage, 'succeeded', 'maintenance requires operator review');
    evidence.status = 'deployed-checking-web'; await save();
    evidence.web = [];
    for (const origin of spec.origins) evidence.web.push(await verifyWeb(origin, candidate.directory));
    await service.verifyRunning();
    assert.deepEqual(JSON.parse(await readPrivateMaintenanceFile(config.activeReleaseFile)), candidate);
    evidence.status = 'verified'; evidence.finishedAt = Date.now(); await save();
    return { status: evidence.status, jobId: id, resultDirectory: spec.resultDirectory };
  } catch {
    evidence.status = 'needs-review'; evidence.finishedAt = Date.now(); await save();
    // Never roll back databases, replay a request or silently release a fence.
    throw new Error('Archive bootstrap not confirmed; inspect its original receipt and private evidence');
  } finally { db?.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    assert.equal(process.argv.length, 5, 'Expected TOOLKIT TOOLKIT_SHA256 PRIVATE_SPEC');
    console.log(JSON.stringify(await runArchiveBootstrap({ toolkit: process.argv[2], toolkitSha256: process.argv[3], specFile: process.argv[4] })));
  } catch { console.error('Controlled maintenance not confirmed. Do not replay; inspect the persistent receipt.'); process.exitCode = 1; }
}
