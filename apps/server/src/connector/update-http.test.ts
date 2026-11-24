import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
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
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { registerConnectorProtocol } from './protocol-http.js';
import { registerConnectorUpdates } from './update-http.js';
import { ConnectorUpdateService } from './update-service.js';
import { registerAsyncMaintenanceReadiness, type MaintenanceBusinessObservation } from './maintenance-readiness.js';

const base = '/api/connector/v1';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; return { promise: new Promise<void>(r => { release = r; }), release: () => release() }; }
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'update-http-worker-'));
  const diagnostics = new PerformanceDiagnostics(() => {});
  const owner = new AsyncConnectorOwner({ file: join(directory, 'connector.sqlite'),
    tokenFile: join(directory, 'tokens.json'), bootstrapToken: 'private-bootstrap' }, diagnostics);
  await owner.open();
  const nodeId = await owner.command('nodeIdentity', {});
  const updater = await owner.command('tokenCreate', { label: 'update', scopes: ['connector:update'] });
  const reader = await owner.command('tokenCreate', { label: 'read', scopes: ['sessions:read'] });
  const lifecycle = await owner.command('tokenCreate', { label: 'lifecycle', scopes: ['connector:lifecycle'] });
  const persistence = new AsyncUpdatePersistence(owner, nodeId, diagnostics);
  const config = loadConfig({ AOD_CONNECTOR_UPDATE_ENABLED: 'true', AOD_CONNECTOR_VERSION: '1.0.0',
    AOD_CONNECTOR_UPDATE_MANIFEST_URL: 'https://example.test/manifest.json',
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(directory, 'state.json'), AOD_CONNECTOR_INSTALL_ROOT: directory,
    AOD_CONNECTOR_CURRENT_SYMLINK: join(directory, 'current') });
  await mkdir(join(directory, 'old/dist'), { recursive: true });
  await writeFile(join(directory, 'old/package.json'), '{}');
  await writeFile(join(directory, 'old/dist/index.js'), 'original');
  await symlink(join(directory, 'old'), config.connector.currentSymlink!);
  await writeFile(config.connector.updateStateFile, JSON.stringify({ supported: true, currentVersion: '1.0.0',
    state: 'idle', rollbackAvailable: false, updatedAt: 1, selectedRelease: { path: join(directory, 'old'), version: '1.0.0' } }));
  const service = new ConnectorUpdateService(config, persistence), app = new Hono();
  const drain = registerRequestDrain(app, { isControl: request => request.method === 'POST'
    && /^\/api\/connector\/v1\/maintenance\/(?:commands\/(?:pause|resume)|readiness)$/.test(new URL(request.url).pathname) });
  service.bindMaintenanceLifecycle(drain.pauseWrites);
  registerConnectorProtocol(app, base, nodeId);
  const routes = registerConnectorUpdates(app, base, { config, service, authority: persistence,
    normalizeError: error => error instanceof Error ? error.message : 'unknown update failure' });
  let probe: ((key: string, check: () => Promise<void>) => Promise<Omit<MaintenanceBusinessObservation, 'fenceId'>>) | undefined;
  const readiness = registerAsyncMaintenanceReadiness(app, { nodeId, authority: persistence, updateService: service,
    probe: async (key, check) => {
      await check();
      if (probe) return probe(key, check);
      return { nodeId, observedAt: Date.now(), revision: 'a'.repeat(40), sessionKey: key,
        messageCount: 2, projectionVerified: true, businessReadVerified: true };
    } });
  app.post('/write', c => c.text('original write'));
  const request = (path: string, body?: unknown, token = updater.token, headers: Record<string, string> = {}) =>
    app.request(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  t.after(async () => { await readiness.close(); await routes.close(); await persistence.close(); await drain(); await owner.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, owner, updater, reader, lifecycle, persistence, config, service, app, routes, request, nodeId, readiness,
    setProbe: (value: NonNullable<typeof probe>) => { probe = value; } };
}

// A real small archive consumed by the original validator/extractor, not a
// mocked install result or an alternative file executor.
function archive() {
  const chunks: Buffer[] = [];
  for (const [name, content] of Object.entries({ 'package.json': '{}', 'dist/index.js': 'installed' })) {
    const data = Buffer.from(content), h = Buffer.alloc(512);
    h.write(name, 0, 100); h.write('0000777\0', 100, 8); h.write('0000000\0', 108, 8); h.write('0000000\0', 116, 8);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12); h.write('00000000000\0', 136, 12);
    h.fill(' ', 148, 156); h.write('0', 156, 1); h.write('ustar\0', 257, 6);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

test('real HTTP worker update installs and rolls back through the original executor, duplicates never download again', async t => {
  const f = await fixture(t), artifact = archive();
  const manifest = JSON.stringify({ releases: [{ version: '2.0.0', artifactUrl: 'https://example.test/artifact.tar',
    sha256: createHash('sha256').update(artifact).digest('hex'), size: artifact.length }] });
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => { downloads++; return new Response(url.includes('artifact') ? artifact : manifest); });
  const body = { version: '2.0.0', manifestSha256: createHash('sha256').update(manifest).digest('hex'), idempotencyKey: 'original' };
  const applied = await f.request('/update/commands/apply', body);
  assert.equal(applied.status, 200, await applied.clone().text()); assert.equal(applied.headers.get('cache-control'), 'no-store');
  const appliedBody = await applied.json(); assert.equal(appliedBody.state, 'succeeded'); assert.equal(appliedBody.command.state, 'accepted');
  const installed = await readlink(f.config.connector.currentSymlink!);
  assert.equal(await readFile(join(installed, 'dist/index.js'), 'utf8'), 'installed'); assert.equal(downloads, 2);
  assert.deepEqual(await (await f.request('/update/commands/apply', body)).json(), appliedBody); assert.equal(downloads, 2);
  const read = await (await f.request('/update/commands/apply/original')).json();
  assert.equal(read.command.id, appliedBody.command.id);
  assert.equal((await f.request('/update/commands/apply', { ...body, version: '3.0.0' })).status, 409);
  assert.equal(downloads, 2);
  const rollback = await f.request('/update/commands/rollback', { idempotencyKey: 'rollback' });
  assert.equal(rollback.status, 200); const rollbackBody = await rollback.json(); assert.equal(rollbackBody.command.state, 'accepted');
  assert.equal(await readlink(f.config.connector.currentSymlink!), join(f.directory, 'old'));
  assert.deepEqual(await (await f.request('/update/commands/rollback', { idempotencyKey: 'rollback' })).json(), rollbackBody);
  assert.equal(downloads, 2);
});

test('real HTTP worker maintenance fences writes and resumes only the original receipt', async t => {
  const f = await fixture(t);
  const paused = await f.request('/maintenance/commands/pause', { idempotencyKey: 'pause' }); assert.equal(paused.status, 200);
  const body = await paused.json(); assert.equal(body.state, 'paused');
  assert.equal((await f.app.request('/write', { method: 'POST' })).status, 503);
  assert.deepEqual(await (await f.request('/maintenance/commands/pause', { idempotencyKey: 'pause' })).json(), body);
  assert.equal((await f.request('/maintenance/commands/pause/pause')).status, 200);
  assert.equal((await f.request('/maintenance/commands/resume', { idempotencyKey: 'invalid', fenceId: '00000000-0000-0000-0000-000000000000' })).status, 409);
  assert.equal((await f.app.request('/write', { method: 'POST' })).status, 503);
  const resumed = await f.request('/maintenance/commands/resume', { idempotencyKey: 'resume', fenceId: body.command.id });
  assert.equal(resumed.status, 200); assert.equal((await resumed.json()).state, 'released');
  assert.equal((await f.app.request('/write', { method: 'POST' })).status, 200);
});

test('async readiness requires exact lifecycle evidence and original actor fence, never releases writes', async t => {
  const f = await fixture(t), headers = { [CONNECTOR_PROTOCOL_HEADER]: '1', [EXPECTED_NODE_HEADER]: f.nodeId };
  const paused = await f.request('/maintenance/commands/pause', { idempotencyKey: 'ready-pause' }, f.lifecycle.token, headers);
  assert.equal(paused.status, 200);
  const { fenceId } = await paused.json(), body = { fenceId, sessionKey: 'codex:existing' };
  assert.equal((await f.request('/maintenance/readiness', body, f.updater.token, headers)).status, 403);
  assert.equal((await f.request('/maintenance/readiness', body, f.lifecycle.token)).status, 426);
  assert.equal((await f.request('/maintenance/readiness', body, f.lifecycle.token, { ...headers, origin: 'https://browser.test' })).status, 403);
  const other = await f.owner.command('tokenCreate', { label: 'other lifecycle', scopes: ['connector:lifecycle'] });
  assert.equal((await f.request('/maintenance/readiness', body, other.token, headers)).status, 409);
  assert.equal((await f.request('/maintenance/readiness', { ...body, injected: true }, f.lifecycle.token, headers)).status, 400);
  const response = await f.request('/maintenance/readiness', body, f.lifecycle.token, headers);
  assert.equal(response.status, 200); assert.equal((await response.json()).fenceId, fenceId);
  assert.equal((await f.app.request('/write', { method: 'POST' })).status, 503);
});

test('readiness awaits worker revocation, retains the original fence and drains physical probes on close', async t => {
  const f = await fixture(t), headers = { [CONNECTOR_PROTOCOL_HEADER]: '1', [EXPECTED_NODE_HEADER]: f.nodeId };
  const paused = await f.request('/maintenance/commands/pause', { idempotencyKey: 'ready-drain' }, f.lifecycle.token, headers);
  const { fenceId } = await paused.json(), entered = gate(), release = gate();
  f.setProbe(async (_key, check) => {
    entered.release(); await release.promise; await check(); assert.fail('revoked/closed probe must not deliver a proof');
  });
  const running = f.request('/maintenance/readiness', { fenceId, sessionKey: 'codex:existing' }, f.lifecycle.token, headers);
  await entered.promise;
  const resume = await f.request('/maintenance/commands/resume', { idempotencyKey: 'blocked-resume', fenceId }, f.lifecycle.token, headers);
  assert.notEqual(resume.status, 200, 'probe holds original fence lock');
  await f.owner.command('tokenRevoke', { tokenId: f.lifecycle.record.id });
  let closed = false; const closing = f.readiness.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  release.release(); assert.equal((await running).status, 403); await closing;
  assert.equal((await f.app.request('/write', { method: 'POST' })).status, 503);
  assert.equal((await f.service.maintenanceAtStartupAsync())?.state, 'paused');
});

test('original protocol and lifecycle identity policy surround the async update routes', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/update/status', undefined, f.reader.token)).status, 200);
  assert.equal((await f.request('/maintenance/status', undefined, f.reader.token)).status, 403);
  assert.equal((await f.request('/update/check', {}, f.reader.token)).status, 403);
  const headers = { [CONNECTOR_PROTOCOL_HEADER]: '1', [EXPECTED_NODE_HEADER]: f.nodeId };
  assert.equal((await f.request('/maintenance/status', undefined, f.lifecycle.token)).status, 403);
  assert.equal((await f.request('/maintenance/status', undefined, f.lifecycle.token, headers)).status, 200);
  assert.equal((await f.request('/maintenance/status', undefined, f.lifecycle.token, { ...headers, origin: 'https://browser.test' })).status, 403);
  assert.equal((await f.request('/update/check', {}, f.lifecycle.token, headers)).status, 403);
  assert.equal((await f.request('/update/status', undefined, f.updater.token, { [EXPECTED_NODE_HEADER]: 'node_other' })).status, 409);
  assert.equal((await f.request('/update/status', undefined, f.updater.token, { [CONNECTOR_PROTOCOL_HEADER]: '99' })).status, 426);
});

