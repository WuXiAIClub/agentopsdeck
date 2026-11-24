import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { DockerSandboxManager, type DockerSandboxConfig } from '../hub/docker-sandbox.js';
import { HubStore } from '../hub/hub-store.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { OriginalHubAdministrativeCommands } from '../hub/original-administrative-commands.js';
import { AsyncHubMemberRequests } from '../hub/async-member-request.js';
import { hubMemberEvidence } from '../hub/member-owner-domain.js';
import { LEGACY_HUB_PRINCIPAL } from '../hub/identity.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubDockerSandboxes } from './hub-docker-sandboxes.js';

const base = '/api/hub/v1/docker-sandboxes';
const quiet = new PerformanceDiagnostics(() => {});

/** Never touches Docker, even if the route accidentally reaches a host method. */
class SyntheticManager extends DockerSandboxManager {
  calls: string[] = [];
  after: (operation: string) => Promise<void> = async () => {};
  override async probeDockerEngine() {
    this.calls.push('probe'); await this.after('probe');
    return { available: true, activeSandboxes: 0, totalCpuAllocated: 0, totalMemoryAllocatedMb: 0 };
  }
  override async listHostContainers() {
    this.calls.push('containers'); await this.after('containers'); return [];
  }
  override async getContainerLogs() {
    this.calls.push('logs'); await this.after('logs'); return ['PRIVATE_HOST_LOG'];
  }
  override async controlHostContainer() {
    this.calls.push('control'); await this.after('control'); return { ok: true, message: 'synthetic receipt' };
  }
  override async create(config: DockerSandboxConfig, execute = false, connectionId?: string) {
    this.calls.push('create'); assert.equal(execute, false, 'HTTP must never execute an unaccepted sandbox');
    const result = await super.create(config, false, connectionId); await this.after('create'); return result;
  }
  override async stop() {
    this.calls.push('stop'); await this.after('stop'); return undefined;
  }
  override renew(id: string, minutes?: number) { this.calls.push('renew'); return super.renew(id, minutes); }
}

