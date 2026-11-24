import assert from 'node:assert/strict';
import test from 'node:test';
import { SystemdConnectorService } from './maintenance-systemd.js';

function fixture() {
  const unit = 'synthetic-connector.service', controlGroup = '/user.slice/app.slice/synthetic-connector.service';
  let own = '/user.slice/app.slice/synthetic-supervisor.service', events = 'populated 0\nfrozen 0\n';
  let missing = false, inaccessible = false;
  const state = { LoadState: 'loaded', ActiveState: 'active', SubState: 'running', MainPID: '1234', ControlPID: '0',
    ControlGroup: controlGroup, KillMode: 'control-group', Delegate: 'no' };
  const calls: string[][] = [];
  const options = { unit, controlGroup, systemctl: '/synthetic/systemctl', platform: 'linux' as const,
    run: async (args: string[]) => {
      calls.push(args);
      if (args[1] === 'show') return Object.entries(state).map(([key, value]) => `${key}=${value}`).join('\n');
      if (args[1] === 'stop') Object.assign(state, { ActiveState: 'inactive', SubState: 'dead', MainPID: '0', ControlGroup: '' });
      if (args[1] === 'start') Object.assign(state, { ActiveState: 'active', SubState: 'running', MainPID: '5678', ControlGroup: controlGroup });
      return '';
    },
    read: async (path: string) => {
      if (path === '/sys/fs/cgroup/cgroup.controllers') return 'cpu memory pids';
      if (path === '/proc/self/cgroup') return `0::${own}\n`;
      assert.equal(path, `/sys/fs/cgroup${controlGroup}/cgroup.events`);
      if (inaccessible || missing) throw Object.assign(new Error('private detail'), { code: inaccessible ? 'EACCES' : 'ENOENT' });
      return events;
    } };
  return { service: new SystemdConnectorService(options), options, state, calls,
    own(value: string) { own = value; }, events(value: string) { events = value; },
    missing() { missing = true; }, inaccessible() { inaccessible = true; } };
}

test('fixed unit is stopped only from an independent cgroup; start requires proven full exit', async () => {
  const f = fixture();
  await f.service.verifyRunning();
  await f.service.stop();
  await f.service.verifyStopped();
  await f.service.start();
  assert.deepEqual(f.calls.filter(args => args[1] !== 'show'), [
    ['--user', 'stop', 'synthetic-connector.service'], ['--user', 'start', 'synthetic-connector.service'],
  ]);
});

test('service transitions allow eleven minutes while state queries retain their short deadline', async () => {
  const fixtureState = fixture();
  const calls: Array<{ operation: string; timeoutMs: number }> = [];
  const service = new SystemdConnectorService({ ...fixtureState.options,
    run: async (args, timeoutMs) => {
      calls.push({ operation: args[1]!, timeoutMs });
      return fixtureState.options.run(args);
    } });
  await service.stop();
  await service.start();
  assert.ok(calls.some(call => call.operation === 'show'));
  assert.deepEqual(calls.filter(call => call.operation !== 'show'), [
    { operation: 'stop', timeoutMs: 660_000 }, { operation: 'start', timeoutMs: 660_000 },
  ]);
  assert.ok(calls.filter(call => call.operation === 'show').every(call => call.timeoutMs === 60_000));
});

test('self/ancestor/descendant process groups cannot control each other', async () => {
  for (const own of ['/user.slice/app.slice/synthetic-connector.service',
    '/user.slice/app.slice/synthetic-connector.service/child', '/user.slice/app.slice', '/', '']) {
    const f = fixture(); f.own(own);
    await assert.rejects(f.service.stop(), /could not be verified/);
    assert.deepEqual(f.calls, []);
  }
});

test('unknown unit, main-pid-only kill and delegated or mismatching cgroup fail before stop', async () => {
  for (const patch of [{ LoadState: 'not-found' }, { KillMode: 'process' }, { KillMode: 'mixed' }, { Delegate: 'yes' },
    { ControlGroup: '/other.service' }, { MainPID: '0' }, { ActiveState: 'activating' }, { ControlPID: '5678' }]) {
    const f = fixture(); Object.assign(f.state, patch);
    await assert.rejects(f.service.stop(), /could not be verified/);
    assert.equal(f.calls.some(args => args[1] === 'stop'), false);
  }
});

test('MainPID zero is not descendant proof; populated, malformed and unreadable groups prevent start', async () => {
  for (const events of ['populated 1\n', '', 'populated 0\npopulated 1\n']) {
    const f = fixture();
    await f.service.stop(); f.events(events);
    await assert.rejects(f.service.start(), /could not be verified/);
    assert.equal(f.calls.some(args => args[1] === 'start'), false);
  }
  const inaccessible = fixture(); await inaccessible.service.stop(); inaccessible.inaccessible();
  await assert.rejects(inaccessible.service.verifyStopped(), /could not be verified/);
  const removed = fixture(); await removed.service.stop(); removed.missing();
  await removed.service.verifyStopped();
});

test('delegated owned workers require opt-in and retain hierarchical exit and independence checks', async () => {
  const f = fixture(); f.state.Delegate = 'yes';
  const service = new SystemdConnectorService({ ...f.options, allowDelegated: true });
  await service.verifyRunning(); await service.stop();
  f.events('populated 1\nfrozen 0\n');
  await assert.rejects(service.start());
  assert.equal(f.calls.some(args => args[1] === 'start'), false);
  f.events('populated 0\nfrozen 0\n'); await service.start();
  f.own(`${f.options.controlGroup}/worker`);
  await assert.rejects(service.stop());
  f.own('/user.slice/app.slice/synthetic-supervisor.service');
  f.state.KillMode = 'mixed'; await assert.rejects(service.stop());
  f.state.KillMode = 'control-group'; f.state.Delegate = 'unknown'; await assert.rejects(service.stop());
});

test('unloaded transient supervisor is only stopped with explicit opt-in and hierarchical empty proof', async () => {
  const f = fixture(); await f.service.stop(); f.state.LoadState = 'not-found';
  await assert.rejects(f.service.verifyStopped());
  const service = new SystemdConnectorService({ ...f.options, allowUnloadedStopped: true });
  await service.verifyStopped(); await assert.rejects(service.verifyRunning());
  f.events('populated 1\n'); await assert.rejects(service.verifyStopped());
  f.events('populated 0\n'); f.state.MainPID = '1'; await assert.rejects(service.verifyStopped());
  f.state.MainPID = '0'; f.missing(); await service.verifyStopped();
});

test('no implicit system platform or unit/path injection; command errors never expose stderr', async () => {
  const f = fixture();
  for (const patch of [{ unit: '--other.service' }, { unit: 'a.service;sh' }, { systemctl: 'systemctl' },
    { controlGroup: '/a/../b' }, { controlGroup: '/' }, { platform: 'darwin' as const }]) {
    assert.throws(() => new SystemdConnectorService({ ...f.options, ...patch }), /could not be verified/);
  }
  const controller = new SystemdConnectorService({ ...f.options, run: async () => { throw new Error('private stderr contents'); } });
  await assert.rejects(controller.stop(), error => error instanceof Error
    && error.message === 'Independent Connector service control could not be verified');
});
