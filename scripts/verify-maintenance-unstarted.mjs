// Isolated OS + journal acceptance. Synthetic HTTP represents only released
// admission, not business readiness. Never accesses production credentials/data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';
import { reconcileLocalMaintenance } from './reconcile-local-maintenance.mjs';
import { ConnectorTokenStore } from '../apps/server/dist/auth/connector-token.js';
import { SqliteMaintenanceJournal } from '../apps/server/dist/lifecycle/maintenance-journal.js';
import { newMaintenanceJob, advanceMaintenance } from '../apps/server/dist/lifecycle/connector-maintenance.js';
import { SystemdConnectorService } from '../apps/server/dist/lifecycle/maintenance-systemd.js';
import { NodeMaintenanceAdapter } from '../apps/server/dist/lifecycle/maintenance-node-adapter.js';

const toolkit = process.argv[2]; assert.ok(toolkit);
const toolkitSha256 = (await verifyCandidateRelease(toolkit)).manifestSha256;
const root = await mkdtemp('/tmp/agentopsdeck-unstarted-acceptance-');
const unit = `agentopsdeck-unstarted-check-${randomBytes(6).toString('hex')}.service`;
const workerUnit = unit.replace('check-', 'supervisor-');
const runtime = `/run/user/${process.getuid()}`;
const unitFile = join(runtime, 'systemd/user', unit), workerFile = join(dirname(unitFile), workerUnit);
const env = { ...process.env, XDG_RUNTIME_DIR: runtime, LC_ALL: 'C', TZ: 'UTC' };
const ctl = (...args) => execFileSync('/usr/bin/systemctl', ['--user', ...args], { env, encoding: 'utf8', timeout: 15000 }).trim();
const write = (path, content) => writeFile(path, content, { mode: 0o600, flag: 'wx' });
const nodeId = 'node:synthetic-unstarted';
let closedAdmission = false;
const server = createServer((req, res) => {
  assert.equal(req.method, 'GET');
  res.setHeader('x-agentopsdeck-node-id', nodeId); res.setHeader('x-agentopsdeck-protocol', '1');
  res.setHeader('content-type', 'application/json');
  if (req.url.endsWith('/status')) res.end(JSON.stringify({ state: closedAdmission ? 'paused' : 'released', boundary: 'admission_only', nativeQuiescent: false }));
  else { res.statusCode = 404; res.end('{}'); }
});
let db, created = false, workerUnloaded = false;
const evidence = { root, passed: false, cleanup: false, productionTouched: false };
try {
  for (const name of ['settings', 'state', 'jobs', 'releases']) await mkdir(join(root, name), { mode: 0o700 });
  const releaseDir = join(root, 'releases/previous'); await cp(toolkit, releaseDir, { recursive: true, force: false, errorOnExist: true });
  const previous = { format: 1, directory: releaseDir, revision: 'a'.repeat(40), manifestSha256: toolkitSha256 };
  const pointer = join(root, 'settings/active.json'); await write(pointer, JSON.stringify(previous));
  await write(unitFile, `[Service]\nExecStart=/bin/sleep 300\nKillMode=control-group\nDelegate=yes\nRestart=no\n`);
  await write(workerFile, '[Service]\nExecStart=/bin/sleep 300\nKillMode=control-group\nDelegate=no\nRestart=no\n');
  created = true; ctl('daemon-reload'); ctl('start', unit);
  const controlGroup = ctl('show', '--value', '-p', 'ControlGroup', unit);
  const pid = ctl('show', '--value', '-p', 'MainPID', unit);
  const service = { unit, controlGroup, systemctl: '/usr/bin/systemctl' };
  const tokenFile = join(root, 'state/tokens.json'), tokens = new ConnectorTokenStore(tokenFile);
  const owner = tokens.create({ label: 'synthetic acceptance', scopes: ['connector:lifecycle'] });
  const credentialFile = join(root, 'settings/key'); await write(credentialFile, owner.token);
  const actorId = tokens.requireScope(new Request('http://127.0.0.1', { headers: { authorization: `Bearer ${owner.token}` } }), 'connector:lifecycle').tokenId;
  const commandKey = 'synthetic-prepare-failure', at = Date.now();
  const jobId = `maintenance:${createHash('sha256').update(JSON.stringify([nodeId, actorId, commandKey])).digest('hex')}`;
  const job = newMaintenanceJob({ id: jobId, nodeId, actorId, operation: 'upgrade', createdAt: at, deadline: at + 60000 });
  const intentFile = join(root, 'settings/intent.json'); await write(intentFile, JSON.stringify({ commandKey, previous, at }));
  const journalFile = join(root, 'journal.sqlite'); db = new DatabaseSync(journalFile);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL'); const journal = new SqliteMaintenanceJournal(db); journal.enqueue(job);
  const adapter = new NodeMaintenanceAdapter({ nodeId, sessionKey: 'codex:synthetic', releasesDirectory: join(root, 'releases'),
    activeReleaseFile: pointer, workDirectory: join(root, 'jobs'), backupRoots: [join(root, 'state'), join(root, 'settings')],
    tar: '/usr/bin/tar', authorize: async () => true, service: new SystemdConnectorService(service), connector: {} });
  const failed = await advanceMaintenance(job, journal, adapter);
  assert.equal(failed.failedStage, 'prepare'); assert.equal(failed.revision, 2); db.close(); db = undefined;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const configFile = join(root, 'settings/config.json');
  await write(configFile, JSON.stringify({ format: 1, nodeId, sessionKey: 'codex:synthetic',
    connectorUrl: `http://127.0.0.1:${server.address().port}`, credentialFile, tokenFile, journalFile,
    listener: { hostname: '127.0.0.1', port: 8793 }, service: { ...service, allowDelegated: true },
    releasesDirectory: join(root, 'releases'), activeReleaseFile: pointer, workDirectory: join(root, 'jobs'),
    backupRoots: [join(root, 'settings'), join(root, 'state')], tar: '/usr/bin/tar' }));
  const options = { toolkit, toolkitSha256, configFile, jobId, expectedRevision: 2, workerUnit, action: 'cancel-unstarted', intentFile };
  ctl('start', workerUnit); await assert.rejects(reconcileLocalMaintenance(options)); ctl('stop', workerUnit);
  await unlink(workerFile); workerUnloaded = true; ctl('daemon-reload');
  assert.equal(ctl('show', '--value', '-p', 'LoadState', workerUnit), 'not-found');
  const directory = join(root, 'jobs', createHash('sha256').update(jobId).digest('hex'));
  await mkdir(directory, { mode: 0o700 }); await assert.rejects(reconcileLocalMaintenance(options)); await rmdir(directory);
  closedAdmission = true; await assert.rejects(reconcileLocalMaintenance(options)); closedAdmission = false;
  const result = await reconcileLocalMaintenance(options); assert.equal(result.stage, 'cancelled'); assert.equal(result.revision, 3);
  await assert.rejects(reconcileLocalMaintenance(options));
  assert.equal(ctl('show', '--value', '-p', 'MainPID', unit), pid);
  assert.deepEqual(JSON.parse(await readFile(pointer, 'utf8')), previous);
  db = new DatabaseSync(journalFile); const reopened = new SqliteMaintenanceJournal(db);
  assert.equal(reopened.get(jobId).stage, 'cancelled'); assert.equal(reopened.unresolved(nodeId), undefined);
  assert.equal(db.prepare('SELECT count(*) AS n FROM connector_maintenance_reconciliations').get().n, 1);
  evidence.passed = true; evidence.revision = result.revision;
} catch { process.exitCode = 1; evidence.failure = 'Isolated unstarted-preparation acceptance failed'; }
finally {
  db?.close(); await new Promise(resolve => server.close(resolve));
  if (created) { ctl('stop', unit); if (!workerUnloaded) { ctl('stop', workerUnit); await unlink(workerFile); } await unlink(unitFile); ctl('daemon-reload'); }
  evidence.cleanup = true; await write(join(root, 'result.json'), JSON.stringify(evidence)); console.log(JSON.stringify(evidence));
}
