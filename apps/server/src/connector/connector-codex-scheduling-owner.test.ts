import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { TurnWorker } from '../commands/turn-worker.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncCodexScheduling } from './async-codex-scheduling.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { executeConnectorCodexScheduling, validConnectorCodexSchedulingInput, validConnectorCodexSchedulingOutput,
  type CodexSchedulingObservation, type CodexSchedulingRecheck } from './connector-codex-scheduling-domain.js';

const key = 'codex:scheduling-original', connection = 'original-connection';
const silence = new PerformanceDiagnostics(() => {});
const payload = (actorId: string) => ({ text: 'PRIVATE original message', images: [], actorId });
const expected = (v: CodexSchedulingObservation): CodexSchedulingRecheck => {
  assert.ok(v.head);
  return { sessionKey: v.sessionKey, executionRevision: v.execution?.revision ?? null, headId: v.head.id, headVersion: v.head.version };
};
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  for (let n = 0; n < 500; n++) { if (check()) return; await delay(5); }
  assert.fail('original worker did not reach expected state');
}
async function fixture(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-scheduling-owner-'));
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: 'synthetic-scheduling-token' };
  const tokens = new ConnectorTokenStore(config.tokenFile, config.bootstrapToken);
  const actor = tokens.authenticateAuthorization(`Bearer ${config.bootstrapToken}`)!.tokenId;
  const store = new ConnectorUserStore(config.file, (id, action) => tokens.hasScope(id, 'execution:delegate')
    && tokens.hasScope(id, 'messages:send') && (action !== 'messages:mirror' || tokens.hasScope(id, 'messages:mirror')), { runtimeOwner: true });
  let closed = false, worker: AsyncConnectorOwner | undefined;
  const closeStore = () => { if (!closed) { store.close(); closed = true; } };
  t.after(async () => { await worker?.close(); closeStore(); rmSync(directory, { recursive: true, force: true }); });
  const logs: any[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
  return { store, tokens, actor, config, logs, diagnostics, closeStore,
    async open() { closeStore(); worker = new AsyncConnectorOwner(config, diagnostics); await worker.open(); return worker; } };
}

test('scheduling envelopes are fixed metadata, never caller-supplied authority or effect claims', () => {
  const observation = { sessionKey: key }, recheck = { sessionKey: key, executionRevision: null, headId: 'original', headVersion: '1:0' };
  const unavailable = new Proxy({}, { get() { throw Error('must not touch owner'); } }) as ConnectorUserStore;
  for (const kind of ['codexSchedulingObservation', 'codexSchedulingRecheck', 'codexSchedulingRejectHead'] as const) {
    const input = kind === 'codexSchedulingObservation' ? observation : recheck;
    assert.equal(validConnectorCodexSchedulingInput(kind, input), true);
    for (const extra of ['sql', 'actorId', 'executionGrant', 'authorized', 'callback', 'release', 'resume', 'replay']) {
      const forged = { ...input, [extra]: true };
      assert.equal(validConnectorCodexSchedulingInput(kind, forged), false);
      assert.throws(() => executeConnectorCodexScheduling(kind, forged as any, unavailable), /unavailable/);
    }
  }
  for (const executionRevision of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validConnectorCodexSchedulingInput('codexSchedulingRecheck', { ...recheck, executionRevision }), false);
  }
  for (const headVersion of ['', '01:0', '1:-1', '1:00', '9223372036854775808:0', '1:9223372036854775808']) {
    assert.equal(validConnectorCodexSchedulingInput('codexSchedulingRecheck', { ...recheck, headVersion }), false);
  }
  const result: CodexSchedulingObservation = { sessionKey: key, execution: null, deleted: false, admissionOpen: true,
    outcomeUnknown: false, head: { id: 'original', version: '1:0', state: 'queued', authorized: true } };
  assert.equal(validConnectorCodexSchedulingOutput('codexSchedulingObservation', result), true);
  for (const change of [{ deleted: true }, { admissionOpen: false }, { outcomeUnknown: true },
    { head: { ...result.head, payload: payload('private') } }, { head: { ...result.head, state: 'outcome_unknown' } }]) {
    assert.equal(validConnectorCodexSchedulingOutput('codexSchedulingObservation', { ...result, ...change }), false);
  }
});