function fixture(admin = false, enabled = false) {
  const manager = new SyntheticManager(), app = new Hono();
  let actor = { userId: 'alice', admin };
  registerHubDockerSandboxes(app, { manager, principal: () => actor, hostOperationsEnabled: enabled });
  const request = (suffix = '', method = 'GET', body?: unknown) => app.request('http://hub.example.invalid' + base + suffix, {
    method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { manager, app, request, change: (userId: string, isAdmin = false) => { actor = { userId, admin: isAdmin }; } };
}

for (const admin of [false, true]) test(`admin=${admin}: default-off gate blocks host access and client opt-in before effects`, async () => {
  const f = fixture(admin);
  for (const [suffix, method, body] of [
    ['/containers/foreign/logs', 'GET', undefined],
    ['/containers/foreign/stop', 'POST', undefined],
    ['', 'POST', { executeContainer: true, hostOperationsEnabled: true, ownerUserId: 'default', image: 'arbitrary', secretEnvKeys: ['PRIVATE_KEY'] }],
  ] as const) assert.equal((await f.request(suffix, method, body)).status, 403);
  assert.deepEqual(f.manager.calls, []);
});

test('server opt-in still cannot grant a member host access', async () => {
  const f = fixture(false, true);
  assert.equal((await f.request('/containers/foreign/logs')).status, 403);
  assert.equal((await f.request('/containers/foreign/restart', 'POST')).status, 403);
  assert.deepEqual(f.manager.calls, []);
});

for (const admin of [false, true]) test(`admin=${admin}: unaccepted host listing returns only own blueprints without probing Docker`, async () => {
  const f = fixture(admin);
  await f.manager.create({ ownerUserId: 'bob', name: 'PRIVATE_FOREIGN_SANDBOX' });
  await f.manager.create({ ownerUserId: 'alice', name: 'own blueprint' }); f.manager.calls.length = 0;
  const response = await f.request(), text = await response.text(), body = JSON.parse(text);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(body.hostOperations, false); assert.equal(body.engine.available, false);
  assert.equal(body.sandboxes.length, 1); assert.deepEqual(body.containers, []);
  assert.equal(text.includes('PRIVATE_FOREIGN_SANDBOX'), false); assert.deepEqual(f.manager.calls, []);
});

test('even opted-in host admin cannot execute arbitrary sandbox profiles or host secret references', async () => {
  const f = fixture(true, true);
  const response = await f.request('', 'POST', { executeContainer: true, image: 'unaccepted', secretEnvKeys: ['PRIVATE_KEY'] });
  assert.equal(response.status, 403); assert.deepEqual(f.manager.calls, []);
});

test('blueprint owner is pinned and malformed/oversized JSON never creates a sandbox', async () => {
  const f = fixture();
  for (const body of [null, [], { executeContainer: 'true' }, { name: 'x'.repeat(9000) }]) {
    assert.ok([400, 413].includes((await f.request('', 'POST', body)).status));
  }
  assert.deepEqual(f.manager.calls, []);
  const created = await f.request('', 'POST', { ownerUserId: 'bob', executeContainer: false });
  assert.equal(created.status, 201); assert.equal((await created.json()).sandbox.ownerUserId, 'alice');
  assert.deepEqual(f.manager.calls, ['create']);
});

test('expired container-backed records cannot bypass host gate through renew/delete', async () => {
  const f = fixture(); const record = await f.manager.create({ ownerUserId: 'alice' });
  // A stale memory record is deliberately not a trusted member execution proof.
  record.status = 'expired'; record.containerId = 'host-container'; f.manager.calls.length = 0;
  assert.equal((await f.request('/' + record.id + '/renew', 'POST', { extendMinutes: 15 })).status, 403);
  assert.equal((await f.request('/' + record.id, 'DELETE')).status, 403);
  assert.deepEqual(f.manager.calls, []);
});

test('account change while consuming JSON prevents blueprint creation', async () => {
  const f = fixture(); let principalReads = 0;
  const app = new Hono();
  registerHubDockerSandboxes(app, { manager: f.manager, principal: () => ({ userId: ++principalReads === 1 ? 'alice' : 'bob', admin: false }) });
  const response = await app.request('http://hub.example.invalid' + base, { method: 'POST', body: '{}' });
  assert.equal(response.status, 401); assert.deepEqual(f.manager.calls, []);
});

test('admin revocation after probe prevents enumeration; late log revocation suppresses bytes', async () => {
  for (const operation of ['probe', 'logs']) {
    const f = fixture(true, true);
    f.manager.after = async current => { if (current === operation) f.change('alice', false); };
    const response = await f.request(operation === 'probe' ? '' : '/containers/foreign/logs');
    assert.equal(response.status, 401); assert.equal((await response.text()).includes('PRIVATE_HOST_LOG'), false);
    assert.deepEqual(f.manager.calls, [operation]);
  }
});

test('unknown host write is never retried or followed by enumeration', async () => {
  const f = fixture(true, true);
  f.app.onError((_error, c) => c.json({ error: 'unavailable' }, 503));
  f.manager.after = async current => { if (current === 'control') throw Error('ACK lost after synthetic effect'); };
  assert.equal((await f.request('/containers/foreign/stop', 'POST')).status, 503);
  assert.deepEqual(f.manager.calls, ['control']);
});

test('request abort during host logs suppresses late output', async () => {
  const f = fixture(true, true), controller = new AbortController();
  f.manager.after = async current => { if (current === 'logs') controller.abort(); };
  const response = await f.app.fetch(new Request('http://hub.example.invalid' + base + '/containers/foreign/logs', { signal: controller.signal }));
  assert.equal(response.status, 503); assert.equal((await response.text()).includes('PRIVATE_HOST_LOG'), false);
  assert.deepEqual(f.manager.calls, ['logs']);
});

test('closing the independent server gate while logs wait suppresses late output', async () => {
  const manager = new SyntheticManager(), app = new Hono();
  const deps = { manager, principal: () => ({ userId: 'alice', admin: true }), hostOperationsEnabled: true };
  registerHubDockerSandboxes(app, deps);
  manager.after = async current => { if (current === 'logs') deps.hostOperationsEnabled = false; };
  const response = await app.request('http://hub.example.invalid' + base + '/containers/foreign/logs');
  assert.equal(response.status, 403); assert.equal((await response.text()).includes('PRIVATE_HOST_LOG'), false);
  assert.deepEqual(manager.calls, ['logs']);
});

test('late account loss after blueprint creation does not claim success or replay creation', async () => {
  const f = fixture();
  f.manager.after = async current => { if (current === 'create') f.change('bob'); };
  const response = await f.request('', 'POST', {});
  assert.equal(response.status, 401); assert.deepEqual(f.manager.calls, ['create']);
  assert.equal(f.manager.list('alice', false).length, 1, 'a final denial cannot undo an already-created blueprint');
});

test('successful opted-in operator reads and controls once; account loss after effect prevents next read', async () => {
  const f = fixture(true, true);
  assert.equal((await f.request('/containers/foreign/logs')).status, 200);
  assert.equal((await f.request('/containers/foreign/stop', 'POST')).status, 200);
  assert.deepEqual(f.manager.calls, ['logs', 'control', 'containers']);
  f.manager.calls.length = 0;
  f.manager.after = async current => { if (current === 'control') f.change('bob', true); };
  assert.equal((await f.request('/containers/foreign/stop', 'POST')).status, 401);
  assert.deepEqual(f.manager.calls, ['control']);
});

for (const mode of ['original', 'worker'] as const) test(`${mode}: original durable key revocation while logs wait prevents late data`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'docker-authority-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'synthetic-vault');
  const operator = seed.createUser('Operator'), controller = seed.createUser('Controller');
  seed.roles.setHubRole(LEGACY_HUB_PRINCIPAL, operator.id, 'admin', 0);
  seed.roles.setHubRole(LEGACY_HUB_PRINCIPAL, controller.id, 'admin', 0);
  const login = seed.identities.issueKey(operator.id), controlLogin = seed.identities.issueKey(controller.id);
  await seed.close();
  const store = mode === 'original' ? new HubStore(file, 'synthetic-vault') : undefined;
  const owner = store ? new OriginalHubAdministrativeCommands(store, quiet)
    : new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-vault' }, quiet);
  const members = new AsyncHubMemberRequests(owner, quiet), manager = new SyntheticManager(), app = new Hono();
  registerHubDockerSandboxes(app, { manager, members, hostOperationsEnabled: true,
    principal: () => { throw Error('synchronous principal bypass'); } });
  manager.after = async operation => {
    if (operation !== 'logs') return;
    const evidence = hubMemberEvidence(new Request('http://hub.example.invalid', { headers: { authorization: `Bearer ${controlLogin.token}` } }));
    const snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
    const result = await owner.command('memberKeyRevoke', { evidence, expectedScope: snapshot.recoveryScope, userId: operator.id, keyId: login.id });
    assert.deepEqual(result, { ok: true });
  };
  try {
    const response = await app.request('http://hub.example.invalid' + base + '/containers/foreign/logs', { headers: { authorization: `Bearer ${login.token}` } });
    assert.equal(response.status, 401); assert.equal((await response.text()).includes('PRIVATE_HOST_LOG'), false);
    assert.deepEqual(manager.calls, ['logs']);
  } finally { await members.close(); await owner.close(); await store?.close(); rmSync(root, { recursive: true, force: true }); }
});
