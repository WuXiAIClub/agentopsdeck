import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorOwnerUnavailable, connectorOwnerSteps, connectorOwnerKinds, encodeConnectorOwnerJson,
  validConnectorOwnerInput, validConnectorOwnerOutput, connectorOwnerConfig, connectorOwnerResultBytes } from './connector-owner-domain.js';

const silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function disk(work: (file: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'connector-complete-owner-'));
  try { await work(join(root, 'connector.sqlite')); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  stops = 0;
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { this.stops++; return Promise.resolve(1); }
  ready() { this.emit('message', { kind: 'ready' }); }
  reply(index: number, value: unknown) {
    const request = this.messages[index]!;
    this.emit('message', { id: request.id, kind: request.kind, ok: true, body: JSON.stringify(value) });
  }
}
const fakeOwner = (file: string, fake: FakeWorker, diagnostics = silence, warningMs = 30_000) =>
  new AsyncConnectorOwner({ file }, diagnostics, () => fake as unknown as Worker, warningMs);

test('fixed Connector commands do not expose SQL, dispatch or mutable diagnostic numbers', () => {
  assert.equal(connectorOwnerKinds.length, 367);
  assert.deepEqual(Object.values(connectorOwnerSteps).sort((a, b) => a - b),
    [...Array.from({ length: 344 }, (_, i) => i + 1), 346, 347, ...Array.from({ length: 21 }, (_, i) => 351 + i)]);
  assert.equal(new Set(Object.values(connectorOwnerSteps)).size, connectorOwnerKinds.length);
  assert.deepEqual([connectorOwnerSteps.codexOwnedLoadBegin, connectorOwnerSteps.codexOwnedLoadAcknowledge,
    connectorOwnerSteps.codexOwnedLoadFinish], [366, 367, 368]);
  assert.deepEqual(['titleClaim', 'titleReceipt', 'titleBegin', 'titleAccept', 'titleAbandon'].map(
    kind => connectorOwnerSteps[kind as keyof typeof connectorOwnerSteps]), [361, 362, 363, 364, 365]);
  assert.equal(connectorOwnerSteps.fileSessionObserve, 353);
  assert.equal(connectorOwnerSteps.executionFactBatch, 370);
  assert.equal(validConnectorOwnerInput('executionFactBatch', { runtime: 'codex', keys: ['same', 'same'] }), false);
  assert.equal(validConnectorOwnerInput('executionFactBatch', { runtime: 'codex',
    keys: Array.from({ length: 17 }, (_, index) => `session-${String(index).padStart(2, '0')}`) }), false);
  assert.deepEqual([connectorOwnerSteps.runtimeMaintenanceObserve, connectorOwnerSteps.runtimeMaintenanceHistory,
    connectorOwnerSteps.runtimeMaintenanceSdkSession, connectorOwnerSteps.runtimeMaintenanceInteractions,
    connectorOwnerSteps.runtimeMaintenancePreservation], [336, 337, 338, 339, 340]);
  assert.equal(connectorOwnerSteps.sdkExecutionContext, 335);
  assert.deepEqual(['workspaceFileGuard', 'workspaceFileBinding', 'workspaceFileInstall', 'workspaceFileInstalled',
    'workspaceFileReceipt', 'workspaceFileWrite', 'workspaceFileSettled', 'workspaceFileRevoke',
    'workspaceFileReconcile', 'workspaceFileSessionFiles'].map(kind => connectorOwnerSteps[kind as keyof typeof connectorOwnerSteps]),
    Array.from({length:10},(_,i) => 311+i));
  assert.deepEqual([connectorOwnerSteps.codexFilesPage, connectorOwnerSteps.codexFilesStart,
    connectorOwnerSteps.codexFilesStep, connectorOwnerSteps.codexFilesCancel, connectorOwnerSteps.codexFilesDeliver], [306, 307, 308, 309, 310]);
  assert.deepEqual([connectorOwnerSteps.codexPublicUsageRange, connectorOwnerSteps.codexPublicUsageExport,
    connectorOwnerSteps.codexPublicUsageSnapshotCreate, connectorOwnerSteps.codexPublicUsageSnapshotRead,
    connectorOwnerSteps.codexPublicUsageDeliver], [301, 302, 303, 304, 305]);
  assert.deepEqual([connectorOwnerSteps.codexDeletionClaim, connectorOwnerSteps.codexDeletionReceipt,
    connectorOwnerSteps.codexDeletionBegin, connectorOwnerSteps.codexDeletionAccept,
    connectorOwnerSteps.codexDeletionAbandon], [296, 297, 298, 299, 300]);
  assert.deepEqual([connectorOwnerSteps.codexCatalogAuthorize, connectorOwnerSteps.codexCatalogDeliver], [288, 289]);
  assert.deepEqual([connectorOwnerSteps.codexSettingsAuthorize, connectorOwnerSteps.codexSettingsClaim,
    connectorOwnerSteps.codexSettingsReceipt, connectorOwnerSteps.codexSettingsBegin,
    connectorOwnerSteps.codexSettingsAccept, connectorOwnerSteps.codexSettingsAbandon], [290, 291, 292, 293, 294, 295]);
  assert.deepEqual(['codexCreationClaim', 'codexCreationReceiptRead', 'codexCreationReady', 'codexCreationIdentify',
    'codexCreationNameReady', 'codexCreationAccept', 'codexCreationAbandon'].map(kind => connectorOwnerSteps[kind as keyof typeof connectorOwnerSteps]),
    [281, 282, 283, 284, 285, 286, 287]);
  assert.equal(connectorOwnerSteps.codexSchedulingRejectHead, 259);
  assert.equal(connectorOwnerSteps.codexQueueContext, 258);
  assert.deepEqual([connectorOwnerSteps.codexToolsBind, connectorOwnerSteps.codexToolsCheck, connectorOwnerSteps.codexToolsRelease], [255, 256, 257]);
  assert.deepEqual([connectorOwnerSteps.codexSchedulingObservation, connectorOwnerSteps.codexSchedulingRecheck], [250, 251]);
  assert.deepEqual([connectorOwnerSteps.codexPreparationReady, connectorOwnerSteps.codexPreparationFinish], [244, 245]);
  assert.deepEqual([connectorOwnerSteps.codexQueuePlan, connectorOwnerSteps.codexQueuePlanChunk, connectorOwnerSteps.codexQueuePlanRelease], [241, 242, 243]);
  assert.deepEqual([connectorOwnerSteps.codexReadAuthorize, connectorOwnerSteps.codexReadDeliver], [239, 240]);
  assert.deepEqual(['codexStopClaim', 'codexStopReady', 'codexStopCheck', 'codexStopSettle', 'codexStopRelease', 'codexStopReceiptRead']
    .map(kind => connectorOwnerSteps[kind as keyof typeof connectorOwnerSteps]), [233, 234, 235, 236, 237, 238]);
  assert.deepEqual(['codexMessageClaim', 'codexMessageReady', 'codexMessageCommit', 'codexMessageReceiptRead',
    'codexMessageSendReceiptRead', 'codexMessageRelease'].map(kind => connectorOwnerSteps[kind as keyof typeof connectorOwnerSteps]),
    [227, 228, 229, 230, 231, 232]);
  assert.equal(connectorOwnerSteps.codexDispatchFailure, 221);
  assert.deepEqual(['codexStartupRecover', 'codexStartupQueuePage', 'codexStartupQueueChunk'].map(
    kind => connectorOwnerSteps[kind as keyof typeof connectorOwnerSteps]), [218, 219, 220]);
  assert.equal(connectorOwnerSteps.codexNativeNotification, 217);
  assert.deepEqual(['codexDispatchClaim', 'codexDispatchReady'].map(
    kind => connectorOwnerSteps[kind as keyof typeof connectorOwnerSteps]), [215, 216]);
  assert.deepEqual(['openClawReadAuthorize', 'openClawReadDeliver'].map(
    kind => connectorOwnerSteps[kind as keyof typeof connectorOwnerSteps]), [213, 214]);
  assert.deepEqual(['openClawCompactClaim', 'openClawCompactReady', 'openClawCompactSettle', 'openClawCompactRelease', 'openClawCompactReceiptRead'].map(
    kind => connectorOwnerSteps[kind as keyof typeof connectorOwnerSteps]), [208, 209, 210, 211, 212]);
  assert.deepEqual(['openClawStatus', 'openClawStatusRead', 'openClawStatusSendRead'].map(
    kind => connectorOwnerSteps[kind as keyof typeof connectorOwnerSteps]), [205, 206, 207]);
  assert.deepEqual(['openClawStopClaim', 'openClawStopReady', 'openClawStopSettle', 'openClawStopRelease'].map(
    kind => connectorOwnerSteps[kind as keyof typeof connectorOwnerSteps]), [201, 202, 203, 204]);
  assert.equal(connectorOwnerSteps.openClawRecoveryCandidate, 194);
  assert.deepEqual(['openClawMessageClaim', 'openClawMessageReady', 'openClawMessageCommit',
    'openClawMessageReceiptRead', 'openClawMessageSendReceiptRead', 'openClawMessageRelease'].map(kind =>
    connectorOwnerSteps[kind as keyof typeof connectorOwnerSteps]), [195, 196, 197, 198, 199, 200]);
  assert.deepEqual(['openClawDispatchPlan', 'openClawDispatchClaim', 'openClawDispatchReady',
    'openClawDispatchCli', 'openClawDispatchAbandon', 'openClawDispatchUnknown'].map(kind =>
    connectorOwnerSteps[kind as keyof typeof connectorOwnerSteps]), [188, 189, 190, 191, 192, 193]);
  assert.equal(Object.isFrozen(connectorOwnerKinds), true);
  assert.equal(Object.isFrozen(connectorOwnerSteps), true);
  assert.equal(validConnectorOwnerInput('exec' as never, {}), false);
  assert.throws(() => connectorOwnerConfig({ file: ':memory:' }), ConnectorOwnerUnavailable);
  assert.equal(validConnectorOwnerInput('userCreate', { label: 'bad\0label' }), true);
  assert.equal(validConnectorOwnerInput('userCreate', { label: '  ' }), false);
  assert.equal(validConnectorOwnerInput('turnSessionPage', { runtime: 'codex', after: '', limit: 65 }), false);
  assert.equal(validConnectorOwnerOutput('storageRecovery', { state: 'ready', attempts: 0 }), true);
  assert.equal(validConnectorOwnerOutput('storageRecovery', { state: 'committed', attempts: 0 }), false);
});