test('same-owner recheck reads original actor/grant and exact revisions; observation has no SQL/token/projection effects', async t => {
  const f = await fixture(t), command = createConnectorOwnerCommands(f.store, f.tokens);
  await f.store.turns.enqueueAsync('codex', { id: 'original', sessionKey: key, createdAt: 1, payload: payload(f.actor) });
  const db = (f.store as unknown as { db: DatabaseSync }).db;
  const changes = () => db.prepare('SELECT total_changes() AS n').get();
  const before = { changes: changes(), token: readFileSync(f.config.tokenFile, 'utf8'), head: await command('eventProjectionHead', {}) };
  const first = await command('codexSchedulingObservation', { sessionKey: key });
  assert.equal(first.head?.authorized, true); assert.equal(first.execution, null);
  assert.equal(await command('codexSchedulingRecheck', expected(first)), true);
  assert.deepEqual(changes(), before.changes); assert.equal(readFileSync(f.config.tokenFile, 'utf8'), before.token);
  assert.deepEqual(await command('eventProjectionHead', {}), before.head);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE|actorId|executionGrant|images|tokenId/);
  f.store.turns.edit<ReturnType<typeof payload>>('codex', key, 'original', p => ({ ...p, text: 'changed' }));
  assert.equal(await command('codexSchedulingRecheck', expected(first)), false, 'exact head version');
  const edited = await command('codexSchedulingObservation', { sessionKey: key });
  assert.equal(await command('codexSchedulingRecheck', expected(edited)), true);
  f.store.codexExecutions.begin(key, 'predecessor', connection);
  assert.equal(await command('codexSchedulingRecheck', expected(edited)), false, 'absent execution is not cached forever');
  const started = await command('codexSchedulingObservation', { sessionKey: key });
  assert.equal(await command('codexSchedulingRecheck', expected(started)), true);
  f.store.codexExecutions.acknowledge(key, 'predecessor', connection, 'native-run', () => {});
  assert.equal(await command('codexSchedulingRecheck', expected(started)), false, 'exact execution revision');
  const acknowledged = await command('codexSchedulingObservation', { sessionKey: key });
  f.store.turns.complete('codex', 'original');
  await f.store.turns.enqueueAsync('codex', { id: 'original', sessionKey: key, createdAt: 1, payload: payload(f.actor) });
  assert.equal(await command('codexSchedulingRecheck', expected(acknowledged)), false, 'queue ABA never reuses original sequence');
  command.dispose();
});

for (const state of ['blocked', 'outcome_unknown', 'dispatching'] as const) {
  test(`protected ${state} FIFO is observable but never authorizes continuation`, async t => {
    const f = await fixture(t);
    await f.store.turns.enqueueAsync('codex', { id: 'original', sessionKey: key, createdAt: 1, state, payload: payload(f.actor) });
    const owner = await f.open(), port = new AsyncCodexScheduling(owner);
    const value = await port.observe(key);
    assert.equal(value.head?.state, state); assert.equal(value.head.authorized, false);
    assert.equal(value.outcomeUnknown, state === 'outcome_unknown');
    assert.equal(await port.recheck(expected(value)), false);
    assert.equal(await port.rejectHead(expected(value)), false);
    assert.deepEqual(await port.observe(key), value, 'pure observation never clears or blocks original head');
  });
}

test('real file worker rejects current token revocation and maintenance pause without mutating original queued input', async t => {
  const f = await fixture(t);
  await f.store.turns.enqueueAsync('codex', { id: 'original', sessionKey: key, createdAt: 1, payload: payload(f.actor) });
  const owner = await f.open(), port = new AsyncCodexScheduling(owner);
  const first = await port.observe(key); assert.equal(first.head?.authorized, true);
  assert.equal(await port.recheck(expected(first)), true);
  const generation = await owner.command('maintenancePause', {});
  assert.equal(await port.recheck(expected(first)), false);
  const paused = await port.observe(key); assert.equal(paused.admissionOpen, false); assert.equal(paused.head?.state, 'queued');
  assert.equal(await owner.command('maintenanceResume', { generation }), true);
  assert.equal(await port.recheck(expected(first)), true);
  assert.equal(await owner.command('tokenRevoke', { tokenId: f.actor }), true);
  assert.equal(await port.recheck(expected(first)), false);
  const revoked = await port.observe(key); assert.equal(revoked.head?.authorized, false); assert.equal(revoked.head?.state, 'queued');
  assert.ok(f.logs.some(row => row.step === 250)); assert.ok(f.logs.some(row => row.step === 251));
  assert.doesNotMatch(JSON.stringify(f.logs), /scheduling-original|PRIVATE|synthetic-scheduling-token|original-connection/);
});

