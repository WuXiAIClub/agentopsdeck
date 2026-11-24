import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { loadConfig } from '../config.js';
import { registerRequestDrain, type AdmissionPause } from '../lifecycle/request-drain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncMaintenanceLifecycle } from './async-maintenance-lifecycle.js';
import { AsyncUpdatePersistence } from './async-update-persistence.js';
import { ConnectorUpdateService, UpdateAuthorizationError } from './update-service.js';
import { AsyncSdkApplication } from './async-sdk-application.js';
import { DeckStore } from '../projection/deck-store.js';

const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
const check = async () => {};
const assertLocal = () => {};
type Port = Pick<AsyncConnectorOwner, 'command'>;
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'async-maintenance-lifecycle-'));
  const file = join(root, 'connector.sqlite');
  const owner = new AsyncConnectorOwner({ file, tokenFile: join(root, 'tokens.json'), bootstrapToken: 'isolated-bootstrap' }, quiet);
  await owner.open();
  const nodeId = await owner.command('nodeIdentity', {});
  const token = await owner.command('tokenCreate', { label: 'updater', scopes: ['connector:update'] });
  const app = new Hono(), drain = registerRequestDrain(app);
  const effects: string[] = [];
  app.post('/write', c => { effects.push('write'); return c.text('written'); });
  const consumers: (() => Promise<void>)[] = [];
  let lifecycle: AsyncMaintenanceLifecycle | undefined;
  const build = (options: { owner?: Port; pauses?: (() => AdmissionPause)[]; diagnostics?: PerformanceDiagnostics } = {}) => {
    lifecycle = new AsyncMaintenanceLifecycle(options.owner ?? owner, [drain.pauseWrites, ...options.pauses ?? []], options.diagnostics ?? quiet);
    return lifecycle;
  };
  t.after(async () => {
    await lifecycle?.close().catch(() => {}); await drain();
    await Promise.allSettled(consumers.map(close => close())); await owner.close();
    rmSync(root, { recursive: true, force: true });
  });
  const snapshot = () => owner.command('maintenanceSnapshot', {});
  const assertStopped = async () => {
    const generation = await owner.command('maintenancePause', {});
    assert.equal(await owner.command('maintenanceResume', { generation }), false, 'shutdown is a permanent latch');
  };
  const request = () => new Request('http://local/', { headers: { authorization: `Bearer ${token.token}` } });
  return { root, file, owner, nodeId, token, app, drain, effects, build, snapshot, assertStopped, request, consumers };
}

test('real worker generation and original HTTP drain release only after all accepted writers finish', async t => {
  const f = await fixture(t), entered = gate(), held = gate();
  f.app.post('/held', async c => { entered.release(); await held.promise; return c.text('done'); });
  const writing = f.app.request('/held', { method: 'POST' }); await entered.promise;
  const lifecycle = f.build(), lease = lifecycle.pause(); let drained = false;
  const waiting = lease.drained.then(() => { drained = true; });
  assert.equal(lifecycle.pause(), lease);
  assert.equal((await f.app.request('/write', { method: 'POST' })).status, 503);
  assert.equal(await lease.resume(check, assertLocal), false);
  await tick(); assert.equal(drained, false);
  held.release(); await writing; await waiting;
  assert.equal((await f.snapshot()).commandAdmissionOpen, false);
  assert.equal(await lease.resume(check, assertLocal), true);
  await assert.rejects(f.snapshot(), /storage_unavailable/, 'queue preservation proof requires the original paused owner');
  assert.equal((await f.app.request('/write', { method: 'POST' })).status, 200);
  assert.equal(await lease.resume(check, assertLocal), false, 'released lease never replays');
  await lifecycle.close();
  await f.assertStopped();
  assert.equal(await f.owner.command('nodeIdentity', {}), f.nodeId, 'consumer close retains shared owner');
});

