import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { loadConfig } from '../config.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerRequestDrain } from '../lifecycle/request-drain.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncUpdatePersistence } from './async-update-persistence.js';
import { validConnectorUpdateInput, updateScopeIdentity } from './connector-update-domain.js';
import { ConnectorUpdateService, UpdateAuthorizationError } from './update-service.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';

const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; return { promise: new Promise<void>(r => { release = r; }), release: () => release() }; }
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'async-update-chain-'));
  const file = join(directory, 'connector.sqlite'), stateFile = join(directory, 'update.json');
  const owner = new AsyncConnectorOwner({ file, tokenFile: join(directory, 'tokens.json'), bootstrapToken: 'PRIVATE-bootstrap' }, quiet);
  await owner.open();
  const nodeId = await owner.command('nodeIdentity', {});
  const first = await owner.command('tokenCreate', { label: 'updater', scopes: ['connector:update'] });
  const persistence = new AsyncUpdatePersistence(owner, nodeId, quiet);
  const config = loadConfig({ AOD_CONNECTOR_UPDATE_STATE_FILE: stateFile, AOD_CONNECTOR_UPDATE_ENABLED: 'false' });
  const service = new ConnectorUpdateService(config, persistence);
  const app = new Hono(), drain = registerRequestDrain(app);
  app.post('/write', c => c.text('written'));
  service.bindMaintenanceLifecycle(drain.pauseWrites);
  const request = (token = first.token, headers?: Record<string, string>) => new Request('http://local/', {
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
  t.after(async () => { await persistence.close(); await drain(); await owner.close(); rmSync(directory, { recursive: true, force: true }); });
  const change = (operation: 'pause' | 'resume', key: string, fence?: string) => persistence.run(request(), 'maintenance',
    operator => service.changeMaintenance(operator.actorId, operation, key, fence, operator.check));
  return { directory, file, stateFile, owner, nodeId, first, persistence, config, service, app, drain, request, change };
}

test('worker command payloads accept only canonical original update and maintenance operations', () => {
  const scope = JSON.stringify(['maintenance', JSON.stringify(['node', 'actor', 'pause'])]);
  const input = { scope, key: 'key', authorization: 'Bearer private', expectedNode: '', protocol: '', originPresent: false,
    actorId: 'actor', payload: {}, existing: false };
  assert.equal(validConnectorUpdateInput('updateReceiptClaim', input), true);
  for (const payload of [undefined, null, [], { sql: 'untrusted' }, { fenceId: 'foreign' }]) {
    assert.equal(validConnectorUpdateInput('updateReceiptClaim', { ...input, payload }), false);
  }
  assert.equal(updateScopeIdentity(JSON.stringify(['maintenance', '[ "node", "actor", "pause" ]'])), undefined);
});

test('real worker original maintenance chain preserves receipts, admission fence and reopen identity', async t => {
  const f = await fixture(t);
  const pause = await f.change('pause', 'original');
  assert.equal(pause.state, 'accepted'); assert.equal(pause.result?.body.state, 'paused');
  assert.equal((await f.app.request('/write', { method: 'POST' })).status, 503);
  assert.deepEqual(await f.change('pause', 'original'), pause);
  const state = JSON.parse(readFileSync(f.stateFile, 'utf8'));
  assert.equal(state.maintenance.nodeId, f.nodeId); assert.equal(state.maintenance.command.id, pause.id);
  assert.throws(() => f.service.maintenanceAtStartup(), /async maintenance startup/);
  await f.persistence.close(); await f.owner.close();
  const reopenedOwner = new AsyncConnectorOwner({ file: f.file, tokenFile: join(f.directory, 'tokens.json') }, quiet);
  await reopenedOwner.open();
  const reopenedPersistence = new AsyncUpdatePersistence(reopenedOwner, f.nodeId, quiet);
  try {
  const reopened = new ConnectorUpdateService(f.config, reopenedPersistence);
  reopened.bindMaintenanceLifecycle(f.drain.pauseWrites, await reopened.maintenanceAtStartupAsync());
  assert.equal((await f.app.request('/write', { method: 'POST' })).status, 503);
  const resumed = await reopenedPersistence.run(f.request(), 'maintenance', operator =>
    reopened.changeMaintenance(operator.actorId, 'resume', 'resume', pause.id, operator.check));
  assert.equal(resumed.result?.body.state, 'released');
  assert.equal((await f.app.request('/write', { method: 'POST' })).status, 200);
  const head = await reopenedOwner.command('eventProjectionHead', {});
  await reopenedPersistence.run(f.request(), 'maintenance', operator => reopened.maintenanceStatus(operator.check));
  assert.deepEqual(await reopenedOwner.command('eventProjectionHead', {}), head, 'pure update observations must not invalidate projection');
  assert.doesNotMatch(JSON.stringify(quiet.snapshot()), /PRIVATE|Bearer/);
  } finally { await reopenedPersistence.close(); await reopenedOwner.close(); }
});

test('captured credentials cannot be replaced by mutable headers or a returned operator', async t => {
  const f = await fixture(t), other = await f.owner.command('tokenCreate', { label: 'other', scopes: ['connector:update'] });
  const request = f.request();
  await assert.rejects(f.persistence.run(request, 'maintenance', async operator => {
    request.headers.set('authorization', `Bearer ${other.token}`); operator.actorId = other.record.id;
    await f.owner.command('tokenRevoke', { tokenId: f.first.record.id });
    await operator.check();
  }), UpdateAuthorizationError);
  assert.throws(() => readFileSync(f.stateFile), { code: 'ENOENT' });
});

test('status scope cannot mutate; lifecycle requires original no-Origin protocol and node evidence', async t => {
  const f = await fixture(t);
  const reader = await f.owner.command('tokenCreate', { label: 'reader', scopes: ['sessions:read'] });
  assert.equal(await f.persistence.run(f.request(reader.token), 'status', async op => op.recover), false);
  await assert.rejects(f.persistence.run(f.request(reader.token), 'maintenance', async () => {}), UpdateAuthorizationError);
  const lifecycle = await f.owner.command('tokenCreate', { label: 'lifecycle', scopes: ['connector:lifecycle'] });
  for (const headers of [{}, { [EXPECTED_NODE_HEADER]: f.nodeId },
    { [EXPECTED_NODE_HEADER]: f.nodeId, [CONNECTOR_PROTOCOL_HEADER]: '1', origin: 'http://local' }]) {
    await assert.rejects(f.persistence.run(f.request(lifecycle.token, headers), 'maintenance', async () => {}), UpdateAuthorizationError);
  }
  const request = f.request(lifecycle.token, { [EXPECTED_NODE_HEADER]: f.nodeId, [CONNECTOR_PROTOCOL_HEADER]: '1' });
  assert.equal(await f.persistence.run(request, 'maintenance', async op => op.recover), false);
  await assert.rejects(f.persistence.run(request, 'update', async () => {}), UpdateAuthorizationError);
});

test('startup fails closed for malformed and mismatched original journals', async t => {
  const f = await fixture(t); await f.change('pause', 'original');
  const original = readFileSync(f.stateFile, 'utf8');
  writeFileSync(f.stateFile, '{'); await assert.rejects(f.service.maintenanceAtStartupAsync(), /invalid|journal/);
  const state = JSON.parse(original); state.maintenance.command.id = '00000000-0000-0000-0000-000000000000';
  state.maintenance.id = state.maintenance.command.id;
  writeFileSync(f.stateFile, JSON.stringify(state));
  await assert.rejects(f.service.maintenanceAtStartupAsync(), /identity mismatch/);
});

test('async resume keeps admission fenced while durable settlement is pending and close drains original work', { timeout: 20_000 }, async t => {
  const f = await fixture(t), pause = await f.change('pause', 'original');
  const entered = gate(), release = gate(); let resumed = 0;
  const forwarding: Pick<AsyncConnectorOwner, 'command'> = { command: (async (kind, input) => {
    if (kind === 'updateReceiptSettle' && (input as { result: { body: { state?: string } } }).result.body.state === 'released') {
      entered.release(); await release.promise;
    }
    return f.owner.command(kind, input);
  }) as AsyncConnectorOwner['command'] };
  const persistence = new AsyncUpdatePersistence(forwarding, f.nodeId, quiet);
  const service = new ConnectorUpdateService(f.config, persistence);
  service.bindMaintenanceLifecycle(() => ({ drained: Promise.resolve(), resume: () => { resumed++; return true; } }));
  const running = persistence.run(f.request(), 'maintenance', op => service.changeMaintenance(op.actorId, 'resume', 'resume', pause.id, op.check));
  const refused = assert.rejects(running, UpdateAuthorizationError);
  await entered.promise; assert.equal(resumed, 0);
  let drained = false; const closing = persistence.close().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); release.release();
  await refused; await closing; assert.equal(resumed, 0);
  assert.equal((await service.maintenanceAtStartupAsync().catch(() => undefined)), undefined, 'closed port cannot read');
  const reopened = new ConnectorUpdateService(f.config, f.persistence);
  const restored = await reopened.maintenanceAtStartupAsync();
  assert.equal(restored?.state, 'paused'); assert.equal(restored?.resumeInterrupted, true);
});