test('real file worker validates delegated original identity and current issuer, not a fabricated local actor', async t => {
  const f = await fixture(t);
  const issuer = f.tokens.create({ label: 'synthetic issuer', scopes: ['messages:send', 'execution:delegate'], delegationHubId: 'hub' });
  const grant = f.store.executionGrants.issue({ principalId: 'member', grantKey: 'original-policy', version: 1,
    runtime: 'codex', sessionKey: key, issuerTokenId: issuer.record.id, hubId: 'hub' }, ['messages:send'], Date.now() + 60_000);
  await f.store.turns.enqueueAsync('codex', { id: 'delegated', sessionKey: key, createdAt: 1,
    payload: { ...payload(grant.actorId), executionGrant: { ...grant, issuerTokenId: issuer.record.id } } });
  await f.store.turns.enqueueAsync('codex', { id: 'forged', sessionKey: 'codex:forged-actor', createdAt: 1, payload: payload(grant.actorId) });
  await f.store.turns.enqueueAsync('codex', { id: 'wrong-target', sessionKey: 'codex:wrong-target', createdAt: 1,
    payload: { ...payload(grant.actorId), executionGrant: { ...grant, issuerTokenId: issuer.record.id } } });
  const owner = await f.open(), port = new AsyncCodexScheduling(owner);
  const first = await port.observe(key); assert.equal(first.head?.authorized, true);
  assert.equal(await port.recheck(expected(first)), true);
  assert.equal((await port.observe('codex:forged-actor')).head?.authorized, false);
  assert.equal((await port.observe('codex:wrong-target')).head?.authorized, false);
  assert.equal(await owner.command('tokenRevoke', { tokenId: issuer.record.id }), true);
  assert.equal(await port.recheck(expected(first)), false);
  assert.equal((await port.observe(key)).head?.state, 'queued');
});

for (const state of ['outcome_unknown', 'accepted'] as const) {
  test(`original ${state} deletion blocks scheduling even without a terminal execution`, async t => {
    const f = await fixture(t);
    await f.store.turns.enqueueAsync('codex', { id: 'original', sessionKey: key, createdAt: 1, payload: payload(f.actor) });
    const scope = JSON.stringify(['delete', JSON.stringify([f.actor, key])]);
    await f.store.commands.claimAsync(scope, 'original-deletion', { sessionKey: key });
    if (state === 'accepted') f.store.commands.settle(scope, 'original-deletion', { status: 200, body: { ok: true } });
    assert.equal(f.store.commands.sessionDeletion(key), state);
    const port = new AsyncCodexScheduling(await f.open()), observed = await port.observe(key);
    assert.equal(observed.execution, null); assert.equal(observed.deleted, true);
    assert.equal(observed.head?.authorized, false);
    assert.equal(await port.recheck(expected(observed)), false);
    assert.equal(await port.rejectHead(expected(observed)), false);
    assert.deepEqual(await port.observe(key), observed, 'deletion cannot be cleared by repeated observation');
  });
}

test('missing identity, read-only tokens and malformed original payloads require explicit durable rejection', async t => {
  const f = await fixture(t), reader = f.tokens.create({ label: 'synthetic reader', scopes: ['sessions:read'] });
  const cases = [
    { text: 'original', images: [] }, payload(reader.record.id), { ...payload(f.actor), text: '' },
    { ...payload(f.actor), images: [{ filePath: '\0', media: {} }] }, { ...payload(f.actor), authorized: true },
  ];
  for (let n = 0; n < cases.length; n++) await f.store.turns.enqueueAsync('codex', {
    id: `original-${n}`, sessionKey: `codex:invalid-${n}`, createdAt: 1, payload: cases[n] });
  const port = new AsyncCodexScheduling(await f.open());
  for (let n = 0; n < cases.length; n++) {
    const observed = await port.observe(`codex:invalid-${n}`);
    assert.equal(observed.head?.state, 'queued'); assert.equal(observed.head?.authorized, false);
    assert.equal(await port.recheck(expected(observed)), false);
    assert.equal(await port.rejectHead(expected(observed)), true);
    assert.equal((await port.observe(`codex:invalid-${n}`)).head?.state, 'blocked');
  }
});