for (const fault of ['revoke', 'lost ACK', 'local refusal', 'local throw', 'lock loss'] as const) {
  test(`worker release followed by ${fault} refences original HTTP and worker with no replay`, async t => {
    const f = await fixture(t); let released = false, localResumes = 0;
    const port: Port = { command: (async (kind, input) => {
      const output = await f.owner.command(kind, input);
      if (kind === 'maintenanceResume') {
        released = true;
        if (fault === 'revoke') await f.owner.command('tokenRevoke', { tokenId: f.token.record.id });
        if (fault === 'lost ACK') throw Error('Unknown resume acknowledgement');
      }
      return output;
    }) as AsyncConnectorOwner['command'] };
    let firstReleased = false;
    const first = () => ({ drained: Promise.resolve(), resume: () => { firstReleased = true; return true; } });
    const second = () => ({ drained: Promise.resolve(), resume: () => {
      localResumes++;
      if (fault === 'local throw') throw Error('Local release failed');
      return fault !== 'local refusal';
    } });
    const lifecycle = f.build({ owner: port, pauses: [() => { firstReleased = false; return first(); }, second] });
    const lease = lifecycle.pause(); await lease.drained;
    const authorize = async () => {
      const auth = await f.owner.command('tokenAuthenticate', { authorization: f.request().headers.get('authorization')! });
      if (!auth) throw new UpdateAuthorizationError();
    };
    const local = () => { if (released && fault === 'lock loss') throw Error('Original local lock lost'); };
    if (fault === 'local refusal') assert.equal(await lease.resume(authorize, local), false);
    else await assert.rejects(lease.resume(authorize, local));
    assert.equal(released, true);
    assert.equal((await f.snapshot()).commandAdmissionOpen, false);
    assert.equal((await f.app.request('/write', { method: 'POST' })).status, 503);
    assert.equal(firstReleased, false, 'already released local producers are paused again');
    assert.equal(localResumes, fault.startsWith('local') ? 1 : 0);
    assert.equal(await lease.resume(check, assertLocal), false);
    assert.notEqual(lifecycle.pause(), lease);
  });
}

test('generation mismatch cannot release the replacement worker fence', async t => {
  const f = await fixture(t), lifecycle = f.build(), old = lifecycle.pause(); await old.drained;
  const generation = await f.owner.command('maintenancePause', {});
  assert.equal(await f.owner.command('maintenanceResume', { generation }), true);
  const replacement = await f.owner.command('maintenancePause', {});
  assert.notEqual(replacement, generation);
  assert.equal(await old.resume(check, assertLocal), false);
  assert.equal((await f.snapshot()).commandAdmissionOpen, false);
  assert.equal(await f.owner.command('maintenancePause', {}), replacement);
});

test('concurrent release and shutdown retain physical worker acknowledgement and stop permanently', async t => {
  const f = await fixture(t), entered = gate(), held = gate();
  const port: Port = { command: (async (kind, input) => {
    const output = await f.owner.command(kind, input);
    if (kind === 'maintenanceResume') { entered.release(); await held.promise; }
    return output;
  }) as AsyncConnectorOwner['command'] };
  const lifecycle = f.build({ owner: port }), lease = lifecycle.pause(); await lease.drained;
  const release = assert.rejects(lease.resume(check, assertLocal), /fenced/);
  await entered.promise;
  assert.equal(await lease.resume(check, assertLocal), false);
  let closed = false; const closing = lifecycle.close().then(() => { closed = true; });
  assert.equal(lifecycle.close(), lifecycle.close());
  assert.equal((await f.app.request('/write', { method: 'POST' })).status, 503);
  // Force shutdown to reach its physical-operation drain before releasing
  // the now-vetoed resume ACK. A scheduler-dependent tick alone hid this race.
  await f.assertStopped();
  await tick(); assert.equal(closed, false);
  held.release(); await release; await closing;
  await f.assertStopped();
  assert.equal(await lifecycle.pause().resume(check, assertLocal), false);
});

