import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { validHubConnectionDirectoryCommand, validHubConnectionDirectoryResult } from './member-connection-directory-domain.js';
import { hubMemberResultBytes, hubMemberResultBudget, validHubMemberInput, validHubMemberOutput, type HubMemberCommands, type HubMemberKind } from './member-owner-domain.js';
const quiet = new PerformanceDiagnostics(() => {});
const status = (value: number) => (error: unknown) => error instanceof HubMemberRequestError && error.status === value;
function fixture(t: test.TestContext, admin = false) {
  const root = mkdtempSync(join(tmpdir(), 'connection-directory-authority-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'isolated-directory-vault');
  const userId = admin ? 'default' : store.createUser('Member').id;
  const db = (store as unknown as { db: DatabaseSync }).db;
  if (admin) db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(userId);
  const key = store.identities.issueKey(userId);
  const request = (signal?: AbortSignal) => new Request('http://fixture.invalid/', {
    headers: { authorization: 'Bearer ' + key.token }, ...(signal ? { signal } : {}),
  });
  store.upsertConnection({ id: 'node', ownerUserId: userId, label: 'Node', connectorUrl: 'http://fixture.invalid' });
  const original = new OriginalHubAdministrativeCommands(store, quiet);
  const service = new AsyncHubMemberRequests(original, quiet);
  t.after(async () => { await service.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, db, original, service, request, key, userId, file };
}
for (const admin of [false, true]) {
  test(`original connection directory preserves scoped wire and pinned epochs (admin=${admin})`, async t => {
    const f = fixture(t, admin), other = f.store.createUser('Other');
    f.store.upsertConnection({ id: 'foreign', ownerUserId: other.id, label: 'Private', connectorUrl: 'http://foreign.invalid' });
    const expectedConnections = f.store.listConnections(f.userId), expectedUsers = f.store.listUsers().filter(row => admin || row.id === f.userId)
      .map(row => admin ? { ...row, usage: { lastLoginAt: null, lastActiveAt: null } } : row);
    const access = await f.service.begin(f.request()), directory = await access.connectionDirectory();
    assert.deepEqual(directory.connections, JSON.parse(JSON.stringify(expectedConnections))); assert.deepEqual(directory.users, JSON.parse(JSON.stringify(expectedUsers)));
    await directory.check(); await directory.check('node');
    assert.doesNotMatch(JSON.stringify(directory), /foreign.invalid|isolated-directory-vault|hub_key_|encrypted_token|authority_version/);
    await assert.rejects(directory.check('foreign'), status(503));
    await assert.rejects(directory.check('node'), status(503), 'denial is sticky');
  });
  for (const change of ['label', 'epoch-only', 'add', 'delete', 'disable', 'recreate', 'credential'] as const)
    test(`directory ${change} invalidates final atomic proof (admin=${admin})`, async t => {
      const f = fixture(t, admin), access = await f.service.begin(f.request()), directory = await access.connectionDirectory();
      await directory.check('node');
      if (change === 'epoch-only') f.db.prepare('UPDATE env_connections SET authority_version=authority_version+1 WHERE id=?').run('node');
      else if (change === 'delete' || change === 'recreate') {
        f.db.prepare('DELETE FROM env_connections WHERE id=?').run('node');
        if (change === 'recreate') f.store.upsertConnection({ id: 'node', ownerUserId: f.userId, label: 'Node', connectorUrl: 'http://fixture.invalid' });
      } else if (change === 'credential') f.store.updateMaintenanceCredential('node', 'private-credential', f.userId);
      else f.store.upsertConnection({ id: change === 'add' ? 'added' : 'node', ownerUserId: f.userId,
        label: change === 'label' ? 'Changed' : 'Node', connectorUrl: 'http://fixture.invalid', status: change === 'disable' ? 'disabled' : 'enabled' });
      await assert.rejects(directory.check(), status(503));
      await assert.rejects(directory.check('node'), status(503));
    });
  test(`key revocation invalidates pinned directory (admin=${admin})`, async t => {
    const f = fixture(t, admin), access = await f.service.begin(f.request()), directory = await access.connectionDirectory();
    f.store.identities.revokeKey(f.userId, f.key.id);
    await assert.rejects(directory.check(), status(401));
  });
}
test('connection directory is available on the sole isolated worker without a peer writer', async t => {
  const f = fixture(t), expected = f.store.listConnections(f.userId);
  await f.service.close(); await f.original.close(); await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'isolated-directory-vault' }, quiet);
  const service = new AsyncHubMemberRequests(owner, quiet);
  try {
    const access = await service.begin(f.request()), directory = await access.connectionDirectory();
    assert.deepEqual(directory.connections, JSON.parse(JSON.stringify(expected))); await directory.check('node'); await directory.check();
  } finally { await service.close(); await owner.close(); }
});
for (const command of [undefined, {}, { action: 'read', sql: 'SELECT 1' }, { action: 'check', version: -1 },
  { action: 'check', version: 1, target: { id: 'node', epoch: 0 } },
  { action: 'check', version: 1, target: { id: 'node', epoch: 1, grant: true } }, { action: 'check', version: 1, principal: 'default' }])
  test(`connection directory refuses non-fixed command ${JSON.stringify(command)}`, () => {
    assert.equal(validHubConnectionDirectoryCommand(command), false);
    assert.equal(validHubMemberInput('connectionDirectory', { evidence: { accessKey: 'x' }, expectedScope: 'a'.repeat(64), command }), false);
  });
test('connection directory transport strictly validates result and positional epochs', async t => {
  const f = fixture(t), access = await f.service.begin(f.request());
  const scope = f.store.identities.recoveryScope({ userId: f.userId, admin: false });
  const result = await f.original.command('connectionDirectory', { evidence: { accessKey: f.key.token }, expectedScope: scope, command: { action: 'read' } });
  assert.ok(result?.action === 'read');
  assert.equal(validHubConnectionDirectoryResult(result), true); assert.equal(validHubMemberOutput('connectionDirectory', result), true);
  for (const corrupt of [{ ...result, epochs: [] }, { ...result, epochs: [0] }, { ...result, epochs: [NaN] },
    { ...result, version: -1 }, { ...result, credential: 'private' }, { ...result, snapshot: null }])
    assert.equal(validHubConnectionDirectoryResult(corrupt), false);
  await (await access.connectionDirectory()).check();
});
for (const corruption of ['action', 'version', 'target', 'unavailable'] as const)
  test(`mismatched owner ${corruption} refuses correlated check and never retries`, async t => {
    const f = fixture(t); let checks = 0;
    const service = new AsyncHubMemberRequests({ command: async <K extends HubMemberKind>(kind: K, input: HubMemberCommands[K]['input']) => {
      const value = await f.original.command(kind, input);
      if (kind !== 'connectionDirectoryCheck') return value;
      checks++;
      if (corruption === 'unavailable') throw Error('private owner failure');
      return { ...(value as object), ...(corruption === 'action' ? { action: 'read' } : corruption === 'version' ? { version: -1 } : { target: { id: 'wrong', epoch: 1 } }) } as HubMemberCommands[K]['output'];
    } }, quiet);
    t.after(() => service.close()); const access = await service.begin(f.request()), directory = await access.connectionDirectory();
    await assert.rejects(directory.check('node'), status(503)); await assert.rejects(directory.check(), status(503)); assert.equal(checks, 1);
  });
for (const boundary of ['cancel', 'deadline', 'close'] as const)
  test(`connection directory ${boundary} never refunds a pending original ACK or replays it`, async t => {
    const f = fixture(t), controller = new AbortController();
    let release!: () => void, started!: () => void, reads = 0;
    const gate = new Promise<void>(done => { release = done; }), entered = new Promise<void>(done => { started = done; });
    const service = new AsyncHubMemberRequests({ command: async <K extends HubMemberKind>(kind: K, input: HubMemberCommands[K]['input']) => {
      const result = await f.original.command(kind, input);
      if (kind === 'connectionDirectory') { reads++; started(); await gate; }
      return result;
    } }, quiet, 5, boundary === 'deadline' ? 5 : 30_000);
    const caller = await service.begin(f.request(controller.signal));
    const refused = assert.rejects(caller.connectionDirectory(), status(boundary === 'cancel' ? 499 : 503));
    await entered;
    if (boundary === 'cancel') controller.abort();
    let closed = false;
    const closing = boundary === 'close' ? service.close().then(() => { closed = true; }) : undefined;
    try {
      if (boundary !== 'close') await refused;
      assert.equal(service.pendingReads, 1); assert.equal(reads, 1);
      await new Promise<void>(done => setImmediate(done)); assert.equal(closed, false);
    } finally { release(); }
    await refused; await (closing ?? service.close()); assert.equal(service.pendingReads, 0); assert.equal(reads, 1);
  });
test('epoch-only generation trigger is idempotent and rolls back with the original facts', async t => {
  const f = fixture(t), access = await f.service.begin(f.request()), directory = await access.connectionDirectory();
  const before = f.store.connectionDirectoryVersion(f.userId);
  f.db.exec('BEGIN');
  try {
    f.db.prepare('UPDATE env_connections SET authority_version=authority_version+1 WHERE id=?').run('node');
    const inside = f.db.prepare('SELECT version FROM hub_connection_authority_versions WHERE user_id=?').get(f.userId)!;
    assert.equal(inside.version, 1);
    assert.equal(f.db.prepare('SELECT version FROM hub_connection_display_versions WHERE user_id=?').get(f.userId)!.version,
      before, 'authorization changes do not invalidate display-only reads');
  } finally { f.db.exec('ROLLBACK'); }
  assert.equal(f.store.connectionDirectoryVersion(f.userId), before); await directory.check('node');
});
test('four small target checks fit the original bounded pool and cannot carry a directory snapshot', async t => {
  const f = fixture(t), expectedScope = f.store.identities.recoveryScope({ userId: f.userId, admin: false });
  const proof = { evidence: { accessKey: f.key.token }, expectedScope, command: { action: 'read' as const } };
  const snapshot = await f.original.command('connectionDirectory', proof);
  assert.ok(snapshot?.action === 'read');
  const check = { ...proof, command: { action: 'check' as const, version: snapshot.version, target: { id: 'node', epoch: snapshot.epochs[0]! } } };
  assert.equal(hubMemberResultBytes('connectionDirectoryCheck'), 32 * 1024);
  assert.ok(hubMemberResultBytes('connectionDirectory') + 4 * hubMemberResultBytes('connectionDirectoryCheck') < hubMemberResultBudget('connectionDirectory'));
  assert.equal(validHubMemberInput('connectionDirectoryCheck', proof), false);
  assert.equal(validHubMemberInput('connectionDirectory', check), false);
  assert.equal(validHubMemberOutput('connectionDirectoryCheck', snapshot), false);
  assert.equal(validHubMemberOutput('connectionDirectory', { action: 'check', version: snapshot.version, ok: true }), false);
  const results = await Promise.all(Array.from({ length: 4 }, () => f.original.command('connectionDirectoryCheck', check)));
  assert.ok(results.every(result => result?.action === 'check' && result.ok));
});
test('combined authorization generation safely refuses overflow without corrupting display reads', async t => {
  const f = fixture(t), directory = await (await f.service.begin(f.request())).connectionDirectory();
  f.db.prepare('INSERT INTO hub_connection_authority_versions(user_id,version) VALUES (?,?)').run(f.userId, Number.MAX_SAFE_INTEGER);
  await assert.rejects(directory.check(), status(503));
  assert.ok(Number.isSafeInteger(f.store.connectionDirectoryVersion(f.userId)));
});

test('version-only command is fixed, scoped and does not materialize the connection directory', async t => {
  const f = fixture(t), proof = { evidence: { accessKey: f.key.token },
    expectedScope: f.store.identities.recoveryScope({ userId: f.userId, admin: false }), command: { action: 'version' as const } };
  assert.equal(validHubMemberInput('connectionDirectoryVersion', proof), true);
  assert.equal(validHubMemberInput('connectionDirectory', proof), false);
  assert.equal(validHubMemberInput('connectionDirectoryVersion', { ...proof, command: { action: 'read' } }), false);
  assert.equal(validHubMemberOutput('connectionDirectoryVersion', { action: 'read', snapshot: {} }), false);
  // A corrupt display payload makes a directory read fail, but must not be
  // decoded or transported by the bounded metadata-only proof.
  f.db.prepare('UPDATE env_connections SET label=? WHERE id=?').run('x'.repeat(16_385), 'node');
  const value = await f.original.command('connectionDirectoryVersion', proof);
  assert.ok(value?.action === 'version'); assert.deepEqual(Object.keys(value).sort(), ['action', 'version']);
  assert.equal(validHubMemberOutput('connectionDirectoryVersion', value), true);
  assert.equal(validHubMemberOutput('connectionDirectory', value), false);
  const check = await f.original.command('connectionDirectoryCheck', { ...proof, command: { action: 'check', version: value.version } });
  assert.ok(check?.action === 'check' && check.ok);
  f.db.prepare('UPDATE env_connections SET authority_version=authority_version+1 WHERE id=?').run('node');
  const changed = await f.original.command('connectionDirectoryCheck', { ...proof, command: { action: 'check', version: value.version } });
  assert.ok(changed?.action === 'check' && !changed.ok);
});