test('original worker facts head is stable for audited observations, invalidates failed changes, and cannot survive reopen', () => disk(async file => {
  const owner = new AsyncConnectorOwner({ file }, silence);
  let originalVersion = '';
  try {
    await owner.open();
    const before = await owner.command('eventProjectionHead', {});
    await owner.command('eventReplay', { after: null });
    await owner.command('sdkSessionPage', { runtime: 'ghcp', after: '', limit: 1 });
    await owner.command('sdkLifecycleRead', { runtime: 'ghcp', key: 'ghcp:missing', history: false });
    assert.deepEqual(await owner.command('eventProjectionHead', {}), before);
    await owner.command('userCreate', { label: 'head fixture' });
    const after = await owner.command('eventProjectionHead', {});
    assert.equal(after.cursor, before.cursor); assert.notEqual(after.version, before.version);
    await assert.rejects(owner.command('maintenanceSnapshot', {}), ConnectorOwnerUnavailable);
    const failed = await owner.command('eventProjectionHead', {});
    assert.equal(failed.cursor, after.cursor); assert.notEqual(failed.version, after.version);
    originalVersion = failed.version;
  } finally { await owner.close(); }
  const reopened = new AsyncConnectorOwner({ file }, silence);
  try {
    await reopened.open();
    assert.notEqual((await reopened.command('eventProjectionHead', {})).version.split(':')[0], originalVersion.split(':')[0]);
  } finally { await reopened.close(); }
}));