test('failed local pause does not abandon other local drains or the original worker pause', async t => {
  const f = await fixture(t), held = gate(); let paused = false, settled = false;
  const lifecycle = f.build({ pauses: [() => { throw Error('Cannot pause original producer'); },
    () => { paused = true; return { drained: held.promise, resume: () => true }; }] });
  const lease = lifecycle.pause(); const failed = assert.rejects(lease.drained, /Cannot pause/).then(() => { settled = true; });
  assert.equal(paused, true); await tick(); assert.equal(settled, false);
  assert.equal((await f.snapshot()).commandAdmissionOpen, false);
  held.release(); await failed;
  assert.equal(await lease.resume(check, assertLocal), false);
  await assert.rejects(lifecycle.close(), /could not confirm/);
});

test('shutdown reentry from local release refences every gate before returning', async t => {
  const f = await fixture(t); let closing: Promise<void> | undefined, released = false;
  const lifecycle = f.build({ pauses: [() => { released = false; return { drained: Promise.resolve(), resume: () => {
    released = true; closing = lifecycle.close(); return true;
  } }; }] });
  const lease = lifecycle.pause(); await lease.drained;
  await assert.rejects(lease.resume(check, assertLocal), /fenced/); await closing;
  assert.equal(released, false);
  await f.assertStopped();
});

test('updater durable intent integrates real worker/local pause, resume and startup restoration', async t => {
  const f = await fixture(t), lifecycle = f.build();
  const stateFile = join(f.root, 'update.json');
  const config = loadConfig({ AOD_CONNECTOR_UPDATE_STATE_FILE: stateFile, AOD_CONNECTOR_UPDATE_ENABLED: 'false' });
  const persistence = new AsyncUpdatePersistence(f.owner, f.nodeId, quiet);
  t.after(() => persistence.close());
  const updater = new ConnectorUpdateService(config, persistence);
  updater.bindAsyncMaintenanceLifecycle(lifecycle.pause);
  const change = (operation: 'pause' | 'resume', key: string, fence?: string) => persistence.run(f.request(), 'maintenance',
    op => updater.changeMaintenance(op.actorId, operation, key, fence, op.check));
  const pause = await change('pause', 'pause');
  assert.equal(pause.state, 'accepted'); assert.equal((await f.snapshot()).commandAdmissionOpen, false);
  const resume = await change('resume', 'resume', pause.id);
  assert.equal(resume.state, 'accepted');
  assert.equal((await f.app.request('/write', { method: 'POST' })).status, 200);
  assert.deepEqual(await change('resume', 'resume', pause.id), resume, 'duplicate only reads original result');
  const paused = await change('pause', 'pause-again');
  const restored = await updater.maintenanceAtStartupAsync(); assert.equal(restored?.id, paused.id);
  const next = new ConnectorUpdateService(config, persistence);
  next.bindAsyncMaintenanceLifecycle(lifecycle.pause, restored);
  assert.equal((await f.app.request('/write', { method: 'POST' })).status, 503);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).maintenance.state, 'paused');
  assert.throws(() => new ConnectorUpdateService(config).bindAsyncMaintenanceLifecycle(lifecycle.pause), /requires async/);
});

