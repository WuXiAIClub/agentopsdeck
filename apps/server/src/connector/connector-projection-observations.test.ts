import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { projectClaudeMessage } from '../claude/message-projection.js';
import { projectCopilotMessage } from '../copilot/message-projection.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { SdkCommands } from './sdk-commands.js';
import { mediaResourceId } from '../messages/media-resource.js';
import { connectorProjectionReadKinds, createConnectorOwnerCommands,
  validConnectorOwnerOutput, type ConnectorOwnerCommands } from './connector-owner-domain.js';

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: every audited projection observation preserves SQL, token file and fact head`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-projection-observations-'));
    const tokenFile = join(directory, 'tokens.json'), tokens = new ConnectorTokenStore(tokenFile);
    const token = tokens.create({ label: 'Original reader', scopes: ['messages:read', 'messages:send',
      'models:read', 'sessions:create', 'sessions:read', 'users:read', 'queue:manage', 'media:read'] });
    const authorization = `Bearer ${token.token}`, readerId = token.record.id;
    const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
    const command = createConnectorOwnerCommands(store, tokens, { [runtime]: { model: 'default', modelChoices: ['default'] } });
    try {
      const key = `${runtime}:original`, nativeSessionId = 'original-native', ref = { key, id: 'execution', epoch: 'epoch' };
      const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
      journal.create({ key, nativeSessionId, title: 'Original', createdAt: 1 });
      await store.turns.enqueueAsync(runtime, { id: 'input', sessionKey: key, createdAt: 2,
        payload: { text: 'Input', actorId: readerId } });
      journal.begin(ref, ['input'], store.turns);
      if (runtime === 'ghcp') store.copilotTranscript.append(ref, projectCopilotMessage({ id: 'original-event',
        type: 'assistant.message', timestamp: new Date(5_000).toISOString(), data: { messageId: 'original-message', content: 'Original output' } })!);
      else store.claudeTranscript.append(ref, projectClaudeMessage({ type: 'assistant', uuid: 'original-message', session_id: nativeSessionId,
        parent_tool_use_id: null, message: { role: 'assistant', content: 'Original output' } }, nativeSessionId));
      const user = store.createUser('Original user'), scope = { runtime, key, authorization };
      store.tokenUsage.record(runtime, key, 'original-usage', { inputTokens: 12, outputTokens: 3 }, 'default', 10);
      const range = { from: 0, to: 120_000, bucketMs: 60_000 }, requestId = randomUUID();
      const receipt = await command('sdkUsageSnapshotCreate', { ...scope, ...range, requestId });
      assert.ok(!('error' in receipt));
      const history = await command('sdkHistoryPage', { ...scope, limit: 20 });
      assert.ok(!('error' in history));
      assert.equal(history.body.messages.length, 2, 'original queued user input and native assistant output are both retained');
      assert.ok(history.body.messages.some(message => message.text === 'Original output'));
      store.hermesJournal.save({ key: 'hermes:original', stored: 'original', title: 'Original', started: false, messages: [] });
      const hermesIdentity = store.hermesJournal.readIdentity('hermes:original')!;
      const openClawKey = 'agent:main:dashboard:original';
      assert.equal(store.openClawExecutions.begin(openClawKey, 'original-command'), true);
      const codexKey = 'codex:original';
      assert.equal(store.codexExecutions.begin(codexKey, 'original-command', 'original-connection'), true);
      const planKey = 'codex:plan-observation';
      await store.turns.enqueueAsync('codex', { id: 'plan-input', sessionKey: planKey, createdAt: 1,
        payload: { text: 'x'.repeat(70_000), images: [], actorId: readerId } });
      const plan = await command('codexQueuePlan', { sessionKey: planKey });
      assert.ok(plan?.state === 'ready');
      const codexReceipt = await command('codexPublicUsageSnapshotCreate', {
        runtime: 'codex', key: codexKey, authorization, ...range, requestId });
      assert.ok(!('error' in codexReceipt));
      const sdk = new SdkCommands({ runtime, store, journal, driver: { wake: async () => {}, interrupt: async () => 'accepted' },
        assertAvailable() {}, authorize: () => true, changed() {}, models: { model: 'default' } });
      const admitted = sdk.send(key, '', { actorId: readerId, accept: () => () => {} },
        [{ name: 'test.txt', mimeType: 'text/plain', data: Buffer.from('original').toString('base64') }]);
      const mediaInput = { authorization, key, messageId: admitted.idempotencyKey, resourceId: mediaResourceId(admitted.media![0]!.url), approval: false };
      const cases = {
        sessionMediaObserve: mediaInput,
        sessionMediaChunk: { ...mediaInput, expected: { readerId, nativeSessionId }, offset: 0, size: 8 },
        updateOperatorCheck: { authorization, expectedNode: '', protocol: '', originPresent: false, mode: 'status' },
        updateReceiptInspect: { scope: JSON.stringify(['maintenance', JSON.stringify([store.nodeId, readerId, 'pause'])]), key: 'missing' },
        codexFilesPage: { runtime: 'codex', key: codexKey, authorization },
        codexFilesDeliver: { runtime: 'codex', key: codexKey, authorization, readerId, generation: null },
        codexPublicUsageRange: { runtime: 'codex', key: codexKey, authorization, ...range },
        codexPublicUsageExport: { runtime: 'codex', key: codexKey, authorization, ...range },
        codexPublicUsageSnapshotRead: { runtime: 'codex', key: codexKey, authorization, requestId },
        codexPublicUsageDeliver: { runtime: 'codex', key: codexKey, authorization, readerId },
        codexToolsRelease: { sessionKey: codexKey, commandId: 'original-command', connectionId: 'original-connection', bindingId: randomUUID() },
        codexQueuePlanChunk: { sessionKey: planKey, planId: plan.planId, offset: 0 },
        codexQueuePlanRelease: { sessionKey: planKey, planId: plan.planId },
        codexExecutionRead: { sessionKey: codexKey },
        codexHistoryObservation: { sessionKey: codexKey },
        codexMaintenanceObservation: {},
        codexSchedulingObservation: { sessionKey: codexKey },
        codexSchedulingRecheck: { sessionKey: codexKey, executionRevision: null, headId: 'not-admitted', headVersion: '1:0' },
        codexReadAuthorize: { key: codexKey, authorization },
        codexReadDeliver: { key: codexKey, authorization, readerId },
        openClawRecoveryCandidate: { sessionKey: 'agent:main:original', connectionId: null },
        openClawExecutionRead: { sessionKey: openClawKey },
        openClawReadAuthorize: { key: openClawKey, authorization },
        openClawReadDeliver: { key: openClawKey, authorization, readerId },
        executionSessionPage: { runtime: 'openclaw', after: '', limit: 64 },
        executionFactBatch: { runtime: 'codex', keys: [codexKey] },
        hermesReadAuthorize: { key: 'hermes:original', authorization },
        hermesReadDeliver: { key: 'hermes:original', authorization, readerId, ...hermesIdentity },
        hermesLifecyclePage: { after: '', limit: 64 }, hermesLifecycleRead: { key: 'hermes:original' },
        hermesLifecycleHistoryPage: { key: 'hermes:original', digest: store.hermesJournal.lifecycleSnapshot('hermes:original').digest, offset: 0, limit: 64 },
        hermesLifecycleHistoryPart: { key: 'hermes:original', digest: store.hermesJournal.lifecycleSnapshot('hermes:original').digest, index: 0, offset: 0 },
        eventReplay: { after: null }, sdkSessionPage: { runtime, after: '', limit: 20 },
        sdkLifecycleRead: { runtime, key, history: true },
        tokenAuthenticate: { authorization }, tokenHasScope: { tokenId: readerId, scope: 'messages:read' },
        tokenDelegationHub: { tokenId: readerId }, tokensList: {},
        authorizedUsersList: { authorization }, authorizedUserGet: { authorization, id: user.id },
        authorizedUsersPermission: { authorization, scope: 'users:read' },
        runtimeMaintenanceObserve: { historyRecovery: false }, runtimeMaintenanceHistory: {},
        runtimeMaintenanceSdkSession: { runtime, key }, runtimeMaintenancePreservation: { key, codex: false },
        sdkStateRead: { ...scope, connected: true }, sdkModelsRead: { runtime, authorization },
        sdkModelsDeliver: { runtime, authorization, readerId },
        sdkHistoryPage: { ...scope, limit: 20 }, sdkHistoryMessage: { ...scope, messageId: history.body.messages[0]!.id },
        sdkHistoryDeliver: { ...scope, readerId, nativeSessionId },
        sdkQueuePage: { ...scope, after: 0 }, sdkQueueCommandPage: { ...scope, after: 0 },
        nativeQueuePage: { runtime: 'codex', key: codexKey, authorization, after: 0 },
        nativeQueueCommandPage: { runtime: 'codex', key: codexKey, authorization, after: 0 },
        nativeQueueReceiptRead: { runtime: 'codex', key: codexKey, authorization,
          target: { messageId: 'not-submitted' }, mutationKey: 'not-submitted' },
        hermesQueuePage: { runtime: 'hermes', key: 'hermes:original', authorization, after: 0 },
        hermesQueueCommandPage: { runtime: 'hermes', key: 'hermes:original', authorization, after: 0 },
        sdkLocalReceiptRead: { runtime, authorization, commandKey: 'not-submitted', operation: 'create' },
        sdkMessageReceiptRead: { ...scope, commandKey: 'not-submitted' },
        sdkMessageSendReceiptRead: { ...scope, commandKey: 'not-submitted' },
        openClawMessageReceiptRead: { key: openClawKey, authorization, commandKey: 'not-submitted' },
        openClawMessageSendReceiptRead: { key: openClawKey, authorization, commandKey: 'not-submitted' },
        sdkSnapshotRead: { runtime, key }, sdkPendingCount: { runtime },
        sdkUsageRange: { ...scope, ...range }, sdkUsageExport: { ...scope, ...range },
        sdkUsageSnapshotRead: { ...scope, requestId }, sdkDeletionReceiptRead: { ...scope, commandKey: 'not-submitted' },
        fileSessionObserve: { sessionKey: key },
      } satisfies { [K in typeof connectorProjectionReadKinds[number]]: ConnectorOwnerCommands[K]['input'] };
      assert.equal(Object.isFrozen(connectorProjectionReadKinds), true);
      assert.equal(connectorProjectionReadKinds.length, 71);
      assert.equal(new Set(connectorProjectionReadKinds).size, 71);
      // Inspect the original connection only, not a second writer. This is a
      // test guard against a formerly pure domain growing an incidental write.
      const db = (store as unknown as { db: DatabaseSync }).db;
      const sql = () => ({ changes: db.prepare('SELECT total_changes() AS n').get(), schema: db.prepare('PRAGMA schema_version').get() });
      const head = await command('eventProjectionHead', {}), beforeSql = sql(), beforeToken = readFileSync(tokenFile, 'utf8');
      // Preservation is a pure observation only under the original exclusive
      // runtime pause. Keep its production ownership barrier in this fixture.
      store.pauseTurnStarts();
      for (const kind of connectorProjectionReadKinds) {
        const result = await command(kind, cases[kind]);
        assert.equal(validConnectorOwnerOutput(kind, result), true, kind);
        assert.ok(!(result && typeof result === 'object' && 'error' in result), kind);
        assert.deepEqual(sql(), beforeSql, `${kind} must not write`);
        assert.equal(readFileSync(tokenFile, 'utf8'), beforeToken, `${kind} must not persist credentials`);
        assert.deepEqual(await command('eventProjectionHead', {}), head, `${kind} must not force projection refresh`);
      }
      const revoked = await command('tokenRevoke', { tokenId: readerId }); assert.equal(revoked, true);
      const revokedHead = await command('eventProjectionHead', {}); assert.notEqual(revokedHead.version, head.version);
      assert.equal(await command('tokenAuthenticate', { authorization }), null);
      assert.deepEqual(await command('sdkHistoryDeliver', { ...scope, readerId, nativeSessionId }), { error: 401 });
      assert.deepEqual(await command('sdkModelsDeliver', { runtime, authorization, readerId }), { error: 401 });
      assert.deepEqual(await command('sdkUsageSnapshotRead', { ...scope, requestId }), { error: 401 });
      assert.deepEqual(await command('eventProjectionHead', {}), revokedHead, 'denied reads never acquire write authority');
    } finally { command.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
