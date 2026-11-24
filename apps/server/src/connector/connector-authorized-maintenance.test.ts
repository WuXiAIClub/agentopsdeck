import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncUpdatePersistence } from './async-update-persistence.js';
import { RuntimeMaintenancePersistence } from './runtime-maintenance-persistence.js';
import { createAuthorizedMaintenanceCommands, validAuthorizedMaintenanceInput, validAuthorizedMaintenanceOutput,
  createAuthorizedMaintenanceResume, validAuthorizedMaintenanceResumeInput, validAuthorizedMaintenanceResumeOutput } from './connector-authorized-maintenance-domain.js';
import { executeConnectorCodexResume } from './connector-codex-resume-domain.js';
import type { ConnectorOwnerCommands } from './connector-owner-domain.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { UpdateAuthorizationError } from './update-service.js';

const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate<T = void>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve: (v: T) => resolve(v) }; }
const local = () => {};
function original(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'authorized-maintenance-original-'));
  const file = join(root, 'connector.sqlite'), tokenFile = join(root, 'tokens.json');
  const tokens = new ConnectorTokenStore(tokenFile, undefined, quiet);
  const owner = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  const actor = tokens.create({ label: 'maintenance', scopes: ['connector:lifecycle'] });
  const execute = createAuthorizedMaintenanceCommands(owner, tokens);
  const evidence = { authorization: `Bearer ${actor.token}`, expectedNode: owner.nodeId, protocol: '1', originPresent: false, actorId: actor.record.id };
  t.after(() => { owner.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, file, tokenFile, tokens, owner, actor, execute, evidence };
}

test('authorized maintenance wire accepts only the five fixed original commands and exact evidence shape', () => {
  const evidence = { authorization: 'Bearer private', expectedNode: 'node', protocol: '1', originPresent: false, actorId: 'actor' };
  const input = { ...evidence, kind: 'runtimeMaintenanceObserve', input: { historyRecovery: false } };
  assert.equal(validAuthorizedMaintenanceInput(input), true);
  for (const extra of [{ sql: 'SELECT 1' }, { mode: 'update' }, { authorized: true }, { callback: local }])
    assert.equal(validAuthorizedMaintenanceInput({ ...input, ...extra }), false);
  for (const kind of ['maintenanceResume', 'tokenRevoke', 'nodeIdentity', 'runtimeMaintenanceAuthorized', '__proto__'])
    assert.equal(validAuthorizedMaintenanceInput({ ...input, kind }), false);
  assert.equal(validAuthorizedMaintenanceInput({ ...input, input: { historyRecovery: false, authorized: true } }), false);
  assert.equal(validAuthorizedMaintenanceOutput({ status: 200, value: { kind: 'runtimeMaintenanceHistory', value: ['codex:a'] } }), true);
  assert.equal(validAuthorizedMaintenanceOutput({ status: 200, value: { kind: 'runtimeMaintenanceHistory', value: ['ghcp:a'] } }), false);
  assert.equal(validAuthorizedMaintenanceOutput({ status: 403, error: 'private token' }), false);
});

test('maintenance resume checks original identity inside intent transactions; raw receipt survives revocation', t => {
  const f = original(t), key = 'codex:resume', execute = createAuthorizedMaintenanceResume(f.owner, f.tokens);
  f.owner.codexExecutions.begin(key, 'command', 'connection');
  f.owner.codexExecutions.acknowledge(key, 'command', 'connection', 'run', local);
  f.owner.codexExecutions.observe(key, 'connection', 'run', 'completed');
  const fact = f.owner.codexExecutions.get(key)!;
  const input = { expected: { sessionKey: key, commandId: fact.commandId, connectionId: fact.connectionId,
    revision: fact.revision, runId: fact.runId! }, nativeConnectionId: 'connection', threadId: 'resume',
    fingerprint: 'a'.repeat(64), continuation: null };
  const prepare = { ...f.evidence, kind: 'codexResumePrepare' as const, input };
  assert.equal(validAuthorizedMaintenanceResumeInput(prepare), true);
  for (const extra of [{ authorized: true }, { sql: 'SELECT 1' }, { owner: 'root' }])
    assert.equal(validAuthorizedMaintenanceResumeInput({ ...prepare, ...extra }), false);
  assert.equal(validAuthorizedMaintenanceResumeInput({ ...prepare, kind: 'codexResumeFinish' }), false);
  assert.throws(() => execute(prepare), /fenced/);
  f.owner.pauseTurnStarts();
  for (const patch of [{ originPresent: true }, { protocol: '2' }, { expectedNode: 'other' }, { actorId: 'other' }])
    assert.deepEqual(execute({ ...prepare, ...patch }), { status: 403, error: 'authority' });
  const result = execute(prepare);
  assert.equal(validAuthorizedMaintenanceResumeOutput(result), true);
  assert.equal(result.status, 200);
  if (result.status !== 200 || result.value.kind !== 'codexResumePrepare' || !result.value.value) throw Error('Missing receipt');
  const receipt = result.value.value;
  f.tokens.revoke(f.actor.record.id);
  assert.deepEqual(execute({ ...f.evidence, kind: 'codexResumeBegin', input: receipt }), { status: 403, error: 'authority' });
  assert.equal(executeConnectorCodexResume('codexResumeFinish', { receipt, outcome: 'not_dispatched' }, f.owner, f.tokens), true);
  assert.equal(f.owner.codexExecutions.nativeResumes.pending(key), false);
  assert.doesNotMatch(readFileSync(f.file).toString('latin1'), new RegExp(f.actor.token));
});

