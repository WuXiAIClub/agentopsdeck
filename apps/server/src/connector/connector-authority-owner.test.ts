import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorOwnerUnavailable, connectorOwnerConfig, validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorUsersRequests } from './async-users-request.js';

const silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const disposers = new WeakMap<object, (() => void | Promise<void>)[]>();
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'connector-authority-worker-'));
  const config = { file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json') };
  const cleanup: (() => void | Promise<void>)[] = []; disposers.set(config, cleanup);
  t.after(async () => { try { for (const dispose of cleanup.reverse()) await dispose(); }
    finally { rmSync(root, { recursive: true, force: true }); } });
  return config;
}
async function ownerFixture(t: TestContext) {
  const config = fixture(t), owner = new AsyncConnectorOwner(config, silence);
  disposers.get(config)!.push(() => owner.closeForShutdown());
  await owner.open(); return { ...config, owner };
}
test('real authority Worker emits recovery evidence without credential, token hash, label or path', async t => {
  const config = fixture(t), lines: string[] = [];
  const owner = new AsyncConnectorOwner(config, silence, () => {
    const source = import.meta.url.endsWith('.ts');
    const entry = new URL(source ? './connector-owner-worker.ts' : './connector-owner-worker.js', import.meta.url);
    const worker = new Worker(`(async () => {
      const { workerData } = require('node:worker_threads');
      if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
      else await import(workerData.entry);
    })().catch(() => process.exit(1));`, { eval: true, execArgv: [], stdout: true, workerData: {
      ...config, entry: entry.href, loader: source ? import.meta.resolve('tsx/esm/api') : undefined,
    } });
    worker.stdout!.setEncoding('utf8'); worker.stdout!.on('data', chunk => lines.push(chunk)); return worker;
  });
  disposers.get(config)!.push(() => owner.closeForShutdown());
  await owner.open();
  const token = await owner.command('tokenCreate', { label: 'private-authority-label' });
  const hash = JSON.parse(readFileSync(config.tokenFile, 'utf8')).records[0].hash;
  mkdirSync(config.tokenFile + '.writer-lock');
  await assert.rejects(owner.command('tokenRevoke', { tokenId: token.record.id }), ConnectorOwnerUnavailable);
  assert.deepEqual(await owner.command('authorizedUserCreate', { authorization: `Bearer ${token.token}`, label: 'private-user-write-label' }), { authorized: false });
  await owner.close();
  const text = lines.join(''), events = text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.ok(events.some(e => e.operation === 'connector-token-owner' && e.step === 4 && e.unknown === 1));
  assert.ok(events.some(e => e.operation === 'connector-sqlite-command' && e.step === 24 && e.unknown === 1));
  for (const secret of [token.token, hash, token.record.id, config.file, config.tokenFile, 'private-authority-label', 'private-user-write-label'])
    assert.equal(text.includes(secret), false);
});
test('token authority and durable user write share one Worker with compatible metadata on reopen', async t => {
  const { file, tokenFile, owner } = await ownerFixture(t);
  const node = await owner.command('nodeIdentity', {});
  const issued = await owner.command('tokenCreate', { label: 'fixture', scopes: ['users:read', 'users:write', 'execution:delegate', 'messages:send'], delegationHubId: 'fixture-hub' });
  const authorization = `Bearer ${issued.token}`;
  assert.equal(await owner.command('tokenHasScope', { tokenId: issued.record.id, scope: 'users:write' }), true);
  assert.equal(await owner.command('tokenDelegationHub', { tokenId: issued.record.id }), 'fixture-hub');
  const principal = await owner.command('tokenAuthenticate', { authorization });
  assert.equal(principal?.tokenId, issued.record.id);
  const created = await owner.command('authorizedUserCreate', { authorization, label: 'saved user' });
  assert.equal(created.authorized, true); if (!created.authorized) assert.fail();
  const updated = await owner.command('authorizedUserUpdate', { authorization, id: created.value.id, label: 'renamed' });
  assert.equal(updated.authorized, true); if (!updated.authorized) assert.fail();
  assert.equal(updated.value?.label, 'renamed');
  assert.deepEqual(await owner.command('tokensList', {}), [issued.record]);
  await owner.close();
  const original = new ConnectorUserStore(file);
  try { assert.equal(original.nodeId, node); assert.equal(original.getUser(created.value.id)?.label, 'renamed'); }
  finally { original.close(); }
  const tokens = new ConnectorTokenStore(tokenFile);
  assert.equal(tokens.authenticateAuthorization(authorization)?.tokenId, issued.record.id);
  assert.equal(tokens.delegationHubId(issued.record.id), 'fixture-hub');
});
test('queued revocation precedes subsequent user mutation; preflight cannot lend authority', async t => {
  const { owner } = await ownerFixture(t);
  const token = await owner.command('tokenCreate', { label: 'writer', scopes: ['users:read', 'users:write'] });
  const authorization = `Bearer ${token.token}`;
  const initial = await owner.command('authorizedUserCreate', { authorization, label: 'original' });
  if (!initial.authorized) assert.fail();
  assert.ok(await owner.command('tokenAuthenticate', { authorization }));
  const revoke = owner.command('tokenRevoke', { tokenId: token.record.id });
  const update = owner.command('authorizedUserUpdate', { authorization, id: initial.value.id, label: 'forbidden update' });
  const create = owner.command('authorizedUserCreate', { authorization, label: 'forbidden create' });
  assert.equal(await revoke, true);
  assert.deepEqual(await update, { authorized: false }); assert.deepEqual(await create, { authorized: false });
  assert.equal((await owner.command('userGet', { id: initial.value.id }))?.label, 'original');
  assert.equal((await owner.command('usersList', {})).some(u => u.label === 'forbidden create'), false);
  assert.equal(await owner.command('tokenAuthenticate', { authorization }), null);
});
test('scope denial and missing credentials cannot disclose users or mutate SQL', async t => {
  const { owner } = await ownerFixture(t);
  const token = await owner.command('tokenCreate', { label: 'reader', scopes: ['users:read'] });
  const authorization = `Bearer ${token.token}`;
  const before = await owner.command('usersList', {});
  assert.deepEqual(await owner.command('authorizedUserCreate', { authorization, label: 'denied' }), { authorized: false });
  assert.deepEqual(await owner.command('authorizedUsersList', { authorization: '' }), { authorized: false });
  assert.deepEqual(await owner.command('authorizedUserGet', { authorization: 'Bearer unknown', id: 'private-id' }), { authorized: false });
  assert.deepEqual(await owner.command('usersList', {}), before);
  assert.equal((await owner.command('authorizedUsersList', { authorization })).authorized, true);
});
test('failed original credential save neither publishes a token nor replays later', async t => {
  const { owner, tokenFile } = await ownerFixture(t);
  const first = await owner.command('tokenCreate', { label: 'first' });
  const before = readFileSync(tokenFile, 'utf8'); mkdirSync(tokenFile + '.writer-lock');
  await assert.rejects(owner.command('tokenCreate', { label: 'must not appear' }), ConnectorOwnerUnavailable);
  assert.equal(readFileSync(tokenFile, 'utf8'), before);
  rmdirSync(tokenFile + '.writer-lock');
  assert.deepEqual(await owner.command('tokensList', {}), [first.record]);
  const next = await owner.command('tokenCreate', { label: 'next' });
  assert.deepEqual((await owner.command('tokensList', {})).map(r => r.id), [first.record.id, next.record.id]);
});
test('failed revocation retires authority, not durable facts, and user operations remain denied', async t => {
  const { owner, tokenFile } = await ownerFixture(t);
  const token = await owner.command('tokenCreate', { label: 'writer' }); const authorization = `Bearer ${token.token}`;
  const before = readFileSync(tokenFile, 'utf8'); mkdirSync(tokenFile + '.writer-lock');
  await assert.rejects(owner.command('tokenRevoke', { tokenId: token.record.id }), ConnectorOwnerUnavailable);
  assert.equal(readFileSync(tokenFile, 'utf8'), before);
  rmdirSync(tokenFile + '.writer-lock');
  assert.deepEqual(await owner.command('authorizedUserCreate', { authorization, label: 'denied even after unlock' }), { authorized: false });
  await assert.rejects(owner.command('tokensList', {}), ConnectorOwnerUnavailable);
  await owner.close();
  assert.ok(new ConnectorTokenStore(tokenFile).authenticateAuthorization(authorization), 'reopening observes the original durable token, not an invented successful revoke');
});
test('external durable revocation invalidates original Worker memory before SQL', async t => {
  const { owner, tokenFile } = await ownerFixture(t);
  const token = await owner.command('tokenCreate', { label: 'writer' });
  const external = new ConnectorTokenStore(tokenFile); external.revoke(token.record.id);
  assert.deepEqual(await owner.command('authorizedUserCreate', { authorization: `Bearer ${token.token}`, label: 'denied stale owner' }), { authorized: false });
  assert.equal(await owner.command('tokenHasScope', { tokenId: token.record.id, scope: 'users:write' }), false);
});
test('no configured authority has no permission fallback', async t => {
  const config = fixture(t), owner = new AsyncConnectorOwner({ file: config.file }, silence); disposers.get(config)!.push(() => owner.closeForShutdown());
  await owner.open();
  await assert.rejects(owner.command('authorizedUserCreate', { authorization: 'Bearer fixture', label: 'denied' }), ConnectorOwnerUnavailable);
  await assert.rejects(owner.command('tokensList', {}), ConnectorOwnerUnavailable);
  assert.ok(await owner.command('nodeIdentity', {}));
});
test('bootstrap uses original default scopes and all credentials survive original-file reopen', async t => {
  const config = fixture(t), owner = new AsyncConnectorOwner({ ...config, bootstrapToken: 'synthetic-bootstrap' }, silence);
  disposers.get(config)!.push(() => owner.closeForShutdown()); await owner.open();
  const principal = await owner.command('tokenAuthenticate', { authorization: 'bEaReR synthetic-bootstrap' });
  assert.ok(principal?.scopes.includes('users:write')); assert.equal(principal?.scopes.includes('execution:delegate'), false);
  await owner.close(); assert.ok(new ConnectorTokenStore(config.tokenFile).authenticateAuthorization('Bearer synthetic-bootstrap'));
});
test('original durable token strings and repeated scopes survive Worker transport without normalization', async t => {
  const config = fixture(t), secret = 'synthetic-legacy-secret';
  const record = { id: 'legacy\0' + 'i'.repeat(6000), label: 'label\0' + 'l'.repeat(6000),
    scopes: Array(40).fill('users:read').concat(['users:write', 'execution:delegate', 'messages:send']),
    createdAt: 1, delegationHubId: 'legacy-hub', hash: createHash('sha256').update(secret).digest('hex') };
  writeFileSync(config.tokenFile, JSON.stringify({ version: 1, records: [record] }));
  const before = readFileSync(config.tokenFile, 'utf8'), authorization = `Bearer ${secret}`;
  const original = new ConnectorTokenStore(config.tokenFile);
  const expected = original.authenticateAuthorization(authorization);
  const owner = new AsyncConnectorOwner(config, silence);
  disposers.get(config)!.push(() => owner.closeForShutdown()); await owner.open();
  assert.deepEqual(await owner.command('tokenAuthenticate', { authorization }), expected);
  assert.deepEqual(await owner.command('tokensList', {}), original.list());
  assert.equal(await owner.command('tokenHasScope', { tokenId: record.id, scope: 'users:write' }), true);
  assert.equal(await owner.command('authorizedUsersPermission', { authorization, scope: 'users:write' }), true);
  assert.equal(await owner.command('tokenDelegationHub', { tokenId: record.id }), 'legacy-hub');
  assert.equal((await owner.command('authorizedUserCreate', { authorization, label: 'legacy writer' })).authorized, true);
  assert.equal(readFileSync(config.tokenFile, 'utf8'), before, 'reads never normalize historical durable records');
  assert.equal(await owner.command('tokenRevoke', { tokenId: record.id }), true);
  assert.equal(await owner.command('tokenAuthenticate', { authorization }), null);
  assert.equal(await owner.command('authorizedUsersPermission', { authorization, scope: 'users:write' }), false);
  await owner.close();
  const reopened = new ConnectorTokenStore(config.tokenFile);
  assert.equal(reopened.authenticateAuthorization(authorization), undefined);
  const persisted = JSON.parse(readFileSync(config.tokenFile, 'utf8')).records[0];
  assert.equal(persisted.id, record.id); assert.equal(persisted.label, record.label);
  assert.deepEqual(persisted.scopes, record.scopes); assert.ok(persisted.revokedAt);
});
test('oversize historical output fails boundedly without retiring owner, changing disk or replaying work', async t => {
  const config = fixture(t), secret = 'synthetic-large-secret';
  writeFileSync(config.tokenFile, JSON.stringify({ version: 1, records: [{ id: 'legacy', label: 'l'.repeat(1024 * 1024),
    scopes: ['users:read'], createdAt: 1, hash: createHash('sha256').update(secret).digest('hex') }] }));
  const before = readFileSync(config.tokenFile, 'utf8'), owner = new AsyncConnectorOwner(config, silence);
  disposers.get(config)!.push(() => owner.closeForShutdown()); await owner.open();
  await assert.rejects(owner.command('tokensList', {}), ConnectorOwnerUnavailable);
  await assert.rejects(owner.command('tokenAuthenticate', { authorization: `Bearer ${secret}` }), ConnectorOwnerUnavailable);
  await assert.rejects(owner.command('tokenRevoke', { tokenId: 'i'.repeat(16384) }), ConnectorOwnerUnavailable);
  assert.ok(await owner.command('nodeIdentity', {}));
  assert.equal(await owner.command('tokenHasScope', { tokenId: 'legacy', scope: 'users:read' }), true);
  const requests = new AsyncConnectorUsersRequests(owner), request = new Request('http://fixture.invalid', { headers: { authorization: `Bearer ${secret}` } });
  assert.equal(await requests.authorize(request, 'users:read'), true, 'preflight does not serialize private metadata');
  assert.equal(await requests.authorize(request, 'users:write'), false);
  assert.equal((await requests.list(request)).authorized, true, 'authorized read remains usable without transferring token label');
  assert.equal(readFileSync(config.tokenFile, 'utf8'), before);
});
for (const [kind, input] of [
  ['authorizedUserCreate', { authorization: 'Bearer fixture', label: 'valid', authorized: true }],
  ['authorizedUserUpdate', { authorization: 'Bearer fixture', label: 'valid', id: 'id', principal: { scopes: ['users:write'] } }],
  ['tokenCreate', { label: 'valid', scopes: ['unknown'] }],
  ['tokenCreate', { label: 'valid', scopes: ['users:read', 'users:read'] }],
  ['tokenCreate', { label: 'valid', delegationHubId: 'hub', scopes: ['users:write'] }],
  ['tokenAuthenticate', { authorization: 'Bearer fixture\r\nsecret' }],
  ['authorizedUsersPermission', { authorization: 'Bearer fixture', scope: 'messages:send' }],
  ['authorizedUsersPermission', { authorization: 'Bearer fixture', scope: 'users:write', authorized: true }],
] as const) test(`fixed authority command rejects untrusted extra authority/input: ${kind} ${Object.keys(input).join(',')}`, () => {
  assert.equal(validConnectorOwnerInput(kind, input), false);
});
test('authority output refuses raw hash and an authorized result with extra fields', () => {
  assert.equal(validConnectorOwnerOutput('tokensList', [{ id: 'id', label: 'label', scopes: [], createdAt: 1, hash: 'secret' }]), false);
  assert.equal(validConnectorOwnerOutput('authorizedUsersList', { authorized: false, value: [] }), false);
  assert.equal(validConnectorOwnerOutput('tokenAuthenticate', { tokenId: 'id', label: 'label', scopes: ['users:read'], hash: 'secret' }), false);
  assert.throws(() => connectorOwnerConfig({ file: 'file', bootstrapToken: 'token' }), ConnectorOwnerUnavailable);
});
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(v: { id: number; kind: string; body: string }) { this.messages.push(v); }
  terminate() { return Promise.resolve(1); }
}
test('both authority and database reservations remain until physical exit; no early token replacement', async t => {
  const config = fixture(t), fake = new FakeWorker();
  const owner = new AsyncConnectorOwner(config, silence, () => fake as unknown as Worker); fake.emit('message', { kind: 'ready' });
  assert.throws(() => new AsyncConnectorOwner({ file: config.file + '.other', tokenFile: config.tokenFile }, silence), ConnectorOwnerUnavailable);
  const retire = owner.retireForShutdown(); await tick(); await tick();
  assert.throws(() => new AsyncConnectorOwner(config, silence), ConnectorOwnerUnavailable);
  fake.emit('exit', 1); await retire;
  const next = new AsyncConnectorOwner(config, silence); disposers.get(config)!.push(() => next.closeForShutdown()); await next.open();
});
test('malformed authorized user reply cannot swap identity or trigger retry', async t => {
  const config = fixture(t), fake = new FakeWorker();
  const owner = new AsyncConnectorOwner(config, silence, () => fake as unknown as Worker); fake.emit('message', { kind: 'ready' });
  const work = owner.command('authorizedUserGet', { authorization: 'Bearer fixture', id: 'expected' }); void work.catch(() => {}); await tick();
  const m = fake.messages[0]!;
  fake.emit('message', { id: m.id, kind: m.kind, ok: true, body: JSON.stringify({ authorized: true, value: { id: 'other', label: 'valid', createdAt: 1, updatedAt: 1 } }) });
  await assert.rejects(work, ConnectorOwnerUnavailable); assert.equal(fake.messages.length, 1);
  const retire = owner.retireForShutdown(); await tick(); fake.emit('exit', 1); await retire;
});
test('token/database alias is rejected before launch and failure rolls back only original reservations', async t => {
  const config = fixture(t), { file } = config; let launched = false;
  assert.throws(() => new AsyncConnectorOwner({ file, tokenFile: file }, silence, () => { launched = true; throw Error('must not launch'); }), ConnectorOwnerUnavailable);
  assert.equal(launched, false);
  assert.throws(() => new AsyncConnectorOwner({ file }, silence, () => { throw Error('launch failure'); }), ConnectorOwnerUnavailable);
  const next = new AsyncConnectorOwner({ file }, silence); disposers.get(config)!.push(() => next.closeForShutdown()); await next.open();
});
