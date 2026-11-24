import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { lstat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';

/** Explicit one-shot local reconciliation, run in its own systemd cgroup with
 * the maintenance host stopped. Never stops/starts a service or clears a fence.
 * No credentials, native transcripts or raw exception details are printed.
 */
export function reconciliationOrigin(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
  'Reconciliation requires an explicit loopback origin');
  return url.origin;
}

// This accepts only the independently supervised deployment/acceptance receipt
// format, not a green HTTP health check or an operator-supplied boolean.
export function replacementReceiptProof({ deployment, acceptance, current, service, nodeId, now = Date.now() }) {
  const deployed = JSON.parse(deployment), accepted = JSON.parse(acceptance);
  assert.equal(deployed.stage, 'verified'); assert.equal(accepted.stage, 'verified');
  assert.equal(deployed.activated, true); assert.equal(deployed.admissionReleased, true);
  assert.deepEqual(deployed.candidate, current);
  assert.equal(deployed.service?.MainPID, service.pid);
  assert.equal(deployed.service?.InvocationID, service.invocation);
  assert.equal(deployed.service?.ActiveState, 'active');
  assert.deepEqual(deployed.liveAcceptance, accepted);
  const completed = Date.parse(deployed.finishedAt), verified = Date.parse(accepted.finishedAt);
  assert.ok(Number.isFinite(verified) && verified >= service.startedAt && completed >= verified && completed <= now);
  assert.ok(deployed.proofs?.some(proof => proof.nodeId === nodeId && proof.businessReadVerified === true
    && proof.projectionVerified === true));
  assert.ok(deployed.backups?.length > 0 && deployed.backups.every(backup => /^[a-f0-9]{64}$/.test(backup.sha256)));
  assert.ok(accepted.checks?.length > 0 && accepted.checks.every(check => check.status === 200
    && check.preservedInputs === true && check.realNativeOutput === true));
  assert.equal(accepted.originalInputsDispatched, true);
  assert.ok(accepted.newAssistantMessages?.length > 0); assert.deepEqual(accepted.queue, []);
  const digest = value => createHash('sha256').update(value).digest('hex');
  return { release: { revision: current.revision, manifestSha256: current.manifestSha256 },
    deploymentSha256: digest(deployment), acceptanceSha256: digest(acceptance) };
}