for (const field of ['sessionKey', 'planId', 'offset'] as const)
  test(`Codex queue chunk supervisor rejects valid foreign ${field} without replay`, () => disk(async file => {
    const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
    const input = { sessionKey: 'codex:original', planId: randomUUID(), offset: 0 };
    const reply = { ...input, chunk: Buffer.from('private').toString('base64'),
      [field]: field === 'sessionKey' ? 'codex:foreign' : field === 'planId' ? randomUUID() : 65536 };
    assert.equal(validConnectorOwnerOutput('codexQueuePlanChunk', reply), true);
    const work = owner.command('codexQueuePlanChunk', input), rejected = assert.rejects(work, ConnectorOwnerUnavailable);
    await tick(); fake.reply(0, reply); await rejected; assert.equal(owner.snapshot().unavailable, true);
    const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
    assert.equal(fake.messages.length, 1);
  }));

for (const field of ['sessionKey', 'commandId', 'connectionId', 'count', 'preparation', 'batch'] as const)
  test(`Codex dispatch supervisor rejects valid foreign ${field} without replay`, () => disk(async file => {
    const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
    const input = { sessionKey: 'codex:original', commandId: 'command', connectionId: 'connection',
      proof: { count: 1, digest: 'a'.repeat(64) }, preparing: false, blockedGoalInput: false };
    const reply = { proof: { count: field === 'count' ? 2 : 1, digest: 'b'.repeat(64) },
      execution: { sessionKey: 'codex:original', commandId: 'command', connectionId: 'connection',
        phase: 'starting', sync: 'current', revision: 1, startedAt: 1, updatedAt: 1,
        ...(['sessionKey', 'commandId', 'connectionId'].includes(field) ? { [field]: field === 'sessionKey' ? 'codex:foreign' : 'foreign' } : {}),
        ...(field === 'preparation' ? { preparation: 'active' } : {}),
        ...(field === 'batch' ? { batch: { separator: 'separator', members: [
          { id: 'first', createdAt: 1, imageCount: 0 }, { id: 'second', createdAt: 2, imageCount: 0 }] } } : {}) } };
    assert.equal(validConnectorOwnerOutput('codexDispatchClaim', reply), true);
    const work = owner.command('codexDispatchClaim', input), rejected = assert.rejects(work, ConnectorOwnerUnavailable);
    await tick(); fake.reply(0, reply); await rejected;
    assert.equal(owner.snapshot().unavailable, true);
    const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
    assert.equal(fake.messages.length, 1);
  }));

for (const field of ['leaseId', 'identity', 'scopes'] as const)
  test(`local credentials supervisor rejects foreign ${field} without replay`, () => disk(async file => {
    const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
    const specs = [{ role: 'daily' as const, identity: 'local:daily', scopes: ['models:read' as const] },
      { role: 'maintenance' as const, identity: 'local:maintenance', scopes: ['models:write' as const] }];
    const input = { leaseId: randomUUID(), specs };
    const reply = { leaseId: field === 'leaseId' ? randomUUID() : input.leaseId,
      credentials: specs.map(s => ({ ...s, scopes: field === 'scopes' ? ['sessions:read'] : s.scopes, token: `aod_local_${'x'.repeat(43)}` })) };
    // A valid different role/identity pair must not satisfy the original bundle.
    if (field === 'identity') reply.credentials.reverse();
    assert.equal(validConnectorOwnerOutput('localCredentialsCreate', reply), true);
    const work = owner.command('localCredentialsCreate', input), rejected = assert.rejects(work, ConnectorOwnerUnavailable);
    await tick(); fake.reply(0, reply); await rejected; assert.equal(owner.snapshot().unavailable, true);
    const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
    assert.equal(fake.messages.length, 1);
  }));

test('local credentials release supervisor rejects a foreign lease and keeps original owner reserved', () => disk(async file => {
  const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
  const work = owner.command('localCredentialsRelease', { leaseId: randomUUID() });
  const rejected = assert.rejects(work, ConnectorOwnerUnavailable);
  await tick(); fake.reply(0, { leaseId: randomUUID(), released: true }); await rejected;
  assert.equal(owner.snapshot().unavailable, true);
  const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
  assert.equal(fake.messages.length, 1);
}));

for (const kind of ['sdkStateRead', 'sdkModelsRead', 'sdkModelsDeliver'] as const)
  for (const field of kind === 'sdkStateRead' ? ['runtime', 'key'] : kind === 'sdkModelsDeliver' ? ['runtime', 'readerId'] : ['runtime'])
    test(`metadata supervisor rejects valid foreign ${kind}/${field} without retry`, () => disk(async file => {
      const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
      const runtime = field === 'runtime' ? 'claude-code' : 'ghcp';
      const key = field === 'runtime' || field === 'key' ? `${runtime}:foreign` : 'ghcp:original';
      const reply = { runtime, readerId: field === 'readerId' ? 'foreign' : 'reader',
        ...(kind === 'sdkStateRead' ? { key, nativeSessionId: 'native', body: { sessionKey: key, status: 'unknown', sourceCursor: '0' } }
          : kind === 'sdkModelsRead' ? { body: { models: [{ id: 'original', label: 'original' }] } } : {}) };
      assert.equal(validConnectorOwnerOutput(kind, reply), true);
      const work = kind === 'sdkStateRead' ? owner.command(kind, { runtime: 'ghcp', key: 'ghcp:original', authorization: 'Bearer original', connected: true })
        : kind === 'sdkModelsRead' ? owner.command(kind, { runtime: 'ghcp', authorization: 'Bearer original' })
          : owner.command(kind, { runtime: 'ghcp', authorization: 'Bearer original', readerId: 'reader' });
      const rejected = assert.rejects(work, ConnectorOwnerUnavailable);
      await tick(); fake.reply(0, reply); await rejected; assert.equal(owner.snapshot().unavailable, true);
      const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
      assert.equal(fake.messages.length, 1);
    }));

for (const field of ['key', 'runtime', 'jobId'] as const)
  test(`files supervisor rejects valid foreign ${field} and never replays a scan`, () => disk(async file => {
    const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
    const input = { runtime: 'ghcp' as const, key: 'ghcp:original', authorization: 'Bearer original', jobId: randomUUID(), step: 0 };
    const runtime = field === 'runtime' ? 'claude-code' : input.runtime;
    const reply = { runtime, key: field === 'key' || field === 'runtime' ? `${runtime}:foreign` : input.key,
      readerId: 'reader', nativeSessionId: 'native', body: { id: field === 'jobId' ? randomUUID() : input.jobId,
        step: 1, state: 'completed', scanned: 0, bytes: 0, found: 0, limited: false } };
    assert.equal(validConnectorOwnerOutput('sdkFilesStep', reply), true);
    const work = owner.command('sdkFilesStep', input), rejected = assert.rejects(work, ConnectorOwnerUnavailable);
    await tick(); fake.reply(0, reply); await rejected; assert.equal(owner.snapshot().unavailable, true);
    const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
    assert.equal(fake.messages.length, 1);
  }));

