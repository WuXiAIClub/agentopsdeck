import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { loadConfig } from '../config.js';
import { registerRequestDrain } from '../lifecycle/request-drain.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorUpdateService, UpdateAuthorizationError } from './update-service.js';

function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-maintenance-journal-'));
  const stateFile = join(directory, 'update.json');
  const config = loadConfig({ AOD_CONNECTOR_UPDATE_STATE_FILE: stateFile, AOD_CONNECTOR_UPDATE_ENABLED: 'false' });
  const users = new ConnectorUserStore(join(directory, 'connector.sqlite'));
  const owner = { nodeId: users.nodeId, receipts: users.commands };
  const app = new Hono(), drain = registerRequestDrain(app);
  app.post('/write', context => context.text('written'));
  const service = new ConnectorUpdateService(config, owner);
  service.bindMaintenanceLifecycle(drain.pauseWrites);
  context.after(async () => { await drain(); users.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, stateFile, config, users, owner, service, app, drain };
}

test('maintenance uses original journal and receipts with original actor, fence and immutable request identity', async context => {
  const setup = fixture(context);
  const pause = await setup.service.changeMaintenance('alice', 'pause', 'pause-one');
  assert.equal(pause.state, 'accepted');
  assert.equal(pause.result?.body.state, 'paused');
  assert.equal(pause.result?.body.nativeQuiescent, false);
  assert.equal((await setup.app.request('/write', { method: 'POST' })).status, 503);
  const stored = JSON.parse(readFileSync(setup.stateFile, 'utf8'));
  assert.equal(stored.maintenance.nodeId, setup.users.nodeId);
  assert.equal(stored.maintenance.command.id, pause.id);
  assert.equal(setup.service.maintenanceAtStartup()?.id, pause.id);
  await assert.rejects(setup.service.changeMaintenance('bob', 'resume', 'resume-other', pause.id), /identity or state conflict/);
  assert.equal(await setup.service.maintenanceCommand('bob', 'pause', 'pause-one'), undefined);
  assert.deepEqual(await setup.service.changeMaintenance('alice', 'pause', 'pause-one'), pause);
  await assert.rejects(setup.service.changeMaintenance('alice', 'pause', 'pause-two'), /identity or state conflict/);
  const resumed = await setup.service.changeMaintenance('alice', 'resume', 'resume-one', pause.id);
  assert.equal(resumed.result?.body.state, 'released');
  assert.equal((await setup.app.request('/write', { method: 'POST' })).status, 200);
  const newer = await setup.service.changeMaintenance('alice', 'pause', 'pause-two');
  assert.deepEqual(await setup.service.changeMaintenance('alice', 'resume', 'resume-one', pause.id), resumed);
  assert.equal((await setup.app.request('/write', { method: 'POST' })).status, 503);
  await assert.rejects(setup.service.changeMaintenance('alice', 'resume', 'resume-two', pause.id), /identity or state conflict/);
  await assert.rejects(setup.service.changeMaintenance('alice', 'resume', 'resume-one', newer.id), /different content/);
  assert.equal((await setup.service.status(false) as any).maintenance, undefined);
});

test('reopened original journal restores maintenance without clearing it through ordinary reads', async context => {
  const setup = fixture(context);
  const paused = await setup.service.changeMaintenance('alice', 'pause', 'original');
  const app = new Hono(), drain = registerRequestDrain(app);
  app.post('/write', context => context.text('written'));
  context.after(() => drain());
  const reopened = new ConnectorUpdateService(setup.config, setup.owner);
  reopened.bindMaintenanceLifecycle(drain.pauseWrites, reopened.maintenanceAtStartup());
  assert.equal((await app.request('/write', { method: 'POST' })).status, 503);
  await reopened.status(false);
  assert.equal((await reopened.maintenanceStatus()).state, 'paused');
  assert.equal((await app.request('/write', { method: 'POST' })).status, 503);
  await reopened.changeMaintenance('alice', 'resume', 'resume', paused.id);
  assert.equal((await app.request('/write', { method: 'POST' })).status, 200);
});