export async function reconcileLocalMaintenance({ toolkit, toolkitSha256, configFile, jobId, expectedRevision, workerUnit, action = 'resume', intentFile, dryRun = false }) {
  assert.ok(['resume', 'cancel', 'cancel-superseded', 'cancel-replaced', 'cancel-unstarted'].includes(action));
  assert.ok(typeof dryRun === 'boolean' && (!dryRun || action === 'cancel-unstarted'));
  assert.match(toolkitSha256, /^[a-f0-9]{64}$/);
  assert.equal((await verifyCandidateRelease(toolkit)).manifestSha256, toolkitSha256);
  const module = name => import(pathToFileURL(join(toolkit, 'apps/server/dist', name)).href);
  const { readPrivateMaintenanceFile, maintenanceHostConfiguration } = await module('lifecycle/maintenance-entry.js');
  const { verifyNodeRelease } = await module('lifecycle/maintenance-node-adapter.js');
  const { SystemdConnectorService } = await module('lifecycle/maintenance-systemd.js');
  const { ConnectorTokenStore } = await module('auth/connector-token.js');
  const { SqliteMaintenanceJournal } = await module('lifecycle/maintenance-journal.js');
  const reconciliation = await module('lifecycle/maintenance-reconciliation.js');
  const reconcile = action === 'cancel-unstarted' ? reconciliation.cancelUnstartedPreparation
    : ['cancel-superseded', 'cancel-replaced'].includes(action) ? reconciliation.cancelSupersededPreFenceMaintenance
    : action === 'cancel' ? reconciliation.cancelPreFenceMaintenance : reconciliation.reconcilePreFenceMaintenance;
  assert.equal(typeof reconcile, 'function', 'Pinned toolkit does not support this operator action');
  const config = maintenanceHostConfiguration(JSON.parse(await readPrivateMaintenanceFile(configFile)));
  const origin = reconciliationOrigin(config.connectorUrl);
  assert.match(workerUnit, /^[A-Za-z0-9_.@-]+\.service$/);
  assert.notEqual(workerUnit, config.service.unit);
  const worker = new SystemdConnectorService({ ...config.service, allowDelegated: false, allowUnloadedStopped: true, unit: workerUnit,
    controlGroup: `${dirname(config.service.controlGroup)}/${workerUnit}` });
  const service = new SystemdConnectorService(config.service);
  await worker.verifyStopped();
  await service.verifyRunning(); // Also proves this process is outside the target.
  const serviceState = () => {
    const out = execFileSync(config.service.systemctl, ['--user', 'show', config.service.unit,
      '--property=MainPID,InvocationID,ExecMainStartTimestamp'], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    });
    const fields = Object.fromEntries(out.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    assert.match(fields.MainPID, /^[1-9]\d*$/); assert.match(fields.InvocationID, /^[a-f0-9]{32}$/);
    return { pid: fields.MainPID, invocation: fields.InvocationID, startedAt: Date.parse(fields.ExecMainStartTimestamp) };
  };
  // Validate private journal metadata without reading its binary bytes through
  // another fd (which can release POSIX locks). Worker exit was proven above.
  const { lstat, realpath } = await import('node:fs/promises');
  const parent = await lstat(dirname(config.journalFile));
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && !(parent.mode & 0o077) && parent.uid === process.getuid());
  const stat = await lstat(config.journalFile);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && !(stat.mode & 0o077) && stat.uid === process.getuid());
  assert.equal(await realpath(dirname(config.journalFile)), dirname(config.journalFile));
  const db = new DatabaseSync(config.journalFile);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const journal = new SqliteMaintenanceJournal(db), original = journal.get(jobId);
    assert.ok(original); assert.equal(original.revision, expectedRevision); assert.equal(original.nodeId, config.nodeId);
    const credential = (await readPrivateMaintenanceFile(config.credentialFile)).trim();
    assert.ok(credential && !/\s/.test(credential));
    const authorize = async job => {
      const tokens = new ConnectorTokenStore(config.tokenFile);
      const principal = tokens.requireScope(new Request(config.connectorUrl, { headers: { authorization: `Bearer ${credential}` } }), 'connector:lifecycle');
      return job.nodeId === config.nodeId && principal?.tokenId === job.actorId;
    };
    const read = async (path, status = 200) => {
      assert.ok(await authorize(original));
      const response = await fetch(`${origin}/api/connector/v1/maintenance/${path}`, {
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${credential}`, 'x-agentopsdeck-protocol': '1', 'x-agentopsdeck-expected-node-id': config.nodeId },
      });
      assert.equal(response.status, status); assert.equal(response.headers.get('x-agentopsdeck-node-id'), config.nodeId);
      assert.equal(response.headers.get('x-agentopsdeck-protocol'), '1');
      if (status === 404) { await response.body?.cancel(); return; }
      const reader = response.body.getReader(); let bytes = 0; const chunks = [];
      try { for (;;) { const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength; assert.ok(bytes <= 32768); chunks.push(part.value); } }
      finally { await reader.cancel(); reader.releaseLock(); }
      assert.ok(await authorize(original));
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    const selectedJournal = dryRun ? { cancelUnstartedPreparation: () => structuredClone(original) } : journal;
    const result = await reconcile(original, { journal: selectedJournal, authorize, inspect: async job => {
      await worker.verifyStopped(); await service.verifyRunning(); const before = serviceState();
      const directory = join(config.workDirectory, createHash('sha256').update(job.id).digest('hex'));
      const release = async file => verifyNodeRelease(JSON.parse(await readPrivateMaintenanceFile(file)), config.releasesDirectory, true);
      if (action === 'cancel-unstarted') {
        const absent = async () => {
          try { await lstat(directory); assert.fail('Partial preparation must remain blocked'); }
          catch (error) { assert.equal(error.code, 'ENOENT'); }
        };
        await absent();
        const intent = JSON.parse(await readPrivateMaintenanceFile(intentFile));
        assert.equal(job.id, `maintenance:${createHash('sha256').update(JSON.stringify([job.nodeId, job.actorId, intent.commandKey])).digest('hex')}`);
        assert.ok(Number.isSafeInteger(intent.at) && intent.at <= job.createdAt && intent.at >= job.createdAt - 60_000);
        const previous = await verifyNodeRelease(intent.previous, config.releasesDirectory, true);
        const current = await release(config.activeReleaseFile); assert.deepEqual(current, previous);
        const key = `lifecycle:${createHash('sha256').update(JSON.stringify([job.id, job.revision - 1, 'pause'])).digest('hex')}`;
        await read(`commands/pause/${encodeURIComponent(key)}`, 404);
        const state = await read('status');
        assert.equal(state.state, 'released'); assert.equal(state.boundary, 'admission_only');
        assert.equal(state.nativeQuiescent, false);
        assert.deepEqual(JSON.parse(await readPrivateMaintenanceFile(config.activeReleaseFile)), current);
        await absent(); await worker.verifyStopped(); await service.verifyRunning(); assert.deepEqual(serviceState(), before);
        return { nodeId: job.nodeId, observedAt: Date.now(), workerStopped: true, serviceRunning: true,
          serviceStartedAt: before.startedAt, serviceInvocationId: before.invocation, originalRelease: current,
          originalReleaseVerified: true, preparationDirectoryAbsent: true, admissionReleased: true, failedInvocationFenceAbsent: true };
      }
      const previous = await release(join(directory, 'previous.json'));
      const current = await release(config.activeReleaseFile);
      if (!['cancel-superseded', 'cancel-replaced'].includes(action)) assert.deepEqual(current, previous);
      const candidate = await release(join(directory, 'candidate.json'));
      if (action === 'cancel-superseded') assert.deepEqual(current, candidate);
      let replacementAcceptance;
      if (action === 'cancel-replaced') {
        const receipts = JSON.parse(await readPrivateMaintenanceFile(intentFile));
        const deployment = await readPrivateMaintenanceFile(receipts.deployment);
        const acceptance = await readPrivateMaintenanceFile(receipts.acceptance);
        replacementAcceptance = replacementReceiptProof({ deployment, acceptance, current, service: before, nodeId: config.nodeId });
        assert.equal(replacementAcceptance.deploymentSha256, receipts.deploymentSha256);
        assert.equal(replacementAcceptance.acceptanceSha256, receipts.acceptanceSha256);
      }
      // For legacy failures without a failedStage, rule out an unacknowledged
      // pause from the last durable invocation. No mutation is ever retried.
      const key = `lifecycle:${createHash('sha256').update(JSON.stringify([job.id, job.revision - 1, 'pause'])).digest('hex')}`;
      await read(`commands/pause/${encodeURIComponent(key)}`, 404);
      const state = await read('status');
      assert.equal(state.state, 'released'); assert.equal(state.boundary, 'admission_only'); assert.equal(state.nativeQuiescent, false);
      assert.deepEqual(JSON.parse(await readPrivateMaintenanceFile(config.activeReleaseFile)), current);
      await worker.verifyStopped(); await service.verifyRunning(); assert.deepEqual(serviceState(), before);
      if (['cancel-superseded', 'cancel-replaced'].includes(action)) return {
        nodeId: config.nodeId, observedAt: Date.now(), workerStopped: true, serviceStartedAt: before.startedAt,
        serviceInvocationId: before.invocation, serviceRunning: true, previousReleaseVerified: true,
        candidate, currentRelease: current, admissionReleased: true, failedInvocationFenceAbsent: true,
        ...(replacementAcceptance ? { replacementAcceptance } : {}),
      };
      return { nodeId: config.nodeId, observedAt: Date.now(), workerStopped: true, serviceStartedAt: before.startedAt,
        serviceRunning: true, originalReleaseVerified: true, candidate, admissionReleased: true, failedInvocationFenceAbsent: true };
    } });
    assert.ok(result, 'Original receipt changed; do not repeat automatically');
    return { id: result.id, revision: result.revision, stage: result.stage, deadline: result.deadline,
      ...(dryRun ? { preconditionsVerified: true, dryRun: true } : { originalReceiptArchived: true }) };
  } finally { db.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    assert.ok(process.argv.length >= 8 && process.argv.length <= 10,
      'Expected TOOLKIT TOOLKIT_SHA256 CONFIG JOB_ID REVISION WORKER_UNIT [resume|cancel|cancel-superseded|cancel-replaced|cancel-unstarted] [EVIDENCE]');
    const [, , toolkit, toolkitSha256, configFile, jobId, revision, workerUnit, action = 'resume', intentFile] = process.argv;
    const expectedRevision = Number(revision); assert.ok(Number.isSafeInteger(expectedRevision) && expectedRevision > 1);
    console.log(JSON.stringify(await reconcileLocalMaintenance({ toolkit, toolkitSha256, configFile, jobId, expectedRevision, workerUnit, action, intentFile })));
  } catch { console.error('Local reconciliation not confirmed; preserve and inspect the original journal.'); process.exitCode = 1; }
}