for (const kind of ['sdkHistoryMessage', 'sdkHistoryDeliver'] as const)
for (const field of kind === 'sdkHistoryDeliver' ? ['key', 'readerId', 'nativeSessionId'] : ['key', 'messageId'])
  test(`${kind}: supervisor rejects valid foreign ${field} without replay`, () => disk(async file => {
    const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
    const scope = { runtime: 'ghcp' as const, key: 'ghcp:original', authorization: 'Bearer original' };
    const work = kind === 'sdkHistoryDeliver' ? owner.command(kind, { ...scope, readerId: 'reader', nativeSessionId: 'native' })
      : owner.command(kind, { ...scope, messageId: 'message' });
    const rejected = assert.rejects(work, ConnectorOwnerUnavailable);
    const key = field === 'key' ? 'ghcp:foreign' : scope.key;
    const reply = { runtime: scope.runtime, key, readerId: 'reader', nativeSessionId: 'native',
      ...(kind === 'sdkHistoryMessage' ? { messageId: 'message', body: { message: { id: 'normalized-id', sessionKey: key,
        role: 'assistant', text: 'Original body', createdAt: 1 }, updatedAt: 1, sourceCursor: '0' } } : {}),
      [field]: field === 'key' ? key : 'foreign' };
    assert.equal(validConnectorOwnerOutput(kind, reply), true);
    await tick(); fake.reply(0, reply); await rejected; assert.equal(owner.snapshot().unavailable, true);
    const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
    assert.equal(fake.messages.length, 1);
  }));

test('history result reservation is weighted and retained until original worker reply', () => disk(async file => {
  const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
  assert.equal(connectorOwnerResultBytes('sdkHistoryPage'), 2 * 1024 * 1024);
  assert.equal(connectorOwnerResultBytes('sdkHistoryMessage'), 2 * 1024 * 1024);
  assert.equal(connectorOwnerResultBytes('sdkHistoryDeliver'), 1024 * 1024);
  const input = { runtime: 'ghcp' as const, key: 'ghcp:original', authorization: 'Bearer original', limit: 1 };
  const works = Array.from({ length: 8 }, () => owner.command('sdkHistoryPage', input));
  assert.equal(owner.snapshot().resultBytes, 16 * 1024 * 1024);
  await assert.rejects(owner.command('sdkHistoryPage', input), ConnectorOwnerUnavailable);
  await assert.rejects(owner.command('sdkHistoryDeliver', { runtime: input.runtime, key: input.key, authorization: input.authorization,
    readerId: 'reader', nativeSessionId: 'native' }), ConnectorOwnerUnavailable);
  await tick(); assert.equal(fake.messages.length, 8);
  for (let i = 0; i < 8; i++) fake.reply(i, { error: 404 });
  await Promise.all(works); assert.equal(owner.snapshot().resultBytes, 0);
  const closing = owner.close(); await tick(); fake.reply(8, null); fake.emit('exit', 0); await closing;
}));

test('automation view has one dedicated physical result slot without starving ordinary RPCs', () => disk(async file => {
  const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
  const evidence = { authorization: 'Bearer original' };
  assert.equal(connectorOwnerResultBytes('automationConfigurationView'), 65 * 1024 * 1024);
  const first = owner.command('automationConfigurationView', evidence);
  await assert.rejects(owner.command('automationConfigurationView', evidence), ConnectorOwnerUnavailable);
  const authority = owner.command('automationAuthority', evidence);
  await tick(); assert.equal(fake.messages.length, 2);
  fake.reply(1, { ok: false, error: 401 }); await authority;
  await assert.rejects(owner.command('automationConfigurationView', evidence), ConnectorOwnerUnavailable);
  fake.reply(0, { ok: false, error: 401 }); await first;
  const next = owner.command('automationConfigurationView', evidence);
  let closed = false;
  const closing = owner.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.equal(fake.messages.length, 3);
  fake.reply(2, { ok: false, error: 401 }); await next; await tick();
  assert.equal(fake.messages[3]!.kind, 'close');
  fake.reply(3, null); fake.emit('exit', 0); await closing;
}));

test('automation supervisor retires a valid receipt for another request without replay', () => disk(async file => {
  const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
  const work = owner.command('automationConfigurationOriginal', { authorization: 'Bearer original', requestId: 'original' });
  const rejected = assert.rejects(work, ConnectorOwnerUnavailable);
  const reply = { ok: true, value: { requestId: 'foreign', fingerprint: 'a'.repeat(64), result: {
    rule: { id: 'rule', revision: 1, authorityEpoch: 1,
      target: { ownerId: 'owner', connectionId: 'node', runtime: 'codex', sessionId: 'codex:session' }, enabled: false,
      startsAt: 1000, expiresAt: 1_000_000, maxSends: 2, maxPerHour: 2, minIntervalMs: 60_000,
      mode: { kind: 'interval', intervalMs: 60_000 } }, template: 'original', templateHash: 'b'.repeat(64), revoked: false,
  } } };
  assert.equal(validConnectorOwnerOutput('automationConfigurationOriginal', reply), true);
  await tick(); fake.reply(0, reply); await rejected;
  assert.equal(owner.snapshot().unavailable, true);
  const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
  assert.equal(fake.messages.length, 1);
}));