test('async update HTTP keeps bounded bodies, closed fields, retired writes and read-only missing commands', async t => {
  const f = await fixture(t), original = await readFile(f.config.connector.updateStateFile, 'utf8');
  t.mock.method(globalThis, 'fetch', async () => assert.fail('invalid requests cannot download'));
  for (const [path, body, status] of [
    ['/update/check', { actorId: 'forged' }, 400], ['/update/check', { channel: 'nightly' }, 400],
    ['/update/commands/apply', { version: 42, manifestSha256: 'x', idempotencyKey: 'x' }, 400],
    ['/update/commands/apply', { version: 'x'.repeat(9000) }, 413], ['/update/commands/rollback', { idempotencyKey: 'bad key' }, 400],
    ['/maintenance/commands/pause', { actorId: 'forged' }, 400], ['/maintenance/commands/resume', { idempotencyKey: 'missing' }, 409],
    ['/update/apply', {}, 410], ['/update/rollback', {}, 410],
  ] as const) assert.equal((await f.request(path, body)).status, status, path);
  assert.equal((await f.request('/update/commands/apply/missing')).status, 404);
  assert.equal((await f.request('/maintenance/commands/pause/missing')).status, 404);
  assert.equal(await readFile(f.config.connector.updateStateFile, 'utf8'), original);
  f.config.connector.updateEnabled = false;
  assert.equal((await f.request('/update/check', {})).status, 400);
});

