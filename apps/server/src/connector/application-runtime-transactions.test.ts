import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { originalApplicationAuthFixture } from '../auth/application-transaction-test-fixture.js';
import { createApplicationTransactionClient, createApplicationTransactionLink,
  type ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncCodexMessages } from './async-codex-messages.js';
import { AsyncOpenClawMessages } from './async-openclaw-messages.js';
import { AsyncHermesMessages } from './async-hermes-messages.js';

const quiet = new PerformanceDiagnostics(() => {}), key = 'isolated-runtime-application-key';
const token = 'isolated-runtime-connector-token', authorization = `Bearer ${token}`;
const payloadJson = '{"message":"original message","metadata":"original fingerprint"}';
const payloadDigest = createHash('sha256').update(payloadJson).digest('hex');
const session = 's'.repeat(43);
const resources = { codex: 'codex:original', openclaw: 'agent:main:web:direct:original', hermes: 'hermes:original' } as const;
function participants(owner: Pick<AsyncConnectorOwner, 'command'>) {
  let effects = 0, wakes = 0;
  const codex = new AsyncCodexMessages({ owner, ready: () => true, sessionExists: () => true, displayBlocked: () => false,
    admitted: () => { wakes++; }, persist: async () => { effects++; return []; }, diagnostics: quiet });
  const openclaw = new AsyncOpenClawMessages({ owner, defaultAgentId: 'main', ready: () => true, sessionExists: () => true,
    admitted: () => { wakes++; }, persist: async () => { effects++; return []; }, diagnostics: quiet });
  const hermes = new AsyncHermesMessages(owner, () => { wakes++; }, quiet);
  return { codex, openclaw, hermes, effects: () => effects, wakes: () => wakes,
    close: () => Promise.all([codex.close(), openclaw.close(), hermes.close()]) };
}

for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) for (const keyed of [true, false]) {
  test(`${role}/${mode}/${keyed ? 'Key' : 'no-Key'}: original paired runtime chains commit, deduplicate and read durable receipts after restart without replay`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-runtime-pair-')), link = createApplicationTransactionLink();
    const file = join(root, 'connector.sqlite');
    // Seed legacy Hermes data offline; never open beside the actual worker.
    const seed = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    seed.hermesJournal.save({ key: resources.hermes, stored: 'original-native', title: 'Original', started: false, messages: [] }); seed.close();
    const config = { file, tokenFile: join(root, 'tokens.json'), bootstrapToken: token };
    const hub = originalApplicationAuthFixture(root, role, mode, keyed ? key : undefined, quiet, link.auth);
    let owner = new AsyncConnectorOwner(config, quiet, undefined, 30_000, link.connector);
    const messages = participants(owner);
    const evidence: ApplicationTransactionEvidence = keyed ? { accessKey: key } : {};
    const receipts = new Map<string, unknown>();
    try {
      await Promise.all([hub.open(), owner.open()]);
      for (const runtime of ['codex', 'openclaw', 'hermes'] as const) {
        const input = { key: resources[runtime], authorization, commandKey: `message-${runtime}`, payloadJson, application: evidence };
        const accepted = await messages[runtime].sendPhysical(input);
        assert.ok('receipt' in accepted && accepted.receipt?.state === 'accepted' && accepted.admitted);
        assert.equal(accepted.queue.presence, 'present'); receipts.set(runtime, accepted.receipt);
        const duplicate = await messages[runtime].sendPhysical(input);
        assert.ok('receipt' in duplicate && !duplicate.admitted); assert.deepEqual(duplicate.receipt, accepted.receipt);
        assert.deepEqual(await owner.command('turnSessionPage', { runtime, after: '', limit: 64 }), [resources[runtime]]);
      }
      assert.equal(messages.effects(), 2); assert.equal(messages.wakes(), 3);
      await messages.close(); await owner.close();
      owner = new AsyncConnectorOwner(config, quiet); await owner.open();
      for (const runtime of ['codex', 'openclaw', 'hermes'] as const) {
        const input = { key: resources[runtime], authorization, commandKey: `message-${runtime}` };
        const recovered = runtime === 'codex' ? await owner.command('codexMessageReceiptRead', input)
          : runtime === 'openclaw' ? await owner.command('openClawMessageReceiptRead', input) : await owner.command('hermesMessageReceiptRead', input);
        assert.ok('receipt' in recovered); assert.deepEqual(recovered.receipt, receipts.get(runtime));
      }
      assert.equal(messages.effects(), 2); assert.equal(messages.wakes(), 3);
    } finally {
      await messages.close(); await Promise.all([owner.closeForShutdown(), hub.closeForShutdown()]); link.closeUnused();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) for (const runtime of ['codex', 'openclaw', 'hermes'] as const)
  for (const phase of ['claim', 'queue'] as const) {
    test(`${role}/${mode}/${runtime}: original Cookie revoked before ${phase} cannot commit, even though commit has no caller-supplied application proof`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-runtime-revoke-')), link = createApplicationTransactionLink();
      const hub = originalApplicationAuthFixture(root, role, mode, key, quiet, link.auth);
      const client = createApplicationTransactionClient(link.connector.data);
      const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), token);
      const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
      store.hermesJournal.save({ key: resources.hermes, stored: 'original', title: 'Original', started: false, messages: [] });
      let claims = 0, queues = 0;
      const evidence = { cookie: `agentopsdeck_session=${session}` };
      const original = createConnectorOwnerCommands(store, tokens, undefined, undefined, undefined, false, undefined, { async run(binding, write) {
        assert.equal(binding.runtime, runtime); assert.equal(binding.resource, resources[runtime]);
        assert.equal(binding.payloadDigest, payloadDigest); assert.deepEqual(binding.evidence, evidence);
        if (binding.phase === 'claim') claims++; else queues++;
        if (binding.phase === phase) await hub.revokeSession(session);
        return client.run(binding, write);
      } });
      const messages = participants({ command: original });
      try {
        await hub.open();
        await hub.issueSession(session);
        const input = { key: resources[runtime], authorization, commandKey: 'original', payloadJson, application: evidence };
        await assert.rejects(messages[runtime].sendPhysical(input), /application_transaction_unavailable/);
        const scope = JSON.stringify([tokens.authenticateAuthorization(authorization)!.tokenId, resources[runtime]]);
        assert.equal(store.commands.get(scope, 'original')?.state ?? null, phase === 'claim' ? null : 'outcome_unknown');
        assert.deepEqual(store.turns.list(runtime, resources[runtime]), []);
        assert.equal(claims, 1); assert.equal(queues, phase === 'queue' ? 1 : 0);
        assert.equal(messages.wakes(), 0); assert.equal(messages.effects(), phase === 'queue' && runtime !== 'hermes' ? 1 : 0);
      } finally {
        await messages.close(); original.dispose(); store.close(); link.connector.confirmExit(); await hub.closeForShutdown(); link.closeUnused();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

test('runtime application evidence never silently downgrades when no original Auth peer exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-runtime-missing-'));
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), token);
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens), messages = participants({ command });
  try {
    for (const runtime of ['codex', 'openclaw', 'hermes'] as const) {
      await assert.rejects(messages[runtime].sendPhysical({ key: resources[runtime], authorization, commandKey: 'original', payloadJson, application: {} }), /application_transaction_unavailable/);
      assert.deepEqual(store.turns.list(runtime, resources[runtime]), []);
    }
    assert.equal(messages.effects(), 0); assert.equal(messages.wakes(), 0);
  } finally { await messages.close(); command.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