test('usage export and snapshot share weighted physical result budget without replacement', () => disk(async file => {
  const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
  const input = { runtime: 'ghcp' as const, key: 'ghcp:original', authorization: 'Bearer original', from: 0, to: 120_000, bucketMs: 60_000 };
  assert.equal(connectorOwnerResultBytes('sdkUsageRange'), 2 * 1024 * 1024);
  for (const kind of ['sdkUsageExport', 'sdkUsageSnapshotCreate', 'sdkUsageSnapshotRead'] as const)
    assert.equal(connectorOwnerResultBytes(kind), 8 * 1024 * 1024);
  const exported = owner.command('sdkUsageExport', input);
  const snapshot = owner.command('sdkUsageSnapshotCreate', { ...input, requestId: randomUUID() });
  assert.equal(owner.snapshot().resultBytes, 16 * 1024 * 1024);
  await assert.rejects(owner.command('sdkUsageRange', input), ConnectorOwnerUnavailable);
  await tick(); assert.equal(fake.messages.length, 2);
  fake.reply(0, { error: 404 }); await exported;
  assert.equal(owner.snapshot().resultBytes, 8 * 1024 * 1024);
  fake.reply(1, { error: 503 }); await snapshot;
  assert.equal(owner.snapshot().resultBytes, 0);
  const closing = owner.close(); await tick(); fake.reply(2, null); fake.emit('exit', 0); await closing;
}));

for (const field of ['key', 'range', 'requestId'] as const)
  test(`usage supervisor rejects valid foreign ${field} and never replays snapshot creation`, () => disk(async file => {
    const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
    const input = { runtime: 'ghcp' as const, key: 'ghcp:original', authorization: 'Bearer original', from: 0, to: 120_000,
      bucketMs: 60_000, requestId: randomUUID() };
    const source = new ConnectorUserStore(':memory:');
    let body;
    try { body = source.tokenUsage.snapshot(input.runtime, input.key, field === 'requestId' ? randomUUID() : input.requestId,
      input.from, field === 'range' ? 180_000 : input.to, input.bucketMs); }
    finally { source.close(); }
    const reply = { runtime: input.runtime, key: field === 'key' ? 'ghcp:foreign' : input.key,
      readerId: 'reader', nativeSessionId: 'native', body };
    assert.equal(validConnectorOwnerOutput('sdkUsageSnapshotCreate', reply), true);
    const work = owner.command('sdkUsageSnapshotCreate', input), rejected = assert.rejects(work, ConnectorOwnerUnavailable);
    await tick(); fake.reply(0, reply); await rejected;
    assert.equal(owner.snapshot().unavailable, true);
    const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
    assert.equal(fake.messages.length, 1);
  }));

for (const changed of [{ sessionKey: 'ghcp:foreign' }, { runId: 'foreign-run' }, { requestId: 'foreign-request' }, { claimId: 'foreign-claim' }])
  test(`interaction owner rejects a valid fact belonging to another original request ${JSON.stringify(changed)}`, () => disk(async file => {
    const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
    const ref = { key: 'ghcp:original', id: 'original-run', epoch: 'original-epoch', nativeSessionId: 'original-native' };
    const work = owner.command('sdkInteractionSettle', { runtime: 'ghcp', ref, bindingId: 'original-binding',
      requestId: 'original-request', claimId: 'original-claim', outcome: 'confirmed' });
    const rejected = assert.rejects(work, ConnectorOwnerUnavailable);
    const { claimId, ...scope } = changed as { claimId?: string; sessionKey?: string; runId?: string; requestId?: string };
    const reply = { ok: true, value: { revision: 4, continuationHash: 'a'.repeat(64), updatedAt: 3,
      claimId: claimId ?? 'original-claim', delivery: 'confirmed', state: { status: 'answered',
        request: { version: 1, ownerId: 'owner', nodeId: 'node', sessionKey: ref.key, runId: ref.id,
          requestId: 'original-request', kind: 'text', prompt: 'Original prompt', createdAt: 1, expiresAt: 100, ...scope },
        responseId: 'original-response', answeredAt: 2, answer: { kind: 'text', text: 'Original answer' } } } };
    assert.equal(validConnectorOwnerOutput('sdkInteractionSettle', reply), true);
    await tick(); fake.reply(0, reply); await rejected;
    assert.equal(owner.snapshot().unavailable, true);
    const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
    assert.equal(fake.messages.length, 1, 'foreign receipt cannot authorize replay or owner replacement');
  }));

test('interaction facts reject inconsistent states, forged physical proof and extra authority', () => {
  const ref = { key: 'ghcp:original', id: 'run', epoch: 'epoch', nativeSessionId: 'native' };
  assert.equal(validConnectorOwnerInput('sdkInteractionRetire', { runtime: 'ghcp', ref, bindingId: 'binding', nativeEnded: 1 }), false);
  assert.equal(validConnectorOwnerInput('sdkInteractionMode', { runtime: 'ghcp', key: ref.key, authorization: 'Bearer original', mode: 'interactive', nativeReady: true, allowed: true }), false);
  assert.equal(validConnectorOwnerOutput('sdkInteractionObserve', { ok: true, value: { mode: 'interactive', requests: [{
    revision: 1, status: 'answered', delivery: 'none', request: { version: 1, ownerId: 'owner', nodeId: 'node', sessionKey: ref.key,
      runId: ref.id, requestId: 'request', kind: 'text', prompt: 'Original prompt', createdAt: 1, expiresAt: 2 },
  }] } }), false);
});

for (const kind of ['sdkDeletionReceiptRead', 'sdkCompactReceiptRead', 'sdkMessageStopClaim', 'sdkMessageStatus', 'sdkMessageStatusRead'] as const)
for (const changed of [{ runtime: 'claude-code', key: 'claude-code:original' }, { key: 'ghcp:other' }, { commandKey: 'other' }])
  test(`${kind} refuses original scope mismatch ${JSON.stringify(changed)}`, () => disk(async file => {
    const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
    const input = { runtime: 'ghcp' as const, key: 'ghcp:original', commandKey: 'original', authorization: 'Bearer original' };
    const work = kind === 'sdkDeletionReceiptRead' ? owner.command(kind, input)
      : kind === 'sdkMessageStopClaim' ? owner.command(kind, { ...input, ref: null, payloadJson: '{}' })
      : kind === 'sdkMessageStatusRead' ? owner.command(kind, input)
      : kind === 'sdkMessageStatus' ? owner.command(kind, { ...input, payloadJson: '{"message":"/status"}',
        display: { connected: true, gateway: 'connected', session: {} } })
      : owner.command(kind, { ...input, purpose: 'read' });
    const rejected = assert.rejects(work, ConnectorOwnerUnavailable);
    const receipt = kind === 'sdkMessageStopClaim' ? { id: 'original-receipt', key: input.commandKey,
      state: 'outcome_unknown', createdAt: 1, updatedAt: 1 } : null;
    await tick(); fake.reply(0, { runtime: input.runtime, key: input.key, commandKey: input.commandKey, receipt,
      ...(kind === 'sdkMessageStopClaim' ? { execution: null } : {}),
      ...(kind === 'sdkMessageStatus' || kind === 'sdkMessageStatusRead' ? { queue: { presence: 'absent' }, report: null } : {}), ...changed });
    await rejected;
    assert.equal(owner.snapshot().unavailable, true);
    const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
    assert.equal(fake.messages.length, 1, 'invalid reply cannot authorize replacement or replay');
  }));