test('route close waits for original physical check and cannot deliver an authorized response afterward', async t => {
  const f = await fixture(t), entered = gate(), release = gate();
  t.mock.method(globalThis, 'fetch', async () => { entered.release(); await release.promise; return Response.json({ releases: [] }); });
  const running = f.request('/update/check', {});
  await entered.promise; let closed = false;
  const closing = f.routes.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  release.release(); assert.equal((await running).status, 403); await closing;
  assert.equal((await f.request('/update/status')).status, 403);
});

test('original HTTP credential is rechecked after streamed body; revoked identity cannot claim a command', async t => {
  const f = await fixture(t), entered = gate(), release = gate();
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
    entered.release(); await release.promise;
    controller.enqueue(new TextEncoder().encode('{"idempotencyKey":"revoked"}')); controller.close();
  } }, { highWaterMark: 0 });
  const request = new Request(`http://connector${base}/maintenance/commands/pause`, {
    method: 'POST', headers: { authorization: `Bearer ${f.updater.token}` }, body: stream, duplex: 'half',
  } as RequestInit);
  const running = f.app.fetch(request);
  await entered.promise; await f.owner.command('tokenRevoke', { tokenId: f.updater.record.id }); release.release();
  assert.equal((await running).status, 403);
  assert.equal((await f.app.request('/write', { method: 'POST' })).status, 200);
});
