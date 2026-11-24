import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChatMessage } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { validConnectorSdkStatusInput, validConnectorSdkStatusOutput } from './connector-sdk-status-domain.js';
import type { SdkAgentId } from './sdk-execution-journal.js';

const token = 'isolated-status-domain', authorization = `Bearer ${token}`;
function fixture(runtime: SdkAgentId) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-status-domain-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token);
  const actor = tokens.authenticateAuthorization(authorization)!;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal, key = `${runtime}:original`;
  journal.create({ key, nativeSessionId: 'original-native', title: 'Original', createdAt: 1 });
  const command = createConnectorOwnerCommands(store, tokens);
  const scope = { runtime, key, authorization, commandKey: 'status' };
  const input = { ...scope, payloadJson: JSON.stringify({ message: ' /status ', metadata: 'fingerprint' }),
    display: { connected: true, gateway: 'connected', session: { model: 'original-model', totalTokens: 123 } } };
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { store, tokens, actor, command, scope, input, journal, key, db,
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: status atomically commits original report; duplicate and reads ignore changed projection`, async () => {
    const f = fixture(runtime);
    try {
      const result = await f.command('sdkMessageStatus', f.input);
      assert.ok('receipt' in result && result.receipt?.state === 'accepted' && result.report);
      assert.match(result.report[1].text, /original-model/); assert.match(result.report[1].text, /123/);
      assert.equal(result.report[0].text, '/status');
      assert.equal(result.report[0].id, result.receipt.id);
      assert.equal(result.report[1].id, `local-status:${result.receipt.id}`);
      const before = f.journal.readSnapshot(f.key);
      f.store.pauseTurnStarts();
      const changed = { ...f.input, display: { ...f.input.display, connected: false, session: { model: 'changed' } } };
      assert.deepEqual(await f.command('sdkMessageStatus', changed), result);
      assert.deepEqual(await f.command('sdkMessageStatusRead', f.scope), result);
      assert.deepEqual(f.journal.readSnapshot(f.key), before);
      assert.equal(f.store.turns.list(runtime, f.key).length, 0);
      assert.deepEqual(await f.command('sdkMessageStatus', { ...f.input, payloadJson: '{"message":"/status","metadata":"changed"}' }), { error: 409 });
      const other = f.tokens.create({ label: 'other', scopes: ['messages:send', 'messages:read'] });
      const isolated = await f.command('sdkMessageStatusRead', { ...f.scope, authorization: `Bearer ${other.token}` });
      assert.ok('receipt' in isolated && isolated.receipt === null && isolated.report === null);
      f.tokens.revoke(f.actor.tokenId);
      assert.deepEqual(await f.command('sdkMessageStatusRead', f.scope), { error: 401 });
    } finally { f.close(); }
  });

  test(`${runtime}: status requires both original scopes, rejects delegated authority and never creates a receipt on denial`, async () => {
    const f = fixture(runtime);
    try {
      for (const scopes of [['messages:send'], ['messages:read'], ['messages:send', 'messages:read', 'execution:delegate']] as const) {
        const actor = f.tokens.create({ label: 'limited', scopes: [...scopes] });
        const input = { ...f.input, authorization: `Bearer ${actor.token}` };
        assert.deepEqual(await f.command('sdkMessageStatus', input), { error: 403 });
        assert.deepEqual(await f.command('sdkMessageStatusRead', { ...f.scope, authorization: input.authorization }), { error: 403 });
      }
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM command_receipts').get()!.n, 0);
    } finally { f.close(); }
  });

  test(`${runtime}: status settlement failure rolls back original metadata and final receipt`, async () => {
    const f = fixture(runtime);
    try {
      f.db.exec(`CREATE TRIGGER fail_status BEFORE UPDATE OF state ON command_receipts
        BEGIN SELECT RAISE(ABORT, 'isolated status failure'); END`);
      await assert.rejects(f.command('sdkMessageStatus', f.input), /isolated status failure/);
      const read = await f.command('sdkMessageStatusRead', f.scope);
      assert.ok('receipt' in read && read.receipt === null && read.report === null);
      assert.equal(f.journal.current(f.key), undefined);
      assert.equal(f.db.isTransaction, false);
    } finally { f.close(); }
  });

  test(`${runtime}: unknown original receipt is not recomputed or promoted by status`, async () => {
    const f = fixture(runtime);
    try {
      const original = f.store.commands.claim(JSON.stringify([f.actor.tokenId, f.key]), f.scope.commandKey, JSON.parse(f.input.payloadJson));
      const result = await f.command('sdkMessageStatus', f.input);
      assert.ok('receipt' in result && result.report === null);
      assert.deepEqual(result.receipt, original.receipt);
    } finally { f.close(); }
  });

  for (const payload of [{ message: 'ordinary' }, { message: '/status', deliveryMode: 'mirror' }, { message: '/status', media: [{ url: 'file:///private' }] }])
  test(`${runtime}: invalid status payload is atomically rejected without execution`, async () => {
    const f = fixture(runtime);
    try {
      const result = await f.command('sdkMessageStatus', { ...f.input, payloadJson: JSON.stringify(payload) });
      assert.ok('receipt' in result && result.receipt?.state === 'rejected' && result.report === null);
      assert.equal(f.journal.current(f.key), undefined);
    } finally { f.close(); }
  });
}

test('status fixed command schema denies forged authority/display and substituted report binding', async () => {
  const f = fixture('ghcp');
  try {
    for (const change of [{ actorId: 'forged' }, { rejectFresh: 'runtime_unavailable' },
      { display: { ...f.input.display, session: { status: 'idle' } } },
      { display: { ...f.input.display, session: { totalTokens: -1 } } },
      { display: { ...f.input.display, connected: 'true' } }])
      assert.equal(validConnectorSdkStatusInput('sdkMessageStatus', { ...f.input, ...change }), false);
    const result = await f.command('sdkMessageStatus', f.input);
    assert.ok('report' in result && result.report);
    for (const field of ['id', 'sessionKey', 'role'] as const) {
      const report: [ChatMessage, ChatMessage] = structuredClone(result.report); report[0] = { ...report[0], [field]: 'substituted' };
      assert.equal(validConnectorSdkStatusOutput('sdkMessageStatus', { ...result, report }), false);
    }
    assert.equal(validConnectorSdkStatusOutput('sdkMessageStatus', { ...result, extra: 'sql' }), false);
  } finally { f.close(); }
});
