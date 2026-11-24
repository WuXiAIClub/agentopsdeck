import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { ownerControlScope, type OwnerControlTarget } from './member-owner-control-domain.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ExecutionUsageAdmission } from './execution-leases.js';

const administratorKey = 'isolated-original-administrative-key';
const request = (key = administratorKey) => new Request('http://fixture.invalid/', { headers: { 'x-agentopsdeck-key': key } });
const quiet = new PerformanceDiagnostics(() => {});
async function fixture(work: (store: HubStore, port: OriginalHubAdministrativeCommands) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'original-admin-'));
  const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-secret', [], administratorKey,
    request => request.headers.get('x-agentopsdeck-key') === administratorKey);
  const port = new OriginalHubAdministrativeCommands(store, quiet);
  try { await work(store, port); }
  finally { await port.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
}

for (const lostAck of [false, true]) test(`original content document owns asynchronous settlement through close, lost ACK=${lostAck}`,
  { timeout: 15_000 }, () => fixture(async (store, port) => {
    const user = store.createUser('Content owner'), key = store.identities.issueKey(user.id);
    const evidence = { accessKey: key.token }, snapshot = await port.command('memberSnapshot', evidence);
    assert.ok(snapshot);
    const resourceId = JSON.stringify(['taskboard', 'default']), requestId = randomUUID();
    const originalFactory = store.createContentDocumentStore.bind(store);
    let release!: () => void, markEntered!: () => void, calls = 0, drained = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    store.createContentDocumentStore = () => {
      const documents = originalFactory(), migrate = documents.migrateNativeRequestAsync.bind(documents);
      documents.migrateNativeRequestAsync = async (...args) => {
        calls++;
        const receipt = await migrate(...args);
        markEntered(); await gate;
        if (lostAck) throw Error('private original content ACK lost');
        return receipt;
      };
      return documents;
    };
    const flight = port.command('contentDocument', { evidence, expectedScope: snapshot.recoveryScope,
      command: { action: 'migrate', resourceId, revision: 0, requestId } });
    const settled = flight.then(value => ({ value }), error => ({ error }));
    try {
      await entered;
      assert.equal(port.pending, 1);
      assert.equal(originalFactory().migration(user.id, requestId)?.mutationId, requestId);
      const closing = port.close(); void closing.then(() => { drained = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(drained, false); assert.equal(port.pending, 1);
      await assert.rejects(port.command('memberSnapshot', evidence), HubMemberOwnerUnavailable);
      assert.equal(calls, 1);
      release();
      const result = await settled;
      if (lostAck) { assert.ok('error' in result); assert.ok(result.error instanceof AuthPersistenceError); }
      else { assert.ok('value' in result && result.value && 'receipt' in result.value); assert.ok(result.value.receipt); }
      await closing;
      assert.equal(drained, true); assert.equal(port.pending, 0); assert.equal(calls, 1);
      assert.equal(originalFactory().migration(user.id, requestId)?.mutationId, requestId);
    } finally { release(); store.createContentDocumentStore = originalFactory; await settled; }
  }));

test('original single writer administrative commands preserve user/key shapes and fresh revocation', () => fixture(async (store, port) => {
  const members = new AsyncHubMemberRequests(port, quiet);
  try {
    const admin = await members.begin(request());
    const user = await admin.createUser(' existing user ');
    assert.equal(user.label, 'existing user');
    assert.equal((await admin.updateUser(user.id, 'renamed'))?.label, 'renamed');
    const key = await admin.issue(user.id);
    assert.deepEqual(Object.keys(key).sort(), ['id', 'token']);
    assert.equal((await admin.keys(user.id)).keys.length, 1);
    assert.deepEqual(await admin.revoke(user.id, 'not-a-key'), { ok: false });
    const member = await members.begin(request(key.token));
    await assert.rejects(member.keys(user.id), error => error instanceof HubMemberRequestError && error.status === 403);
    assert.deepEqual(await admin.revoke(user.id, key.id), { ok: true });
    assert.equal((await admin.keys(user.id)).keys.length, 0);
    await assert.rejects(member.check(), error => error instanceof HubMemberRequestError && error.status === 403);
    assert.equal(store.getUser(user.id)?.label, 'renamed');
  } finally { await members.close(); }
}));

test('closed retained request cannot use even a malformed-key no-op and port never closes original store', () => fixture(async (store, port) => {
  const members = new AsyncHubMemberRequests(port, quiet), admin = await members.begin(request());
  await members.close();
  await assert.rejects(admin.revoke('default', 'invalid'), error => error instanceof HubMemberRequestError && error.status === 503);
  const closing = port.close(); assert.equal(port.close(), closing); await closing;
  await assert.rejects(port.command('memberSnapshot', { accessKey: administratorKey }), HubMemberOwnerUnavailable);
  assert.equal(store.createUser('store remains original owner').label, 'store remains original owner');
}));

test('fixed production port rejects unsupported domains, proxies, getters and authority injection without executing them', () => fixture(async (_store, port) => {
  let invoked = 0;
  const values = [new Proxy({}, { ownKeys() { invoked++; return []; } }),
    Object.defineProperty({}, 'accessKey', { enumerable: true, get() { invoked++; return administratorKey; } }),
    { accessKey: administratorKey, authorized: true }];
  for (const value of values) await assert.rejects(port.command('memberSnapshot', value), HubMemberOwnerUnavailable);
  await assert.rejects(port.command('legacyAuth', {} as never), HubMemberOwnerUnavailable);
  // Workspace reads are now an admitted domain, not an unsupported command.
  // Missing original identity must still yield no authority or document.
  assert.equal(await port.command('workspaceGet', { evidence: {}, expectedScope: 'a'.repeat(64) }), null);
  assert.equal(invoked, 0); assert.equal(port.pending, 0);
}));

test('diagnostic reentrant close prevents reserved dispatch and drains exactly that original reservation', () => fixture(async (store, _port) => {
  const diagnostics = new PerformanceDiagnostics(() => {});
  const port = new OriginalHubAdministrativeCommands(store, diagnostics);
  let closing: Promise<void> | undefined, originalCalls = 0;
  const original = store.identities.commandPrincipal.bind(store.identities);
  store.identities.commandPrincipal = (...args) => { originalCalls++; return original(...args); };
  const start = diagnostics.start.bind(diagnostics);
  diagnostics.start = (...args) => { closing ??= port.close(); return start(...args); };
  await assert.rejects(port.command('memberSnapshot', { accessKey: administratorKey }), AuthPersistenceError);
  await closing; assert.equal(port.pending, 0); assert.equal(originalCalls, 0);
}));

test('owner control original async claim ACK retains port admission and survives close without replay', () => fixture(async (store, port) => {
  store.upsertConnection({ id: 'node', kind: 'local', label: 'Local', connectorUrl: 'local://aod-connector' });
  const target: OwnerControlTarget = { operation: 'create', connectionId: 'node', agentId: 'codex' };
  const epoch = store.connectionAuthority('node', 'default')!, snapshot = await port.command('memberSnapshot', { accessKey: administratorKey });
  assert.ok(snapshot);
  let enter!: () => void, release!: () => void, calls = 0, drained = false;
  const entered = new Promise<void>(yes => { enter = yes; }), gate = new Promise<void>(yes => { release = yes; });
  const original = store.commands.claimAsync.bind(store.commands);
  store.commands.claimAsync = async (...args) => { calls++; const result = await original(...args); enter(); await gate; return result; };
  const claim = port.command('ownerControl', { evidence: { accessKey: administratorKey }, expectedScope: snapshot.recoveryScope,
    command: { action: 'claim', target, epoch, key: 'saved', payload: {} } });
  await entered; assert.equal(port.pending, 1);
  const closing = port.close(); void closing.then(() => { drained = true; });
  try {
    await new Promise<void>(yes => setImmediate(yes)); assert.equal(drained, false); assert.equal(port.pending, 1);
    await assert.rejects(port.command('ownerControl', { evidence: { accessKey: administratorKey }, expectedScope: snapshot.recoveryScope,
      command: { action: 'claim', target, epoch, key: 'other', payload: {} } }), HubMemberOwnerUnavailable);
    assert.equal(calls, 1);
  } finally { release(); }
  const result = await claim; assert.ok(result && 'fresh' in result && result.fresh && result.receipt.state === 'outcome_unknown');
  await closing; assert.equal(port.pending, 0); assert.equal(drained, true); assert.equal(calls, 1);
  assert.equal(store.commands.get(ownerControlScope('default', target), 'saved')?.id, result.receipt.id);
}));

test('bounded production admission releases reservations after ACK and never caches a principal', () => fixture(async (_store, port) => {
  const pending = Array.from({ length: 256 }, () => port.command('memberSnapshot', { accessKey: administratorKey }));
  assert.equal(port.pending, 256);
  await assert.rejects(port.command('memberSnapshot', { accessKey: administratorKey }), HubMemberOwnerUnavailable);
  const results = await Promise.all(pending); assert.ok(results.every(value => value?.principal.admin));
  assert.equal(port.pending, 0);
  assert.equal(await port.command('memberSnapshot', { accessKey: 'wrong' }), null);
  assert.ok((await port.command('memberSnapshot', { accessKey: administratorKey }))?.principal.admin);
}));

test('lost result after an original mutation is unknown, never replayed, and logs contain no private error or key', () => fixture(async (store, _port) => {
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const port = new OriginalHubAdministrativeCommands(store, diagnostics);
  const principal = { userId: 'default', admin: true };
  const expectedScope = store.identities.recoveryScope(principal);
  const original = store.identities.administratorUserCommand.bind(store.identities);
  let effects = 0;
  store.identities.administratorUserCommand = (...args) => {
    effects++; original(...args); throw Error('PRIVATE original commit reply ' + administratorKey);
  };
  await assert.rejects(port.command('userChange', { evidence: { accessKey: administratorKey }, expectedScope,
    change: { action: 'create', label: 'original effect' } }), AuthPersistenceError);
  await port.close();
  assert.equal(effects, 1); assert.equal(store.listUsers().filter(user => user.label === 'original effect').length, 1);
  assert.ok(diagnostics.snapshot().events.some(event => event.unknown === 1));
  assert.doesNotMatch(lines.join('\n'), /PRIVATE|isolated-original-administrative-key|original effect/);
}));

for (const lostAck of [false, true]) test(`issuer preflight keeps original read ownership through close (lost ACK: ${lostAck})`, () => fixture(async (store, port) => {
  const original = store.executionLeaseCommand.bind(store);
  let enter!: () => void, release!: () => void, calls = 0, drained = false;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  store.executionLeaseCommand = async command => {
    calls++; const result = await original(command); enter(); await gate;
    if (lostAck) throw Error('PRIVATE issuer read ACK lost');
    return result;
  };
  const pending = port.command('executionIssuer', { action: 'open', id: 1, binding: 'a'.repeat(64) });
  const settled = pending.then(value => ({ value }), error => ({ error }));
  await entered;
  const closing = port.close(); void closing.then(() => { drained = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(drained, false); assert.equal(port.pending, 1);
    await assert.rejects(port.command('executionIssuer', { action: 'open', id: 1, binding: 'a'.repeat(64) }), HubMemberOwnerUnavailable);
    assert.equal(calls, 1);
  } finally { release(); }
  const result = await settled;
  assert.ok('error' in result && result.error instanceof AuthPersistenceError, 'missing lease or lost read ACK never becomes a snapshot');
  await closing; assert.equal(drained, true); assert.equal(port.pending, 0); assert.equal(calls, 1);
}));

for (const lostAck of [false, true]) test(`execution usage original reservation retains port through close, lost ACK=${lostAck}`, () => fixture(async (store, port) => {
  const user = store.createUser('Recipient'), nodeId = 'node_' + randomUUID();
  store.upsertConnection({ id: 'node', kind: 'remote', label: 'Fixture', connectorUrl: 'http://private.invalid' });
  store.pinConnectionNode('node', 'default', store.connectionAuthority('node', 'default')!, nodeId);
  const target = { ownerUserId: 'default', connectionId: 'node', userId: user.id };
  const resource = { runtime: 'codex' as const, sessionKey: 'codex:private-session' };
  const grant = store.grants.create(target, { ...resource, actions: ['messages:send'] });
  const proof = store.grants.authorize(target, 'messages:send', resource, grant.id)!;
  const reserved = await port.command('executionLease', { action: 'reserve', proof, nodeId, issuerId: 'fixture', actions: ['messages:send'] });
  assert.ok('lease' in reserved && reserved.lease);
  const { id } = reserved.lease;
  const prepared = await port.command('executionLease', { action: 'prepareIssue', id });
  assert.ok('lease' in prepared && prepared.lease);
  const ack = await port.command('executionLease', { action: 'acknowledgeIssue', id,
    ref: { id: randomUUID(), actorId: 'actor_' + 'a'.repeat(64) }, expiresAt: prepared.lease.expiresAt });
  assert.deepEqual(ack, { action: 'acknowledgeIssue', value: true });
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare('UPDATE hub_execution_leases SET usage_pending=1,usage_version=usage_version+1,usage_after=0 WHERE id=?').run(id);
  const admission = store.executionLeases as unknown as { asyncStorageAdmission: ExecutionUsageAdmission };
  const original = admission.asyncStorageAdmission;
  let enter!: () => void, release!: () => void, calls = 0, drained = false;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  admission.asyncStorageAdmission = async (bytes, write) => {
    calls++; const result = await original(bytes, write); enter(); await gate;
    if (lostAck) throw Error('PRIVATE storage release ACK lost');
    return result;
  };
  const pending = port.command('executionLease', { action: 'usageDue', limit: 1 });
  // Attach rejection handling before deliberately holding the original ACK.
  const settled = pending.then(value => ({ value }), error => ({ error }));
  await entered; assert.equal(port.pending, 1);
  const afterReservation = db.prepare('SELECT usage_after,usage_pending FROM hub_execution_leases WHERE id=?').get(id)!;
  assert.ok(Number(afterReservation.usage_after) > 0); assert.equal(afterReservation.usage_pending, 1);
  const closing = port.close(); void closing.then(() => { drained = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(drained, false); assert.equal(port.pending, 1);
    await assert.rejects(port.command('executionLease', { action: 'usageDue', limit: 1 }), HubMemberOwnerUnavailable);
    assert.equal(calls, 1);
  } finally { release(); }
  const result = await settled;
  if (lostAck) { assert.ok('error' in result); assert.ok(result.error instanceof AuthPersistenceError); }
  else { assert.ok('value' in result && 'page' in result.value); assert.equal(result.value.page.length, 1); }
  await closing; assert.equal(drained, true); assert.equal(port.pending, 0); assert.equal(calls, 1);
  assert.deepEqual(db.prepare('SELECT usage_after,usage_pending FROM hub_execution_leases WHERE id=?').get(id), afterReservation);
}));