test('current lifecycle identity, node, protocol and no-Origin are verified in the original worker transaction', t => {
  const f = original(t), observe = { ...f.evidence, kind: 'runtimeMaintenanceObserve' as const, input: { historyRecovery: false } };
  assert.equal(f.execute(observe).status, 200, 'read-only observations do not require pause');
  for (const scopes of [['connector:update'], ['sessions:read'], []] as const) {
    const other = f.tokens.create({ label: 'not lifecycle', scopes: [...scopes] });
    assert.deepEqual(f.execute({ ...observe, authorization: `Bearer ${other.token}`, actorId: other.record.id }), { status: 403, error: 'authority' });
  }
  for (const patch of [{ originPresent: true }, { protocol: '2' }, { protocol: '' }, { expectedNode: 'other-node' },
    { actorId: 'other-actor' }, { authorization: 'Bearer stale' }])
    assert.deepEqual(f.execute({ ...observe, ...patch }), { status: 403, error: 'authority' });
  f.tokens.revoke(f.actor.record.id);
  assert.deepEqual(f.execute(observe), { status: 403, error: 'authority' });
  assert.equal(f.owner.storageRecovery().state, 'ready', 'ordinary permission rejection must not poison the connection');
});

test('interaction retirement requires pause; revocation after original work rolls back its exact facts and audit', t => {
  const f = original(t), key = 'codex:existing', now = Date.now();
  const scope = { ownerId: 'owner', nodeId: f.owner.nodeId, sessionKey: key, runId: 'original-run' };
  f.owner.codexExecutions.begin(key, 'original-command', 'original-connection');
  f.owner.codexExecutions.acknowledge(key, 'original-command', 'original-connection', scope.runId, local);
  f.owner.interactions.create({ ...scope, version: 1, requestId: 'question', kind: 'text', prompt: 'PRIVATE original prompt',
    createdAt: now, expiresAt: now + 60_000 }, { version: 1, kinds: ['text'], modes: ['automatic', 'interactive'] }, scope,
  { connectionId: 'original-connection', goal: { status: 'active', version: 'goal-generation' } }, now);
  f.owner.codexExecutions.observe(key, 'original-connection', scope.runId, 'completed');
  f.owner.codexExecutions.settleHistory({ sessionKey: key, commandId: 'original-command', runId: scope.runId }, 'current');
  assert.equal(f.owner.codexExecutions.canStart(key), true);
  const input = { ...f.evidence, kind: 'runtimeMaintenanceInteractions' as const, input: {} };
  assert.throws(() => f.execute(input), /fenced/);
  assert.equal(f.owner.interactions.hasUnresolved(scope), true);
  const fact = f.owner.interactions.get(scope, 'question'), audit = f.owner.interactions.auditTrail(scope, 'question');
  const resume = f.owner.pauseTurnStarts(), reconcile = f.owner.reconcileEndedInteractions.bind(f.owner);
  let retired: string[] = [];
  f.owner.reconcileEndedInteractions = () => {
    retired = reconcile();
    assert.deepEqual(retired, [key]);
    f.tokens.revoke(f.actor.record.id);
    return retired;
  };
  assert.deepEqual(f.execute(input), { status: 403, error: 'authority' });
  assert.deepEqual(retired, [key], 'the test revoked after the real original mutation, before outer commit');
  assert.deepEqual(f.owner.interactions.get(scope, 'question'), fact);
  assert.deepEqual(f.owner.interactions.auditTrail(scope, 'question'), audit);
  assert.equal(f.owner.storageRecovery().state, 'ready');
  f.owner.reconcileEndedInteractions = reconcile;
  const renewed = f.tokens.create({ label: 'new lifecycle', scopes: ['connector:lifecycle'] });
  assert.deepEqual(f.execute({ ...input, authorization: `Bearer ${renewed.token}`, actorId: renewed.record.id }),
    { status: 200, value: { kind: 'runtimeMaintenanceInteractions', value: [key] } });
  assert.equal(f.owner.interactions.hasUnresolved(scope), false);
  assert.equal(f.owner.interactions.auditTrail(scope, 'question').at(-1)?.event, 'native-run-ended');
  assert.equal(resume(), true);
  f.owner.stopTurnStarts();
  assert.throws(() => f.execute({ ...input, authorization: `Bearer ${renewed.token}`, actorId: renewed.record.id }), /fenced/);
});