for (const invalidity of ['expired', 'clock-rollback', 'revoked'] as const) {
  test(`${invalidity} delegated scheduling observations deny without SQL writes; actual admission retains sticky revocation`, async t => {
    const f = await fixture(t), issuer = f.tokens.create({ label: 'synthetic issuer',
      scopes: ['messages:send', 'execution:delegate'], delegationHubId: 'hub' });
    const grant = f.store.executionGrants.issue({ principalId: 'member', grantKey: 'original-policy', version: 1,
      runtime: 'codex', sessionKey: key, issuerTokenId: issuer.record.id, hubId: 'hub' }, ['messages:send'], Date.now() + 60_000);
    const authority = { ...grant, issuerTokenId: issuer.record.id };
    await f.store.turns.enqueueAsync('codex', { id: 'original', sessionKey: key, createdAt: 1,
      payload: { ...payload(grant.actorId), executionGrant: authority } });
    const db = (f.store as unknown as { db: DatabaseSync }).db;
    if (invalidity === 'revoked') f.store.executionGrants.revoke(issuer.record.id, grant.id);
    else if (invalidity === 'expired') db.prepare('UPDATE connector_execution_grants SET issued_at = ?, expires_at = ? WHERE id = ?')
      .run(Date.now() - 2000, Date.now() - 1000, grant.id);
    else db.prepare('UPDATE connector_execution_grants SET issued_at = ?, expires_at = ? WHERE id = ?')
      .run(Date.now() + 60_000, Date.now() + 120_000, grant.id);
    const command = createConnectorOwnerCommands(f.store, f.tokens);
    const before = db.prepare('SELECT total_changes() AS n').get();
    const observed = await command('codexSchedulingObservation', { sessionKey: key });
    assert.equal(observed.head?.authorized, false);
    assert.equal(await command('codexSchedulingRecheck', expected(observed)), false);
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before, 'observation never revokes a lease');
    assert.equal(f.store.executionGrants.authorize(authority, issuer.record.id, { runtime: 'codex', sessionKey: key }, 'messages:send'), false);
    assert.equal(db.prepare('SELECT revoked FROM connector_execution_grants WHERE id = ?').get(grant.id)?.revoked, 1,
      'real authority path still durably revokes expired/rollback leases');
    command.dispose();
    const port = new AsyncCodexScheduling(await f.open());
    assert.equal((await port.observe(key)).head?.authorized, false, 'reopen cannot revive original invalid authority');
  });
}

test('original TurnWorker fairly merges real-worker queue and recovery pages and drains pause without a second scheduler', async t => {
  const f = await fixture(t), keys: string[] = [];
  for (let n = 0; n < 67; n++) {
    const sessionKey = `codex:queued-${String(n).padStart(3, '0')}`; keys.push(sessionKey);
    await f.store.turns.enqueueAsync('codex', { id: `input-${n}`, sessionKey, createdAt: n, payload: payload(f.actor) });
  }
  for (const sessionKey of ['codex:cold-a', 'codex:cold-z']) {
    keys.push(sessionKey); f.store.codexExecutions.begin(sessionKey, 'predecessor', connection);
    f.store.codexExecutions.acknowledge(sessionKey, 'predecessor', connection, 'native-run', () => {});
    f.store.codexExecutions.observe(sessionKey, connection, 'native-run', 'completed');
  }
  const owner = await f.open(), port = new AsyncCodexScheduling(owner), seen = new Set<string>();
  const worker = new TurnWorker({ queue: port, runtime: 'codex', retryMs: 1, pageSize: 16, diagnostics: silence,
    additionalSessionPage: (after, limit) => port.recoveryPage(after, limit, connection),
    reconcile: async sessionKey => { await port.observe(sessionKey); seen.add(sessionKey); } });
  try {
    worker.start(); await until(() => seen.size === keys.length);
    const pause = worker.pause(); await pause.drained;
    assert.deepEqual([...seen].sort(), keys.sort());
    port.notifyAdmission(); await delay(10); assert.equal((worker as any).timer, undefined);
    assert.equal((await port.sessionPage('codex', '', 64)).length, 64, 'observation does not dequeue anything');
    assert.equal(pause.resume(), true);
  } finally { await worker.close(); }
});