for (const changed of [{ id: 'other-run' }, { epoch: 'other-epoch' }, { nativeSessionId: 'other-native' }])
  test(`stop owner refuses wrong original physical reference ${JSON.stringify(changed)}`, () => disk(async file => {
    const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
    const ref = { key: 'ghcp:original', id: 'original-run', epoch: 'original-epoch', nativeSessionId: 'original-native' };
    const work = owner.command('sdkMessageStopClaim', { runtime: 'ghcp', key: ref.key, commandKey: 'stop',
      authorization: 'Bearer original', ref, payloadJson: '{}' });
    const rejected = assert.rejects(work, ConnectorOwnerUnavailable);
    const reply = { runtime: 'ghcp', key: ref.key, commandKey: 'stop',
      receipt: { id: 'original-receipt', key: 'stop', state: 'outcome_unknown', createdAt: 1, updatedAt: 1 },
      execution: { ...ref, ...changed, kind: 'message', phase: 'running', members: ['original-turn'],
        nativeMode: 'resume', nativeRequestId: 'original-request', stopRequested: true, createdAt: 1, updatedAt: 1 },
    };
    assert.equal(validConnectorOwnerOutput('sdkMessageStopClaim', reply), true, 'valid reply shape must fail on original reference, not schema');
    await tick(); fake.reply(0, reply);
    await rejected; assert.equal(owner.snapshot().unavailable, true);
    const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
    assert.equal(fake.messages.length, 1);
  }));

for (const [name, value] of [
  ['getter', Object.defineProperty({}, 'label', { enumerable: true, get() { throw Error('getter invoked'); } })],
  ['proxy', new Proxy({}, { ownKeys() { throw Error('proxy invoked'); } })],
  ['toJSON', { toJSON() { throw Error('toJSON invoked'); } }],
  ['then', { then() { throw Error('then invoked'); } }],
  ['sparse', new Array(2)], ['nan', NaN], ['date', new Date()], ['extra', { label: 'ok', authority: true }],
] as const) test(`Connector admission rejects ${name} without dispatch`, () => disk(async file => {
  const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
  try {
    await assert.rejects(owner.command('userCreate', value as never), ConnectorOwnerUnavailable);
    assert.equal(fake.messages.length, 0);
    assert.equal(owner.snapshot().accepted, 0);
  } finally { const close = owner.close(); await tick(); fake.reply(0, null); fake.emit('exit', 0); await close; }
}));

for (const kind of ['turnSessionPage', 'turnRecoveryPage'] as const) for (const badPage of [['a'], ['b', 'c', 'd'], ['c', 'b'], ['b', 'b']])
  test(`${kind} rejects owner reply outside original cursor, bound or BINARY order`, () => disk(async file => {
    const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
    const input = kind === 'turnSessionPage' ? { runtime: 'codex' as const, after: 'a', limit: 2 }
      : { runtime: 'codex' as const, after: 'a', limit: 2, connectionId: null, mirror: false };
    const work = owner.command(kind, input), rejected = assert.rejects(work, ConnectorOwnerUnavailable);
    await tick(); fake.reply(0, badPage); await rejected;
    assert.equal(owner.snapshot().unavailable, true);
    const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
    assert.equal(owner.snapshot().ownerExitConfirmed, true);
    assert.equal(fake.messages.length, 1, 'no replay or replacement command');
  }));

test('Connector JSON budget rejects cycles, oversized output and metadata without invoking callbacks', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => encodeConnectorOwnerJson(cycle), ConnectorOwnerUnavailable);
  assert.throws(() => encodeConnectorOwnerJson('x'.repeat(32_000)), ConnectorOwnerUnavailable);
  assert.throws(() => encodeConnectorOwnerJson(Object.defineProperty({}, 'x', { value: 1 })), ConnectorOwnerUnavailable);
  assert.equal(encodeConnectorOwnerJson({ value: ['a', true, null, 2] }), '{"value":["a",true,null,2]}');
});