async function worker(t: TestContext, intercept?: (kind: string, run: () => Promise<unknown>) => Promise<unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'authorized-maintenance-worker-'));
  const file = join(root, 'connector.sqlite');
  const originalOwner = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  await originalOwner.turns.enqueueAsync('codex', { id: 'original-queued', sessionKey: 'codex:original', createdAt: 1,
    payload: { text: 'PRIVATE original queue', images: [] } });
  originalOwner.pauseTurnStarts(); const hash = originalOwner.maintenanceQueueSha256(); originalOwner.close();
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const owner = new AsyncConnectorOwner({ file, tokenFile: join(root, 'tokens.json') }, diagnostics);
  await owner.open();
  const port: Pick<AsyncConnectorOwner, 'command'> = { command: async (kind, input) =>
    await (intercept ? intercept(kind, () => owner.command(kind, input)) : owner.command(kind, input)) as never };
  const nodeId = await owner.command('nodeIdentity', {});
  const actor = await owner.command('tokenCreate', { label: 'lifecycle', scopes: ['connector:lifecycle'] });
  const authority = new AsyncUpdatePersistence(port, nodeId, diagnostics);
  const persistence = new RuntimeMaintenancePersistence(authority.maintenance, diagnostics);
  const request = (signal?: AbortSignal) => new Request('http://local/maintenance', { ...(signal ? { signal } : {}), headers: {
    authorization: `Bearer ${actor.token}`, [EXPECTED_NODE_HEADER]: nodeId, [CONNECTOR_PROTOCOL_HEADER]: '1' } });
  t.after(async () => { await persistence.close(); await authority.close(); await owner.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, file, hash, owner, nodeId, actor, authority, persistence, request, logs };
}

test('true worker maintenance port preserves queue hash, exact node and shared owner across consumer close/reopen', async t => {
  const f = await worker(t);
  const generation = await f.owner.command('maintenancePause', {});
  await f.authority.run(f.request(), 'readiness', async () => {
    assert.equal((await f.persistence.command('runtimeMaintenanceObserve', { historyRecovery: true }, local)).queuedMessages, 1);
    assert.deepEqual(await f.persistence.command('runtimeMaintenanceHistory', {}, local), []);
    assert.equal(await f.persistence.command('runtimeMaintenanceSdkSession', { runtime: 'ghcp', key: 'ghcp:missing' }, local), false);
    assert.deepEqual(await f.persistence.command('runtimeMaintenanceInteractions', {}, local), []);
    assert.equal((await f.persistence.command('runtimeMaintenancePreservation', { key: 'codex:original', codex: true }, local)).queueSha256, f.hash);
  });
  assert.equal(await f.owner.command('maintenanceResume', { generation }), true);
  await f.persistence.close(); await f.authority.close();
  assert.equal(await f.owner.command('nodeIdentity', {}), f.nodeId);
  await f.owner.close();
  const reopened = new ConnectorUserStore(f.file, undefined, { runtimeOwner: true });
  try {
    reopened.pauseTurnStarts();
    assert.equal(reopened.maintenanceQueueSha256(), f.hash);
    assert.equal(reopened.turns.head('codex', 'codex:original')?.state, 'queued');
  } finally { reopened.close(); }
  assert.doesNotMatch(f.logs.join(''), /PRIVATE|original-queued|Bearer|codex:original/);
  assert.doesNotMatch(readFileSync(f.file).toString('latin1'), new RegExp(f.actor.token));
});

