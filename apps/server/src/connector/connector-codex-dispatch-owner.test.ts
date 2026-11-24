import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { codexAdmissionProof } from '../codex/dispatch-admission.js';
import { describeBatch } from '../codex/queued-batch.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { connectorCodexDispatchSteps, executeConnectorCodexDispatch, validConnectorCodexDispatchInput,
  type ConnectorCodexDispatchCommands } from './connector-codex-dispatch-domain.js';

const key = 'codex:worker-admission', connectionId = 'original-connection', token = 'synthetic-isolated-codex-dispatch';
type Payload = { text: string; images: unknown[]; actorId: string };
type Claim = ConnectorCodexDispatchCommands['codexDispatchClaim']['input'];
async function seed(store: ConnectorUserStore, actorId: string): Promise<Claim> {
  for (const id of ['first', 'second']) await store.turns.enqueueAsync('codex', { id, sessionKey: key, createdAt: 1,
    payload: { text: `private-message-${id}`, images: [], actorId } });
  const entries = store.turns.list<Payload>('codex', key);
  const batch = describeBatch(entries); assert.ok(batch);
  return { sessionKey: key, commandId: 'first', connectionId, proof: codexAdmissionProof(store.turns, entries),
    batch, preparing: false, blockedGoalInput: false };
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'codex-dispatch-domain-'));
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: token };
  const tokens = new ConnectorTokenStore(config.tokenFile, token);
  const actor = tokens.authenticateAuthorization(`Bearer ${token}`)!.tokenId;
  const store = new ConnectorUserStore(config.file, id => !!tokens.delegationHubId(id), { runtimeOwner: true });
  const claim = await seed(store, actor);
  return { directory, config, tokens, actor, store, claim,
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('Codex dispatch protocol is fixed, bounded and refuses caller authority/SQL before touching owner', () => {
  assert.deepEqual(Object.values(connectorCodexDispatchSteps), [215, 216, 221, 244, 245, 366, 367, 368]);
  const claim: Claim = { sessionKey: key, commandId: 'first', connectionId, proof: { count: 2, digest: 'a'.repeat(64) },
    preparing: false, blockedGoalInput: false };
  const { preparing: _, blockedGoalInput: __, ...ready } = claim;
  const owner = new Proxy({}, { get() { throw Error('Owner must not be touched'); } }) as ConnectorUserStore;
  for (const kind of ['codexDispatchClaim', 'codexDispatchReady'] as const) {
    const input = kind === 'codexDispatchClaim' ? claim : ready;
    assert.equal(validConnectorCodexDispatchInput(kind, input), true);
    for (const extra of ['sql', 'callback', 'actorId', 'authorized', 'members', 'release', 'replay']) {
      const forged = { ...input, [extra]: true };
      assert.equal(validConnectorCodexDispatchInput(kind, forged), false);
      assert.throws(() => executeConnectorCodexDispatch(kind, forged, owner), /unavailable/);
    }
    for (const proof of [{ count: 0, digest: 'a'.repeat(64) }, { count: 17, digest: 'a'.repeat(64) },
      { count: 1, digest: 'invalid' }, { ...ready.proof, authorized: true }]) {
      assert.equal(validConnectorCodexDispatchInput(kind, { ...input, proof }), false);
    }
  }
  assert.equal(validConnectorCodexDispatchInput('codexDispatchClaim', { ...claim, preparing: true,
    context: { hash: 'a'.repeat(64), originalLength: 1 } }), false);
  for (const predecessor of [null, { commandId: 'old', connectionId, revision: 1 }]) {
    assert.equal(validConnectorCodexDispatchInput('codexDispatchClaim', { ...claim, predecessor }), true);
    assert.equal(validConnectorCodexDispatchInput('codexDispatchReady', { ...ready, predecessor }), false);
  }
  for (const predecessor of [false, {}, [], { commandId: 'old', connectionId, revision: 0 },
    { commandId: 'old', connectionId, revision: 1.5 }, { commandId: 'old', connectionId: '', revision: 1 },
    { commandId: 'old', connectionId, revision: 1, authorized: true }]) {
    const forged = { ...claim, predecessor };
    assert.equal(validConnectorCodexDispatchInput('codexDispatchClaim', forged), false);
    assert.throws(() => executeConnectorCodexDispatch('codexDispatchClaim', forged as any, owner), /unavailable/);
  }
});

test('failure protocol is exact and cannot carry actor truth, replay or SQL', () => {
  const input: ConnectorCodexDispatchCommands['codexDispatchFailure']['input'] = { sessionKey: key, commandId: 'first',
    expected: null, proof: { count: 2, digest: 'a'.repeat(64) }, failure: 'authorization' };
  assert.ok(validConnectorCodexDispatchInput('codexDispatchFailure', input));
  assert.ok(validConnectorCodexDispatchInput('codexDispatchFailure', { ...input, failure: 'compaction_authorization' }));
  for (const forged of [{ ...input, failure: 'retry' }, { ...input, expected: {} },
    { ...input, expected: { commandId: 'first', connectionId, revision: 0 } },
    ...['actorId', 'authorized', 'release', 'replay', 'sql', 'callback'].map(field => ({ ...input, [field]: true }))]) {
    assert.equal(validConnectorCodexDispatchInput('codexDispatchFailure', forged), false);
    const owner = new Proxy({}, { get() { throw Error('Must not touch owner'); } }) as ConnectorUserStore;
    assert.throws(() => executeConnectorCodexDispatch('codexDispatchFailure', forged as any, owner), /unavailable/);
  }
});

test('worker failure domain rechecks current authority inside the original transaction', async () => {
  const f = await fixture();
  try {
    const failure = { sessionKey: key, commandId: 'first', expected: null, proof: f.claim.proof, failure: 'authorization' as const };
    assert.equal(executeConnectorCodexDispatch('codexDispatchFailure', failure, f.store, f.tokens), null,
      'caller cannot claim authorization failed while original issuer remains permitted');
    assert.deepEqual(f.store.turns.list('codex', key).map(row => row.state), ['queued', 'queued']);
    f.tokens.revoke(f.actor);
    assert.equal(executeConnectorCodexDispatch('codexDispatchFailure', failure, f.store, f.tokens), 'blocked');
    assert.equal(f.store.codexExecutions.get(key), undefined);
    assert.deepEqual(f.store.turns.list('codex', key).map(row => row.state), ['blocked', 'blocked']);
  } finally { f.close(); }
});

test('real worker failure commits all queue members and execution; reopen preserves unknown without replay', async () => {
  const f = await fixture(), rows: any[] = [];
  f.store.close();
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  let worker = new AsyncConnectorOwner(f.config, diagnostics);
  try {
    await worker.open();
    const claimed = await worker.command('codexDispatchClaim', f.claim); assert.ok(claimed);
    const expected = { commandId: claimed.execution.commandId, connectionId, revision: claimed.execution.revision };
    const failure = { sessionKey: key, commandId: 'first', expected, proof: claimed.proof, failure: 'unknown' as const };
    assert.equal(await worker.command('codexDispatchFailure', { ...failure, expected: { ...expected, connectionId: 'replacement' } }), null);
    assert.equal(await worker.command('codexDispatchFailure', failure), 'outcome_unknown');
    assert.equal(await worker.command('codexDispatchFailure', failure), null);
    assert.equal(await worker.command('codexDispatchClaim', f.claim), null);
    await worker.close();
    worker = new AsyncConnectorOwner(f.config, diagnostics); await worker.open();
    assert.equal(await worker.command('codexDispatchFailure', failure), null);
    assert.equal(await worker.command('turnMaintenanceCount', { runtime: 'codex' }), 2);
    assert.equal(await worker.command('codexDispatchClaim', f.claim), null);
    await worker.close();
    const reopened = new ConnectorUserStore(f.config.file);
    try {
      assert.deepEqual(reopened.turns.list('codex', key).map(row => row.state), ['outcome_unknown', 'outcome_unknown']);
      assert.equal(reopened.codexExecutions.get(key)?.reason, 'send_unknown');
    } finally { reopened.close(); }
    assert.ok(rows.some(row => row.step === 221));
    assert.doesNotMatch(JSON.stringify(rows), /private-message|original-connection|worker-admission|synthetic-isolated/);
  } finally { await worker.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('real worker late ACK cannot be rolled back by an old dispatch failure receipt', async () => {
  const f = await fixture(); f.store.close();
  const worker = new AsyncConnectorOwner(f.config);
  try {
    await worker.open();
    const claimed = await worker.command('codexDispatchClaim', f.claim); assert.ok(claimed);
    const expected = { commandId: claimed.execution.commandId, connectionId, revision: claimed.execution.revision };
    assert.equal(await worker.command('codexExecutionAcknowledge', { sessionKey: key, commandId: 'first', connectionId, runId: 'late-ack-run' }), true);
    assert.equal(await worker.command('codexDispatchFailure', { sessionKey: key, commandId: 'first', expected,
      proof: claimed.proof, failure: 'unknown' }), null);
    assert.equal(await worker.command('turnMaintenanceCount', { runtime: 'codex' }), 0);
  } finally { await worker.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

for (const refusal of ['revoked', 'maintenance', 'stale-edit'] as const) {
  test(`worker business domain refuses current ${refusal} atomically without claiming queue`, async () => {
    const f = await fixture();
    try {
      if (refusal === 'revoked') f.tokens.revoke(f.actor);
      else if (refusal === 'maintenance') f.store.pauseTurnStarts();
      else f.store.turns.edit<Payload>('codex', key, 'second', payload => ({ ...payload, text: 'edited' }));
      const before = f.store.turns.list('codex', key), cursor = f.store.events.latestEventId();
      assert.equal(executeConnectorCodexDispatch('codexDispatchClaim', f.claim, f.store, f.tokens), null);
      assert.deepEqual(f.store.turns.list('codex', key), before);
      assert.equal(f.store.codexExecutions.get(key), undefined);
      assert.equal(f.store.events.latestEventId(), cursor);
    } finally { f.close(); }
  });
}

test('Codex preparation continuation keeps original claim; last-effect guard rechecks current authority', async () => {
  const f = await fixture();
  try {
    const first = executeConnectorCodexDispatch('codexDispatchClaim', { ...f.claim, preparing: true }, f.store, f.tokens)!;
    const ref = { sessionKey: key, commandId: 'first', connectionId, proof: first.proof };
    assert.equal(executeConnectorCodexDispatch('codexDispatchReady', ref, f.store, f.tokens), false);
    assert.equal(f.store.codexExecutions.finishPreparation(first.execution), true);
    const started = executeConnectorCodexDispatch('codexDispatchClaim', { ...f.claim, proof: first.proof }, f.store, f.tokens)!;
    assert.deepEqual(started.proof, first.proof);
    assert.equal(executeConnectorCodexDispatch('codexDispatchReady', ref, f.store, f.tokens), true);
    assert.equal(executeConnectorCodexDispatch('codexDispatchReady', { ...ref, proof: f.claim.proof }, f.store, f.tokens), false);
    const resume = f.store.pauseTurnStarts();
    assert.equal(executeConnectorCodexDispatch('codexDispatchReady', ref, f.store, f.tokens), false);
    resume(); f.tokens.revoke(f.actor);
    assert.equal(executeConnectorCodexDispatch('codexDispatchReady', ref, f.store, f.tokens), false);
    assert.deepEqual(f.store.turns.list('codex', key).map(row => row.state), ['dispatching', 'dispatching']);
    assert.equal(f.store.codexExecutions.get(key)?.phase, 'starting');
  } finally { f.close(); }
});

for (const compact of [false, true]) test(`preparation claim requires original delegated compact authority: ${compact}`, async () => {
  const f = await fixture();
  try {
    const issuer = f.tokens.create({ label: 'isolated-issuer', scopes: ['messages:send', 'execution:delegate'], delegationHubId: 'hub' });
    const grant = f.store.executionGrants.issue({ principalId: 'member', grantKey: 'policy', version: 1,
      runtime: 'codex', sessionKey: key, issuerTokenId: issuer.record.id, hubId: 'hub' },
      compact ? ['messages:send', 'runs:compact'] : ['messages:send'], Date.now() + 30_000);
    // A native batch must have one principal; a mixed-principal fixture would
    // fail before compact scope is considered and could mask a missing guard.
    for (const id of ['first', 'second']) f.store.turns.edit('codex', key, id, () => ({ text: 'private', images: [], actorId: grant.actorId,
      executionGrant: { ...grant, issuerTokenId: issuer.record.id } }));
    const entries = f.store.turns.list<Payload>('codex', key);
    const claim = { ...f.claim, proof: codexAdmissionProof(f.store.turns, entries), preparing: true };
    const before = f.store.turns.list('codex', key), cursor = f.store.events.latestEventId();
    const result = executeConnectorCodexDispatch('codexDispatchClaim', claim, f.store, f.tokens);
    if (compact) assert.equal(result?.execution.preparation, 'active');
    else {
      assert.equal(result, null);
      assert.equal(f.store.codexExecutions.get(key), undefined);
      assert.deepEqual(f.store.turns.list('codex', key), before);
      assert.equal(f.store.events.latestEventId(), cursor);
    }
  } finally { f.close(); }
});

for (const stage of ['denied', 'permitted', 'edited-queue', 'changed-predecessor', 'maintenance', 'preparing'] as const) {
  test(`independent compaction refusal settles only original denied queue: ${stage}`, async () => {
    const f = await fixture();
    try {
      const compact = stage === 'permitted' || stage === 'maintenance' || stage === 'preparing';
      const issuer = f.tokens.create({ label: 'isolated-compact-issuer', scopes: ['messages:send', 'execution:delegate'], delegationHubId: 'hub' });
      const grant = f.store.executionGrants.issue({ principalId: 'member', grantKey: 'recovery-policy', version: 1,
        runtime: 'codex', sessionKey: key, issuerTokenId: issuer.record.id, hubId: 'hub' },
        compact ? ['messages:send', 'runs:compact'] : ['messages:send'], Date.now() + 60_000);
      for (const id of ['first', 'second']) assert.ok(f.store.turns.edit('codex', key, id, () => ({ text: 'private', images: [],
        actorId: grant.actorId, executionGrant: { ...grant, issuerTokenId: issuer.record.id } })));
      const claim = { ...f.claim, proof: codexAdmissionProof(f.store.turns, f.store.turns.list<Payload>('codex', key)),
        preparing: true, predecessor: null };
      const resume = stage === 'maintenance' ? f.store.pauseTurnStarts() : undefined;
      const receipt = executeConnectorCodexDispatch('codexDispatchClaim', claim, f.store, f.tokens);
      if (stage === 'permitted' || stage === 'preparing') assert.ok(receipt);
      else assert.equal(receipt, null);
      if (stage === 'edited-queue') assert.ok(f.store.turns.edit('codex', key, 'first', () => ({ text: 'edited', images: [], actorId: f.actor })));
      if (stage === 'changed-predecessor') assert.ok(f.store.codexExecutions.begin(key, 'competing', 'other-connection'));
      if (stage === 'preparing') assert.equal(f.store.executionGrants.revoke(issuer.record.id, grant.id), true);
      const expected = receipt ? { commandId: receipt.execution.commandId,
        connectionId, revision: receipt.execution.revision } : null;
      const outcome = executeConnectorCodexDispatch('codexDispatchFailure', { sessionKey: key, commandId: 'first',
        expected, proof: receipt?.proof ?? claim.proof, failure: 'compaction_authorization' }, f.store, f.tokens);
      assert.equal(outcome, stage === 'denied' ? 'blocked' : stage === 'preparing' ? 'outcome_unknown' : null);
      if (stage === 'denied') {
        assert.equal(f.tokens.hasScope(issuer.record.id, 'messages:send'), true, 'send authority remains valid');
        assert.deepEqual(f.store.turns.list('codex', key).map(row => row.state), ['blocked', 'blocked']);
        assert.equal(f.store.codexExecutions.get(key), undefined);
      } else if (stage === 'preparing') {
        assert.equal(f.store.codexExecutions.get(key)?.reason, 'preparation_unknown');
        assert.deepEqual(f.store.turns.list('codex', key).map(row => row.state), ['outcome_unknown', 'outcome_unknown']);
      } else assert.ok(f.store.turns.list('codex', key).every(row => row.state !== 'blocked'));
      resume?.();
    } finally { f.close(); }
  });
}

for (const change of ['none', 'revision', 'command', 'connection', 'proof', 'revoked', 'maintenance', 'unknown'] as const) {
  test(`preparation current authority and exact receipt guard ready/finish: ${change}`, async () => {
    const f = await fixture();
    try {
      const claimed = executeConnectorCodexDispatch('codexDispatchClaim', { ...f.claim, preparing: true }, f.store, f.tokens)!;
      const ref = { sessionKey: key, commandId: 'first', connectionId, proof: claimed.proof, revision: claimed.execution.revision };
      if (change === 'revision') ref.revision++;
      if (change === 'command') ref.commandId = 'foreign';
      if (change === 'connection') ref.connectionId = 'foreign';
      if (change === 'proof') ref.proof = f.claim.proof;
      if (change === 'revoked') f.tokens.revoke(f.actor);
      if (change === 'maintenance') f.store.pauseTurnStarts();
      if (change === 'unknown') executeConnectorCodexDispatch('codexDispatchFailure', { sessionKey: key, commandId: 'first',
        expected: { commandId: 'first', connectionId, revision: ref.revision }, proof: claimed.proof, failure: 'unknown' }, f.store, f.tokens);
      const before = f.store.codexExecutions.get(key), cursor = f.store.events.latestEventId();
      assert.equal(executeConnectorCodexDispatch('codexPreparationReady', ref, f.store, f.tokens), change === 'none');
      assert.equal(executeConnectorCodexDispatch('codexPreparationFinish', ref, f.store, f.tokens), change === 'none');
      if (change === 'none') {
        const ready = f.store.codexExecutions.get(key)!;
        assert.equal(ready.preparation, 'ready'); assert.equal(ready.revision, ref.revision + 1);
        assert.equal(executeConnectorCodexDispatch('codexPreparationFinish', ref, f.store, f.tokens), false);
        const started = executeConnectorCodexDispatch('codexDispatchClaim', { ...f.claim, proof: claimed.proof }, f.store, f.tokens);
        assert.ok(started); assert.equal(started.execution.preparation, undefined);
      } else {
        assert.deepEqual(f.store.codexExecutions.get(key), before);
        assert.equal(f.store.events.latestEventId(), cursor);
      }
    } finally { f.close(); }
  });
}

test('preparation finish rechecks original authority INSIDE execution transaction and rolls back on refusal', async () => {
  const f = await fixture();
  try {
    const claimed = executeConnectorCodexDispatch('codexDispatchClaim', { ...f.claim, preparing: true }, f.store, f.tokens)!;
    const ref = { sessionKey: key, commandId: 'first', connectionId, proof: claimed.proof, revision: claimed.execution.revision };
    const before = f.store.codexExecutions.get(key), cursor = f.store.events.latestEventId();
    const scope = f.tokens.hasScope.bind(f.tokens);
    let consulted = 0;
    f.tokens.hasScope = (actor, permission) => {
      consulted++; assert.equal((f.store as any).db.isTransaction, true, 'authority must share original execution transaction');
      return consulted > 1 ? false : scope(actor, permission);
    };
    assert.equal(executeConnectorCodexDispatch('codexPreparationFinish', ref, f.store, f.tokens), false);
    assert.ok(consulted >= 2);
    assert.deepEqual(f.store.codexExecutions.get(key), before);
    assert.equal(f.store.events.latestEventId(), cursor);
  } finally { f.close(); }
});

for (const kind of ['codexPreparationReady', 'codexPreparationFinish'] as const) test(`${kind} refuses malformed or invented authority before owner access`, () => {
  const valid = { sessionKey: key, commandId: 'first', connectionId, revision: 1, proof: { count: 1, digest: 'a'.repeat(64) } };
  assert.ok(validConnectorCodexDispatchInput(kind, valid));
  const owner = new Proxy({}, { get() { throw Error('Owner must not be touched'); } }) as ConnectorUserStore;
  for (const input of [{ ...valid, revision: 0 }, { ...valid, revision: 1.1 }, { ...valid, revision: NaN },
    { ...valid, sessionKey: 'openclaw:foreign' }, { ...valid, proof: { ...valid.proof, count: 0 } },
    ...['sql', 'callback', 'actorId', 'authorized', 'release', 'replay'].map(name => ({ ...valid, [name]: true }))]) {
    assert.equal(validConnectorCodexDispatchInput(kind, input), false);
    assert.throws(() => executeConnectorCodexDispatch(kind, input, owner), /unavailable/);
  }
});

test('real worker transports original Codex claim, authority, ACK and restart without a second writer or replay', async () => {
  const f = await fixture(), rows: any[] = [];
  f.store.close(); // Seed owner is physically closed before the worker opens.
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  let worker = new AsyncConnectorOwner(f.config, diagnostics);
  try {
    await worker.open();
    const claimed = await worker.command('codexDispatchClaim', f.claim);
    assert.ok(claimed); assert.notEqual(claimed.proof.digest, f.claim.proof.digest);
    const ref = { sessionKey: key, commandId: 'first', connectionId, proof: claimed.proof };
    assert.equal(await worker.command('codexDispatchReady', ref), true);
    assert.equal(await worker.command('codexDispatchReady', { ...ref, connectionId: 'replacement' }), false);
    assert.equal(await worker.command('codexExecutionAcknowledge', { sessionKey: key, commandId: 'first', connectionId, runId: 'native-run' }), true);
    assert.equal(await worker.command('turnMaintenanceCount', { runtime: 'codex' }), 0);
    assert.equal(await worker.command('codexDispatchReady', ref), false);
    await worker.close();
    worker = new AsyncConnectorOwner(f.config, diagnostics); await worker.open();
    assert.equal(await worker.command('codexDispatchClaim', f.claim), null);
    assert.equal(await worker.command('turnMaintenanceCount', { runtime: 'codex' }), 0);
    await worker.close();
    assert.ok(rows.some(row => row.step === 215)); assert.ok(rows.some(row => row.step === 216));
    assert.doesNotMatch(JSON.stringify(rows), /private-message|original-connection|worker-admission|synthetic-isolated/);
    const reopened = new ConnectorUserStore(f.config.file);
    try { assert.equal(reopened.codexExecutions.get(key)?.runId, 'native-run'); }
    finally { reopened.close(); }
  } finally { await worker.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