test('complete Connector owner preserves all original tables, node identity and saved users through reopen', () => disk(async file => {
  const original = new ConnectorUserStore(file);
  const initial = original.listUsers(), node = original.nodeId;
  original.close();
  const snapshot = () => {
    const db = new DatabaseSync(file);
    try {
      return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
        .filter(row => row.name !== 'connector_users')
        .map(row => [row.name, db.prepare('SELECT * FROM "' + row.name.replaceAll('"', '""') + '"').all().map(value => JSON.stringify(value)).sort()]);
    } finally { db.close(); }
  };
  const before = snapshot(); assert.ok(before.length > 20);
  const owner = new AsyncConnectorOwner({ file }, silence);
  let id = '';
  try {
    await owner.open();
    assert.throws(() => new ConnectorUserStore(file));
    assert.equal(await owner.command('nodeIdentity', {}), node);
    assert.deepEqual(await owner.command('usersList', {}), initial);
    const created = await owner.command('userCreate', { label: 'preserved-fixture-user' }); id = created.id;
    assert.deepEqual(await owner.command('userGet', { id }), created);
    assert.equal((await owner.command('userUpdate', { id, label: 'updated-fixture-user' }))!.label, 'updated-fixture-user');
    assert.equal(await owner.command('userGet', { id: 'missing' }), null);
    assert.deepEqual(await owner.command('storageRecovery', {}), { state: 'ready', attempts: 0 });
    assert.equal(await owner.command('interactionCount', {}), 0);
    assert.equal(await owner.command('receiptDeletion', { sessionKey: 'codex:fixture' }), null);
    assert.equal(await owner.command('receiptSettingsPending', { sessionKey: 'codex:fixture' }), false);
    assert.equal(await owner.command('interactionPending', { sessionKey: 'codex:fixture' }), false);
    assert.equal(await owner.command('turnMaintenanceCount', {}), 0);
    assert.deepEqual(await owner.command('turnSessionPage', { runtime: 'codex', after: '', limit: 32 }), []);
    assert.deepEqual(await owner.command('sessionPolicy', { sessionKey: 'codex:fixture' }), { canDelete: true, canChangeSettings: true });
    assert.equal(typeof await owner.command('eventCursor', {}), 'string');
    await assert.rejects(owner.command('maintenanceSnapshot', {}), ConnectorOwnerUnavailable);
    const generation = await owner.command('maintenancePause', {});
    assert.equal(await owner.command('maintenancePause', {}), generation);
    const paused = await owner.command('maintenanceSnapshot', {});
    assert.match(paused.queueSha256, /^[a-f0-9]{64}$/); assert.equal(paused.commandAdmissionOpen, false);
    assert.equal(await owner.command('maintenanceResume', { generation: generation + 1 }), false);
    assert.equal(await owner.command('maintenanceResume', { generation }), true);
    const next = await owner.command('maintenancePause', {}); assert.ok(next > generation);
    assert.equal(await owner.command('maintenanceResume', { generation }), false);
    await owner.command('maintenanceStop', {});
    assert.equal(await owner.command('maintenanceResume', { generation: next }), false);
    await assert.rejects(owner.command('maintenanceSnapshot', {}), ConnectorOwnerUnavailable);
  } finally { await owner.close(); }
  assert.equal(owner.snapshot().ownerExitConfirmed, true);
  assert.deepEqual(snapshot(), before);
  const reopened = new ConnectorUserStore(file);
  try { assert.equal(reopened.nodeId, node); assert.equal(reopened.getUser(id)!.label, 'updated-fixture-user'); }
  finally { reopened.close(); }
}));

test('real Connector worker produces numeric failure evidence without user content, path or error text', () => disk(async file => {
  const seed = new ConnectorUserStore(file);
  (seed as unknown as { db: DatabaseSync }).db.exec("CREATE TRIGGER private_connector_trigger BEFORE INSERT ON connector_users WHEN NEW.id <> 'default' BEGIN SELECT RAISE(ABORT, 'private-sql-exception'); END");
  seed.close();
  const lines: string[] = [];
  const owner = new AsyncConnectorOwner({ file }, silence, () => {
    const source = import.meta.url.endsWith('.ts');
    const entry = new URL(source ? './connector-owner-worker.ts' : './connector-owner-worker.js', import.meta.url);
    const worker = new Worker(`(async () => {
      const { workerData } = require('node:worker_threads');
      if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
      else await import(workerData.entry);
    })().catch(() => process.exit(1));`, { eval: true, execArgv: [], stdout: true, workerData: {
      file, entry: entry.href, loader: source ? import.meta.resolve('tsx/esm/api') : undefined,
    } });
    worker.stdout!.setEncoding('utf8'); worker.stdout!.on('data', chunk => lines.push(chunk)); return worker;
  });
  try {
    await owner.open();
    await assert.rejects(owner.command('userCreate', { label: 'private-connector-label' }), ConnectorOwnerUnavailable);
    assert.ok((await owner.command('usersList', {})).length > 0);
  } finally { await owner.close(); }
  const text = lines.join('');
  const events = text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.ok(events.some(row => row.operation === 'connector-sqlite-command' && row.step === 4 && row.unknown === 1 && row.sqlErrorCode === 1811));
  assert.doesNotMatch(text, /private-sql-exception|private_connector_trigger|private-connector-label/);
  assert.equal(text.includes(file), false);
}));

test('accepted Connector commands drain before close; bounded capacity refusal never dispatches', () => disk(async file => {
  const fake = new FakeWorker(), owner = fakeOwner(file, fake);
  const work = Array.from({ length: 16 }, () => owner.command('interactionCount', {}));
  await assert.rejects(owner.command('interactionCount', {}), ConnectorOwnerUnavailable);
  const close = owner.close(); await tick(); assert.equal(fake.messages.length, 0);
  await assert.rejects(owner.command('interactionCount', {}), ConnectorOwnerUnavailable);
  fake.ready(); await tick(); assert.equal(fake.messages.length, 16);
  work.forEach((_, i) => fake.reply(i, 0)); await Promise.all(work); await tick();
  assert.equal(fake.messages[16]!.kind, 'close'); fake.reply(16, null);
  let settled = false; void close.then(() => { settled = true; }); await tick(); assert.equal(settled, false);
  fake.emit('exit', 0); await close;
  assert.equal(owner.snapshot().inputBytes, 0); assert.equal(owner.snapshot().resultBytes, 0);
}));

test('Connector SQL rejection does not replay a write or invalidate readable original data', () => disk(async file => {
  const original = new ConnectorUserStore(file);
  const before = original.listUsers();
  const db = (original as unknown as { db: DatabaseSync }).db;
  db.exec("CREATE TRIGGER connector_owner_fixture_fault BEFORE INSERT ON connector_users WHEN NEW.id <> 'default' BEGIN SELECT RAISE(ABORT, 'private-connector-error'); END");
  original.close();
  const owner = new AsyncConnectorOwner({ file }, silence);
  try {
    await owner.open();
    await assert.rejects(owner.command('userCreate', { label: 'private-user-label' }), ConnectorOwnerUnavailable);
    assert.equal(owner.snapshot().unavailable, false);
    assert.deepEqual(await owner.command('usersList', {}), before);
    assert.deepEqual(await owner.command('storageRecovery', {}), { state: 'ready', attempts: 0 });
  } finally { await owner.close(); }
  const reopened = new ConnectorUserStore(file);
  try { assert.deepEqual(reopened.listUsers(), before); }
  finally { reopened.close(); }
}));

test('Connector diagnostic sink reentrant close observes already reserved accepted command', () => disk(async file => {
  const fake = new FakeWorker(); let owner: AsyncConnectorOwner, close: Promise<void> | undefined;
  const diagnostics = new PerformanceDiagnostics(line => {
    const row = JSON.parse(line);
    if (row.operation === 'connector-sqlite-command' && row.phase === 'pending') close ??= owner.close();
  });
  owner = fakeOwner(file, fake, diagnostics, 1); fake.ready();
  const work = owner.command('interactionCount', {}); await tick();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(close); assert.equal(fake.messages.length, 1);
  assert.equal(owner.snapshot().accepted, 1);
  fake.reply(0, 0); await work; await tick();
  assert.equal(fake.messages[1]!.kind, 'close'); fake.reply(1, null); fake.emit('exit', 0); await close;
}));