test('port requires live readiness context and does not lend old authority to detached async work', async t => {
  const f = await worker(t);
  await assert.rejects(async () => f.authority.maintenance.command('runtimeMaintenanceHistory', {}), UpdateAuthorizationError);
  await assert.rejects(f.authority.run(f.request(), 'maintenance', async () => f.authority.maintenance.command('runtimeMaintenanceHistory', {})), UpdateAuthorizationError);
  const released = gate();
  let detached!: Promise<unknown>;
  await f.authority.run(f.request(), 'readiness', async operator => {
    detached = released.promise.then(() => f.authority.maintenance.command('runtimeMaintenanceHistory', {}));
    await operator.check();
  });
  const rejected = assert.rejects(detached, UpdateAuthorizationError);
  released.resolve(); await rejected;
});

for (const operation of ['abort', 'revoke', 'close', 'local-change'] as const) {
  test(`late ${operation} denies maintenance delivery while retaining the physical original worker command`, async t => {
    const entered = gate(), release = gate();
    let armed = true, commandCount = 0;
    const f = await worker(t, async (kind, run) => {
      if (kind === 'runtimeMaintenanceAuthorized' && armed) {
        commandCount++; entered.resolve(); await release.promise;
      }
      return run();
    });
    const controller = new AbortController(); let current = true;
    const action = f.authority.run(f.request(controller.signal), 'readiness', async () =>
      f.persistence.command('runtimeMaintenanceObserve', { historyRecovery: false }, () => { if (!current) throw Error('PRIVATE local changed'); }));
    const rejected = assert.rejects(action, /Maintenance persistence unavailable|Update operator authorization/);
    await entered.promise;
    let drained = false;
    if (operation === 'abort') controller.abort();
    if (operation === 'revoke') await f.owner.command('tokenRevoke', { tokenId: f.actor.record.id });
    if (operation === 'local-change') current = false;
    const closing = (operation === 'close' ? f.authority.close() : f.persistence.close()).then(() => { drained = true; });
    await tick(); assert.equal(drained, false);
    armed = false; release.resolve(); await rejected; await closing;
    assert.equal(commandCount, 1); assert.equal(drained, true);
    assert.equal(await f.owner.command('nodeIdentity', {}), f.nodeId);
    assert.doesNotMatch(f.logs.join(''), /PRIVATE|Bearer/);
  });
}

test('permission await rechecks local guard immediately before dispatch and freezes caller input', async t => {
  const entered = gate(), release = gate(); let checks = 0, armed = false, commands = 0;
  let supplied: ConnectorOwnerCommands['runtimeMaintenanceAuthorized']['input'] | undefined;
  const f = await worker(t, async (kind, run) => {
    if (kind === 'updateOperatorCheck' && armed && ++checks === 1) { entered.resolve(); await release.promise; }
    if (kind === 'runtimeMaintenanceAuthorized') commands++;
    return run();
  });
  let current = true;
  await f.authority.run(f.request(), 'readiness', async () => {
    armed = true;
    const input = { historyRecovery: false };
    const pending = f.authority.maintenance.command('runtimeMaintenanceObserve', input, () => { if (!current) throw Error('changed'); });
    const rejected = assert.rejects(async () => pending, /changed/);
    input.historyRecovery = true;
    await entered.promise; current = false; release.resolve(); await rejected;
    assert.equal(commands, 0);
  });
  // A separate original worker call proves the serialized input was captured
  // before any caller mutation, not merely that a failed guard suppressed it.
  const port: Pick<AsyncConnectorOwner, 'command'> = { command: async (kind, input) => {
    if (kind === 'runtimeMaintenanceAuthorized') supplied = input as typeof supplied;
    return f.owner.command(kind, input);
  } };
  const authority = new AsyncUpdatePersistence(port, f.nodeId, quiet);
  try {
    await authority.run(f.request(), 'readiness', async () => {
      const input = { historyRecovery: false };
      const pending = authority.maintenance.command('runtimeMaintenanceObserve', input);
      input.historyRecovery = true; await pending;
      assert.deepEqual(supplied?.input, { historyRecovery: false });
    });
  } finally { await authority.close(); }
});

test('async and non-void local guards cannot issue a worker maintenance operation', async t => {
  let commands = 0, invoked = false;
  const f = await worker(t, async (kind, run) => { if (kind === 'runtimeMaintenanceAuthorized') commands++; return run(); });
  await f.authority.run(f.request(), 'readiness', async () => {
    await assert.rejects(f.persistence.command('runtimeMaintenanceHistory', {}, async () => { invoked = true; }), /Maintenance persistence unavailable/);
    assert.equal(invoked, false);
    for (const result of [true, Promise.reject(Error('private rejection')), Object.defineProperty({}, 'then', { get() { throw Error('private getter'); } })])
      await assert.rejects(f.persistence.command('runtimeMaintenanceHistory', {}, () => result as never), /Maintenance persistence unavailable/);
    assert.equal(commands, 0);
  });
});