for (const failure of ['revoked after settlement', 'local admission refuses release'] as const) {
  test(`accepted async release intent stays fenced when ${failure}, with no automatic replay`, async t => {
    const f = await fixture(t), pause = await f.change('pause', 'pause');
    let resumeCalls = 0;
    const forwarding: Pick<AsyncConnectorOwner, 'command'> = { command: (async (kind, input) => {
      const output = await f.owner.command(kind, input);
      if (kind === 'updateReceiptSettle' && (input as { result: { body: { state?: string } } }).result.body.state === 'released'
        && failure === 'revoked after settlement') await f.owner.command('tokenRevoke', { tokenId: f.first.record.id });
      return output;
    }) as AsyncConnectorOwner['command'] };
    const persistence = new AsyncUpdatePersistence(forwarding, f.nodeId, quiet);
    const service = new ConnectorUpdateService(f.config, persistence);
    service.bindMaintenanceLifecycle(() => ({ drained: Promise.resolve(), resume: () => { resumeCalls++; return false; } }));
    try {
      await assert.rejects(persistence.run(f.request(), 'maintenance', op =>
        service.changeMaintenance(op.actorId, 'resume', 'resume', pause.id, op.check)),
      failure === 'revoked after settlement' ? UpdateAuthorizationError : /cannot resume/);
      assert.equal(resumeCalls, failure === 'revoked after settlement' ? 0 : 1);
      const restored = await service.maintenanceAtStartupAsync();
      assert.equal(restored?.state, 'paused'); assert.equal(restored?.resumeInterrupted, true);
      const receipt = await persistence.receipts.get(restored!.command.scope, 'resume');
      assert.equal(receipt?.state, 'accepted', 'durable intent cannot be erased by a late local failure');
      assert.equal((await f.app.request('/write', { method: 'POST' })).status, 503);
      assert.equal(resumeCalls, failure === 'revoked after settlement' ? 0 : 1, 'inspection does not replay release');
    } finally { await persistence.close(); }
  });
}