for (const operation of ['connector-sqlite-command', 'connector-sqlite-owner'] as const)
test(`${operation} logs numeric pending and failure evidence after routine traffic saturation`, () => {
  const rows: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0);
  for (let i = 0; i < 100; i++) { diagnostics.start('storage-admission').finish(); diagnostics.start('storage-admission').finish(true); }
  const trace = diagnostics.start(operation); trace.add('step', 1); trace.reportPending({ pending: 1 });
  trace.add('unknown', 1); trace.finish(true);
  const events = rows.filter(row => row.operation === operation);
  assert.equal(events.length, 2); assert.equal(events[0]!.phase, 'pending'); assert.equal(events[1]!.unknown, 1);
  assert.doesNotMatch(JSON.stringify(rows), /private-user-label|private-connector-error|connector\.sqlite/);
});

test('Connector termination fulfillment is not proof of physical exit and cannot release reservation', () => disk(async file => {
  const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
  assert.throws(() => fakeOwner(file, new FakeWorker()), ConnectorOwnerUnavailable);
  const retirement = owner.retireForShutdown(); await tick(); await tick();
  assert.equal(fake.stops, 1);
  assert.throws(() => fakeOwner(file, new FakeWorker()), ConnectorOwnerUnavailable);
  fake.emit('exit', 1); await retirement;
  const nextFake = new FakeWorker(), next = fakeOwner(file, nextFake); nextFake.ready();
  const close = next.close(); await tick(); nextFake.reply(0, null); nextFake.emit('exit', 0); await close;
}));

test('authority notifications wake readers without consuming or replaying accepted commands', () => disk(async file => {
  const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
  const work = owner.command('interactionCount', {}); await tick();
  const revision = owner.authorityChanges.revision, stop = new AbortController();
  const wake = owner.authorityChanges.wait(revision, stop.signal);
  fake.emit('message', {kind:'authorityChanged', revision:1}); await wake;
  assert.equal(owner.authorityChanges.revision, revision + 1);
  assert.equal(owner.snapshot().unavailable, false); assert.equal(fake.messages.length, 1);
  fake.reply(0, 0); assert.equal(await work, 0);
  fake.emit('message', {kind:'authorityChanged', revision:3});
  assert.equal(owner.authorityChanges.revision, revision + 2);
  const close = owner.close(); await tick(); fake.reply(1, null); fake.emit('exit', 0); await close;
}));

for (const fault of ['before-ready', 'extra', 'zero', 'fraction', 'duplicate', 'decreasing'] as const)
test(`authority notification ${fault} fails closed and retains physical ownership`, () => disk(async file => {
  const fake = new FakeWorker(), owner = fakeOwner(file, fake);
  if (fault !== 'before-ready') fake.ready();
  const work = owner.command('interactionCount', {}); void work.catch(() => {}); await tick();
  if (fault === 'duplicate' || fault === 'decreasing') fake.emit('message', {kind:'authorityChanged', revision:2});
  fake.emit('message', {kind:'authorityChanged', revision:fault === 'zero' ? 0 : fault === 'fraction' ? 1.5
    : fault === 'duplicate' ? 2 : 1, ...(fault === 'extra' ? {authorization:'not allowed'} : {})});
  await assert.rejects(work, ConnectorOwnerUnavailable);
  assert.throws(() => fakeOwner(file, new FakeWorker()), ConnectorOwnerUnavailable);
  assert.equal(fake.messages.length, fault === 'before-ready' ? 0 : 1);
  const retirement = owner.retireForShutdown(); await tick(); fake.emit('exit', 1); await retirement;
}));

for (const malformed of ['wrong-user', 'wrong-kind', 'extra-field', 'duplicate-ready'] as const)
test(`Connector rejects ${malformed} reply without replay and requires original physical exit`, () => disk(async file => {
  const fake = new FakeWorker(), owner = fakeOwner(file, fake); fake.ready();
  const work = owner.command('userGet', { id: 'expected-user' }); void work.catch(() => {}); await tick();
  const request = fake.messages[0]!;
  if (malformed === 'duplicate-ready') fake.ready();
  else fake.emit('message', { id: request.id, kind: malformed === 'wrong-kind' ? 'userUpdate' : request.kind, ok: true,
    body: JSON.stringify({ id: malformed === 'wrong-user' ? 'other-user' : 'expected-user', label: 'fixture', createdAt: 1, updatedAt: 1 }),
    ...(malformed === 'extra-field' ? { extra: true } : {}) });
  await assert.rejects(work, ConnectorOwnerUnavailable);
  assert.equal(fake.messages.length, 1);
  assert.throws(() => fakeOwner(file, new FakeWorker()), ConnectorOwnerUnavailable);
  const retirement = owner.retireForShutdown(); await tick(); fake.emit('exit', 1); await retirement;
}));

for (const fault of ['start', 'add', 'finish', 'pending'] as const)
test(`Connector ${fault} observation failure cannot block accepted work or cleanup`, () => disk(async file => {
  const diagnostics = { start() {
    if (fault === 'start') throw Error('private diagnostic fault');
    return { add() { if (fault === 'add') throw Error('private diagnostic fault'); },
      finish() { if (fault === 'finish') throw Error('private diagnostic fault'); },
      reportPending() { if (fault === 'pending') throw Error('private diagnostic fault'); } };
  } } as unknown as PerformanceDiagnostics;
  const fake = new FakeWorker(), owner = fakeOwner(file, fake, diagnostics, 1); fake.ready();
  const work = owner.command('interactionCount', {}); await tick();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(owner.snapshot().unavailable, false); fake.reply(0, 0); assert.equal(await work, 0);
  const close = owner.close(); await tick(); fake.reply(1, null); fake.emit('exit', 0); await close;
  assert.equal(owner.snapshot().accepted, 0); assert.equal(owner.snapshot().resultBytes, 0);
}));
