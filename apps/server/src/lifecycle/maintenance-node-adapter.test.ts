import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { serve } from '@hono/node-server';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { loadConfig } from '../config.js';
import { createConnectorRuntime } from '../connector/runtime.js';
import { EXPECTED_NODE_HEADER } from '../connector/node-identity.js';
import { advanceMaintenance, newMaintenanceJob, type MaintenanceJob } from './connector-maintenance.js';
import { SqliteMaintenanceJournal } from './maintenance-journal.js';
import { MaintenanceConnectorClient } from './maintenance-connector-client.js';
import { startMaintenanceHost } from './maintenance-host.js';
import { MAINTENANCE_API, MAINTENANCE_PROTOCOL_HEADER } from './maintenance-http.js';
import { NodeMaintenanceAdapter, verifyNodeRelease, type NodeRelease } from './maintenance-node-adapter.js';
import type { PreparationCommand } from './maintenance-preparation.js';
import { initializeStoppedCodexRecovery, hasStoppedCodexRecovery } from '../codex/stopped-recovery.js';

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function files(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-node-maintenance-'));
  const releases = join(root, 'releases'), settings = join(root, 'settings'), work = join(root, 'work');
  for (const directory of [releases, settings, work]) mkdirSync(directory, { mode: 0o700 });
  const directory = join(releases, 'initial');
  mkdirSync(join(directory, 'apps/server/dist'), { recursive: true, mode: 0o700 });
  const text = 'export {};\n', path = 'apps/server/dist/index.js';
  writeFileSync(join(directory, path), text);
  const manifest = JSON.stringify({ format: 1, platform: process.platform, arch: process.arch,
    entrypoint: path, files: [{ path, bytes: Buffer.byteLength(text), sha256: hash(text) }] });
  writeFileSync(join(directory, 'candidate-manifest.json'), manifest);
  const release: NodeRelease = { format: 1, directory, revision: 'a'.repeat(40), manifestSha256: hash(manifest) };
  const pointer = join(settings, 'active.json');
  writeFileSync(pointer, JSON.stringify(release), { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, releases, settings, work, directory, release, pointer };
}

test('node release verifies actual complete inventory, not descriptor/revision metadata', async t => {
  const f = files(t);
  assert.deepEqual(await verifyNodeRelease(f.release, f.releases), f.release);
  writeFileSync(join(f.directory, 'apps/server/dist/index.js'), 'changed bytes');
  await assert.rejects(verifyNodeRelease(f.release, f.releases), /unavailable/);
});

test('expired authorization cannot admit filesystem or service effects after the await', async t => {
  const f = files(t), effects: string[] = [];
  const job = newMaintenanceJob({ id: 'expired-authorization', nodeId: 'node', actorId: 'actor',
    operation: 'upgrade', createdAt: Date.now(), deadline: Date.now() + 60_000 });
  const adapter = new NodeMaintenanceAdapter({ nodeId: 'node', sessionKey: 'codex:fixture',
    releasesDirectory: f.releases, activeReleaseFile: f.pointer, workDirectory: f.work,
    backupRoots: [f.settings], tar: '/usr/bin/tar',
    authorize: async () => { await Promise.resolve(); job.deadline = Date.now() - 1; return true; },
    service: { verifyRunning: async () => { effects.push('verifyRunning'); },
      verifyStopped: async () => { effects.push('verifyStopped'); },
      stop: async () => { effects.push('stop'); }, start: async () => { effects.push('start'); } },
    connector: {} as MaintenanceConnectorClient });
  await assert.rejects(adapter.prepare(job), /unavailable/);
  assert.deepEqual(effects, []);
  assert.deepEqual(JSON.parse(readFileSync(f.pointer, 'utf8')), f.release);
});

test('archive bootstrap is denied by ordinary adapter; failed stopped evidence never selects candidate or starts', async t => {
  const f = files(t), effects: string[] = [];
  const candidate = { ...f.release, revision: 'b'.repeat(40) };
  const proof = ({ revision, manifestSha256 }: NodeRelease) => ({ revision, manifestSha256 });
  const job: MaintenanceJob = { ...newMaintenanceJob({ id: 'bootstrap', nodeId: 'node', actorId: 'actor',
    operation: 'upgrade', createdAt: Date.now(), deadline: Date.now() + 60_000 }),
    archiveBootstrap: { authorizationId: 'one-window', serviceInvocationId: 'c'.repeat(32),
      previous: proof(f.release), candidate: proof(candidate), sessions: ['codex:01a0adde-49f0-7382-8068-c87f9b68d3fa'] } };
  let running = true;
  const options = { nodeId: 'node', sessionKey: 'codex:fixture', releasesDirectory: f.releases,
    activeReleaseFile: f.pointer, workDirectory: f.work, backupRoots: [f.settings], tar: '/usr/bin/tar',
    authorize: async () => true,
    service: { verifyRunning: async () => { assert.ok(running); }, verifyStopped: async () => { assert.ok(!running); },
      stop: async () => { effects.push('stop'); running = false; }, start: async () => { effects.push('start'); running = true; } },
    connector: { inspect: async () => ({ nodeId: 'node', observedAt: Date.now(), nativeVerified: true,
      activeRuns: 0, backgroundTerminals: 0, pendingExecutions: 1, queuedMessages: 0, inFlightWrites: 0, fenceId: 'fence' }) } as unknown as MaintenanceConnectorClient,
    prepare: { executable: '/usr/bin/node', args: [], systemdRun: '/usr/bin/systemd-run', systemctl: '/usr/bin/systemctl' },
    runPreparation: async (_command: PreparationCommand, cwd: string) => {
      writeFileSync(join(cwd, 'prepared.json'), JSON.stringify(candidate), { mode: 0o600 });
    } };
  const ordinary = new NodeMaintenanceAdapter(options);
  assert.equal(await ordinary.authorize(job), false);
  await assert.rejects(ordinary.prepare(job));
  assert.equal(effects.length, 0);
  const adapter = new NodeMaintenanceAdapter({ ...options, archiveBootstrap: {
    beforeStop: async () => { effects.push('beforeStop'); },
    verifyStoppedArchive: async () => { effects.push('verifyArchive'); throw new Error('wrong archived identity'); },
  } });
  const release = await adapter.prepare(job);
  const fenced = { ...job, release, fenceId: 'fence' };
  await adapter.stop(fenced);
  const backup = await adapter.backup(fenced);
  await assert.rejects(adapter.activate({ ...fenced, backupId: backup.backupId }), /wrong archived identity/);
  assert.deepEqual(effects, ['beforeStop', 'stop', 'verifyArchive']);
  assert.deepEqual(JSON.parse(readFileSync(f.pointer, 'utf8')), f.release);
  assert.equal(running, false);
});

test('release links, extras, outside paths and foreign platform are not admitted', async t => {
  const f = files(t);
  await assert.rejects(verifyNodeRelease({ ...f.release, directory: f.root }, f.releases));
  await assert.rejects(verifyNodeRelease({ ...f.release, revision: 'main' }, f.releases));
  await assert.rejects(verifyNodeRelease({ ...f.release, shell: 'run' }, f.releases));
  symlinkSync(join(f.directory, 'apps/server/dist/index.js'), join(f.directory, 'extra'));
  await assert.rejects(verifyNodeRelease(f.release, f.releases), /unavailable/);
});

/** Real HTTP, durable coordinator, tar backup and Connector close/reopen.
 * OS service transitions and native history are simulated; no real systemd
 * unit, downstream Agent process or model/provider is used by this test.
 */
async function chain(t: TestContext, readinessFails = false, upgrade = false, corruptBackup = false) {
  const f = files(t), state = join(f.root, 'runtime'), journal = join(f.root, 'supervisor');
  mkdirSync(state, { mode: 0o700 }); mkdirSync(journal, { mode: 0o700 });
  const workspace = join(state, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(join(workspace, '用户文件.md'), '# Preserved workspace\n', { mode: 0o600 });
  let target = f.release;
  const builder = join(f.settings, 'synthetic-builder.mjs');
  if (upgrade) {
    const directory = join(f.releases, 'next');
    mkdirSync(join(directory, 'apps/server/dist'), { recursive: true, mode: 0o700 });
    const text = 'export const upgraded = true;\n', path = 'apps/server/dist/index.js';
    writeFileSync(join(directory, path), text);
    const manifest = JSON.stringify({ format: 1, platform: process.platform, arch: process.arch,
      entrypoint: path, files: [{ path, bytes: Buffer.byteLength(text), sha256: hash(text) }] });
    writeFileSync(join(directory, 'candidate-manifest.json'), manifest);
    target = { format: 1, directory, revision: 'b'.repeat(40), manifestSha256: hash(manifest) };
    writeFileSync(builder, `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv.at(-1), ${JSON.stringify(JSON.stringify(target))}, {flag:'wx',mode:0o600});\n`);
  }
  const config = loadConfig({ AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(state, 'connector.sqlite'), AOD_CONNECTOR_TOKENS_FILE: join(state, 'tokens.json'),
    AOD_SESSION_TITLES_FILE: join(state, 'titles.json'), AOD_QUEUE_FILE: join(state, 'queue.json'),
    AOD_MIRROR_OUTBOX_FILE: join(state, 'mirror.json'), AOD_ARTIFACT_INDEX_FILE: join(state, 'artifacts.json'),
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(state, 'update.json'), AOD_CONNECTOR_UPDATE_ENABLED: 'false' });
  config.connector.revision = f.release.revision;
  const tokenFile = config.connector.tokenFile, tokens = new ConnectorTokenStore(tokenFile);
  const owner = tokens.create({ label: 'synthetic lifecycle', scopes: ['connector:lifecycle'] });
  const sessionKey = 'codex:completed-history', effects: string[] = [];
  let running = true, runtime = createConnectorRuntime(config, () => false), starts = 0;
  const native = () => {
    t.mock.getter(runtime.codex, 'enabled', () => true);
    t.mock.method(runtime.codex, 'refreshSessions', async () => {
      runtime.store.upsertSession({ sessionKey, agentId: 'codex', title: 'Synthetic', status: 'idle', hasActiveRun: false,
        runtime: { phase: 'completed', sync: 'current', connection: 'connected', lastEventAt: 1 } });
    });
    t.mock.method(runtime.codex, 'refreshSession', async () => {
      if (readinessFails && starts) throw new Error('private history failure');
      runtime.store.addMessage({ sessionKey, id: 'old:user', role: 'user', text: 'synthetic question', createdAt: 1 });
      runtime.store.addMessage({ sessionKey, id: 'old:reply', role: 'assistant', text: 'synthetic reply', createdAt: 2 });
    });
    t.mock.method(runtime.codex, 'isSessionListReady', () => true);
    t.mock.method(runtime.codex, 'isSessionHistoryReady', () => true);
  };
  native();
  const nodeId = runtime.connectorUsers.nodeId;
  let listener!: ReturnType<typeof serve>;
  const address = await new Promise<{ port: number }>(resolve => {
    listener = serve({ hostname: '127.0.0.1', port: 0,
      fetch: request => running ? runtime.app.fetch(request) : new Response(null, { status: 503 }) }, resolve);
  });
  const authorized = (job: Readonly<MaintenanceJob>) => job.nodeId === nodeId
    && new ConnectorTokenStore(tokenFile).hasScope(job.actorId, 'connector:lifecycle');
  const client = new MaintenanceConnectorClient({ connectorUrl: `http://127.0.0.1:${address.port}`, nodeId,
    credential: () => owner.token, authorize: job => { if (!authorized(job)) throw new Error('revoked'); } });
  const service = {
    async verifyRunning() { assert.equal(running, true); },
    async verifyStopped() { assert.equal(running, false); },
    async stop() { effects.push('stop'); assert.equal(running, true); await runtime.close(); running = false; },
    async start() { effects.push('start'); assert.equal(running, false); starts++;
      config.connector.revision = JSON.parse(readFileSync(f.pointer, 'utf8')).revision;
      runtime = createConnectorRuntime(config, () => false); native(); running = true; },
  };
  const options = { nodeId, sessionKey, releasesDirectory: f.releases, activeReleaseFile: f.pointer,
    workDirectory: f.work, backupRoots: [state, f.settings], tar: '/usr/bin/tar',
    authorize: async (job: Readonly<MaintenanceJob>) => authorized(job), service, connector: client,
    ...(upgrade ? { prepare: { executable: process.execPath, args: [builder], systemdRun: '/usr/bin/systemd-run', systemctl: '/usr/bin/systemctl' },
      runPreparation: async (command: PreparationCommand, cwd: string, timeout: number) => {
        execFileSync(command.executable, [...command.args], { cwd, timeout, stdio: 'pipe' });
      } } : {}) };
  const adapter = new NodeMaintenanceAdapter(options);
  if (corruptBackup) {
    const backup = adapter.backup.bind(adapter);
    t.mock.method(adapter, 'backup', async (job: Readonly<MaintenanceJob>) => {
      const result = await backup(job);
      writeFileSync(join(f.work, hash(job.id), 'backup/0.tar'), 'corrupted after backup');
      return result;
    });
  }
  // Mutating caller configuration after installation cannot redirect targets.
  options.backupRoots = [f.root]; options.activeReleaseFile = join(f.root, 'not-the-pointer');
  const host = await startMaintenanceHost({ nodeId, journalFile: join(journal, 'journal.sqlite'), tokenFile,
    protectedRoots: [state, f.settings, f.releases, f.work], adapter, operations: upgrade ? ['upgrade'] : ['restart'], port: 0, tickMs: 50 });
  t.after(async () => {
    await host.close(); await runtime.close();
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  });
  const headers = { authorization: `Bearer ${owner.token}`, [EXPECTED_NODE_HEADER]: nodeId,
    [MAINTENANCE_PROTOCOL_HEADER]: '1', 'Content-Type': 'application/json' };
  const url = `http://127.0.0.1:${host.port}${MAINTENANCE_API}/commands`;
  const request = JSON.stringify({ commandKey: 'original', operation: upgrade ? 'upgrade' : 'restart' });
  const admitted = await fetch(url, { method: 'POST', headers, body: request });
  assert.equal(admitted.status, 202);
  const original = (await admitted.json() as { command: MaintenanceJob }).command;
  let result = original;
  const deadline = Date.now() + 12_000;
  while (!['succeeded', 'attention'].includes(result.stage)) {
    assert.ok(Date.now() < deadline, `chain timed out at ${result.stage}`);
    await delay(30);
    const response = await fetch(`${url}/original`, { headers });
    assert.equal(response.status, 200);
    result = (await response.json() as { command: MaintenanceJob }).command;
  }
  assert.equal(result.id, original.id);
  if (corruptBackup) {
    assert.equal(result.stage, 'attention');
    assert.equal(running, false);
    assert.deepEqual(effects, ['stop'], 'damaged backup prevents activation/start');
    assert.deepEqual(JSON.parse(readFileSync(f.pointer, 'utf8')), f.release);
    return;
  }
  assert.deepEqual(effects, ['stop', 'start']);
  const backup = join(f.work, hash(original.id), 'backup');
  assert.equal(statSync(join(backup, '0.tar')).mode & 0o777, 0o600);
  const manifest = JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8'));
  assert.equal(manifest.records.length, 2);
  for (const record of manifest.records) assert.equal(hash(readFileSync(join(backup, record.archive))), record.sha256);
  // Restore into a NEW isolated tree, never over the restarted runtime. A tar
  // digest is not evidence that its contents can restore identity and fences.
  const restored = join(f.root, 'restore-drill');
  mkdirSync(restored, { mode: 0o700 });
  for (const record of manifest.records) execFileSync('/usr/bin/tar',
    ['-xf', join(backup, record.archive), '-C', restored], { timeout: 10_000, stdio: 'pipe' });
  assert.deepEqual(JSON.parse(readFileSync(join(restored, 'settings/active.json'), 'utf8')), f.release,
    'backup retains the previous release, including during upgrade');
  assert.equal(readFileSync(join(restored, 'runtime/workspace/用户文件.md'), 'utf8'), '# Preserved workspace\n');
  assert.equal(statSync(join(restored, 'runtime/workspace/用户文件.md')).mode & 0o777, 0o600);
  assert.ok(new ConnectorTokenStore(join(restored, 'runtime/tokens.json')).hasScope(owner.record.id, 'connector:lifecycle'));
  const restoredFence = JSON.parse(readFileSync(join(restored, 'runtime/update.json'), 'utf8')).maintenance;
  assert.equal(restoredFence.id, result.fenceId);
  assert.equal(restoredFence.state, 'paused', 'stopped backup must not contain a released fence');
  assert.deepEqual(JSON.parse(readFileSync(f.pointer, 'utf8')), target);
  const observation = await client.inspect(original);
  assert.equal(observation.fenceId !== undefined, readinessFails);
  assert.equal(result.stage, readinessFails ? 'attention' : 'succeeded');
  const again = await fetch(url, { method: 'POST', headers, body: request });
  assert.equal(again.status, 202);
  assert.equal((await again.json() as { command: MaintenanceJob }).command.id, result.id);
  assert.deepEqual(effects, ['stop', 'start'], 'original command never repeats effects');
}

test('restart chain preserves original fence through real runtime reopen, backs up stopped data and releases only after business proof', async t => chain(t));
test('business failure leaves the restarted Connector fenced with original attention receipt; no automatic rollback/retry', async t => chain(t, true));
test('upgrade invokes fixed local builder, verifies and selects its candidate, then proves new revision with original history', async t => chain(t, false, true));
test('backup changed after verification prevents upgrade activation/start and retains old release', async t => chain(t, false, true, true));

async function recoveryFixture(t: TestContext, staged = true) {
  const f = files(t), databaseFile = join(f.settings, 'connector.sqlite'), effects: string[] = [];
  const run = { sessionKey: 'codex:interrupted', commandId: 'original-command', connectionId: 'original-connection', runId: 'original-run', revision: 7 };
  const fact = { ...run, phase: 'interrupted', sync: 'error', updatedAt: Date.now() - 100 };
  const db = new DatabaseSync(databaseFile);
  db.exec(`PRAGMA synchronous=FULL;
    CREATE TABLE connector_identity (singleton INTEGER, node_id TEXT);
    INSERT INTO connector_identity VALUES (1, 'node');
    CREATE TABLE connector_codex_executions (session_key TEXT PRIMARY KEY, fact TEXT);
    CREATE TABLE preserved_queue (payload TEXT);
    INSERT INTO preserved_queue VALUES ('synthetic queued successor');`);
  initializeStoppedCodexRecovery(db);
  db.prepare('INSERT INTO connector_codex_executions VALUES (?, ?)').run(run.sessionKey, JSON.stringify(fact));
  db.close(); chmodSync(databaseFile, 0o600);
  let running = true, authorized = true;
  const options = { nodeId: 'node', sessionKey: 'codex:history', releasesDirectory: f.releases,
    activeReleaseFile: f.pointer, workDirectory: f.work, backupRoots: [f.settings], tar: '/usr/bin/tar',
    stoppedRecovery: { databaseFile }, authorize: async () => authorized,
    service: { verifyRunning: async () => { assert.ok(running); }, verifyStopped: async () => { assert.ok(!running); },
      stop: async () => { effects.push('stop'); running = false; }, start: async () => { effects.push('start'); running = true; } },
    connector: {
      inspect: async () => ({ nodeId: 'node', observedAt: Date.now(), nativeVerified: true as const,
        activeRuns: 0, backgroundTerminals: 0, pendingExecutions: running ? 1 : 0, queuedMessages: 1,
        inFlightWrites: 0, fenceId: 'fence', recoveryRuns: [run] }),
      fence: async () => ({ nodeId: 'node', fenceId: 'fence' }),
      releaseFence: async () => { effects.push('release'); return { nodeId: 'node', fenceId: 'fence', released: true as const }; },
      readiness: async (_job: Readonly<MaintenanceJob>, sessionKey: string) => {
        effects.push(`history:${sessionKey}`);
        return { nodeId: 'node', fenceId: 'fence', sessionKey, revision: f.release.revision,
          observedAt: Date.now(), messageCount: 2, projectionVerified: true as const, businessReadVerified: true as const };
      },
    } };
  const adapter = new NodeMaintenanceAdapter(options);
  const initial = newMaintenanceJob({ id: 'recover:fixture', nodeId: 'node', actorId: 'actor',
    operation: 'recover', createdAt: Date.now(), deadline: Date.now() + 60_000 });
  let job = initial;
  if (staged) {
    const release = await adapter.prepare(initial);
    const fenced = { ...initial, release, fenceId: 'fence', recoveryRuns: [run] };
    await adapter.stop(fenced);
    const { backupId } = await adapter.backup(fenced);
    job = { ...fenced, backupId, stage: 'recover' };
  }
  return { ...f, options, adapter, job, databaseFile, run, fact, effects,
    revoke: () => { authorized = false; }, revive: () => { running = true; } };
}

test('explicit stopped recovery writes only exact proof after stopped backup, then probes every affected session', async t => {
  const f = await recoveryFixture(t);
  assert.deepEqual(await f.adapter.recover(f.job), { nodeId: 'node', recovered: true });
  const db = new DatabaseSync(f.databaseFile);
  try {
    assert.equal(hasStoppedCodexRecovery(db, f.fact, f.run.runId), true);
    assert.deepEqual(JSON.parse(db.prepare('SELECT fact FROM connector_codex_executions').get()!.fact as string), f.fact);
    assert.equal(db.prepare('SELECT payload FROM preserved_queue').get()!.payload, 'synthetic queued successor');
    const receipt = JSON.parse(db.prepare('SELECT record FROM connector_codex_stopped_recovery').get()!.record as string);
    assert.equal(receipt.proof.jobId, f.job.id);
    assert.equal(receipt.proof.fenceId, f.job.fenceId);
    assert.equal(receipt.proof.backupId, f.job.backupId);
  } finally { db.close(); }
  const restored = join(f.root, 'restored'); mkdirSync(restored, { mode: 0o700 });
  execFileSync('/usr/bin/tar', ['-xf', join(f.work, hash(f.job.id), 'backup/0.tar'), '-C', restored], { stdio: 'pipe', timeout: 10_000 });
  const copy = new DatabaseSync(join(restored, 'settings/connector.sqlite'), { readOnly: true });
  try {
    assert.equal(copy.prepare('SELECT count(*) AS n FROM connector_codex_stopped_recovery').get()!.n, 0,
      'stopped backup precedes proof writes, not a backup of already-mutated state');
    assert.deepEqual(JSON.parse(copy.prepare('SELECT fact FROM connector_codex_executions').get()!.fact as string), f.fact);
    assert.equal(copy.prepare('SELECT payload FROM preserved_queue').get()!.payload, 'synthetic queued successor');
  } finally { copy.close(); }
  await f.adapter.start({ ...f.job, stage: 'start' });
  await f.adapter.ready({ ...f.job, stage: 'ready' });
  assert.deepEqual(f.effects, ['stop', 'start', 'history:codex:history', 'history:codex:interrupted']);
  assert.deepEqual(JSON.parse(readFileSync(f.pointer, 'utf8')), f.release, 'recovery is not an upgrade');
});

test('post-restart readiness hydrates additional interrupted histories without broadening stopped recovery', async t => {
  const fixture = await recoveryFixture(t);
  await fixture.adapter.recover(fixture.job);
  await fixture.adapter.start({ ...fixture.job, stage: 'start' });
  let inspections = 0;
  const adapter = new NodeMaintenanceAdapter({ ...fixture.options, connector: { ...fixture.options.connector,
    inspect: async () => {
      inspections++;
      const observation = await fixture.options.connector.inspect();
      return { ...observation, pendingExecutions: 9, queuedMessages: 0, recoveryRuns: [fixture.run,
        { ...fixture.run, sessionKey: 'codex:previous-interruption-one', runId: 'previous-run-one' },
        { ...fixture.run, sessionKey: 'codex:previous-interruption-two', runId: 'previous-run-two' }] };
    },
  } });
  const result = await adapter.ready({ ...fixture.job, stage: 'ready' });
  assert.equal(result.businessReadVerified, true);
  assert.equal(inspections, 1);
  assert.deepEqual(fixture.job.recoveryRuns, [fixture.run]);
  assert.deepEqual(fixture.effects, ['stop', 'start', 'history:codex:history', 'history:codex:interrupted']);
});

test('durable coordinator completes real backup/proof adapter chain and refuses to repeat terminal job', async t => {
  const f = await recoveryFixture(t, false);
  const db = new DatabaseSync(join(f.root, 'journal.sqlite'));
  db.exec('PRAGMA synchronous=FULL');
  try {
    const journal = new SqliteMaintenanceJournal(db);
    let current = journal.enqueue(f.job);
    for (let step = 0; current.stage !== 'succeeded' && step < 20; step++) {
      assert.notEqual(current.stage, 'attention');
      await advanceMaintenance(current, journal, f.adapter);
      current = journal.get(current.id)!;
    }
    assert.equal(current.stage, 'succeeded');
    assert.deepEqual(current.recoveryRuns, [f.run]);
    assert.deepEqual(f.effects, ['stop', 'start', 'history:codex:history', 'history:codex:interrupted', 'release']);
    assert.deepEqual(await advanceMaintenance(current, journal, f.adapter), current);
    assert.equal(f.effects.length, 5);
  } finally { db.close(); }
});

test('recovery is explicit local capability; invalid storage is rejected before a service stop', async t => {
  const f = await recoveryFixture(t);
  const { stoppedRecovery: _disabled, ...ordinary } = f.options;
  const disabled = new NodeMaintenanceAdapter(ordinary);
  assert.equal(await disabled.authorize(f.job), false);
  await assert.rejects(disabled.recover(f.job));
  for (const databaseFile of ['/outside/connector.sqlite', f.settings, join(f.settings, '../connector.sqlite')]) {
    assert.throws(() => new NodeMaintenanceAdapter({ ...f.options, stoppedRecovery: { databaseFile } }));
  }
});

test('recovery refuses unverified backup, live service, revoked actor, replaced run/node or insecure database without proof', async t => {
  for (const kind of ['backup', 'live', 'revoked', 'run', 'node', 'public', 'symlink', 'wrong-stage'] as const) {
    await t.test(kind, async child => {
      const f = await recoveryFixture(child);
      if (kind === 'backup') writeFileSync(join(f.work, hash(f.job.id), 'backup/0.tar'), 'corrupted');
      if (kind === 'live') f.revive();
      if (kind === 'revoked') f.revoke();
      if (kind === 'public') chmodSync(f.databaseFile, 0o644);
      if (kind === 'symlink') {
        symlinkSync(f.databaseFile, join(f.settings, 'linked.sqlite'));
        f.adapter = new NodeMaintenanceAdapter({ ...f.options, stoppedRecovery: { databaseFile: join(f.settings, 'linked.sqlite') } });
      }
      if (kind === 'run' || kind === 'node') {
        const db = new DatabaseSync(f.databaseFile);
        if (kind === 'run') db.prepare('UPDATE connector_codex_executions SET fact = ?').run(JSON.stringify({ ...f.fact, runId: 'replacement' }));
        else db.exec("UPDATE connector_identity SET node_id = 'replacement'");
        db.close();
      }
      await assert.rejects(f.adapter.recover(kind === 'wrong-stage' ? { ...f.job, stage: 'backup' } : f.job));
      const db = new DatabaseSync(f.databaseFile);
      try { assert.equal(db.prepare('SELECT count(*) AS n FROM connector_codex_stopped_recovery').get()!.n, 0); }
      finally { db.close(); }
      assert.deepEqual(f.effects, ['stop'], 'never start/release after missing evidence');
    });
  }
});

test('node adapter refuses broad/overlapping storage and world-readable control files before stopping', async t => {
  const f = files(t);
  let stopped = 0;
  const unexpected = async () => { throw new Error('unexpected'); };
  const options = { nodeId: 'node:1', sessionKey: 'codex:history', releasesDirectory: f.releases, activeReleaseFile: f.pointer,
    workDirectory: f.work, backupRoots: [f.settings], tar: '/usr/bin/tar', authorize: async () => true,
    service: { verifyRunning: async () => {}, verifyStopped: unexpected, stop: async () => { stopped++; }, start: unexpected },
    connector: { inspect: unexpected, fence: unexpected, releaseFence: unexpected, readiness: unexpected } };
  assert.throws(() => new NodeMaintenanceAdapter({ ...options, backupRoots: ['/'] }));
  assert.throws(() => new NodeMaintenanceAdapter({ ...options, backupRoots: [f.root] }));
  assert.doesNotThrow(() => new NodeMaintenanceAdapter({ ...options, sessionKey: 'claude-code:history' }));
  for (const sessionKey of ['claude-code:', 'claude-code:../history', 'github-copilot:history', 'hermes:history']) {
    assert.throws(() => new NodeMaintenanceAdapter({ ...options, sessionKey }));
  }
  chmodSync(f.pointer, 0o644);
  const adapter = new NodeMaintenanceAdapter(options);
  await assert.rejects(adapter.prepare({ version: 1, id: 'job:1', actorId: 'actor:1', nodeId: 'node:1', operation: 'restart',
    stage: 'prepare', createdAt: Date.now(), deadline: Date.now() + 60_000, revision: 0 }));
  assert.equal(stopped, 0);
});