for (const fault of ['revocation', 'lost acknowledgement', 'failed refence drain'] as const) {
  test(`updater persists conservative recovery after physical worker release and ${fault}`, async t => {
    const f = await fixture(t); let releases = 0;
    const port: Port = { command: (async (kind, input) => {
      const result = await f.owner.command(kind, input);
      if (kind === 'maintenanceResume') {
        releases++;
        if (fault === 'revocation') await f.owner.command('tokenRevoke', { tokenId: f.token.record.id });
        else throw Error('Worker acknowledgement lost');
      }
      return result;
    }) as AsyncConnectorOwner['command'] };
    const lifecycle = f.build({ owner: port, pauses: [() => {
      const drained = fault === 'failed refence drain' && releases ? Promise.reject(Error('Original drain failed')) : Promise.resolve();
      return { drained, resume: () => true };
    }] });
    const stateFile = join(f.root, 'update.json');
    const config = loadConfig({ AOD_CONNECTOR_UPDATE_STATE_FILE: stateFile, AOD_CONNECTOR_UPDATE_ENABLED: 'false' });
    const persistence = new AsyncUpdatePersistence(f.owner, f.nodeId, quiet);
    f.consumers.push(() => persistence.close());
    const updater = new ConnectorUpdateService(config, persistence);
    updater.bindAsyncMaintenanceLifecycle(lifecycle.pause);
    const change = (operation: 'pause' | 'resume', key: string, fence?: string) => persistence.run(f.request(), 'maintenance',
      op => updater.changeMaintenance(op.actorId, operation, key, fence, op.check));
    const pause = await change('pause', 'pause');
    await assert.rejects(change('resume', 'resume', pause.id), fault === 'revocation' ? UpdateAuthorizationError
      : fault === 'failed refence drain' ? /recovery fence persisted/ : /acknowledgement lost/);
    const restored = await updater.maintenanceAtStartupAsync();
    assert.equal(restored?.state, 'paused'); assert.equal(restored?.resumeInterrupted, true);
    assert.equal((await persistence.receipts.get(restored!.command.scope, 'resume'))?.state, 'accepted');
    assert.equal((await f.app.request('/write', { method: 'POST' })).status, 503);
    assert.equal((await f.snapshot()).commandAdmissionOpen, false);
    assert.equal(releases, 1);
    await updater.maintenanceAtStartupAsync();
    assert.equal(releases, 1, 'read-only recovery cannot replay an accepted release');
  });
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: complete original SDK graph remains unstarted while worker/local maintenance is fenced`, async t => {
    const f = await fixture(t); let checks = 0;
    const config = { homeDirectory: join(f.root, runtime), workspace: f.root, sdkDirectory: f.root,
      startupTimeoutMs: 1_000, apiKeyFile: join(f.root, 'absent-key'), model: 'default', baseUrl: 'http://127.0.0.1:1',
      auth: { mode: 'github' as const, credentialFile: join(f.root, 'absent-key') } };
    mkdirSync(config.homeDirectory, { mode: 0o700 });
    const ports = { start: () => assert.fail('Maintenance must not infer or dispatch'), check: () => {
      checks++; return { ready: Promise.resolve(true), finished: Promise.resolve(), inspectQuiescence: () => true, close() {} };
    }, deleteNative: () => assert.fail('Maintenance must not delete native history') };
    const sdk = new AsyncSdkApplication({ owner: f.owner, projection: new DeckStore(), diagnostics: quiet,
      ...(runtime === 'ghcp' ? { copilot: config } : { claude: config }) }, runtime === 'ghcp' ? { copilot: ports } : { claude: ports });
    f.consumers.push(() => sdk.close());
    const original = runtime === 'ghcp' ? sdk.copilot! : sdk.claude!;
    const lifecycle = f.build({ pauses: [() => original.pauseQueueWorker()] });
    const lease = lifecycle.pause(); sdk.activate(); await lease.drained;
    assert.equal(checks, 0); assert.equal((await f.snapshot()).commandAdmissionOpen, false);
    await lifecycle.close(); await sdk.close();
    assert.equal(checks, 0); assert.equal(await f.owner.command('nodeIdentity', {}), f.nodeId);
  });
}

test('diagnostic sink failure cannot skip release or shared-owner shutdown fencing', async t => {
  const f = await fixture(t);
  const lifecycle = f.build({ diagnostics: new PerformanceDiagnostics(() => { throw Error('Broken diagnostic sink'); }) });
  const lease = lifecycle.pause(); await lease.drained;
  assert.equal(await lease.resume(check, assertLocal), true);
  await lifecycle.close(); await f.assertStopped();
});