for (const stage of ['turnSessionPage', 'turnRecoveryPage', 'codexSchedulingObservation'] as const) {
  test(`original TurnWorker close waits for real-worker ${stage} observation and starts no replacement pass`, async t => {
    const f = await fixture(t), gate = deferred();
    await f.store.turns.enqueueAsync('codex', { id: 'original', sessionKey: key, createdAt: 1, payload: payload(f.actor) });
    const owner = await f.open(); let held = false, calls = 0;
    const transport = { command: (async (kind: any, input: any) => {
      const result = await owner.command(kind, input);
      if (!held && kind === stage) { held = true; await gate.promise; }
      return result;
    }) as AsyncConnectorOwner['command'] };
    const port = new AsyncCodexScheduling(transport);
    const worker = new TurnWorker({ queue: port, runtime: 'codex', retryMs: 1, diagnostics: silence,
      additionalSessionPage: (after, limit) => port.recoveryPage(after, limit, connection),
      reconcile: async sessionKey => { calls++; await port.observe(sessionKey); } });
    try {
      worker.start(); await until(() => held);
      let closed = false; const closing = worker.close().then(() => { closed = true; });
      const before = calls; port.notifyAdmission(); worker.wake(); await delay(10);
      assert.equal(closed, false); assert.equal(calls, before);
      gate.resolve(); await closing; assert.equal((worker as any).timer, undefined);
      assert.equal((await port.observe(key)).head?.state, 'queued');
    } finally { gate.resolve(); await worker.close(); }
  });
}

test('scan hints are not authority and wrong-key/malformed worker replies fail closed', async () => {
  let commands = 0, hint = 0;
  const port = new AsyncCodexScheduling({ command: (async () => { commands++; return null; }) as AsyncConnectorOwner['command'] });
  const dispose = port.onAdmission(() => { hint++; throw Error('subscriber failed'); });
  assert.doesNotThrow(() => port.notifyAdmission()); assert.equal(hint, 1); assert.equal(commands, 0);
  dispose(); port.notifyAdmission(); assert.equal(hint, 1);
  await assert.rejects(port.sessionPage('claude', '', 1), /unavailable/); assert.equal(commands, 0);
  await assert.rejects(port.observe(key), /unavailable/);
  await assert.rejects(port.recheck({ sessionKey: key, executionRevision: null, headId: 'original', headVersion: '1:0' }), /unavailable/);
  await assert.rejects(port.rejectHead({ sessionKey: key, executionRevision: null, headId: 'original', headVersion: '1:0' }), /unavailable/);
  const other = new AsyncCodexScheduling({ command: (async () => ({ sessionKey: 'codex:wrong-key', execution: null, deleted: false,
    admissionOpen: true, outcomeUnknown: false, head: null })) as AsyncConnectorOwner['command'] });
  await assert.rejects(other.observe(key), /unavailable/);
});

test('real worker rejection checks current rights, exact head and maintenance, then persists across reopen', async t => {
  const f = await fixture(t);
  await f.store.turns.enqueueAsync('codex', { id: 'original', sessionKey: key, createdAt: 1, payload: payload(f.actor) });
  const owner = await f.open(), port = new AsyncCodexScheduling(owner), first = await port.observe(key);
  assert.equal(await port.rejectHead(expected(first)), false, 'an observation is not rejection authority');
  await owner.command('tokenRevoke', { tokenId: f.actor });
  const generation = await owner.command('maintenancePause', {});
  assert.equal(await port.rejectHead(expected(first)), false, 'maintenance never mutates the queue');
  assert.equal(await owner.command('maintenanceResume', { generation }), true);
  assert.equal(await port.rejectHead({ ...expected(first), headId: 'foreign' }), false);
  assert.equal(await port.rejectHead({ ...expected(first), headVersion: '999:0' }), false);
  assert.equal(await port.rejectHead({ ...expected(first), executionRevision: 1 }), false);
  const before = await owner.command('eventProjectionHead', {});
  assert.equal(await port.rejectHead(expected(first)), true);
  assert.notDeepEqual(await owner.command('eventProjectionHead', {}), before, 'mutation invalidates DISPLAY snapshots');
  const rejected = await port.observe(key);
  assert.equal(rejected.head?.state, 'blocked'); assert.equal(rejected.execution, null);
  assert.notEqual(rejected.head.version, first.head!.version);
  assert.equal(await port.rejectHead(expected(first)), false, 'no duplicate transition');
  assert.deepEqual(await port.sessionPage('codex', '', 64), [], 'blocked head no longer spins active queue scans');
  assert.equal(await owner.command('turnMaintenanceCount', { runtime: 'codex' }), 1, 'original message retained');
  await owner.close();
  const reopened = new AsyncConnectorOwner(f.config, f.diagnostics);
  try { await reopened.open(); assert.equal((await new AsyncCodexScheduling(reopened).observe(key)).head?.state, 'blocked'); }
  finally { await reopened.close(); }
  assert.ok(f.logs.some(row => row.step === 259));
  assert.doesNotMatch(JSON.stringify(f.logs), /scheduling-original|PRIVATE|synthetic-scheduling-token|original-connection/);
});

