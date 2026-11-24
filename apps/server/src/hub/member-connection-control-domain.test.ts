import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AOD_MODEL_SET_ID, createCommandKey } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { ConnectionControlOperation } from './connection-control-contract.js';
import type { ConnectionControlReference, ConnectionControlSettlement } from './member-connection-control-domain.js';
import { AsyncHubConnectionProxyAccess } from './async-connection-proxy-access.js';

async function fixture(t: TestContext, mode: 'original' | 'worker', failAudit = false) {
  const root = mkdtempSync(join(tmpdir(), 'connection-control-domain-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'fixture');
  const db = (seed as unknown as {db: DatabaseSync}).db;
  db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = seed.identities.issueKey('default'), user = seed.createUser('Control owner');
  const key = seed.identities.issueKey(user.id), second = seed.identities.issueKey(user.id);
  seed.upsertConnection({id: 'node', ownerUserId: user.id, label: 'Node', connectorUrl: 'http://connector.invalid', credentialToken: 'PRIVATE_CONTROL_TOKEN'});
  if (failAudit) db.exec("CREATE TRIGGER fail_control_audit BEFORE INSERT ON audit_logs WHEN new.action = 'connector.capabilities.checked' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END");
  await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => {logs.push(line);});
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics) : new AsyncHubMemberOwner({file, encryptionSecret: 'fixture'}, diagnostics);
  const access = new AsyncHubConnectionProxyAccess(owner, diagnostics);
  const request = (token = key.token) => new Request('http://hub.invalid/api/hub/v1/connections/node/capabilities', {headers: {'x-agentopsdeck-key': token}});
  const evidence = {accessKey: key.token}, snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
  const proof = {evidence, expectedScope: snapshot.recoveryScope};
  const target = await owner.command('connectionTarget', {...proof, id: 'node'}); assert.ok(target && 'epoch' in target);
  const claim = (control: ConnectionControlOperation = {operation: 'capabilities'}, commandKey = createCommandKey(randomUUID()), epoch = target.epoch) =>
    owner.command('connectionControl', {...proof, command: {action: 'claim', id: 'node', expectedEpoch: epoch, key: commandKey, control}});
  const read = (sql: string) => {const reader = new DatabaseSync(file, {readOnly: true}); try {return reader.prepare(sql).all();} finally {reader.close();}};
  const revoke = async () => {
    const evidence = {accessKey: admin.token}, actor = await owner.command('memberSnapshot', evidence); assert.ok(actor);
    await owner.command('memberKeyRevoke', {evidence, expectedScope: actor.recoveryScope, userId: user.id, keyId: key.id});
  };
  t.after(async () => {
    try {await access.close();} finally {try {await owner.close();} finally {if (original) await original.close();}}
    assert.equal(logs.join('').includes(key.token), false); assert.equal(logs.join('').includes('PRIVATE_CONTROL_TOKEN'), false);
    rmSync(root, {recursive: true, force: true});
  });
  return {owner, original, claim, read, proof, target, revoke, access, request, second, user};
}
function reference(result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['claim']>>): ConnectionControlReference {
  assert.ok(result && 'reference' in result); assert.equal(result.fresh, true); assert.equal(result.receipt.state, 'outcome_unknown');
  assert.equal('binding' in result.receipt, false); return result.reference;
}
function observation(reference: ConnectionControlReference, operation: ConnectionControlOperation['operation'] = 'capabilities', status = 200): ConnectionControlSettlement {
  return {reference, observation: {operation, status, facts: {ok: true, state: 'succeeded'}}};
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: recovery reads only original receipt and rechecks current authority without allocating`, async t => {
    const f = await fixture(t, mode), key = createCommandKey(randomUUID());
    const read = (operation: 'reconcile' | 'updateCheck' = 'updateCheck', originalKey = key) => f.owner.command('connectionControl', {
      ...f.proof, command: {action: 'receipt', id: 'node', expectedEpoch: f.target.epoch, key: originalKey, operation},
    });
    assert.deepEqual(await read(), {error: 404});
    const ref = reference(await f.claim({operation: 'updateCheck', request: {}}, key));
    assert.deepEqual(await read(), {action: 'receipt', receipt: {key, operation: 'updateCheck', state: 'outcome_unknown'}});
    assert.deepEqual(await read('reconcile'), {error: 404});
    await f.owner.connectionControlSettlement().command(observation(ref, 'updateCheck', 403));
    assert.deepEqual(await read(), {action: 'receipt', receipt: {key, operation: 'updateCheck', state: 'rejected', status: 403}});
    assert.equal(f.read('SELECT * FROM command_receipts').length, 1);
    await f.revoke(); assert.equal(await read(), null);
  });
  test(`${mode}: fixed control claim, atomic original audit, duplicate ACK and conflicting ACK`, async t => {
    const f = await fixture(t, mode), result = await f.claim(), ref = reference(result), input = observation(ref);
    const duplicate = await f.claim({operation: 'capabilities'}, ref.key); assert.ok(duplicate && 'fresh' in duplicate); assert.equal(duplicate.fresh, false);
    assert.deepEqual(await f.claim({operation: 'updateStatus'}, ref.key), {error: 409});
    const settlement = f.owner.connectionControlSettlement();
    assert.deepEqual(await settlement.command(input), {reference: ref, state: 'accepted'});
    assert.deepEqual(await settlement.command(input), {reference: ref, state: 'accepted'});
    await assert.rejects(settlement.command({...input, observation: {...input.observation, facts: {ok: false}}}));
    await assert.rejects(settlement.command({...input, observation: {...input.observation, status: 201}}));
    const rows = f.read("SELECT owner_user_id,action,connection_id,detail_json FROM audit_logs WHERE action = 'connector.capabilities.checked'");
    assert.equal(rows.length, 1); assert.equal(rows[0]!.owner_user_id, f.user.id); assert.equal(rows[0]!.connection_id, 'node');
    assert.deepEqual({...JSON.parse(String(rows[0]!.detail_json)), updatedAt: 0}, {ok: true, state: 'succeeded', updatedAt: 0});
    const persisted = f.read('SELECT result,binding_json FROM command_receipts')[0]!;
    assert.ok(Buffer.byteLength(String(persisted.result)) <= 128, 'fits original result capacity reserve');
    assert.equal(String(persisted.binding_json).includes('PRIVATE_CONTROL_TOKEN'), false);
  });

  test(`${mode}: current revoked user cannot dispatch/claim/deliver, but original effect still settles`, async t => {
    const f = await fixture(t, mode), begun = await f.access.begin(f.request(), 'node');
    const ref = reference(await begun.claimControl({action: 'claim', id: 'node', expectedEpoch: begun.epoch, key: createCommandKey(randomUUID()), control: {operation: 'capabilities'}}));
    await f.revoke();
    await assert.rejects(begun.check());
    await assert.rejects(begun.claimControl({action: 'claim', id: 'node', expectedEpoch: begun.epoch, key: ref.key, control: {operation: 'capabilities'}}));
    assert.deepEqual(await f.owner.connectionControlSettlement().command(observation(ref)), {reference: ref, state: 'accepted'});
    assert.equal(f.read("SELECT count(*) AS n FROM audit_logs WHERE action = 'connector.capabilities.checked'")[0]!.n, 1);
  });

  test(`${mode}: settlement capability rejects generic RPC, caller audit fields, wrong original reference and operation`, async t => {
    const f = await fixture(t, mode), ref = reference(await f.claim()), input = observation(ref), settlement = f.owner.connectionControlSettlement();
    await assert.rejects(f.owner.command('connectionControlSettlement', input));
    for (const wrong of [
      {...input, ownerUserId: 'default'}, {...input, action: 'connector.capabilities.checked'},
      {...input, reference: {...ref, receiptId: 'wrong'}}, {...input, reference: {...ref, connectionId: 'wrong'}},
      {...input, reference: {...ref, ownerUserId: 'default'}}, {...input, reference: {...ref, key: 'missing'}},
      {...input, observation: {...input.observation, operation: 'reconcile'}},
      {...input, observation: {...input.observation, facts: {state: 'PRIVATE_ARBITRARY_STATE'}}},
      {...input, observation: {...input.observation, status: 503}},
    ]) await assert.rejects(settlement.command(wrong as ConnectionControlSettlement));
    assert.equal(f.read("SELECT state FROM command_receipts")[0]!.state, 'outcome_unknown');
    assert.equal(f.read("SELECT count(*) AS n FROM audit_logs WHERE action = 'connector.capabilities.checked'")[0]!.n, 0);
  });

  test(`${mode}: stale epoch cannot claim and original uncertainty is never rekeyed/released`, async t => {
    const f = await fixture(t, mode), ref = reference(await f.claim());
    assert.deepEqual(await f.claim({operation: 'capabilities'}, ref.key, f.target.epoch + 1), {error: 403});
    const result = await f.claim({operation: 'capabilities'}, ref.key); assert.ok(result && 'receipt' in result);
    assert.ok('fresh' in result); assert.equal(result.fresh, false); assert.equal(result.receipt.state, 'outcome_unknown');
    assert.equal(f.read('SELECT count(*) AS n FROM command_receipts')[0]!.n, 1);
  });

  test(`${mode}: audit failure rolls back receipt settlement and duplicate fact can retry settlement only`, async t => {
    const f = await fixture(t, mode, true), ref = reference(await f.claim()), settlement = f.owner.connectionControlSettlement();
    await assert.rejects(settlement.command(observation(ref)));
    assert.equal(f.read('SELECT state FROM command_receipts')[0]!.state, 'outcome_unknown');
    assert.equal(f.read("SELECT count(*) AS n FROM audit_logs WHERE action = 'connector.capabilities.checked'")[0]!.n, 0);
    await assert.rejects(settlement.command(observation(ref)));
    assert.equal(f.read('SELECT count(*) AS n FROM command_receipts')[0]!.n, 1);
  });

  test(`${mode}: known rejection settles without success audit; read-only control does not invent audit`, async t => {
    const f = await fixture(t, mode), ref = reference(await f.claim());
    const settlement = f.owner.connectionControlSettlement();
    assert.equal((await settlement.command(observation(ref, 'capabilities', 403))).state, 'rejected');
    const readonly = reference(await f.claim({operation: 'modelSet'}));
    assert.equal((await settlement.command(observation(readonly, 'modelSet'))).state, 'accepted');
    assert.equal(f.read("SELECT count(*) AS n FROM audit_logs WHERE action = 'connector.capabilities.checked'")[0]!.n, 0);
  });

  test(`${mode}: fixed reconcile intent binds normalized original request to the original audit`, async t => {
    const f = await fixture(t, mode), control = {operation: 'reconcile', request: {setId: AOD_MODEL_SET_ID, dryRun: true, idempotencyKey: 'original'}} as const;
    const ref = reference(await f.claim(control));
    await f.owner.connectionControlSettlement().command(observation(ref, 'reconcile'));
    const row = f.read("SELECT detail_json FROM audit_logs WHERE action = 'gateway.model_set.reconciled'")[0]!;
    assert.deepEqual(JSON.parse(String(row.detail_json)).request, control.request);
  });
}
