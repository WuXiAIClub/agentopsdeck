import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { workspaceFileCardResource } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubMemberOwnerUnavailable, validHubMemberInput } from './member-owner-domain.js';
import { validHubFileBindingCommand, validHubFileBindingReply, validHubFileBindingResult } from './member-file-binding-domain.js';
import { seedFileBindings } from './file-binding-test-fixtures.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
const quiet = new PerformanceDiagnostics(() => {}), tick = () => new Promise<void>(yes => setImmediate(yes));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-binding-command-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'isolated-binding-vault'), key = store.identities.issueKey('default');
  return { root, file, store, key };
}
test('binding DTO accepts only canonical correlated public metadata and exact keys', () => {
  const command = { domain: 'board', action: 'current', resourceId: 'default' };
  assert.equal(validHubFileBindingCommand(command), true);
  assert.equal(validHubMemberInput('fileBindingRead', { evidence: {}, expectedScope: 'a'.repeat(64), command }), true);
  for (const value of [{ ...command, userId: 'other' }, { ...command, action: 'write' }, { ...command, domain: 'other' }, { ...command, resourceId: 'invalid' }, { ...command, bindingId: randomUUID() }]) assert.equal(validHubFileBindingCommand(value), false);
  const binding = { bindingId: randomUUID(), resourceId: 'default', sessionId: 'codex:fixture', state: 'prepared', problem: null };
  const reply = { ...command, binding };
  assert.equal(validHubFileBindingReply(command as never, reply), true);
  for (const extra of [{ ...binding, authority: 1 }, { ...binding, userId: 'other' }, { ...binding, sourceHash: 'private' }, { ...binding, state: 'revoked' }, { ...binding, resourceId: randomUUID() }]) assert.equal(validHubFileBindingResult({ ...reply, binding: extra }), false);
  assert.equal(validHubFileBindingReply(command as never, { ...command, domain: 'card', resourceId: workspaceFileCardResource('notebook', 'hub:default'), binding: null }), false);
  assert.equal(validHubFileBindingReply(command as never, { ...command, binding: null }), true);
  assert.equal(validHubFileBindingReply(command as never, null), true);
  const get = { domain: 'board', action: 'get', resourceId: 'default', bindingId: binding.bindingId };
  assert.equal(validHubFileBindingReply(get as never, { ...get, binding: { ...binding, state: 'revoked' } }), true);
  assert.equal(validHubFileBindingReply(get as never, { ...get, bindingId: randomUUID(), binding: null }), false);
});
for (const domain of ['board', 'card'] as const) test(domain + ': original command preserves owner/resource fences, revoked history and public shape', async t => {
  const f = fixture(), original = new OriginalHubAdministrativeCommands(f.store, quiet);
  try {
    const values = seedFileBindings(f.store), binding = values[domain];
    const snapshot = await original.command('memberSnapshot', { accessKey: f.key.token }); assert.ok(snapshot);
    const command = { domain, action: 'current' as const, resourceId: binding.resourceId }, proof = { evidence: { accessKey: f.key.token }, expectedScope: snapshot.recoveryScope, command };
    const files = domain === 'board' ? f.store.boardFiles : f.store.cardFiles;
    t.mock.method(files, 'prepare', () => assert.fail('metadata cannot admit a binding'));
    t.mock.method(files, 'apply', () => assert.fail('metadata cannot import a snapshot'));
    assert.deepEqual(await original.command('fileBindingRead', proof), { ...command, binding });
    assert.equal(await original.command('fileBindingRead', { ...proof, expectedScope: '0'.repeat(64) }), null);
    const other = f.store.createUser('Other'), key = f.store.identities.issueKey(other.id), otherSnapshot = await original.command('memberSnapshot', { accessKey: key.token }); assert.ok(otherSnapshot);
    assert.deepEqual(await original.command('fileBindingRead', { ...proof, evidence: { accessKey: key.token }, expectedScope: otherSnapshot.recoveryScope }), { ...command, binding: null });
    const wrong = { domain, action: 'get' as const, bindingId: binding.bindingId, resourceId: domain === 'board' ? randomUUID() : workspaceFileCardResource('browser', randomUUID()) };
    assert.deepEqual(await original.command('fileBindingRead', { ...proof, command: wrong }), { ...wrong, binding: null });
    assert.ok(files.revoke('default', binding.bindingId));
    assert.deepEqual(await original.command('fileBindingRead', proof), { ...command, binding: null });
    const get = { ...command, action: 'get' as const, bindingId: binding.bindingId };
    assert.deepEqual(await original.command('fileBindingRead', { ...proof, command: get }), { ...get, binding: { ...binding, state: 'revoked' } });
  } finally { await original.close(); await f.store.close(); rmSync(f.root, { recursive: true, force: true }); }
});
test('real sole worker retains board/card public metadata across two opens, original connection is closed first', async () => {
  const f = fixture(), values = seedFileBindings(f.store); await f.store.close();
  let owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'isolated-binding-vault' }, quiet);
  try {
    for (let round = 0; round < 2; round++) {
      const snapshot = await owner.command('memberSnapshot', { accessKey: f.key.token }); assert.ok(snapshot);
      for (const domain of ['board', 'card'] as const) {
        const binding = values[domain], command = { domain, action: 'get' as const, resourceId: binding.resourceId, bindingId: binding.bindingId };
        assert.deepEqual(await owner.command('fileBindingRead', { evidence: { accessKey: f.key.token }, expectedScope: snapshot.recoveryScope, command }), { ...command, binding });
      }
      await owner.close(); if (round === 0) owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'isolated-binding-vault' }, quiet);
    }
  } finally { await owner.close(); rmSync(f.root, { recursive: true, force: true }); }
});
test('cross-resource null worker reply is refused without killing an unknown writer', async () => {
  class FakeWorker extends EventEmitter {
    messages: { id: number; kind: string }[] = [];
    postMessage(value: { id: number; kind: string }) { this.messages.push(value); }
    terminate() { assert.fail('unknown writer cannot be killed'); }
  }
  const f = fixture(); await f.store.close(); const fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: f.file }, quiet, () => fake as unknown as Worker); fake.emit('message', { kind: 'ready' });
  try {
    const pending = assert.rejects(owner.command('fileBindingRead', { evidence: {}, expectedScope: 'a'.repeat(64), command: { domain: 'board', action: 'current', resourceId: 'default' } }), HubMemberOwnerUnavailable);
    await tick(); fake.emit('message', { ...fake.messages[0]!, ok: true, body: JSON.stringify({ domain: 'board', action: 'current', resourceId: randomUUID(), binding: null }) });
    await pending; assert.equal(owner.snapshot().unavailable, true);
  } finally { const retired = owner.retireForShutdown(); await tick(); fake.emit('exit', 1); await retired; rmSync(f.root, { recursive: true, force: true }); }
});
