import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubMemberOwnerUnavailable, validHubMemberInput } from './member-owner-domain.js';
import { HUB_CONFIGURATION_KINDS, validHubConfigurationCommand, validHubConfigurationReply,
  hubConfigurationExpectation, type HubConfigurationCommand } from './member-configuration-domain.js';
import { WorkspaceNativeFileLocks } from './workspace-native-file-locks.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { configurationWrite } from './configuration-test-fixtures.js';

const quiet = new PerformanceDiagnostics(() => {}), tick = () => new Promise<void>(yes => setImmediate(yes));
for (const kind of HUB_CONFIGURATION_KINDS) {
  test(`${kind}: bounded declarative commands reject authority, bindings, execution and cross-kind inputs`, () => {
    const command = { action: 'save', kind, resourceId: randomUUID(), document: configurationWrite(kind) };
    assert.equal(validHubConfigurationCommand(command), true);
    for (const value of [{ ...command, userId: 'other' }, { ...command, binding: 'bypass' },
      { ...command, action: 'execute' }, { ...command, resourceId: '../other' },
      { ...command, document: { ...command.document, content: { ...command.document.content, command: 'executable' } } },
      { ...command, document: { ...command.document, revision: Number.MAX_SAFE_INTEGER } }])
      assert.equal(validHubConfigurationCommand(value), false);
    assert.equal(validHubMemberInput('workspaceConfiguration', { evidence: {}, expectedScope: 'a'.repeat(64), command }), true);
    assert.equal(validHubMemberInput('workspaceConfiguration', { evidence: {}, expectedScope: 'a'.repeat(64), command, userId: 'other' }), false);
    const { mutationId: _mutation, ...document } = command.document;
    const reply = { action: 'save', kind, resourceId: command.resourceId, result: { status: 'saved', document: { ...document, revision: 1, updatedAt: 1 } } };
    const expected = hubConfigurationExpectation(command as HubConfigurationCommand);
    assert.equal(validHubConfigurationReply(expected, reply), true);
    for (const value of [{ ...reply, resourceId: randomUUID() }, { ...reply, action: 'get' },
      { ...reply, result: { status: 'saved', document: { ...reply.result.document, revision: 2 } } },
      { ...reply, result: { status: 'saved', document: { ...reply.result.document, content: { ...document.content, title: 'Wrong' } } } }])
      assert.equal(validHubConfigurationReply(expected, value), false);
  });
  test(`${kind}: original CAS, exact receipts, cross-user isolation and native lock survive command boundary`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-configuration-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-config-vault');
    const original = new OriginalHubAdministrativeCommands(store, quiet), key = store.identities.issueKey('default');
    try {
      const snapshot = await original.command('memberSnapshot', { accessKey: key.token }); assert.ok(snapshot);
      const proof = { evidence: { accessKey: key.token }, expectedScope: snapshot.recoveryScope };
      const resourceId = randomUUID(), document = configurationWrite(kind), command: HubConfigurationCommand = { action: 'save', kind, resourceId, document };
      const send = (value: HubConfigurationCommand) => original.command('workspaceConfiguration', { ...proof, command: value });
      const saved = await send(command); assert.ok(saved && saved.action === 'save' && saved.result.status === 'saved');
      assert.deepEqual(await send(command), saved);
      assert.deepEqual(await send({ ...command, document: { ...document, content: { ...document.content, title: 'Changed' } } as typeof document }), { action: 'save', kind, resourceId, result: { status: 'mutation-reused' } });
      assert.deepEqual(await send({ ...command, document: { ...document, mutationId: randomUUID() } }), { action: 'save', kind, resourceId, result: { status: 'conflict' } });
      const other = store.createUser('Isolated'), otherKey = store.identities.issueKey(other.id), otherSnapshot = await original.command('memberSnapshot', { accessKey: otherKey.token }); assert.ok(otherSnapshot);
      assert.deepEqual(await original.command('workspaceConfiguration', { evidence: { accessKey: otherKey.token }, expectedScope: otherSnapshot.recoveryScope,
        command: { action: 'get', kind, resourceId } }), { action: 'get', kind, resourceId, document: null });
      const locks = new WorkspaceNativeFileLocks((store as unknown as { db: DatabaseSync }).db);
      assert.equal(locks.claim('default', randomUUID(), [{ kind, id: resourceId }]), true);
      assert.deepEqual(await send(command), { action: 'save', kind, resourceId, result: { status: 'file-managed' } });
      assert.equal(await original.command('workspaceConfiguration', { ...proof, expectedScope: 'b'.repeat(64), command }), null);
      assert.equal(await original.command('workspaceConfiguration', { ...proof, evidence: { accessKey: 'revoked' }, command }), null);
    } finally { await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
test('actual sole worker persists all six configurations and exact receipts across reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-configuration-worker-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'isolated-config-vault'), key = seed.identities.issueKey('default'); await seed.close();
  let owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'isolated-config-vault' }, quiet);
  try {
    const snapshot = await owner.command('memberSnapshot', { accessKey: key.token }); assert.ok(snapshot);
    const proof = { evidence: { accessKey: key.token }, expectedScope: snapshot.recoveryScope };
    const cases = HUB_CONFIGURATION_KINDS.map(kind => ({ action: 'save', kind, resourceId: randomUUID(), document: configurationWrite(kind) }) as HubConfigurationCommand), saved = [];
    for (const command of cases) saved.push(await owner.command('workspaceConfiguration', { ...proof, command }));
    await owner.close(); owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'isolated-config-vault' }, quiet);
    for (const [index, command] of cases.entries()) {
      assert.deepEqual(await owner.command('workspaceConfiguration', { ...proof, command }), saved[index]);
      const read = await owner.command('workspaceConfiguration', { ...proof, command: { action: 'get', kind: command.kind, resourceId: command.resourceId } });
      assert.ok(read && read.action === 'get' && read.document?.revision === 1);
    }
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
test('worker protocol refuses a well-shaped cross-resource configuration reply without killing writer', async () => {
  class FakeWorker extends EventEmitter {
    messages: { id: number; kind: string }[] = [];
    postMessage(value: { id: number; kind: string }) { this.messages.push(value); }
    terminate() { assert.fail('unknown writer cannot be killed'); }
  }
  const root = mkdtempSync(join(tmpdir(), 'hub-configuration-protocol-')), fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite') }, quiet, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' });
  try {
    const pending = assert.rejects(owner.command('workspaceConfiguration', { evidence: {}, expectedScope: 'a'.repeat(64),
      command: { action: 'get', kind: 'browser', resourceId: randomUUID() } }), HubMemberOwnerUnavailable);
    await tick(); fake.emit('message', { ...fake.messages[0]!, ok: true, body: JSON.stringify({ action: 'get', kind: 'browser', resourceId: randomUUID(), document: null }) });
    await pending; assert.equal(owner.snapshot().unavailable, true);
  } finally { const retired = owner.retireForShutdown(); await tick(); fake.emit('exit', 1); await retired; rmSync(root, { recursive: true, force: true }); }
});
