import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { originalApplicationAuthFixture } from '../auth/application-transaction-test-fixture.js';
import { createApplicationTransactionClient, createApplicationTransactionLink } from '../auth/application-transaction-gate.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {}), key = 'isolated-original-key';
const bootstrapToken = 'isolated-connector-token', authorization = `Bearer ${bootstrapToken}`;
const catalogs = { 'claude-code': { model: 'default' }, ghcp: { model: 'default' } };
const session = 's'.repeat(43);
function authConfig(root: string, mode: 'json' | 'sqlite', keyed = true) {
  return { file: join(root, 'hub.sqlite'), ...(keyed ? { administratorKey: key } : {}),
    auth: mode === 'json' ? { kind: 'json' as const, passkeysFile: join(root, 'passkeys.json'), sessionsFile: join(root, 'sessions.json') }
      : { file: join(root, 'auth.sqlite'), legacyFiles: [] } };
}
function payload() { return JSON.stringify({ message: 'original message', media: [{ name: 'input.txt', mimeType: 'text/plain',
  size: 5, dataUrl: 'data:text/plain;base64,aGVsbG8=' }] }); }

for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) for (const keyed of [true, false]) {
  test(`${role}/${mode}/${keyed ? 'Key' : 'no-Key'}: paired original workers commit SDK receipt/queue/attachment and recover without replay`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-paired-message-')), link = createApplicationTransactionLink();
    const hub = originalApplicationAuthFixture(root, role, mode, keyed ? key : undefined, quiet, link.auth);
    const config = { file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'), bootstrapToken, sdkModels: catalogs };
    let connector = new AsyncConnectorOwner(config, quiet, undefined, 30_000, link.connector);
    try {
      await Promise.all([hub.open(), connector.open()]);
      for (const runtime of ['claude-code', 'ghcp'] as const) {
        const created = await connector.command('sdkSessionCreate', { runtime, authorization, commandKey: `create-${runtime}`, payloadJson: '{}' });
        assert.ok('receipt' in created && created.receipt.state === 'accepted' && created.key);
        const input = { runtime, authorization, key: created.key, commandKey: `message-${runtime}`, payloadJson: payload(),
          application: keyed ? { accessKey: key } : {} };
        const accepted = await connector.command('sdkMessageSend', input);
        assert.ok('receipt' in accepted && accepted.receipt?.state === 'accepted' && accepted.admitted);
        assert.equal(accepted.queue.presence, 'present'); assert.equal((accepted.receipt.result!.body.media as unknown[]).length, 1);
        const duplicate = await connector.command('sdkMessageSend', input);
        assert.ok('receipt' in duplicate && !duplicate.admitted); assert.deepEqual(duplicate.receipt, accepted.receipt);
        assert.deepEqual(await connector.command('turnSessionPage', { runtime, after: '', limit: 64 }), [created.key]);
        const { payloadJson: _payload, application: _application, ...read } = input;
        assert.deepEqual((await connector.command('sdkMessageReceiptRead', read) as { receipt: unknown }).receipt, accepted.receipt);
      }
      await connector.close();
      // Restart ONLY after the actual original exit, without any application
      // evidence or replay: the durable original receipt remains sufficient.
      connector = new AsyncConnectorOwner(config, quiet); await connector.open();
      for (const runtime of ['claude-code', 'ghcp'] as const) {
        const sessions = await connector.command('turnSessionPage', { runtime, after: '', limit: 64 });
        assert.equal(sessions.length, 1);
        const read = await connector.command('sdkMessageReceiptRead', { runtime, authorization, key: sessions[0]!, commandKey: `message-${runtime}` });
        assert.ok('receipt' in read && read.receipt?.state === 'accepted');
      }
    } finally {
      await Promise.all([connector.closeForShutdown(), hub.closeForShutdown()]); link.closeUnused();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) for (const phase of ['claim', 'queue'] as const) {
  test(`${role}/${mode}: original session revoked before ${phase} cannot commit a queued SDK effect`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-paired-revoke-')), link = createApplicationTransactionLink();
    const hub = originalApplicationAuthFixture(root, role, mode, key, quiet, link.auth);
    const client = createApplicationTransactionClient(link.connector.data);
    const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), bootstrapToken);
    const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
    let claims = 0, queues = 0;
    try {
      await hub.open();
      await hub.issueSession(session);
      const original = createConnectorOwnerCommands(store, tokens, catalogs, undefined, undefined, false, undefined, { async run(binding, write) {
        if (binding.phase === 'claim') claims++; else queues++;
        if (binding.phase === phase) await hub.revokeSession(session);
        return client.run(binding, write);
      } });
      const runtime = 'ghcp', resource = 'ghcp:original';
      store.copilotJournal.create({ key: resource, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
      const input = { runtime, key: resource, authorization, commandKey: 'original', payloadJson: payload(), application: { cookie: `agentopsdeck_session=${session}` } } as const;
      await assert.rejects(original('sdkMessageSend', input), /application_transaction_unavailable/);
      const read = await original('sdkMessageReceiptRead', { runtime, key: resource, authorization, commandKey: 'original' });
      assert.ok('receipt' in read);
      assert.equal(read.receipt?.state ?? null, phase === 'claim' ? null : 'outcome_unknown');
      assert.equal(store.turns.maintenanceCount(), 0);
      assert.equal(claims, 1); assert.equal(queues, phase === 'queue' ? 1 : 0);
      assert.deepEqual(await original('turnSessionPage', { runtime, after: '', limit: 64 }), []);
    } finally {
      link.connector.confirmExit(); store.close(); await hub.closeForShutdown(); link.closeUnused();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('application evidence cannot degrade to machine-only admission when the original Auth peer is absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-paired-missing-'));
  const connector = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'), bootstrapToken, sdkModels: catalogs }, quiet);
  try {
    await connector.open();
    const created = await connector.command('sdkSessionCreate', { runtime: 'ghcp', authorization, commandKey: 'create', payloadJson: '{}' });
    assert.ok('key' in created && created.key);
    await assert.rejects(connector.command('sdkMessageSend', { runtime: 'ghcp', key: created.key, authorization,
      commandKey: 'original', payloadJson: payload(), application: {} }));
    assert.deepEqual(await connector.command('turnSessionPage', { runtime: 'ghcp', after: '', limit: 64 }), []);
  } finally { await connector.closeForShutdown(); rmSync(root, { recursive: true, force: true }); }
});

test('original Auth worker exit cannot release files for a replacement while its paired Connector still lives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-paired-retirement-')), link = createApplicationTransactionLink();
  const config = authConfig(root, 'sqlite');
  const hub = new AsyncHubMemberOwner(config, quiet, undefined, 30_000, link.auth);
  const connector = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite') }, quiet, undefined, 30_000, link.connector);
  let replacement: AsyncHubMemberOwner | undefined;
  try {
    await Promise.all([hub.open(), connector.open()]);
    await hub.close();
    assert.throws(() => new AsyncHubMemberOwner(config, quiet));
    await connector.close(); // actual exit, not a close request or timer
    replacement = new AsyncHubMemberOwner(config, quiet); await replacement.open();
  } finally {
    await Promise.all([connector.closeForShutdown(), hub.closeForShutdown(), replacement?.closeForShutdown()]);
    link.closeUnused(); rmSync(root, { recursive: true, force: true });
  }
});

test('failed Connector construction proves no peer writer exists and does not strand paired Auth reservations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-paired-unstarted-')), link = createApplicationTransactionLink();
  const config = authConfig(root, 'sqlite');
  const hub = new AsyncHubMemberOwner(config, quiet, undefined, 30_000, link.auth);
  let replacement: AsyncHubMemberOwner | undefined;
  try {
    await hub.open();
    assert.throws(() => new AsyncConnectorOwner({ file: '' }, quiet, undefined, 30_000, link.connector));
    await hub.close();
    replacement = new AsyncHubMemberOwner(config, quiet); await replacement.open();
  } finally {
    await Promise.all([hub.closeForShutdown(), replacement?.closeForShutdown()]);
    link.closeUnused(); rmSync(root, { recursive: true, force: true });
  }
});