test('interrupted resume recovers as fenced, never implicitly resumes on receipt query', async context => {
  const setup = fixture(context);
  const paused = await setup.service.changeMaintenance('alice', 'pause', 'original');
  let resumed = 0;
  const stopped = new ConnectorUpdateService(setup.config, setup.owner);
  stopped.bindMaintenanceLifecycle(() => ({ drained: Promise.resolve(), resume: () => { resumed++; return false; } }));
  await assert.rejects(stopped.changeMaintenance('alice', 'resume', 'resume', paused.id), /during shutdown/);
  assert.equal(resumed, 1);
  assert.equal(stopped.maintenanceAtStartup()?.state, 'resuming');
  const reopened = new ConnectorUpdateService(setup.config, setup.owner);
  reopened.bindMaintenanceLifecycle(setup.drain.pauseWrites, reopened.maintenanceAtStartup());
  const result = await reopened.maintenanceCommand('alice', 'resume', 'resume');
  assert.equal(result?.state, 'accepted');
  assert.equal(result?.result?.status, 200);
  assert.equal(result?.result?.body.state, 'paused');
  assert.equal(result?.result?.body.resumeInterrupted, true);
  assert.equal((await setup.app.request('/write', { method: 'POST' })).status, 503);
  assert.deepEqual(await reopened.changeMaintenance('alice', 'resume', 'resume', paused.id), result);
  const next = await reopened.changeMaintenance('alice', 'resume', 'resume-next', paused.id);
  assert.equal(next.result?.body.state, 'released');
});

test('revocation after journal persistence cannot release an original fence', async context => {
  const setup = fixture(context);
  const paused = await setup.service.changeMaintenance('alice', 'pause', 'original');
  let forbidden = false, resumed = 0;
  const revoked = new ConnectorUpdateService(setup.config, setup.owner);
  revoked.bindMaintenanceLifecycle(() => ({ drained: Promise.resolve().then(() => { forbidden = true; }),
    resume: () => { resumed++; return true; } }));
  await assert.rejects(revoked.changeMaintenance('alice', 'resume', 'resume', paused.id,
    () => { if (forbidden) throw new UpdateAuthorizationError(); }), UpdateAuthorizationError);
  assert.equal(resumed, 0);
  assert.equal(revoked.maintenanceAtStartup()?.state, 'resuming');
  assert.equal((await setup.app.request('/write', { method: 'POST' })).status, 503);
});

for (const damage of ['json', 'version', 'node', 'actor', 'receipt', 'missing-receipt']) test(`startup fails closed on ${damage} original maintenance evidence`, async context => {
  const setup = fixture(context);
  const paused = await setup.service.changeMaintenance('alice', 'pause', 'original');
  const state = JSON.parse(readFileSync(setup.stateFile, 'utf8'));
  if (damage === 'version') state.maintenance.version = 2;
  if (damage === 'node') state.maintenance.nodeId = 'other-node';
  if (damage === 'actor') state.maintenance.actorId = 'other-actor';
  if (damage === 'receipt') state.maintenance.command.id = '00000000-0000-0000-0000-000000000000';
  if (damage === 'missing-receipt') state.maintenance.command.key = 'missing';
  writeFileSync(setup.stateFile, damage === 'json' ? '{invalid' : JSON.stringify(state));
  assert.throws(() => setup.service.maintenanceAtStartup(), /maintenance journal/);
  assert.equal(paused.state, 'accepted');
});

