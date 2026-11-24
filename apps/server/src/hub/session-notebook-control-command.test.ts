import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AGENT_RUNTIME_IDS } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { encodeHubSessionId } from './session-id.js';
import { sessionRef } from './session-ref.js';
import type { HubSessionNotebookAuthority } from './member-session-notebook-authority.js';
import { hubNotebookControlExpectation, validHubNotebookControlCommand, validHubNotebookControlReply,
  type HubNotebookControlCommand } from './member-notebook-control-domain.js';
import { WorkspaceNativeFileLocks } from './workspace-native-file-locks.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {}), nodeId = 'node_11111111-1111-4111-8111-111111111111';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const grant = () => ({ facets: ['hot:read' as const], expiresAt: Date.now() + 600_000 });
async function fixture(shared: boolean, remote: string, work: (f: ReturnType<typeof seed>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'session-notebook-control-'));
  const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-control');
  const f = seed(store, join(root, 'hub.sqlite'), shared, remote);
  try { await work(f); } finally { await f.owner.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore, file: string, shared: boolean, remote: string) {
  const userId = shared ? store.createUser('Recipient').id : 'default';
  store.upsertConnection({ id: 'fixture', ownerUserId: 'default', kind: 'local', connectorUrl: 'local://aod-connector', label: 'Isolated' });
  store.pinConnectionNode('fixture', 'default', store.connectionAuthority('fixture', 'default')!, nodeId);
  const ref = sessionRef(nodeId, remote)!, sessionId = encodeHubSessionId('fixture', remote);
  const resourceId = JSON.stringify(['default', ref.nodeId, ref.runtimeId, ref.nativeSessionKey]);
  const target = { ownerUserId: 'default', connectionId: 'fixture', userId };
  let authority: HubSessionNotebookAuthority;
  if (shared) {
    store.grants.create(target, { runtime: 'codex', sessionKey: remote, actions: ['messages:read'] });
    authority = { kind: 'shared', sessionId, ownerUserId: 'default',
      proof: store.grants.authorize(target, 'messages:read', { runtime: 'codex', sessionKey: remote })! };
  } else authority = { kind: 'owner', sessionId, connectionVersion: store.connectionAuthority('fixture', 'default')! };
  const key = store.identities.issueKey(userId), evidence = { accessKey: key.token };
  const proof = { evidence, expectedScope: store.identities.recoveryScope({ userId, admin: false }) };
  store.notebooks.save(userId, { resourceId, revision: 0, text: 'hello world' });
  const input = { requestId: randomUUID(), direction: 'archive' as const, hotRevision: 1, coldRevision: 0,
    ranges: [{ start: 0, end: 5, sha256: hash('hello') }] };
  const owner = new OriginalHubAdministrativeCommands(store, quiet);
  const command = (c: HubNotebookControlCommand) => owner.command('notebookControl', { ...proof, command: c });
  const request = () => new Request('http://fixture.invalid', { headers: { authorization: `Bearer ${key.token}` } });
  return { store, file, owner, userId, resourceId, authority, target, input, proof, command, request };
}
for (const runtime of AGENT_RUNTIME_IDS) test(`session controls ${runtime}: original authority and capability epoch`, () =>
  fixture(false, runtime === 'openclaw' ? 'agent:legacy:session' : runtime + ':fixture', async f => {
    const { resourceId, authority } = f;
    const issued = await f.command({ action: 'issue', resourceId, authority, input: grant() });
    assert.ok(issued?.action === 'issue' && issued.issued);
    assert.deepEqual(f.store.notebookCapabilities.authorized(issued.issued.token)?.authority,
      { connectionId: 'fixture', version: authority.kind === 'owner' ? authority.connectionVersion : 0 });
    const listed = await f.command({ action: 'capabilities', resourceId, authority });
    assert.ok(listed?.action === 'capabilities'); assert.equal(listed.capabilities.length, 1);
    assert.deepEqual(await f.command({ action: 'revoke', resourceId, authority, capabilityId: issued.issued.capability.id }),
      { action: 'revoke', resourceId, capabilityId: issued.issued.capability.id, revoked: true });
    const second = await f.command({ action: 'issue', resourceId, authority, input: grant() });
    assert.ok(second?.action === 'issue' && second.issued);
    (f.store as unknown as { db: DatabaseSync }).db.prepare('UPDATE env_connections SET authority_version=authority_version+1 WHERE id=?').run('fixture');
    assert.equal(f.store.notebookCapabilities.authorized(second.issued.token), undefined);
    assert.deepEqual(await f.command({ action: 'capabilities', resourceId, authority }),
      { action: 'denied', resourceId, operation: 'capabilities' });
  }));
