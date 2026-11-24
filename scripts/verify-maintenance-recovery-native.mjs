// Opt-in helper for verify-maintenance-native.mjs. No production recovery gate
// is changed. It uses only that harness's freshly created native state/unit.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, readlink, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function processGone(identity) {
  try {
    const fields = (await readFile(`/proc/${identity.pid}/stat`, 'utf8')).split(') ').at(-1).split(' ');
    return fields[19] !== identity.start || fields[0] === 'Z';
  } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
const exists = file => stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

export function assertHeldRecoveryQueue({ queueId, marker, queue, events }) {
  assert.deepEqual(queue.map(row => ({ id: row.id, state: row.state })), [{ id: queueId, state: 'queued' }],
    'same queued command must remain held until business readiness');
  // Chat intentionally includes waiting messages. Visibility is not dispatch:
  // check durable queue identity/state and the native transcript instead.
  assert.equal(events.filter(event => event.type === 'user_message' && event.message?.includes(marker)).length, 0,
    'restored queue must not dispatch behind the maintenance fence');
}

export async function verifyNativeStoppedRecovery(f) {
  const { directory, state, settings, releases, jobs, journal, pointer, tokenFile, owner, nodeId,
    controller, sessionKey, sessionPath, secondaryKey, secondaryPath, secondaryHistory, connectorUrl,
    request, systemctl, unit, evidence, wait, turn, ConnectorTokenStore,
    MaintenanceConnectorClient, NodeMaintenanceAdapter, startMaintenanceHost } = f;
  const recovery = evidence.recovery = { source: 'real-native-http', queueSubmissions: 0, stopSubmissions: 0,
    restoredRuntimeBooted: false, originalStateResumed: false, provesOrdinaryStopBarrier: false };
  const childCheck = process.env.AOD_TEST_MAINTENANCE_RECOVERY_CHILD === '1';
  recovery.detachedChildFixture = childCheck;
  const workspace = join(state, 'workspace');
  const probe = join(workspace, 'recovery-probe.mjs');
  await writeFile(probe, `import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = new URL('./', import.meta.url);
const child = process.argv.includes('--child');
const prefix = child ? 'recovery-child' : 'recovery';
const fields = (await readFile('/proc/self/stat','utf8')).split(') ').at(-1).split(' ');
await writeFile(new URL(prefix+'-process.json',root), JSON.stringify({pid:process.pid,start:fields[19]}), {flag:'wx',mode:0o600});
if (${childCheck} && !child) spawn(process.execPath,[fileURLToPath(import.meta.url),'--child'],{detached:true,stdio:'ignore'}).unref();
await writeFile(new URL(prefix+'-started',root),'started',{flag:'wx',mode:0o600});
await new Promise(resolve=>setTimeout(resolve,90000));
await writeFile(new URL(prefix+'-done',root),'UNEXPECTED_COMPLETION',{flag:'wx',mode:0o600});
`, { flag: 'wx', mode: 0o600 });
  const beforeHistory = (await request(`${sessionPath}/messages?limit=200`)).messages;
  async function nativeEvents() {
    const rollouts = [];
    async function visit(root) {
      for (const item of await readdir(root, { withFileTypes: true })) {
        const file = join(root, item.name);
        if (item.isDirectory()) await visit(file);
        else if (item.isFile() && item.name.endsWith(`-${sessionKey.slice('codex:'.length)}.jsonl`)) rollouts.push(file);
      }
    }
    await visit(join(state, 'native/sessions'));
    assert.equal(rollouts.length, 1);
    return (await readFile(rollouts[0], 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      .filter(row => row.type === 'event_msg').map(row => row.payload);
  }
  const beforePin = await readFile(pointer);
  const beforePid = await systemctl('show', '--property=MainPID', '--value', unit);
  console.log('STEP recovery: real native tool and one queued successor');
  await request(`${sessionPath}/messages`, { message: `Execute exactly this harmless command once: /usr/bin/node ${probe}. `
    + 'It only writes the temporary test workspace. Wait for it to finish. Do not access other paths or use other tools.' }, 'fixture:recovery:tool');
  await wait('real recovery tool started', () => exists(join(workspace, 'recovery-started')));
  const identity = JSON.parse(await readFile(join(workspace, 'recovery-process.json'), 'utf8'));
  assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 1 && /^\d+$/.test(identity.start));
  assert.equal(await processGone(identity), false, 'real tool must still be alive before Stop');
  recovery.tool = identity;
  const tools = [identity];
  if (childCheck) {
    await wait('real detached child started', () => exists(join(workspace, 'recovery-child-started')));
    const child = JSON.parse(await readFile(join(workspace, 'recovery-child-process.json'), 'utf8'));
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 1 && /^\d+$/.test(child.start));
    assert.equal(await processGone(child), false);
    tools.push(child); recovery.child = child;
  }
  async function assertNoCompletion() {
    for (const prefix of childCheck ? ['recovery', 'recovery-child'] : ['recovery'])
      assert.equal(await exists(join(workspace, `${prefix}-done`)), false);
  }
  const active = await request(`${sessionPath}/state`);
  assert.ok(active.hasActiveRun && active.runtime?.turnId);
  recovery.runId = active.runtime.turnId;
  const queuedKey = 'fixture:recovery:successor';
  const marker = `RECOVERED_QUEUE_${randomUUID().replaceAll('-', '')}`;
  const queuedText = `Reply with exactly ${marker}. Do not use tools.`;
  recovery.queueSubmissions++;
  await request(`${sessionPath}/messages`, { message: queuedText }, queuedKey);
  const queueBefore = (await request(`${sessionPath}/queue`)).items;
  assert.equal(queueBefore.length, 1, 'successor must be durably queued behind the actual tool');
  recovery.queueId = queueBefore[0].id;
  recovery.stopSubmissions++;
  await request(`${sessionPath}/messages`, { message: '/stop', expectedRunId: active.runtime.turnId }, 'fixture:recovery:stop');
  const observed = await wait('authentic interrupted cleanup-unconfirmed recovery identity', async () => {
    const observation = await request('/maintenance/inspection');
    if (!observation.recoveryRuns?.some(run => run.sessionKey === sessionKey && run.runId === active.runtime.turnId)) return false;
    assert.equal(observation.activeRuns, 0);
    assert.equal(observation.queuedMessages, 1);
    return observation;
  }, 30_000);
  recovery.observed = observed;
  // A clean native stop is not evidence for the missing cleanup barrier. Fail
  // closed if no genuine recovery identity exists; never insert one into DB.
  recovery.toolAliveAfterNativeStop = !(await processGone(identity));
  if (childCheck) {
    recovery.childAliveAfterNativeStop = !(await processGone(tools[1]));
    assert.equal(recovery.childAliveAfterNativeStop, true,
      'surviving-child acceptance requires a genuinely live descendant, not just an unconfirmed projection');
  }
  await assertNoCompletion();
  assert.deepEqual((await request(`${sessionPath}/queue`)).items.map(row => row.id), [recovery.queueId]);
  const authorized = job => job.nodeId === nodeId && new ConnectorTokenStore(tokenFile).hasScope(job.actorId, 'connector:lifecycle');
  const connector = new MaintenanceConnectorClient({ connectorUrl, nodeId, credential: () => owner.token,
    authorize: job => { if (!authorized(job)) throw new Error('Fixture authority changed'); } });
  const adapter = new NodeMaintenanceAdapter({ nodeId, sessionKey: secondaryKey,
    releasesDirectory: releases, activeReleaseFile: pointer, workDirectory: jobs, backupRoots: [state, settings],
    tar: '/usr/bin/tar', service: controller, connector, authorize: async job => authorized(job),
    stoppedRecovery: { databaseFile: join(state, '.agentopsdeck-connector-users.sqlite') } });
  const originalRecover = adapter.recover.bind(adapter);
  const originalReleaseFence = adapter.releaseFence.bind(adapter);
  adapter.releaseFence = async job => {
    try {
      // Admission is paused, including ordinary business reads. The running
      // Connector also owns an exclusive SQLite lock. Use its real privileged
      // inspection here; exact queue identity is checked while stopped below.
      await assert.rejects(request(`${sessionPath}/queue`), /returned 503$/);
      const observation = await connector.inspect(job);
      assert.equal(observation.activeRuns, 0); assert.equal(observation.pendingExecutions, 0);
      assert.equal(observation.queuedMessages, 1);
      assert.equal((await nativeEvents()).filter(event => event.type === 'user_message' && event.message?.includes(marker)).length, 0);
      recovery.queuePreservedUntilRelease = true;
      return originalReleaseFence(job);
    } catch (error) {
      recovery.releaseProbeError = error instanceof Error ? error.message : 'Release probe failed';
      throw error;
    }
  };
  // Test-only restore at the stopped/backup boundary. Restore the entire node
  // and config at their original *temporary* paths (native rollouts store
  // absolute paths). Neither native metadata nor queue/execution facts edited.
  adapter.recover = async job => {
    await controller.verifyStopped();
    for (const tool of tools) assert.equal(await processGone(tool), true, 'whole service/cgroup stop must prove every exact tool exit');
    await assertNoCompletion();
    recovery.stoppedProcessVerified = true;
    const archiveDirectory = join(jobs, digest(job.id), 'backup');
    const manifest = JSON.parse(await readFile(join(archiveDirectory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.nodeId, nodeId); assert.equal(manifest.jobId, job.id);
    assert.deepEqual(manifest.records.map(record => record.source), [state, settings]);
    const restored = join(directory, 'restored-backup');
    await mkdir(restored, { mode: 0o700 });
    for (const [index, record] of manifest.records.entries()) {
      assert.equal(record.archive, `${index}.tar`);
      const archive = join(archiveDirectory, record.archive), bytes = await readFile(archive);
      assert.equal(bytes.length, record.bytes); assert.equal(digest(bytes), record.sha256);
      await execute('/usr/bin/tar', ['-xf', archive, '-C', restored], { timeout: 30_000 });
    }
    const database = join(state, '.agentopsdeck-connector-users.sqlite');
    const originalInode = (await stat(database)).ino;
    recovery.originalDatabaseSha256 = digest(await readFile(database));
    await rename(state, join(directory, 'original-stopped-node'));
    await rename(settings, join(directory, 'original-stopped-settings'));
    await cp(join(restored, 'node'), state, { recursive: true, errorOnExist: true, force: false });
    await cp(join(restored, 'settings'), settings, { recursive: true, errorOnExist: true, force: false });
    assert.notEqual((await stat(database)).ino, originalInode);
    assert.equal(digest(await readFile(database)), recovery.originalDatabaseSha256);
    assert.ok((await readFile(pointer)).equals(beforePin));
    recovery.restoredDatabaseIsDistinct = true;
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const fact = JSON.parse(db.prepare('SELECT fact FROM connector_codex_executions WHERE session_key = ?').get(sessionKey).fact);
      assert.equal(fact.runId, recovery.runId); assert.equal(fact.phase, 'interrupted');
      const queue = db.prepare('SELECT id, state, payload FROM connector_turns WHERE runtime = ? AND session_key = ? ORDER BY sequence')
        .all('codex', sessionKey);
      assertHeldRecoveryQueue({ queueId: recovery.queueId, marker, queue, events: await nativeEvents() });
      assert.equal(JSON.parse(queue[0].payload).text, queuedText);
    } finally { db.close(); }
    recovery.queuePreservedInRestoredDatabase = true;
    return originalRecover(job);
  };
  const hostOptions = { nodeId, journalFile: join(journal, 'recovery.sqlite'), tokenFile,
    protectedRoots: [state, settings, releases, jobs], adapter, operations: ['recover'], port: 0, tickMs: 100 };
  let host = await startMaintenanceHost(hostOptions);
  const key = 'fixture:recovery:maintenance';
  async function maintenance(path, body) {
    const response = await fetch(`http://127.0.0.1:${host.port}/api/maintenance/v1${path}`, {
      headers: { authorization: `Bearer ${owner.token}`, 'x-agentopsdeck-maintenance-protocol': '1',
        'x-agentopsdeck-expected-node-id': nodeId, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000), ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, body ? 202 : 200); return response.json();
  }
  try {
    console.log('STEP recovery: independent stop, stopped backup, restore, proof and readiness');
    await maintenance('/commands', { commandKey: key, operation: 'recover' });
    const stages = new Set();
    const job = await wait('real stopped recovery', async () => {
      const { command } = await maintenance(`/commands/${encodeURIComponent(key)}`);
      if (!stages.has(command.stage)) console.log('RECOVERY_STAGE', command.stage);
      stages.add(command.stage);
      recovery.receipt = command;
      if (command.stage === 'attention') throw new Error(`Recovery needs attention at ${command.failedStage}: ${command.reason}`);
      return command.stage === 'succeeded' ? command : false;
    });
    assert.equal((await request('/identity')).nodeId, nodeId);
    const restoredPid = await systemctl('show', '--property=MainPID', '--value', unit);
    assert.notEqual(restoredPid, beforePid);
    assert.equal(await readlink(`/proc/${restoredPid}/cwd`), state);
    recovery.restoredRuntimeBooted = true;
    assert.deepEqual((await request(`${secondaryPath}/messages?limit=200`)).messages, secondaryHistory.messages);
    await wait('original queued successor completes once from restored backup', async () => {
      const status = await request(`${sessionPath}/state`);
      if (status.runtime?.phase === 'failed') throw new Error('Recovered queue execution failed');
      if (status.runtime?.phase !== 'completed' || status.runtime?.sync !== 'current' || status.hasActiveRun) return false;
      const history = (await request(`${sessionPath}/messages?limit=200`)).messages;
      assert.deepEqual(history.slice(0, beforeHistory.length), beforeHistory);
      assert.equal(history.filter(row => row.role === 'user' && row.text?.includes(marker)).length, 1);
      assert.equal(history.filter(row => row.role === 'assistant' && row.text?.trim() === marker).length, 1);
      recovery.successorRunId = status.runtime.turnId;
      return true;
    });
    assert.equal((await request(`${sessionPath}/queue`)).items.length, 0);
    for (const tool of tools) assert.equal(await processGone(tool), true);
    await assertNoCompletion();
    await host.close(); host = await startMaintenanceHost(hostOptions);
    assert.equal((await maintenance(`/commands/${encodeURIComponent(key)}`)).command.id, job.id);
    assert.equal((await maintenance('/commands', { commandKey: key, operation: 'recover' })).command.stage, 'succeeded');
    assert.equal(await systemctl('show', '--property=MainPID', '--value', unit), restoredPid);
    await turn('RESTORED_NATIVE_FOLLOWUP_OK');
    const history = (await request(`${sessionPath}/messages?limit=200`)).messages;
    assert.equal(history.filter(row => row.role === 'user' && row.text?.includes(marker)).length, 1);
    // Projection deduplication alone cannot certify exactly-once execution.
    // Also count the real persisted native task_started/user_message events.
    const events = await nativeEvents();
    assert.equal(events.filter(event => event.type === 'task_started' && event.turn_id === recovery.successorRunId).length, 1);
    assert.equal(events.filter(event => event.type === 'user_message' && event.message?.includes(marker)).length, 1);
    recovery.nativeSuccessorStarts = 1;
    assert.equal(digest(await readFile(join(directory, 'original-stopped-node/.agentopsdeck-connector-users.sqlite'))),
      recovery.originalDatabaseSha256, 'displaced original database must not be reopened or changed');
    recovery.queueExactlyOnce = true;
    recovery.receiptSurvivedSupervisorRestart = true;
    recovery.stages = [...stages];
    evidence.checks.push({ operation: 'recover-restored-backup', passed: true });
    console.log('PASS real native recovery, booted restored backup, original queue executed once');
  } finally { await host.close(); }
}
