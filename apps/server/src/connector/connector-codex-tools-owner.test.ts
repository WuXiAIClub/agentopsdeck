import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { codexAdmissionProof } from '../codex/dispatch-admission.js';
import { executeConnectorCodexDispatch } from './connector-codex-dispatch-domain.js';
import { executeConnectorExecutionSettlement } from './connector-execution-settlement-domain.js';
import { createConnectorCodexToolsCommands, validConnectorCodexToolsInput, type CodexToolsRef } from './connector-codex-tools-domain.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'codex-original-tools-'));
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: 'isolated-tools-proof' };
  const tokens = new ConnectorTokenStore(config.tokenFile, config.bootstrapToken);
  const actor = tokens.authenticateAuthorization(`Bearer ${config.bootstrapToken}`)!.tokenId;
  const store = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  const threadId = randomUUID(), sessionKey = `codex:${threadId}`, commandId = 'original-command', connectionId = 'original-connection';
  store.codexExecutions.enrollBoardTools(threadId);
  await store.turns.enqueueAsync('codex', { id: commandId, sessionKey, createdAt: 1, payload: { text: 'private-body', images: [], actorId: actor } });
  const claim = { sessionKey, commandId, connectionId, proof: codexAdmissionProof(store.turns,
    store.turns.list<{ text: string; images: unknown[]; actorId: string }>('codex', sessionKey)),
    preparing: false, blockedGoalInput: false };
  const domain = createConnectorCodexToolsCommands(store, tokens);
  return { directory, config, tokens, actor, store, sessionKey, claim, domain,
    claimOriginal() {
      const claimed = executeConnectorCodexDispatch('codexDispatchClaim', claim, store, tokens); assert.ok(claimed);
      return { sessionKey, commandId, connectionId, proof: claimed.proof };
    },
    close() { domain.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('task-tool domain rejects caller-provided authority before touching the owner', () => {
  // Constructing the authorizer captures its store reference, but invalid wire
  // input must never invoke it or read any execution/queue facts.
  const untouched = new Proxy({}, { get(_, key) {
    if (key === 'executionGrants') return new Proxy({}, { get() { throw Error('authority touched'); } });
    throw Error('owner touched');
  } }) as ConnectorUserStore;
  const domain = createConnectorCodexToolsCommands(untouched);
  const ref: CodexToolsRef = { sessionKey: 'codex:thread', commandId: 'original', connectionId: 'connection', bindingId: randomUUID() };
  for (const name of ['sql', 'actorId', 'authorized', 'grant', 'runtime', 'replay', 'callback']) {
    for (const kind of ['codexToolsCheck', 'codexToolsRelease'] as const) {
      const input = { ...ref, ...(kind === 'codexToolsCheck' ? { runId: 'run' } : {}), [name]: true };
      assert.equal(validConnectorCodexToolsInput(kind, input), false);
      assert.throws(() => domain(kind, input), /unavailable/);
    }
  }
});

for (const refusal of ['revoked', 'maintenance', 'different-command', 'different-connection', 'different-proof'] as const)
  test(`original tools bind rejects ${refusal} without installing a capability`, async () => {
    const f = await fixture();
    try {
      const input = f.claimOriginal();
      if (refusal === 'revoked') f.tokens.revoke(f.actor);
      if (refusal === 'maintenance') f.store.pauseTurnStarts();
      if (refusal === 'different-command') input.commandId = 'replacement';
      if (refusal === 'different-connection') input.connectionId = 'replacement';
      if (refusal === 'different-proof') input.proof.digest = 'a'.repeat(64);
      assert.equal(f.domain('codexToolsBind', input), null);
      assert.equal(f.store.codexExecutions.get(f.sessionKey)?.phase, 'starting');
    } finally { f.close(); }
  });

test('original task capability survives ACK queue deletion but not run/identity substitution or revocation', async () => {
  const f = await fixture();
  try {
    const input = f.claimOriginal(), binding = f.domain('codexToolsBind', input); assert.ok(binding?.enabled);
    assert.equal(f.domain('codexToolsBind', input), null, 'unknown/duplicate binding cannot replay');
    const check = { ...binding.ref, runId: 'original-run' };
    assert.equal(f.domain('codexToolsCheck', check), false, 'starting does not authorize native tools');
    assert.equal(executeConnectorExecutionSettlement('codexExecutionAcknowledge', { sessionKey: f.sessionKey, commandId: input.commandId,
      connectionId: input.connectionId, runId: check.runId }, f.store), true);
    assert.equal(f.store.turns.list('codex', f.sessionKey).length, 0);
    assert.equal(f.domain('codexToolsCheck', check), true);
    for (const name of ['runId', 'sessionKey', 'commandId', 'connectionId', 'bindingId'] as const)
      assert.equal(f.domain('codexToolsCheck', { ...check, [name]: name === 'bindingId' ? randomUUID()
        : name === 'sessionKey' ? 'codex:replacement' : `replacement-${name}` }), false);
    f.tokens.revoke(f.actor);
    assert.equal(f.domain('codexToolsCheck', check), false);
    assert.equal(f.domain('codexToolsRelease', binding.ref), true);
    assert.equal(f.domain('codexToolsRelease', binding.ref), false);
    assert.equal(f.store.codexExecutions.get(f.sessionKey)?.phase, 'running', 'release never unlocks execution');
  } finally { f.close(); }
});

test('sole real worker retains original principal after ACK; restart loses ephemeral tool capability, never execution', async () => {
  const f = await fixture(); f.store.close();
  let worker = new AsyncConnectorOwner(f.config);
  try {
    await worker.open();
    const claimed = await worker.command('codexDispatchClaim', f.claim); assert.ok(claimed);
    const binding = await worker.command('codexToolsBind', { sessionKey: f.sessionKey, commandId: f.claim.commandId,
      connectionId: f.claim.connectionId, proof: claimed.proof }); assert.ok(binding?.enabled);
    const check = { ...binding.ref, runId: 'original-run' };
    assert.equal(await worker.command('codexExecutionAcknowledge', { sessionKey: check.sessionKey, commandId: check.commandId,
      connectionId: check.connectionId, runId: check.runId }), true);
    assert.equal(await worker.command('codexToolsCheck', check), true);
    await worker.close(); worker = new AsyncConnectorOwner(f.config); await worker.open();
    assert.equal(await worker.command('codexToolsCheck', check), false);
    assert.equal(await worker.command('codexToolsRelease', binding.ref), false);
    const fact = await worker.command('codexExecutionRead', { sessionKey: f.sessionKey });
    assert.equal(fact?.phase, 'running'); assert.equal(fact?.runId, check.runId);
  } finally { await worker.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

for (const state of ['accepted', 'outcome_unknown'] as const) test(`task authority denies ${state} deletion without settling the live run`, async () => {
  const f = await fixture();
  try {
    const input = f.claimOriginal(), binding = f.domain('codexToolsBind', input); assert.ok(binding?.enabled);
    const check = { ...binding.ref, runId: 'original-run' };
    assert.equal(executeConnectorExecutionSettlement('codexExecutionAcknowledge', { sessionKey: f.sessionKey, commandId: input.commandId,
      connectionId: input.connectionId, runId: check.runId }, f.store), true);
    const scope = JSON.stringify(['delete', JSON.stringify([f.actor, f.sessionKey])]), deletionId = randomUUID();
    await f.store.commands.claimAsync(scope, deletionId, {});
    if (state === 'accepted') f.store.commands.settle(scope, deletionId, { status: 200, body: { ok: true } });
    assert.equal(f.store.commands.sessionDeletion(f.sessionKey), state);
    assert.equal(f.domain('codexToolsCheck', check), false);
    assert.equal(f.domain('codexToolsRelease', binding.ref), true);
    assert.equal(f.store.codexExecutions.get(f.sessionKey)?.phase, 'running');
  } finally { f.close(); }
});