for (const shared of [false, true]) test(`session controls ${shared ? 'shared' : 'owner'}: atomic move, immutable receipt and actor isolation`, () =>
  fixture(shared, 'codex:fixture', async f => {
    const c = { action: 'move' as const, resourceId: f.resourceId, authority: f.authority, input: f.input };
    const moved = await f.command(c);
    assert.equal(validHubNotebookControlReply(hubNotebookControlExpectation(c), moved), true);
    assert.ok(moved?.action === 'move' && moved.result); assert.equal(moved.result.moved, 5);
    assert.deepEqual(await f.command(c), moved);
    assert.equal(f.store.notebooks.get(f.userId, f.resourceId).text, ' world');
    assert.equal(f.store.notebooks.getArchive(f.userId, f.resourceId).text, 'hello');
    if (shared) assert.equal(f.store.notebooks.get('default', f.resourceId).revision, 0);
    const receipt = await f.command({ action: 'receipt', resourceId: f.resourceId, authority: f.authority, requestId: f.input.requestId });
    assert.ok(receipt?.action === 'receipt'); assert.deepEqual(receipt.result, moved.result);
    const conflict = await f.command({ ...c, input: { ...f.input, direction: 'restore' } });
    assert.ok(conflict?.action === 'move'); assert.equal(conflict.conflict, 'Request ID already used');
    for (const resourceId of [JSON.stringify(['other', nodeId, 'codex', 'fixture']), JSON.stringify(['default', nodeId, 'codex', 'other'])])
      assert.deepEqual(await f.command({ ...c, resourceId }), { action: 'denied', resourceId, operation: 'move' });
  }));
test('shared session proof cannot mint/list/revoke machine authority or retarget original grant', () => fixture(true, 'codex:fixture', async f => {
  const commands: HubNotebookControlCommand[] = [{ action: 'capabilities', resourceId: f.resourceId, authority: f.authority },
    { action: 'issue', resourceId: f.resourceId, authority: f.authority, input: grant() },
    { action: 'revoke', resourceId: f.resourceId, authority: f.authority, capabilityId: randomUUID() }];
  const services = createHubAdministrativeServices(f.owner, quiet);
  try {
    for (const command of commands) assert.deepEqual(await f.command(command),
      { action: 'denied', resourceId: f.resourceId, operation: command.action });
    await assert.rejects(services.notebookControl.issue(f.request(), f.userId, f.resourceId, grant(), f.authority),
      (e: unknown) => (e as { status: number }).status === 403);
    assert.equal(f.store.notebookCapabilities.list(f.userId, f.resourceId).length, 0);
    assert.ok(f.authority.kind === 'shared');
    const original = f.authority;
    for (const patch of [{ userId: 'default' }, { action: 'messages:send' as const }, { administrator: true },
      { resource: { runtime: 'codex' as const, sessionKey: 'codex:other' } }]) {
      const c = { action: 'move' as const, resourceId: f.resourceId, input: f.input,
        authority: { ...original, proof: { ...original.proof, ...patch } } };
      assert.deepEqual(await f.command(c), { action: 'denied', resourceId: f.resourceId, operation: 'move' });
    }
    assert.equal(f.store.grants.replace(f.target, original.proof.grantId, original.proof.version,
      { runtime: 'codex', sessionKey: 'codex:fixture', actions: ['messages:read'] }), true);
    assert.deepEqual(await f.command({ action: 'move', resourceId: f.resourceId, authority: original, input: f.input }),
      { action: 'denied', resourceId: f.resourceId, operation: 'move' });
  } finally { await services.close(); }
}));
test('session control DTO requires exact bounded proof and correlates denied replies; native lock remains authoritative', () => fixture(false, 'codex:fixture', async f => {
  const c = { action: 'move' as const, resourceId: f.resourceId, authority: f.authority, input: f.input };
  assert.equal(validHubNotebookControlCommand(c), true);
  for (const command of [{ ...c, authority: undefined }, { ...c, authority: null }, { ...c, principal: 'default' },
    { ...c, resourceId: JSON.stringify(['hub-notebook', 1]) }, { ...c, authority: { ...f.authority, sessionId: 'x'.repeat(4097) } }])
    assert.equal(validHubNotebookControlCommand(command), false);
  const denied = { action: 'denied', resourceId: f.resourceId, operation: 'move' };
  assert.equal(validHubNotebookControlReply(hubNotebookControlExpectation(c), denied), true);
  assert.equal(validHubNotebookControlReply(hubNotebookControlExpectation(c), { ...denied, operation: 'receipt' }), false);
  new WorkspaceNativeFileLocks((f.store as unknown as { db: DatabaseSync }).db).claim(f.userId, randomUUID(), [{ kind: 'notebook', id: f.resourceId }]);
  const reply = await f.command(c); assert.ok(reply?.action === 'move');
  assert.equal(reply.conflict, 'Linked notebook requires coordinated file projection');
  assert.equal(f.store.notebooks.moveReceipt(f.userId, f.resourceId, f.input.requestId), undefined);
}));
test('session control typed worker preserves receipt after owner close/reopen without a second writer', () => fixture(true, 'codex:fixture', async f => {
  await f.owner.close(); await f.store.close();
  const worker = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'isolated-control' }, quiet);
  try {
    await worker.open();
    const reply = await worker.command('notebookControl', { ...f.proof,
      command: { action: 'move', resourceId: f.resourceId, authority: f.authority, input: f.input } });
    assert.ok(reply?.action === 'move' && reply.result);
  } finally { await worker.close(); }
  const reopened = new HubStore(f.file, 'isolated-control');
  try { assert.equal(reopened.notebooks.moveReceipt(f.userId, f.resourceId, f.input.requestId)?.moved, 5); }
  finally { await reopened.close(); }
}));