test('journal sync failure preserves unknown identity and conservatively fences live admissions', async context => {
  const setup = fixture(context);
  const originalOpen = fsPromises.open;
  let failed = false;
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    const originalSync = handle.sync.bind(handle);
    context.mock.method(handle, 'sync', async () => {
      if (!failed && String(args[0]) === setup.directory) { failed = true; throw new Error('synthetic directory sync failure'); }
      return originalSync();
    });
    return handle;
  });
  syncBuiltinESMExports();
  await assert.rejects(setup.service.changeMaintenance('alice', 'pause', 'original'), /synthetic directory sync failure/);
  assert.equal(failed, true);
  assert.equal((await setup.app.request('/write', { method: 'POST' })).status, 503);
  const fence = setup.service.maintenanceAtStartup()!;
  assert.equal(setup.users.commands.get(fence.command.scope, 'original')?.state, 'outcome_unknown');
  const recovered = await setup.service.maintenanceCommand('alice', 'pause', 'original');
  assert.equal(recovered?.state, 'accepted');
  assert.equal(recovered?.id, fence.id);
  assert.equal((await setup.app.request('/write', { method: 'POST' })).status, 503);
});

for (const fault of ['directory-sync', 'receipt', 'revocation'] as const) test(`resume ${fault} failure remains fenced and reconciles the original identity`, async context => {
  const setup = fixture(context);
  const paused = await setup.service.changeMaintenance('alice', 'pause', 'original');
  const originalOpen = fsPromises.open;
  const originalSettle = setup.users.commands.settle.bind(setup.users.commands);
  let injected = false, forbidden = false;
  const admissions: number[] = [];
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    const originalSync = handle.sync.bind(handle);
    context.mock.method(handle, 'sync', async () => {
      if (!injected && String(args[0]) === setup.directory
        && JSON.parse(readFileSync(setup.stateFile, 'utf8')).maintenance.state === 'released') {
        admissions.push((await setup.app.request('/write', { method: 'POST' })).status);
        if (fault !== 'receipt') {
          injected = true;
          if (fault === 'directory-sync') throw new Error('synthetic resume sync failure');
          forbidden = true;
        }
      }
      return originalSync();
    });
    return handle;
  });
  context.mock.method(setup.users.commands, 'settle', (...args: Parameters<typeof originalSettle>) => {
    if (!injected && fault === 'receipt' && args[1] === 'resume') {
      injected = true;
      throw new Error('synthetic resume receipt failure');
    }
    return originalSettle(...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(setup.service.changeMaintenance('alice', 'resume', 'resume', paused.id,
    () => { if (forbidden) throw new UpdateAuthorizationError(); }),
  fault === 'revocation' ? UpdateAuthorizationError : /synthetic resume/);
  assert.equal(injected, true);
  assert.deepEqual(admissions, [503], 'no release before durable journal and renewed authorization');
  assert.equal((await setup.app.request('/write', { method: 'POST' })).status, 503);
  assert.notEqual((await setup.service.maintenanceStatus()).state, 'released');
  const recoveredFence = setup.service.maintenanceAtStartup()!;
  assert.equal(recoveredFence.state, 'resuming');
  assert.equal(setup.users.commands.get(recoveredFence.command.scope, 'resume')?.state, 'outcome_unknown');
  const reopened = new ConnectorUpdateService(setup.config, setup.owner);
  reopened.bindMaintenanceLifecycle(setup.drain.pauseWrites, recoveredFence);
  const recovered = await reopened.maintenanceCommand('alice', 'resume', 'resume');
  assert.equal(recovered?.state, 'accepted');
  assert.equal(recovered?.id, recoveredFence.command.id);
  assert.equal(recovered?.result?.body.state, 'paused');
  assert.equal(recovered?.result?.body.resumeInterrupted, true);
  assert.deepEqual(await reopened.changeMaintenance('alice', 'resume', 'resume', paused.id), recovered);
  assert.equal((await setup.app.request('/write', { method: 'POST' })).status, 503);
  assert.equal((await reopened.changeMaintenance('alice', 'resume', 'resume-new', paused.id)).result?.body.state, 'released');
});
