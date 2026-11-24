import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AGENT_RUNTIME_IDS } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { encodeHubSessionId } from './session-id.js';
import { sessionRef } from './session-ref.js';
import { WorkspaceNativeFileLocks } from './workspace-native-file-locks.js';
import { hubNotebookReplyExpectation, validHubNotebookCommand, validHubNotebookReply, type HubNotebookCommand } from './member-notebook-domain.js';
import type { HubSessionNotebookAuthority } from './member-session-notebook-authority.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const nodeId = 'node_11111111-1111-4111-8111-111111111111';
async function fixture(shared: boolean, remoteKey: string, work: (f: ReturnType<typeof seed>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'session-notebook-command-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'isolated-session-notebook');
  const f = seed(store, file, shared, remoteKey);
  try { await work(f); } finally { await f.port.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore, file: string, shared: boolean, remoteKey: string) {
  const userId = shared ? store.createUser('Recipient').id : 'default';
  store.upsertConnection({ id: 'fixture', ownerUserId: 'default', kind: 'local', connectorUrl: 'local://aod-connector', label: 'Fixture' });
  store.pinConnectionNode('fixture', 'default', store.connectionAuthority('fixture', 'default')!, nodeId);
  const ref = sessionRef(nodeId, remoteKey)!, sessionId = encodeHubSessionId('fixture', remoteKey);
  const target = { ownerUserId: 'default', connectionId: 'fixture', userId };
  let authority: HubSessionNotebookAuthority;
  if (shared) {
    store.grants.create(target, { runtime: 'codex', sessionKey: remoteKey, actions: ['messages:read'] });
    authority = { kind: 'shared', sessionId, ownerUserId: 'default',
      proof: store.grants.authorize(target, 'messages:read', { runtime: 'codex', sessionKey: remoteKey })! };
  } else authority = { kind: 'owner', sessionId, connectionVersion: store.connectionAuthority('fixture', 'default')! };
  const resourceId = JSON.stringify(['default', ref.nodeId, ref.runtimeId, ref.nativeSessionKey]);
  const key = store.identities.issueKey(userId), token = store.identities.createSession(key.token)!;
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId, admin: false }) };
  const port = new OriginalHubAdministrativeCommands(store, quiet);
  const save = (area: 'hot' | 'cold' = 'hot', revision = 0, text = '中文 **session**'): HubNotebookCommand =>
    ({ action: 'saveSession', document: { resourceId, revision, text }, area, styled: false, authority });
  const command = (c: HubNotebookCommand) => port.command('personalNotebook', { ...proof, command: c });
  return { file, store, port, userId, authority, resourceId, proof, save, command, target };
}
for (const runtime of AGENT_RUNTIME_IDS) for (const area of ['hot', 'cold'] as const) {
  test(`session owner ${runtime}/${area} retains original runtime identity, CAS and private actor scope`, () => fixture(false,
    runtime === 'openclaw' ? 'agent:legacy:session' : runtime + ':fixture', async f => {
      const command = f.save(area), saved = await f.command(command);
      assert.ok(saved?.action === 'saveSession' && saved.status === 'saved');
      assert.equal(validHubNotebookReply(hubNotebookReplyExpectation(command), saved), true);
      assert.equal(saved.document?.revision, 1);
      assert.deepEqual(await f.command(command), { action: 'saveSession', status: 'conflict', document: null });
      for (const patch of [{ resourceId: 'wrong' }, { revision: 2 }, { text: 'wrong' }])
        assert.equal(validHubNotebookReply(hubNotebookReplyExpectation(command), { ...saved, document: { ...saved.document, ...patch } }), false);
    }));
}
for (const shared of [false, true]) for (const area of ['hot', 'cold'] as const) {
  test(`session ${shared ? 'shared' : 'owner'}/${area} checks original authority, current formatting and native locks at effect`, () => fixture(shared, 'codex:fixture', async f => {
    const get = () => area === 'cold' ? f.store.notebooks.getArchive(f.userId, f.resourceId) : f.store.notebooks.get(f.userId, f.resourceId);
    const write = (text: string) => area === 'cold'
      ? f.store.notebooks.saveArchive(f.userId, { resourceId: f.resourceId, revision: 0, text })
      : f.store.notebooks.save(f.userId, { resourceId: f.resourceId, revision: 0, text });
    const styled = '<span data-agentopsdeck-note="v1">Concurrent format</span>';
    write(styled);
    assert.deepEqual(await f.command(f.save(area, 1)), { action: 'saveSession', status: 'format', document: null });
    const command = { ...f.save(area, 1), styled: true } as HubNotebookCommand;
    new WorkspaceNativeFileLocks((f.store as unknown as { db: DatabaseSync }).db)
      .claim(f.userId, randomUUID(), [{ kind: area === 'cold' ? 'notebook-archive' : 'notebook', id: f.resourceId }]);
    assert.deepEqual(await f.command(command), { action: 'saveSession', status: 'conflict', document: null });
    assert.equal(get().text, styled);
    if (f.authority.kind === 'shared') {
      assert.equal(f.store.grants.replace(f.target, f.authority.proof.grantId, f.authority.proof.version,
        { runtime: 'codex', sessionKey: 'codex:fixture', actions: ['messages:read'] }), true);
    } else (f.store as unknown as { db: DatabaseSync }).db.prepare('UPDATE env_connections SET authority_version = authority_version + 1 WHERE id = ?').run('fixture');
    assert.deepEqual(await f.command(command), { action: 'saveSession', status: 'denied', document: null });
    assert.equal(get().revision, 1);
  }));
}
test('session save DTO rejects arbitrary principals, malformed proof, oversized IDs and generic production save', () => fixture(false, 'codex:fixture', async f => {
  const c = f.save(); assert.ok(c.action === 'saveSession');
  for (const v of [{ ...c, principal: { userId: 'default', admin: true } }, { ...c, area: 'layout' },
    { ...c, authority: { ...c.authority, administrator: true } }, { ...c, authority: { ...c.authority, sessionId: 'x'.repeat(4097) } },
    { ...c, authority: { kind: 'owner', sessionId: c.authority.sessionId, connectionVersion: 0 } }]) assert.equal(validHubNotebookCommand(v), false);
  await assert.rejects(f.command({ action: 'save', document: c.document }));
  for (const resourceId of ['["hub-notebook",1]', JSON.stringify(['other', nodeId, 'codex', 'fixture']), JSON.stringify(['default', nodeId, 'codex', 'other'])]) {
    assert.deepEqual(await f.command({ ...c, document: { ...c.document, resourceId } }), { action: 'saveSession', status: 'denied', document: null });
    assert.equal(f.store.notebooks.get(f.userId, resourceId).revision, 0);
  }
}));
test('shared proof cannot retarget recipient, session, owner, action or administrator authority', () => fixture(true, 'codex:fixture', async f => {
  const c = f.save(); assert.ok(c.action === 'saveSession' && c.authority.kind === 'shared');
  for (const patch of [{ userId: 'default' }, { ownerUserId: f.userId }, { action: 'messages:send' as const },
    { administrator: true }, { resource: { runtime: 'codex' as const, sessionKey: 'codex:other' } }]) {
    assert.deepEqual(await f.command({ ...c, authority: { ...c.authority, proof: { ...c.authority.proof, ...patch } } }),
      { action: 'saveSession', status: 'denied', document: null });
  }
  assert.equal((await f.command(c))?.action, 'saveSession');
  assert.equal(f.store.notebooks.get(f.userId, f.resourceId).revision, 1);
  assert.equal(f.store.notebooks.get('default', f.resourceId).revision, 0, 'shared notes belong to recipient, not node owner');
}));
test('typed worker session save closes, reopens and revalidates original session proof without a second writer', () => fixture(true, 'codex:fixture', async f => {
  await f.port.close(); await f.store.close();
  const worker = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'isolated-session-notebook' }, quiet);
  try {
    await worker.open();
    const result = await worker.command('personalNotebook', { ...f.proof, command: f.save() });
    assert.ok(result?.action === 'saveSession' && result.status === 'saved');
  } finally { await worker.close(); }
  const reopened = new HubStore(f.file, 'isolated-session-notebook');
  try { assert.equal(reopened.notebooks.get(f.userId, f.resourceId).revision, 1); }
  finally { await reopened.close(); }
}));