for (const race of ['edited', 'replacement', 'execution', 'restored'] as const)
test(`rejection cannot select a stale head or restored authority: ${race}`, async t => {
  const f = await fixture(t), reader = f.tokens.create({ label: 'reader', scopes: ['sessions:read'] });
  await f.store.turns.enqueueAsync('codex', { id: 'original', sessionKey: key, createdAt: 1, payload: payload(reader.record.id) });
  const first = executeConnectorCodexScheduling('codexSchedulingObservation', { sessionKey: key }, f.store, f.tokens);
  assert.equal(first.head?.authorized, false);
  if (race === 'edited') f.store.turns.edit<ReturnType<typeof payload>>('codex', key, 'original', p => ({ ...p, text: 'edited original' }));
  if (race === 'replacement') {
    f.store.turns.complete('codex', 'original');
    await f.store.turns.enqueueAsync('codex', { id: 'original', sessionKey: key, createdAt: 2, payload: payload(reader.record.id) });
  }
  if (race === 'execution') f.store.codexExecutions.begin(key, 'predecessor', connection);
  if (race === 'restored') f.tokens.hasScope = () => true;
  assert.equal(executeConnectorCodexScheduling('codexSchedulingRejectHead', expected(first), f.store, f.tokens), false);
  assert.equal(f.store.turns.head('codex', key)?.state, 'queued');
});

test('expired grant revocation and exact queued rejection roll back together, then commit together', async t => {
  const f = await fixture(t), issuer = f.tokens.create({ label: 'issuer', scopes: ['messages:send', 'execution:delegate'], delegationHubId: 'hub' });
  const grant = f.store.executionGrants.issue({ principalId: 'member', grantKey: 'original', version: 1,
    runtime: 'codex', sessionKey: key, issuerTokenId: issuer.record.id, hubId: 'hub' }, ['messages:send'], Date.now() + 60_000);
  await f.store.turns.enqueueAsync('codex', { id: 'original', sessionKey: key, createdAt: 1,
    payload: { ...payload(grant.actorId), executionGrant: { ...grant, issuerTokenId: issuer.record.id } } });
  const db = (f.store as unknown as { db: DatabaseSync }).db;
  db.prepare('UPDATE connector_execution_grants SET issued_at = ?, expires_at = ? WHERE id = ?')
    .run(Date.now() - 2000, Date.now() - 1000, grant.id);
  const ref = expected(executeConnectorCodexScheduling('codexSchedulingObservation', { sessionKey: key }, f.store, f.tokens));
  db.exec("CREATE TRIGGER synthetic_reject_failure BEFORE UPDATE ON connector_turns WHEN NEW.state = 'blocked' BEGIN SELECT RAISE(ABORT, 'synthetic rejection fault'); END");
  assert.throws(() => executeConnectorCodexScheduling('codexSchedulingRejectHead', ref, f.store, f.tokens), /synthetic rejection fault/);
  assert.equal(f.store.turns.head('codex', key)?.state, 'queued');
  assert.equal(db.prepare('SELECT revoked FROM connector_execution_grants WHERE id = ?').get(grant.id)?.revoked, 0);
  db.exec('DROP TRIGGER synthetic_reject_failure');
  assert.equal(executeConnectorCodexScheduling('codexSchedulingRejectHead', ref, f.store, f.tokens), true);
  assert.equal(f.store.turns.head('codex', key)?.state, 'blocked');
  assert.equal(db.prepare('SELECT revoked FROM connector_execution_grants WHERE id = ?').get(grant.id)?.revoked, 1);
});
